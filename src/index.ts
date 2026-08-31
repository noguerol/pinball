import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface PinballModel { provider: string; id: string; name?: string; reasoning?: boolean }
interface PinballConfig { enabled: boolean; maxRetries: number; cooldownMs: number; notifyOnBounce: boolean; models: PinballModel[] }
interface PinballState {
  currentIndex: number;
  retryCount: number;
  lastBounceTime: number;
  consecutiveFailures: number;
  gaveUp: boolean;
  failures: Map<string, number>;
  bounceLog: Array<{ from: string; to: string; reason: string; timestamp: number }>;
}
type PinballRuntime = {
  getConfig(): PinballConfig;
  saveConfig(config?: PinballConfig): void;
  state: PinballState;
  getOriginalModel(): { provider: string; id: string } | null;
  resetState(clearLog?: boolean): void;
  updateStatus(ctx: ExtensionContext): void;
};

const CONFIG_FILE = "pinball.json";
const LEGACY_CONFIG_FILE = "model-bouncer.json";
const DEFAULT_CONFIG: PinballConfig = { enabled: true, maxRetries: 3, cooldownMs: 60_000, notifyOnBounce: true, models: [] };
const BOUNCE_DEDUPE_MS = 10_000;

const CONTEXT_OVERFLOW_PATTERNS = [
  /context window/i, /context length/i, /prompt is too long/i, /maximum context/i,
  /too many tokens/i, /token limit/i, /request.?too.?large/i, /input.?token/i,
  /reduce the length/i, /maximum prompt length/i,
];
const BOUNCE_ERROR_PATTERNS = [
  /\b429\b/, /\b402\b/, /\b403\b/, /\b5\d\d\b/, /rate.?limit/i,
  /too many requests/i, /quota/i, /usage limit/i, /limit reached/i, /insufficient/i,
  /out of budget/i, /available balance/i, /billing/i, /credit/i, /payment required/i,
  /subscription/i, /paywall/i, /resource.?exhausted/i, /overloaded/i,
  /service.?unavailable/i, /temporarily.?unavailable/i, /server Error/i,
  /chatgpt usage limit/i, /hit your .* limit/i,
];

function configPath() { return join(getAgentDir(), CONFIG_FILE); }
function loadConfig(): PinballConfig {
  const path = configPath();
  if (!existsSync(path)) {
    const legacyPath = join(getAgentDir(), LEGACY_CONFIG_FILE);
    if (existsSync(legacyPath)) {
      try {
        const migrated = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(legacyPath, "utf-8")) };
        saveConfig(migrated);
        return migrated;
      } catch (err) { console.error(`[pinball] legacy config: ${err}`); }
    }
    return { ...DEFAULT_CONFIG };
  }
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, "utf-8")) }; }
  catch (err) { console.error(`[pinball] config load: ${err}`); return { ...DEFAULT_CONFIG }; }
}
function saveConfig(config: PinballConfig) {
  try { writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8"); }
  catch (err) { console.error(`[pinball] config save: ${err}`); }
}

function modelKey(m: { provider: string; id: string }) { return `${m.provider}/${m.id}`; }
function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
function shorten(text: string, max = 90) {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function normStopReason(msg: { stopReason?: unknown } | null | undefined) { return String(msg?.stopReason ?? "").toLowerCase(); }
function isErrorStop(msg: { stopReason?: unknown } | null | undefined) { return normStopReason(msg) === "error"; }
function isSuccessStop(msg: { stopReason?: unknown } | null | undefined) {
  const r = normStopReason(msg);
  return r === "stop" || r === "toolUse" || r === "length" || r === "deferred";
}
function isBounceWorthyError(text: string) {
  return !!text && !CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(text)) && BOUNCE_ERROR_PATTERNS.some((p) => p.test(text));
}
function countActiveFailures(st: PinballState, cooldownMs: number) {
  const now = Date.now();
  let count = 0;
  for (const ts of st.failures.values()) if (now - ts < cooldownMs) count++;
  return count;
}

export default function pinballExtension(pi: ExtensionAPI) {
  let config: PinballConfig = { ...DEFAULT_CONFIG, models: [] };
  let configLoaded = false;
  let originalModel: { provider: string; id: string } | null = null;
  let pendingRetryMessage: string | null = null;
  const state: PinballState = {
    currentIndex: 0,
    retryCount: 0,
    lastBounceTime: 0,
    consecutiveFailures: 0,
    gaveUp: false,
    failures: new Map(),
    bounceLog: [],
  };

  function ensureConfig() {
    if (!configLoaded) { config = loadConfig(); configLoaded = true; }
    return config;
  }
  function persistConfig(cfg = config) {
    config = cfg;
    configLoaded = true;
    saveConfig(config);
  }
  function resetState(clearLog = true) {
    state.currentIndex = 0;
    state.retryCount = 0;
    state.consecutiveFailures = 0;
    state.gaveUp = false;
    state.failures.clear();
    if (clearLog) state.bounceLog = [];
  }
  function updateStatus(ctx: ExtensionContext) {
    const cfg = ensureConfig();
    if (!cfg.enabled) { ctx.ui.setStatus("pinball", undefined); return; }
    const failures = countActiveFailures(state, cfg.cooldownMs);
    const label = failures > 0 ? `🎯 (on ${failures})` : "🎯 (on)";
    ctx.ui.setStatus("pinball", ctx.ui.theme.fg(failures > 0 ? "warning" : "success", label));
  }
  const runtime: PinballRuntime = {
    getConfig: ensureConfig,
    saveConfig: persistConfig,
    state,
    getOriginalModel: () => originalModel,
    resetState,
    updateStatus,
  };
  let commandsPromise: Promise<typeof import("./commands")> | null = null;
  function loadCommands() { return commandsPromise ??= import("./commands"); }

  function findNextAvailableModel(excludeKey?: string) {
    const now = Date.now();
    for (const model of config.models) {
      const key = modelKey(model);
      if (excludeKey && key === excludeKey) continue;
      const lastFailure = state.failures.get(key);
      if (lastFailure && now - lastFailure < config.cooldownMs) continue;
      return model;
    }
    return null;
  }

  async function bounceToModel(ctx: ExtensionContext, target: PinballModel) {
    const current = ctx.model;
    if (current?.provider === target.provider && current.id === target.id) return true;
    try {
      const model = ctx.modelRegistry.find(target.provider, target.id);
      if (!model || !(await pi.setModel(model))) throw new Error("unavailable");
    } catch {
      state.failures.set(modelKey(target), Date.now() + config.cooldownMs * 10);
      return false;
    }
    state.currentIndex = config.models.findIndex((m) => m.provider === target.provider && m.id === target.id);
    state.bounceLog.push({
      from: originalModel ? modelKey(originalModel) : "unknown",
      to: modelKey(target),
      reason: "rate-limit/quota",
      timestamp: Date.now(),
    });
    if (state.bounceLog.length > 50) state.bounceLog = state.bounceLog.slice(-50);
    pendingRetryMessage = `[pinball] Switched to ${modelKey(target)} after provider error.\nRetry last action.`;
    return true;
  }

  async function bounceAway(ctx: ExtensionContext, failedProvider: string, failedModel: string, errorText: string) {
    const cfg = ensureConfig();
    if (!cfg.enabled || !failedProvider || !failedModel) return null;
    const failedKey = `${failedProvider}/${failedModel}`;
    const now = Date.now();
    const lastFailure = state.failures.get(failedKey);
    if (lastFailure && now - lastFailure < BOUNCE_DEDUPE_MS) return findNextAvailableModel(failedKey);

    state.failures.set(failedKey, now);
    state.retryCount++;
    state.lastBounceTime = now;
    if (!originalModel) originalModel = { provider: failedProvider, id: failedModel };

    const maxAttempts = Math.max(1, config.maxRetries) * Math.max(1, config.models.length);
    if (state.consecutiveFailures > maxAttempts) {
      state.gaveUp = true;
      ctx.ui.notify(`pinball: ${maxAttempts} attempts exhausted; stopped (/pinball reset).`, "Error");
      updateStatus(ctx);
      return null;
    }

    for (let i = 0; i < config.models.length; i++) {
      const target = findNextAvailableModel(failedKey);
      if (!target) break;
      if (await bounceToModel(ctx, target)) {
        if (config.notifyOnBounce) ctx.ui.notify(`🔄 ${failedKey} → ${modelKey(target)} (${shorten(errorText)})`, "info");
        updateStatus(ctx);
        return target;
      }
    }
    ctx.ui.notify(`pinball: no models (${shorten(errorText)}).`, "Error");
    updateStatus(ctx);
    return null;
  }

  function retryMessage(failedKey: string, targetKey: string, errorText: string) {
    return `[pinball] ${failedKey} hit provider limit/error (${shorten(errorText, 140)}). Switched to ${targetKey}. Continue the task; retry the failed step.`;
  }

  pi.on("after_provider_response", async (event, ctx) => {
    if (!ensureConfig().enabled || ![429, 402, 403].includes(event.status)) return;
    const cur = ctx.model;
    if (cur) await bounceAway(ctx, cur.provider, cur.id, `HTTP ${event.status}`);
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if (isErrorStop(msg)) {
      const errorText = msg.errorMessage ?? "";
      if (isBounceWorthyError(errorText)) await bounceAway(ctx, msg.provider, msg.model, errorText);
    } else if (isSuccessStop(msg)) {
      state.consecutiveFailures = 0;
      state.gaveUp = false;
      pendingRetryMessage = null;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ensureConfig().enabled || state.gaveUp) return;
    let lastError: string | null = null;
    let lastProvider = "";
    let lastModel = "";

    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message") continue;
      const m = entry.message;
      if (m.role === "assistant") {
        if (isErrorStop(m) && isBounceWorthyError(m.errorMessage ?? "")) {
          lastError = m.errorMessage ?? "";
          lastProvider = m.provider;
          lastModel = m.model;
        }
        break;
      }
    }
    if (!lastError || !lastProvider) return;

    const failedKey = `${lastProvider}/${lastModel}`;
    const target = await bounceAway(ctx, lastProvider, lastModel, lastError);
    if (!target || modelKey(target) === failedKey) {
      ctx.ui.notify(`pinball: no continuation model (${shorten(lastError)}).`, "Error");
      return;
    }

    pendingRetryMessage = null;
    state.consecutiveFailures++;
    const maxAttempts = Math.max(1, config.maxRetries) * Math.max(1, config.models.length);
    if (state.consecutiveFailures > maxAttempts) {
      state.gaveUp = true;
      ctx.ui.notify(`pinball: ${maxAttempts} attempts exhausted; stopped (/pinball reset).`, "Error");
      return;
    }

    ctx.ui.notify(`🔄 ${failedKey} → ${modelKey(target)}; retrying…`, "info");
    const text = retryMessage(failedKey, modelKey(target), lastError);
    if (ctx.isIdle()) {
      try { await pi.sendUserMessage(text); }
      catch (err) { console.warn(`[pinball] retry failed: ${err}`); }
    } else {
      pendingRetryMessage = text;
    }
  });

  pi.on("before_agent_start", async () => {
    if (!pendingRetryMessage) return;
    const content = pendingRetryMessage;
    pendingRetryMessage = null;
    return { message: { customType: "pinball-retry", content, display: false } };
  });

  pi.registerCommand("pinball", {
    description: "Auto failover on provider errors",
    getArgumentCompletions: (prefix) => ["enable", "disable", "status", "config", "list", "add", "remove", "test", "reset", "log"]
      .filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      ensureConfig();
      const sub = args?.trim().toLowerCase() ?? "";
      switch (sub) {
        case "enable":
          config.enabled = true; persistConfig(); ctx.ui.notify("pinball: on", "info"); updateStatus(ctx); break;
        case "disable":
          config.enabled = false; persistConfig(); ctx.ui.notify("pinball: off", "info"); updateStatus(ctx); break;
        case "reset":
          state.failures.clear(); state.retryCount = 0; state.consecutiveFailures = 0; state.gaveUp = false;
          ctx.ui.notify("pinball: reset", "info"); updateStatus(ctx); break;
        case "status": case "config": case "list": case "add": case "remove": case "test": case "log":
          try { await (await loadCommands()).handlePinballCommand(sub, pi, ctx, runtime); }
          catch (err) { console.error(`[pinball] command load: ${err}`); ctx.ui.notify(`pinball: command unavailable (${shorten(String(err))})`, "Error"); }
          break;
        default:
          config.enabled = !config.enabled; persistConfig(); ctx.ui.notify(`pinball: ${config.enabled ? "on" : "off"}`, "info"); updateStatus(ctx);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    configLoaded = true;
    originalModel = null;
    pendingRetryMessage = null;
    resetState();
    updateStatus(ctx);
  });
}
