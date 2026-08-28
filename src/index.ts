/**
 * pinball Extension for pi
 *
 * Automatically switches to the next provider/model when the active one
 * returns rate-limit (429), payment-required (402/403), quota/usage-limit,
 * or persistent server errors (5xx). Transparent retry: the agent continues
 * without user intervention — including in headless spawned processes
 * (e.g. multi-agent extensions that run `pi --mode json -p`).
 *
 * Failure detection points (each feeds the same bounce core):
 *   1. after_provider_response — HTTP 429/402/403 (early, before the error
 *      message is even created; pi's own retries then use the new model).
 *   2. message_end — assistant message with stopReason "error" + bounce-worthy
 *      text (catches providers that fail mid-stream with HTTP 200, e.g. Codex
 *      SSE `error` events: "Codex error: The usage limit has been reached").
 *   3. agent_settled — the run died on a bounce-worthy error and pi will not
 *      auto-retry it: bounce and AWAIT a re-trigger via sendUserMessage so the
 *      task continues with the next model. Awaited on purpose — in headless
 *      print mode the process exits as soon as the prompt settles, so a
 *      fire-and-forget retry would be killed before it runs.
 *
 * All configuration is done via /pinball subcommands with native pi UI.
 * Model list comes from pi's built-in model registry (same as /model).
 *
 * Commands:
 *   /pinball              - Toggle on/off
 *   /pinball enable       - Enable pinball
 *   /pinball disable      - Disable pinball
 *   /pinball status       - Show current state
 *   /pinball config       - Open interactive config menu
 *   /pinball add          - Add a provider/model interactively
 *   /pinball remove       - Remove a provider/model
 *   /pinball test         - Test all configured providers
 *   /pinball reset        - Reset all cooldowns
 *   /pinball log          - Show bounce history
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PinballModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

interface PinballConfig {
  enabled: boolean;
  maxRetries: number;
  cooldownMs: number;
  notifyOnBounce: boolean;
  models: PinballModel[];
}

interface PinballState {
  currentIndex: number;
  retryCount: number;
  lastBounceTime: number;
  consecutiveFailures: number;
  gaveUp: boolean;
  failures: Map<string, number>;
  bounceLog: Array<{
    from: string;
    to: string;
    reason: string;
    timestamp: number;
  }>;
}

interface TestResult {
  model: PinballModel;
  status: "ok" | "Error" | "No-key" | "timeout";
  message: string;
  latencyMs: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CONFIG_FILE = "pinball.json";
/** Pre-rename config file ("model-bouncer.json"); migrated once, then ignored. */
const LEGACY_CONFIG_FILE = "model-bouncer.json";

const DEFAULT_CONFIG: PinballConfig = {
  enabled: true,
  maxRetries: 3,
  cooldownMs: 60_000,
  notifyOnBounce: true,
  models: [],
};

/**
 * Window during which repeated reports of the SAME failing model (HTTP hook +
 * message_end + agent_settled, or pi's own internal retry attempts) are
 * deduplicated so the model list is not thrashed. Does NOT suppress the
 * agent_settled re-trigger — that always runs when the run dies.
 */
const BOUNCE_DEDUPE_MS = 10_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

function loadConfig(): PinballConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    // One-time migration from the pre-rename "model-bouncer.json".
    const legacyPath = join(getAgentDir(), LEGACY_CONFIG_FILE);
    if (existsSync(legacyPath)) {
      try {
        const migrated = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(legacyPath, "utf-8")) };
        saveConfig(migrated);
        return migrated;
      } catch (err) {
        console.error(`[pinball] Legacy config migration Error: ${err}`);
      }
    }
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath, "utf-8")) };
  } catch (err) {
    console.error(`[pinball] Config load Error: ${err}`);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: PinballConfig): void {
  try {
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error(`[pinball] Config save Error: ${err}`);
  }
}

function modelKey(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * Select helper: presents labeled strings to ctx.ui.select(), returns the
 * matched value from the items array. Returns undefined if cancelled.
 */
function selectFrom<T>(
  ctx: ExtensionContext,
  title: string,
  items: Array<{ value: T; label: string; description?: string }>
): Promise<T | undefined> {
  const strings = items.map((it) =>
    it.description ? `${it.label} — ${it.description}` : it.label
  );
  return ctx.ui.select(title, strings).then((picked) => {
    if (picked === undefined) return undefined;
    const idx = strings.indexOf(picked);
    return idx >= 0 ? items[idx].value : undefined;
  });
}

// ─── stopReason normalization ───────────────────────────────────────────────
// pi's StopReason type is all-lowercase:
//   "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"
// Older code compared against "Error" (capital E) and never matched, so the
// pinball never detected failures. Normalize defensively.

function normStopReason(msg: { stopReason?: unknown } | null | undefined): string {
  return String(msg?.stopReason ?? "").toLowerCase();
}

function isErrorStop(msg: { stopReason?: unknown } | null | undefined): boolean {
  return normStopReason(msg) === "error";
}

function isSuccessStop(msg: { stopReason?: unknown } | null | undefined): boolean {
  const r = normStopReason(msg);
  return r === "stop" || r === "toolUse" || r === "length" || r === "deferred";
}

// ─── Bounce-worthy Error detection ─────────────────────────────────────────

// Context overflow is NOT a bounce reason (pi handles it with compaction)
const CONTEXT_OVERFLOW_PATTERNS = [
  /context window/i, /context length/i, /prompt is too long/i,
  /maximum context/i, /too many tokens/i, /token limit/i,
  /request.?too.?large/i, /input.?token/i, /reduce the length/i,
  /maximum prompt length/i,
];

// Rate limits, quota exhaustion, credits, billing, 5xx...
const BOUNCE_ERROR_PATTERNS = [
  /\b429\b/, /\b402\b/, /\b403\b/, /\b5\d\d\b/,
  /rate.?limit/i, /too many requests/i, /quota/i, /usage limit/i,
  /limit reached/i, /insufficient/i, /out of budget/i, /available balance/i,
  /billing/i, /credit/i, /payment required/i, /subscription/i,
  /paywall/i, /resource.?exhausted/i, /overloaded/i,
  /service.?unavailable/i, /temporarily.?unavailable/i, /server Error/i,
  // Codex / ChatGPT wording
  /chatgpt usage limit/i, /hit your .* limit/i,
];

function isBounceWorthyError(text: string): boolean {
  if (!text) return false;
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(text))) return false;
  return BOUNCE_ERROR_PATTERNS.some((p) => p.test(text));
}

function shorten(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function pinballExtension(pi: ExtensionAPI) {
  let config: PinballConfig = loadConfig();
  let originalModel: { provider: string; id: string } | null = null;

  const state: PinballState = {
    currentIndex: 0,
    retryCount: 0,
    lastBounceTime: 0,
    consecutiveFailures: 0,
    gaveUp: false,
    failures: new Map(),
    bounceLog: [],
  };

  let pendingRetryMessage: string | null = null;

  // ─── Core: detect failures and bounce ────────────────────────────────────

  /**
   * Find the next available model to bounce to, in CONFIGURED PRIORITY ORDER
   * (index 0 = highest priority, matching the /pinball list UI label). Models
   * in cooldown or equal to `excludeKey` (the one that just failed) are
   * skipped. Returns null when nothing is usable.
   */
  function findNextAvailableModel(
    cfg: PinballConfig,
    st: PinballState,
    excludeKey?: string
  ): PinballModel | null {
    const now = Date.now();
    for (const model of cfg.models) {
      if (!model) continue;
      const key = modelKey(model);
      if (excludeKey && key === excludeKey) continue;
      const lastFailure = st.failures.get(key);
      if (lastFailure && now - lastFailure < cfg.cooldownMs) continue;
      return model;
    }
    return null;
  }

  function countActiveFailures(st: PinballState, cooldownMs: number): number {
    const now = Date.now();
    let count = 0;
    for (const ts of st.failures.values()) {
      if (now - ts < cooldownMs) count++;
    }
    return count;
  }

  /**
   * Switch the session to `target`. Returns false when the model is unknown
   * or has no API key (the caller then marks it with a long cooldown and
   * tries the next candidate). Sets pendingRetryMessage so pi's internal
   * auto-retry (agent.continue) injects an explanation on its next run.
   */
  async function bounceToModel(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    target: PinballModel
  ): Promise<boolean> {
    // Already on the target (e.g. a previous hook already bounced for this
    // failure) — nothing to do, but keep the pending retry message intact.
    const current = ctx.model;
    if (current && current.provider === target.provider && current.id === target.id) {
      return true;
    }

    let model;
    try {
      model = ctx.modelRegistry.find(target.provider, target.id);
      if (!model) {
        state.failures.set(modelKey(target), Date.now() + config.cooldownMs * 10);
        return false;
      }
      const success = await pi.setModel(model);
      if (!success) {
        state.failures.set(modelKey(target), Date.now() + config.cooldownMs * 10);
        return false;
      }
    } catch (err) {
      state.failures.set(modelKey(target), Date.now() + config.cooldownMs * 10);
      return false;
    }

    state.currentIndex = config.models.findIndex(
      (m) => m.provider === target.provider && m.id === target.id
    );

    state.bounceLog.push({
      from: originalModel ? `${originalModel.provider}/${originalModel.id}` : "unknown",
      to: modelKey(target),
      reason: "rate-limit/quota",
      timestamp: Date.now(),
    });
    if (state.bounceLog.length > 50) state.bounceLog = state.bounceLog.slice(-50);

    pendingRetryMessage = [
      `[pinball] Previous provider returned an Error. Switched to ${modelKey(target)}.`,
      `Please retry your last action.`,
    ].join("\n");
    return true;
  }

  /**
   * Unified entry point for every failure signal. Deduplicates repeated
   * reports of the same failing model, records it in cooldown, and bounces to
   * the first available model in priority order (skipping candidates that
   * fail setModel/auth). Returns the model switched to, or null when nothing
   * is available.
   */
  async function bounceAway(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    failedProvider: string,
    failedModel: string,
    errorText: string
  ): Promise<PinballModel | null> {
    if (!config.enabled) return null;
    if (!failedProvider || !failedModel) return null;

    const failedKey = `${failedProvider}/${failedModel}`;
    const now = Date.now();
    const lastFailure = state.failures.get(failedKey);

    // Dedupe: this failure was already handled by another hook within the
    // window. Report the best candidate without bouncing again (the
    // agent_settled re-trigger still runs on its own).
    if (lastFailure && now - lastFailure < BOUNCE_DEDUPE_MS) {
      return findNextAvailableModel(config, state, failedKey);
    }

    state.failures.set(failedKey, now);
    state.retryCount++;
    state.lastBounceTime = now;
    if (!originalModel) {
      originalModel = { provider: failedProvider, id: failedModel };
    }

    const totalAttempts = Math.max(1, config.maxRetries) * Math.max(1, config.models.length);
    if (state.consecutiveFailures > totalAttempts) {
      state.gaveUp = true;
      ctx.ui.notify(
        `🔄 pinball: se agotaron ${totalAttempts} intentos consecutivos. Detengo el rebote (usa /pinball reset).`,
        "Error"
      );
      return null;
    }

    // Try candidates in priority order until one accepts the bounce.
    for (let i = 0; i < config.models.length; i++) {
      const target = findNextAvailableModel(config, state, failedKey);
      if (!target) break;
      const bounced = await bounceToModel(pi, ctx, target);
      if (bounced) {
        if (config.notifyOnBounce) {
          ctx.ui.notify(`🔄 ${failedKey} → ${modelKey(target)} (${shorten(errorText)})`, "info");
        }
        return target;
      }
    }

    ctx.ui.notify(
      `🔄 pinball: No quedan modelos disponibles para hacer bounce (${shorten(errorText)}).`,
      "Error"
    );
    return null;
  }

  function buildRetryMessage(failedKey: string, targetKey: string, errorText: string): string {
    return (
      `[pinball] El modelo ${failedKey} falló por límite de uso o cuota (${shorten(errorText, 140)}). ` +
      `Se cambió a ${targetKey}. Continúa la tarea en curso hasta completarla. ` +
      `El último intento anterior falló; reinténtalo con el nuevo modelo.`
    );
  }

  // ─── Hook 1: early HTTP status detection ─────────────────────────────────

  pi.on("after_provider_response", async (event, ctx) => {
    if (!config.enabled) return;
    const status = event.status;
    // 429/402/403 are not transient — bounce now so pi's own internal retries
    // (if any) already run on a healthy model. 5xx is left to message_end /
    // agent_settled because it is usually a short blip pi retries internally.
    if (status !== 429 && status !== 402 && status !== 403) return;
    const cur = ctx.model;
    if (!cur) return;
    await bounceAway(pi, ctx, cur.provider, cur.id, `HTTP ${status}`);
  });

  // ─── Hook 2: failed assistant messages ───────────────────────────────────

  /**
   * message_end fires for EVERY finalized assistant message, including failed
   * ones (stopReason "error" + errorMessage). This is the reliable place to
   * detect rate-limit/quota failures that arrive mid-stream with HTTP 200
   * (e.g. Codex SSE `error` events) — after_provider_response only sees the
   * HTTP status, which is 200 for those.
   *
   * Bouncing here (pi.setModel) also helps pi's own auto-retry: setModel
   * mutates agent.state.model, so a subsequent agent.continue() re-runs with
   * the new model.
   */
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;

    if (isErrorStop(msg)) {
      const errorText = msg.errorMessage ?? "";
      if (isBounceWorthyError(errorText)) {
        await bounceAway(pi, ctx, msg.provider, msg.model, errorText);
      }
    } else if (isSuccessStop(msg)) {
      // Genuine success — reset the failure streak and clear any stale
      // pendingRetryMessage from a previous bounce that was resolved by
      // pi's auto-retry. (Aborts are neither success nor failure.)
      state.consecutiveFailures = 0;
      state.gaveUp = false;
      pendingRetryMessage = null;
    }
  });

  // ─── Hook 3: settled run died on a bounce-worthy error ───────────────────

  /**
   * agent_settled fires when pi has fully given up (retries exhausted or the
   * Error was not retryable — e.g. "The usage limit has been reached" is NOT
   * in pi's retryable set, so pi fails fast). If the run died on a
   * bounce-worthy Error, bounce once more and AWAIT a re-trigger so the agent
   * continues autonomously with the next provider.
   *
   * The await is essential for headless spawned processes (multi-agent
   * extensions run `pi --mode json -p --no-session`): in print mode the process exits as
   * soon as session.prompt() settles, so a fire-and-forget setTimeout retry
   * was killed before it ran. Blocking here keeps the process alive until the
   * retried run completes (its own agent_settled then handles further
   * failures recursively, capped by state.gaveUp).
   */
  pi.on("agent_settled", async (_event, ctx) => {
    if (!config.enabled || state.gaveUp) return;

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
        break; // only inspect the last assistant message
      }
    }
    if (!lastError || !lastProvider) return;

    const failedKey = `${lastProvider}/${lastModel}`;
    const target = await bounceAway(pi, ctx, lastProvider, lastModel, lastError);
    if (!target || modelKey(target) === failedKey) {
      ctx.ui.notify(
        `🔄 pinball: sin modelos disponibles para continuar (${shorten(lastError)}).`,
        "Error"
      );
      return;
    }

    // Clear the pendingRetryMessage that bounceToModel set — we send our own,
    // more informative message below, so before_agent_start must not inject a
    // second one when the retried run starts.
    pendingRetryMessage = null;

    state.consecutiveFailures++;
    const totalAttempts = Math.max(1, config.maxRetries) * Math.max(1, config.models.length);
    if (state.consecutiveFailures > totalAttempts) {
      state.gaveUp = true;
      ctx.ui.notify(
        `🔄 pinball: se agotaron ${totalAttempts} intentos consecutivos. Detengo el rebote (usa /pinball reset).`,
        "Error"
      );
      return;
    }

    ctx.ui.notify(
      `🔄 pinball: ${failedKey} agotó cuota/rate-limit. Reintentando la tarea con ${modelKey(target)}…`,
      "info"
    );

    const retryText = buildRetryMessage(failedKey, modelKey(target), lastError);
    if (ctx.isIdle()) {
      // Session is idle (settled) — re-trigger NOW and wait for the new run.
      try {
        await pi.sendUserMessage(retryText);
      } catch (err) {
        console.warn(`[pinball] Fallo al reintentar la tarea: ${err}`);
      }
    } else {
      // Something else started a run already — inject via before_agent_start.
      pendingRetryMessage = retryText;
    }
  });

  // ─── Follow-up injection for retry ──────────────────────────────────────

  pi.on("before_agent_start", async () => {
    if (!pendingRetryMessage) return;
    const msg = pendingRetryMessage;
    pendingRetryMessage = null;
    return {
      message: { customType: "pinball-retry", content: msg, display: false },
    };
  });

  // ─── Status bar ─────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext) {
    if (!config.enabled) {
      ctx.ui.setStatus("pinball", undefined);
      return;
    }
    const failures = countActiveFailures(state, config.cooldownMs);
    ctx.ui.setStatus("pinball", failures > 0 ? `🕹️ pinball(${failures})` : "🕹️ pinball");
  }

  // ─── Provider test ──────────────────────────────────────────────────────

  async function testProvider(pi: ExtensionAPI, ctx: ExtensionContext, model: PinballModel): Promise<TestResult> {
    const startTime = Date.now();
    try {
      const found = ctx.modelRegistry.find(model.provider, model.id);
      if (!found) {
        return { model, status: "Error", message: "Model not found in registry", latencyMs: 0 };
      }

      // Just try setModel — it validates auth internally.
      // No separate key check: providers resolve keys dynamically
      // (env vars, OAuth, /login, models.json apiKey field, etc.)
      const success = await pi.setModel(found);

      // Restore original model
      if (originalModel) {
        const orig = ctx.modelRegistry.find(originalModel.provider, originalModel.id);
        if (orig) await pi.setModel(orig);
      }

      return {
        model,
        status: success ? "ok" : "No-key",
        message: success ? "Available" : "No API key — use /login or set env var",
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      return { model, status: "Error", message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - startTime };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COMMANDS
  // ═══════════════════════════════════════════════════════════════════════

  // ─── /pinball [subcommand] ──────────────────────────────────────────────

  pi.registerCommand("pinball", {
    description: "Pinball: auto-switch on provider errors",
    getArgumentCompletions: (prefix) => {
      const subs = ["enable", "disable", "status", "config", "list", "add", "remove", "test", "reset", "log"];
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const sub = args?.trim().toLowerCase() ?? "";
      switch (sub) {
        case "enable":
          config.enabled = true;
          saveConfig(config);
          ctx.ui.notify("🔄 pinball: ENABLED", "info");
          updateStatus(ctx);
          break;
        case "disable":
          config.enabled = false;
          saveConfig(config);
          ctx.ui.notify("🔄 pinball: DISABLED", "info");
          updateStatus(ctx);
          break;
        case "status":
          await showStatus(ctx);
          break;
        case "config":
          await showConfigMenu(pi, ctx);
          break;
        case "list":
          await listModels(pi, ctx);
          break;
        case "add":
          await addModelInteractive(pi, ctx);
          break;
        case "remove":
          await removeModelInteractive(ctx);
          break;
        case "test":
          await testAllProviders(pi, ctx);
          break;
        case "reset":
          state.failures.clear();
          state.retryCount = 0;
          state.consecutiveFailures = 0;
          state.gaveUp = false;
          ctx.ui.notify("🔄 All cooldowns and counters reset", "info");
          updateStatus(ctx);
          break;
        case "log":
          await showBounceLog(ctx);
          break;
        default:
          config.enabled = !config.enabled;
          saveConfig(config);
          ctx.ui.notify(`🔄 pinball: ${config.enabled ? "ENABLED" : "DISABLED"}`, "info");
          updateStatus(ctx);
          break;
      }
    },
  });

  // ─── /pinball status ────────────────────────────────────────────────────

  async function showStatus(ctx: ExtensionContext) {
    const currentModel = ctx.model;
    const currentKey = currentModel ? `${currentModel.provider}/${currentModel.id}` : "unknown";
    const failures = countActiveFailures(state, config.cooldownMs);
    const totalAttempts = config.maxRetries * config.models.length;

    const lines = [
      `State: ${config.enabled ? "✅ ENABLED" : "❌ DISABLED"}`,
      `Active model: ${currentKey}`,
      `Bounce list: ${config.models.length} models`,
      `Retries: ${state.retryCount}/${totalAttempts}`,
      `Consecutive failures: ${state.consecutiveFailures}`,
      `In cooldown: ${failures}`,
      `Cooldown: ${formatDuration(config.cooldownMs)}`,
    ];
    if (originalModel) lines.push(`Original: ${originalModel.provider}/${originalModel.id}`);
    if (state.bounceLog.length > 0) {
      const last = state.bounceLog[state.bounceLog.length - 1];
      lines.push(`Last bounce: ${last.from} → ${last.to} (${last.reason}, ${formatDuration(Date.now() - last.timestamp)} ago)`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
  }

  // ─── /pinball config ────────────────────────────────────────────────────

  async function showConfigMenu(pi: ExtensionAPI, ctx: ExtensionContext) {
    const enabledLabel = config.enabled ? "🟢 Disable pinball" : "🔴 Enable pinball";

    const action = await selectFrom(ctx, "🔄 Pinball Config", [
      { value: "toggle", label: enabledLabel, description: `Currently: ${config.enabled ? "enabled" : "disabled"}` },
      { value: "list", label: "📋 List models", description: `${config.models.length} configured` },
      { value: "add", label: "➕ Add model", description: "Add provider/model to bounce list" },
      { value: "remove", label: "➖ Remove model", description: "Remove from bounce list" },
      { value: "test", label: "🧪 Test all providers", description: "Check connectivity" },
      { value: "cooldown", label: `⏱️  Cooldown: ${formatDuration(config.cooldownMs)}`, description: "Change after-Error cooldown" },
      { value: "retries", label: `🔁 Max retries: ${config.maxRetries}`, description: "Change retries per model" },
      { value: "notify", label: `🔔 Notifications: ${config.notifyOnBounce ? "on" : "off"}`, description: "Toggle bounce notifications" },
      { value: "reset", label: "🔃 Reset cooldowns", description: "Clear all cooldown timers" },
    ]);

    if (!action) return;

    switch (action) {
      case "toggle":
        config.enabled = !config.enabled;
        saveConfig(config);
        ctx.ui.notify(`pinball: ${config.enabled ? "ENABLED" : "DISABLED"}`, "info");
        updateStatus(ctx);
        break;
      case "list":
        await listModels(pi, ctx);
        break;
      case "add":
        await addModelInteractive(pi, ctx);
        break;
      case "remove":
        await removeModelInteractive(ctx);
        break;
      case "test":
        await testAllProviders(pi, ctx);
        break;
      case "cooldown": {
        const picked = await selectFrom(ctx, "Select cooldown period", [
          { value: 30_000, label: "30 seconds" },
          { value: 60_000, label: "1 minute" },
          { value: 120_000, label: "2 minutes" },
          { value: 300_000, label: "5 minutes" },
          { value: 600_000, label: "10 minutes" },
        ]);
        if (picked !== undefined) {
          config.cooldownMs = picked;
          saveConfig(config);
          ctx.ui.notify(`Cooldown set to ${formatDuration(config.cooldownMs)}`, "info");
        }
        break;
      }
      case "retries": {
        const picked = await selectFrom(ctx, "Max retries per model", [
          { value: 1, label: "1 retry" },
          { value: 2, label: "2 retries" },
          { value: 3, label: "3 retries" },
          { value: 5, label: "5 retries" },
          { value: 10, label: "10 retries" },
        ]);
        if (picked !== undefined) {
          config.maxRetries = picked;
          saveConfig(config);
          ctx.ui.notify(`Max retries set to ${config.maxRetries}`, "info");
        }
        break;
      }
      case "notify":
        config.notifyOnBounce = !config.notifyOnBounce;
        saveConfig(config);
        ctx.ui.notify(`Notifications: ${config.notifyOnBounce ? "ON" : "OFF"}`, "info");
        break;
      case "reset":
        state.failures.clear();
        state.retryCount = 0;
        state.consecutiveFailures = 0;
        state.gaveUp = false;
        ctx.ui.notify("All cooldowns reset", "info");
        updateStatus(ctx);
        break;
    }
  }

  // ─── /pinball add ───────────────────────────────────────────────────────

  // ─── Registry model picker ─────────────────────────────────────────────

  /**
   * Pick a model from pi's built-in registry (same list as /model).
   * Two steps: provider → model. Returns undefined if cancelled.
   */
  async function pickModelFromRegistry(
    pi: ExtensionAPI,
    ctx: ExtensionContext
  ): Promise<PinballModel | undefined> {
    const allModels = ctx.modelRegistry.getAvailable();

    if (allModels.length === 0) {
      ctx.ui.notify("No models available in pi. Configure providers first.", "warning");
      return undefined;
    }

    // Group models by provider
    const byProvider = new Map<string, typeof allModels>();
    for (const m of allModels) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }

    // Step 1: Select provider (from registry)
    const providerEntries = Array.from(byProvider.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    const providerItems = providerEntries.map(([providerId, models]) => ({
      value: providerId,
      label: providerId,
      description: `${models.length} model${models.length !== 1 ? "s" : ""}`,
    }));

    const providerId = await selectFrom(ctx, "Select provider", providerItems);
    if (!providerId) return undefined;

    const providerModels = byProvider.get(providerId) ?? [];

    // Step 2: Select model from this provider (from registry)
    const modelItems = providerModels.map((m) => {
      const alreadyAdded = config.models.some(
        (cm) => cm.provider === m.provider && cm.id === m.id
      );
      return {
        value: { provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning },
        label: alreadyAdded ? `✅ ${m.id}` : m.id,
        description: [
          m.name !== m.id ? m.name : "",
          m.reasoning ? "reasoning" : "",
          alreadyAdded ? "already in pinball" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });

    if (modelItems.length === 0) {
      ctx.ui.notify("No models found for this provider", "warning");
      return undefined;
    }

    const selected = await selectFrom(ctx, `Select model (${providerId})`, modelItems);
    if (!selected) return undefined;

    const picked: PinballModel = {
      provider: selected.provider,
      id: selected.id,
      reasoning: selected.reasoning,
    };
    if (selected.name && selected.name !== selected.id) picked.name = selected.name;

    return picked;
  }

  // ─── /pinball add ───────────────────────────────────────────────────────

  async function addModelInteractive(pi: ExtensionAPI, ctx: ExtensionContext) {
    const picked = await pickModelFromRegistry(pi, ctx);
    if (!picked) return;

    // Check duplicate
    const exists = config.models.some(
      (m) => m.provider === picked.provider && m.id === picked.id
    );
    if (exists) {
      ctx.ui.notify(`⚠️  ${modelKey(picked)} is already in the bounce list`, "warning");
      return;
    }

    config.models.push(picked);
    saveConfig(config);
    ctx.ui.notify(`✅ Added ${modelKey(picked)} to bounce list`, "info");
  }

  // ─── /pinball remove ────────────────────────────────────────────────────

  async function removeModelInteractive(ctx: ExtensionContext) {
    if (config.models.length === 0) {
      ctx.ui.notify("No models to remove", "warning");
      return;
    }

    const items = config.models.map((m, i) => ({
      value: i,
      label: modelKey(m),
      description: m.name || "",
    }));

    const idx = await selectFrom(ctx, "Remove model", items);
    if (idx === undefined) return;

    const removed = config.models.splice(idx, 1)[0];
    saveConfig(config);
    ctx.ui.notify(`🗑️  Removed ${modelKey(removed)}`, "info");
  }

  // ─── /pinball list ──────────────────────────────────────────────────────

  /**
   * Interactive bounce list manager. Selecting a model opens an action
   * menu: reorder (up/down/top/bottom), replace with another model from
   * pi's registry, or remove. The list re-shows after every action until
   * the user exits.
   */
  async function listModels(pi: ExtensionAPI, ctx: ExtensionContext) {
    while (true) {
      if (config.models.length === 0) {
        ctx.ui.notify("No models configured. Use /pinball add to add models.", "info");
        return;
      }

      const items = config.models.map((m, i) => {
        const key = modelKey(m);
        const failureTime = state.failures.get(key);
        const inCooldown = failureTime && Date.now() - failureTime < config.cooldownMs;
        const isOriginal = originalModel?.provider === m.provider && originalModel?.id === m.id;

        let status = "";
        if (inCooldown) status = " ⏳ cooldown";
        else if (isOriginal) status = " ⭐ original";

        return {
          value: i,
          label: `${i + 1}. ${key}${status}`,
          description: [m.name, m.reasoning ? "reasoning" : ""].filter(Boolean).join(" · "),
        };
      });
      items.push({ value: -1, label: "⬅️  Back", description: "Exit list" });

      const idx = await selectFrom(
        ctx,
        `📋 Bounce list — order = bounce priority (${config.models.length} models)`,
        items
      );
      if (idx === undefined || idx === -1) return;

      const model = config.models[idx];

      // Build contextual action menu
      const actions: Array<{ value: string; label: string; description?: string }> = [];
      if (idx > 0) actions.push({ value: "up", label: "⬆️  Move up", description: "Swap with previous" });
      if (idx < config.models.length - 1) actions.push({ value: "down", label: "⬇️  Move down", description: "Swap with next" });
      if (idx > 0) actions.push({ value: "top", label: "⏫  Move to top", description: "First in bounce order" });
      if (idx < config.models.length - 1) actions.push({ value: "bottom", label: "⏬  Move to bottom", description: "Last in bounce order" });
      actions.push({ value: "replace", label: "🔁 Replace model", description: "Swap for a different provider/model" });
      actions.push({ value: "remove", label: "🗑️  Remove", description: "Delete from bounce list" });

      const action = await selectFrom(ctx, `${modelKey(model)} — select action`, actions);
      if (!action) continue; // Esc → back to list

      switch (action) {
        case "up": {
          [config.models[idx - 1], config.models[idx]] = [config.models[idx], config.models[idx - 1]];
          saveConfig(config);
          break;
        }
        case "down": {
          [config.models[idx], config.models[idx + 1]] = [config.models[idx + 1], config.models[idx]];
          saveConfig(config);
          break;
        }
        case "top": {
          const [moved] = config.models.splice(idx, 1);
          config.models.unshift(moved);
          saveConfig(config);
          break;
        }
        case "bottom": {
          const [moved] = config.models.splice(idx, 1);
          config.models.push(moved);
          saveConfig(config);
          break;
        }
        case "replace": {
          const replacement = await pickModelFromRegistry(pi, ctx);
          if (!replacement) break;

          // Duplicate check (ignore the slot being replaced)
          const dupAt = config.models.findIndex(
            (cm, i) => i !== idx && cm.provider === replacement.provider && cm.id === replacement.id
          );
          if (dupAt !== -1) {
            ctx.ui.notify(`⚠️  ${modelKey(replacement)} is already at position ${dupAt + 1}`, "warning");
            break;
          }

          const old = config.models[idx];
          config.models[idx] = replacement;
          saveConfig(config);
          ctx.ui.notify(`🔁 Replaced ${modelKey(old)} → ${modelKey(replacement)}`, "info");
          break;
        }
        case "remove": {
          const removed = config.models.splice(idx, 1)[0];
          saveConfig(config);
          ctx.ui.notify(`🗑️  Removed ${modelKey(removed)}`, "info");
          break;
        }
      }
      // Loop re-shows the updated list
    }
  }

  // ─── /pinball test ──────────────────────────────────────────────────────

  async function testAllProviders(pi: ExtensionAPI, ctx: ExtensionContext) {
    if (config.models.length === 0) {
      ctx.ui.notify("No models configured. Use /pinball add first.", "warning");
      return;
    }

    ctx.ui.notify(`🧪 Testing ${config.models.length} providers...`, "info");

    const results: TestResult[] = [];
    for (const model of config.models) {
      results.push(await testProvider(pi, ctx, model));
    }

    const lines = results.map((r) => {
      const icon = r.status === "ok" ? "✅" : r.status === "No-key" ? "🔑" : "❌";
      return `${icon} ${modelKey(r.model)}: ${r.message} (${r.latencyMs}ms)`;
    });

    const okCount = results.filter((r) => r.status === "ok").length;
    ctx.ui.notify(`🧪 Test results:\n${lines.join("\n")}\n\n${okCount}/${results.length} available`, "info");
  }

  // ─── /pinball log ───────────────────────────────────────────────────────

  async function showBounceLog(ctx: ExtensionContext) {
    if (state.bounceLog.length === 0) {
      ctx.ui.notify("No bounces recorded this session", "info");
      return;
    }

    const items = state.bounceLog.slice(-20).reverse().map((entry) => ({
      value: "",
      label: `${entry.from} → ${entry.to}`,
      description: `${entry.reason} · ${formatDuration(Date.now() - entry.timestamp)} ago`,
    }));

    await selectFrom(ctx, `🔄 Bounce log (${state.bounceLog.length} total)`, items);
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    state.currentIndex = 0;
    state.retryCount = 0;
    state.consecutiveFailures = 0;
    state.gaveUp = false;
    state.failures.clear();
    state.bounceLog = [];
    originalModel = null;
    pendingRetryMessage = null;
    updateStatus(ctx);
  });
}

