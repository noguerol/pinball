import { SettingsList } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SelectItem<T> { value: T; label: string; description?: string }
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
type TestResult = { model: PinballModel; status: "ok" | "Error" | "No-key" | "timeout"; message: string; latencyMs: number };

function modelKey(m: { provider: string; id: string }) { return `${m.provider}/${m.id}`; }
function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

// --- Native pi settings-menu UI -------------------------------------------------
//
// pi's `SettingsList` renders each setting on one row: label (left), current
// value (right), a hint line at the bottom, and — crucially — a muted description
// shown beneath the list for the *selected* option, exactly like the built-in
// /settings menu. Items with `values` cycle on Enter; items with `submenu` open
// a nested menu on Enter (which may `navigateTo` an id after closing).

let currentTheme: any = null;

function settingsTheme(theme: any) {
  currentTheme = theme;
  return {
    label: (t: string, selected: boolean) => theme.fg(selected ? "accent" : "text", t),
    value: (t: string, selected: boolean) => theme.fg(selected ? "success" : "muted", t),
    description: (t: string) => theme.fg("muted", t),
    cursor: "→ ",
    hint: (t: string) => theme.fg("dim", t),
  };
}

// Applies a cycling/toggle setting straight from the native menu (Enter on an
// item with `values`), then refreshes the status widget.
function applyConfigSetting(ctx: ExtensionContext, rt: PinballRuntime, id: string, newValue: string) {
  const config = rt.getConfig();
  switch (id) {
    case "toggle":
      config.enabled = newValue === "on";
      ctx.ui.notify(`pinball: ${config.enabled ? "on" : "off"}`, "info");
      break;
    case "cooldown":
      config.cooldownMs = { "30s": 30_000, "1m": 60_000, "2m": 120_000, "5m": 300_000, "10m": 600_000 }[newValue] ?? config.cooldownMs;
      ctx.ui.notify(`Cooldown: ${formatDuration(config.cooldownMs)}`, "info");
      break;
    case "retries":
      config.maxRetries = Number(newValue) || config.maxRetries;
      ctx.ui.notify(`Retries: ${config.maxRetries}`, "info");
      break;
    case "notify":
      config.notifyOnBounce = newValue === "on";
      ctx.ui.notify(`Notify: ${config.notifyOnBounce ? "on" : "off"}`, "info");
      break;
  }
  rt.saveConfig();
  rt.updateStatus(ctx);
}

// Dispatches the "open a submenu / run an action" settings that don't cycle.
async function dispatchConfigAction(pi: ExtensionAPI, ctx: ExtensionContext, rt: PinballRuntime, id: string) {
  switch (id) {
    case "list": await listModels(pi, ctx, rt); break;
    case "add": await addModelInteractive(ctx, rt); break;
    case "remove": await removeModelInteractive(ctx, rt); break;
    case "test": await testAllProviders(pi, ctx, rt); break;
    case "reset":
      rt.state.failures.clear(); rt.state.retryCount = 0; rt.state.consecutiveFailures = 0; rt.state.gaveUp = false;
      ctx.ui.notify("pinball: reset", "info"); rt.updateStatus(ctx); break;
  }
}

// The bounce-list manager, rendered as its own native settings menu.
function buildListSubmenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rt: PinballRuntime,
  done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
): SettingsList {
  const config = rt.getConfig();
  const state = rt.state;
  const buildItems = () => {
    const items = config.models.map((m, i) => {
      const key = modelKey(m);
      const failureTime = state.failures.get(key);
      const inCooldown = failureTime && Date.now() - failureTime < config.cooldownMs;
      const status = inCooldown ? "⏳" : "";
      return {
        id: `${i}|${key}`,
        label: `${i + 1}. ${key}${status}`,
        currentValue: m.name || "",
        description: [m.name, m.reasoning ? "reasoning" : ""].filter(Boolean).join(" · "),
        submenu: (_cur, d) => buildActionSubmenu(pi, ctx, rt, i, config.models.length, item => d(item), key),
      };
    });
    items.push({
      id: "-1",
      label: "⬅️ Back",
      currentValue: "",
      description: "Return to the config menu",
      submenu: (_cur, d) => d({ id: "-1" }),
    });
    return items;
  };
  return new SettingsList(
    buildItems(),
    Math.min(config.models.length + 1, 8),
    settingsTheme(currentTheme),
    () => {},
    () => done(undefined),
  );
}

// Per-model action submenu: move up/down/top/bottom, replace, remove.
function buildActionSubmenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rt: PinballRuntime,
  idx: number,
  count: number,
  done: (selected?: { id: string; label: string }) => void,
  originalKey: string,
): SettingsList {
  const actions = [
    { id: "up", label: "⬆️ Move up", description: "swap with previous" },
    { id: "down", label: "⬇️ Move down", description: "swap with next" },
    { id: "top", label: "⏫ Move to top", description: "first in the chain" },
    { id: "bottom", label: "⏬ Move to bottom", description: "last in the chain" },
    { id: "replace", label: "🔁 Replace", description: "swap for another model" },
    { id: "remove", label: "🗑️ Remove", description: "delete from the list" },
  ].filter((a) => {
    if (a.id === "up") return idx > 0;
    if (a.id === "down") return idx < count - 1;
    if (a.id === "top") return idx > 0;
    if (a.id === "bottom") return idx < count - 1;
    return true;
  });
  return new SettingsList(
    actions.map((a) => ({ id: a.id, label: a.label, currentValue: a.description, description: a.description })),
    Math.min(actions.length, 8),
    settingsTheme(currentTheme),
    (id) => {
      const item = rt.getConfig().models[idx];
      runModelAction(pi, ctx, rt, idx, count, id, () => {
        const newKey = item ? modelKey(rt.getConfig().models[idx] ?? item) : originalKey;
        done({ id: `${idx}|${newKey}`, label: newKey });
      });
    },
    () => done({ id: "", label: "" }),
  );
}

async function runModelAction(pi: ExtensionAPI, ctx: ExtensionContext, rt: PinballRuntime, idx: number, count: number, action: string, reopen: () => void) {
  const config = rt.getConfig();
  switch (action) {
    case "up": [config.models[idx - 1], config.models[idx]] = [config.models[idx], config.models[idx - 1]]; rt.saveConfig(); break;
    case "down": [config.models[idx], config.models[idx + 1]] = [config.models[idx + 1], config.models[idx]]; rt.saveConfig(); break;
    case "top": { const [moved] = config.models.splice(idx, 1); config.models.unshift(moved); rt.saveConfig(); break; }
    case "bottom": { const [moved] = config.models.splice(idx, 1); config.models.push(moved); rt.saveConfig(); break; }
    case "replace": {
      const replacement = await pickModelFromRegistry(ctx, rt);
      if (!replacement) return;
      const dupAt = config.models.findIndex((cm, i) => i !== idx && cm.provider === replacement.provider && cm.id === replacement.id);
      if (dupAt !== -1) { ctx.ui.notify(`⚠️ ${modelKey(replacement)} already at ${dupAt + 1}`, "warning"); return; }
      const old = config.models[idx];
      config.models[idx] = replacement;
      rt.saveConfig();
      ctx.ui.notify(`🔁 ${modelKey(old)} → ${modelKey(replacement)}`, "info");
      break;
    }
    case "remove": {
      const removed = config.models.splice(idx, 1)[0];
      rt.saveConfig();
      ctx.ui.notify(`🗑️ Removed ${modelKey(removed)}`, "info");
      break;
    }
  }
}

// The main config menu: one row per setting, value on the right, hint below.
async function showConfigMenuNative(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rt: PinballRuntime,
): Promise<string | undefined> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
  const ui = ctx.ui as any;
  if (typeof ui.custom !== "function") return undefined;

  const config = rt.getConfig();
  return ui.custom<string>((_tui, theme, _keybindings, done) => {
    const items = [
      {
        id: "toggle",
        label: config.enabled ? "🟢 Enabled" : "🔴 Enabled",
        currentValue: config.enabled ? "on" : "off",
        description: config.enabled ? "Auto-switch to the next model on provider errors" : "Switch auto-failover on",
        values: ["off", "on"],
      },
      {
        id: "cooldown",
        label: "⏱️ Cooldown",
        currentValue: formatDuration(config.cooldownMs),
        description: "How long a failed model rests before it's tried again",
        values: ["30s", "1m", "2m", "5m", "10m"],
      },
      {
        id: "retries",
        label: "🔁 Retries/model",
        currentValue: String(config.maxRetries),
        description: `Failover attempts per model before giving up (× ${config.models.length} models)`,
        values: ["1", "2", "3", "5", "10"],
      },
      {
        id: "notify",
        label: "🔔 Notify",
        currentValue: config.notifyOnBounce ? "on" : "off",
        description: "Pop up an alert every time pinball switches models",
        values: ["off", "on"],
      },
      {
        id: "list",
        label: "📋 Models",
        currentValue: `${config.models.length} in order`,
        description: config.models.length
          ? `Bounce priority: ${config.models.map((m, i) => `${i + 1}. ${modelKey(m)}`).join(", ")}`
          : "Add a model to fail over to",
        submenu: (_cur, d) => buildListSubmenu(pi, ctx, rt, (item) => d(item?.id ?? "-1")),
      },
      {
        id: "add",
        label: "➕ Add model",
        currentValue: "",
        description: "Choose a provider/model from pi's registry to fail over to",
      },
      {
        id: "remove",
        label: "➖ Remove model",
        currentValue: config.models.length ? "pick one" : "none",
        description: config.models.length ? "Drop a model from the bounce list" : "No models to remove",
      },
      {
        id: "test",
        label: "🧪 Test all",
        currentValue: config.models.length ? `${config.models.length} configured` : "",
        description: "Ping each model's connectivity and API key",
      },
      {
        id: "reset",
        label: "🔃 Reset",
        currentValue: "",
        description: "Clear cooldowns, retry counters and the streak",
      },
    ];
    const list = new SettingsList(
      items,
      Math.min(items.length, 8),
      settingsTheme(theme),
      (id, newValue) => applyConfigSetting(ctx, rt, id, newValue),
      () => done(undefined),
    );
    list.onSelect = (id) => done(id);
    return list;
  });
}

async function showConfigMenu(pi: ExtensionAPI, ctx: ExtensionContext, rt: PinballRuntime) {
  const id = await showConfigMenuNative(pi, ctx, rt);
  if (!id) return;
  await dispatchConfigAction(pi, ctx, rt, id);
}

// --- Legacy (non-TUI) fallback selectors ---------------------------------------

async function showSubmenu<T>(
  ctx: ExtensionContext,
  title: string,
  items: Array<{ value: T; label: string; description?: string }>,
): Promise<T | undefined> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
  const ui = ctx.ui as any;
  if (typeof ui.custom !== "function") {
    const strings = items.map((it) => it.description ? `${it.label} — ${it.description}` : it.label);
    const picked = await ui.select(title, strings);
    if (picked === undefined) return undefined;
    const idx = items.findIndex((it) => it.label === picked);
    return idx >= 0 ? items[idx].value : undefined;
  }
  // Fallback: a minimal SettingsList-based selector (no cycling/submenus).
  return ui.custom<string>((_tui, theme, _keybindings, done) => {
    const list = new SettingsList(
      items.map((it) => ({ id: String(it.value), label: it.label, currentValue: it.description ?? "", description: it.description ?? "" })),
      Math.min(items.length, 8),
      settingsTheme(theme),
      () => {},
      () => done(undefined),
    );
    list.onSelect = (id) => done(id);
    return list;
  }).then((id) => {
    if (id === undefined) return undefined;
    const idx = items.findIndex((it) => String(it.value) === id);
    return idx >= 0 ? items[idx].value : undefined;
  });
}

function selectFrom<T>(
  ctx: ExtensionContext,
  title: string,
  items: Array<{ value: T; label: string; description?: string }>
): Promise<T | undefined> {
  return showSubmenu(ctx, title, items);
}

export async function handlePinballCommand(sub: string, pi: ExtensionAPI, ctx: ExtensionContext, rt: PinballRuntime) {
  switch (sub) {
    case "status": return showStatus(ctx, rt);
    case "config": return showConfigMenu(pi, ctx, rt);
    case "list": return listModels(pi, ctx, rt);
    case "add": return addModelInteractive(ctx, rt);
    case "remove": return removeModelInteractive(ctx, rt);
    case "test": return testAllProviders(pi, ctx, rt);
    case "log": return showBounceLog(ctx, rt);
  }
}

async function showStatus(ctx: ExtensionContext, rt: PinballRuntime) {
  const config = rt.getConfig();
  const state = rt.state;
  const currentModel = ctx.model;
  const currentKey = currentModel ? modelKey(currentModel) : "unknown";
  const now = Date.now();
  let activeFailures = 0;
  for (const ts of state.failures.values()) if (now - ts < config.cooldownMs) activeFailures++;

  const lines = [
    `State: ${config.enabled ? "✅ on" : "❌ off"}`,
    `Model: ${currentKey}`,
    `List: ${config.models.length}`,
    `Retries: ${state.retryCount}/${config.maxRetries * config.models.length}`,
    `Streak: ${state.consecutiveFailures}`,
    `Cooldowns: ${activeFailures}`,
    `Cooldown: ${formatDuration(config.cooldownMs)}`,
  ];
  const original = rt.getOriginalModel();
  if (original) lines.push(`Original: ${modelKey(original)}`);
  if (state.bounceLog.length > 0) {
    const last = state.bounceLog[state.bounceLog.length - 1];
    lines.push(`Last: ${last.from} → ${last.to} (${last.reason}, ${formatDuration(Date.now() - last.timestamp)} ago)`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function pickModelFromRegistry(ctx: ExtensionContext, rt: PinballRuntime): Promise<PinballModel | undefined> {
  const allModels = ctx.modelRegistry.getAvailable();
  if (allModels.length === 0) { ctx.ui.notify("No pi models. Configure providers first.", "warning"); return undefined; }

  const byProvider = new Map<string, typeof allModels>();
  for (const m of allModels) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  const providerId = await selectFrom(ctx, "Provider", Array.from(byProvider.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([provider, models]) => ({
    value: provider,
    label: provider,
    description: `${models.length} model${models.length !== 1 ? "s" : ""}`,
  })));
  if (!providerId) return undefined;

  const config = rt.getConfig();
  const modelItems = (byProvider.get(providerId) ?? []).map((m) => {
    const added = config.models.some((cm) => cm.provider === m.provider && cm.id === m.id);
    return {
      value: { provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning },
      label: added ? `✅ ${m.id}` : m.id,
      description: [m.name !== m.id ? m.name : "", m.reasoning ? "reasoning" : "", added ? "added" : ""].filter(Boolean).join(" · "),
    };
  });
  if (modelItems.length === 0) { ctx.ui.notify("No provider models", "warning"); return undefined; }

  const selected = await selectFrom(ctx, `Model (${providerId})`, modelItems);
  if (!selected) return undefined;
  const picked: PinballModel = { provider: selected.provider, id: selected.id, reasoning: selected.reasoning };
  if (selected.name && selected.name !== selected.id) picked.name = selected.name;
  return picked;
}

async function addModelInteractive(ctx: ExtensionContext, rt: PinballRuntime) {
  const config = rt.getConfig();
  const picked = await pickModelFromRegistry(ctx, rt);
  if (!picked) return;
  if (config.models.some((m) => m.provider === picked.provider && m.id === picked.id)) {
    ctx.ui.notify(`⚠️ ${modelKey(picked)} already listed`, "warning");
    return;
  }
  config.models.push(picked);
  rt.saveConfig();
  ctx.ui.notify(`✅ Added ${modelKey(picked)}`, "info");
}

async function removeModelInteractive(ctx: ExtensionContext, rt: PinballRuntime) {
  const config = rt.getConfig();
  if (config.models.length === 0) { ctx.ui.notify("No models to remove", "warning"); return; }
  const idx = await selectFrom(ctx, "Remove model", config.models.map((m, i) => ({ value: i, label: modelKey(m), description: m.name || "" })));
  if (idx === undefined) return;
  const removed = config.models.splice(idx, 1)[0];
  rt.saveConfig();
  ctx.ui.notify(`🗑️ Removed ${modelKey(removed)}`, "info");
}

async function listModels(pi: ExtensionAPI, ctx: ExtensionContext, rt: PinballRuntime) {
  const config = rt.getConfig();
  const state = rt.state;
  while (true) {
    if (config.models.length === 0) { ctx.ui.notify("No models. Use /pinball add.", "info"); return; }
    const items = config.models.map((m, i) => {
      const key = modelKey(m);
      const failureTime = state.failures.get(key);
      const inCooldown = failureTime && Date.now() - failureTime < config.cooldownMs;
      const isOriginal = rt.getOriginalModel()?.provider === m.provider && rt.getOriginalModel()?.id === m.id;
      const status = inCooldown ? " ⏳" : isOriginal ? " ⭐" : "";
      return { value: i, label: `${i + 1}. ${key}${status}`, description: [m.name, m.reasoning ? "reasoning" : ""].filter(Boolean).join(" · ") };
    });
    items.push({ value: -1, label: "⬅️ Back", description: "exit" });

    const idx = await selectFrom(ctx, `📋 Bounce order (${config.models.length})`, items);
    if (idx === undefined || idx === -1) return;
    const model = config.models[idx];
    const actions: Array<{ value: string; label: string; description?: string }> = [];
    if (idx > 0) actions.push({ value: "up", label: "⬆️ Up", description: "swap prev" });
    if (idx < config.models.length - 1) actions.push({ value: "down", label: "⬇️ Down", description: "swap next" });
    if (idx > 0) actions.push({ value: "top", label: "⏫ Top", description: "first" });
    if (idx < config.models.length - 1) actions.push({ value: "bottom", label: "⏬ Bottom", description: "last" });
    actions.push({ value: "replace", label: "🔁 Replace", description: "other model" });
    actions.push({ value: "remove", label: "🗑️ Remove", description: "delete" });

    const action = await selectFrom(ctx, `${modelKey(model)} — action`, actions);
    if (!action) continue;
    switch (action) {
      case "up": [config.models[idx - 1], config.models[idx]] = [config.models[idx], config.models[idx - 1]]; rt.saveConfig(); break;
      case "down": [config.models[idx], config.models[idx + 1]] = [config.models[idx + 1], config.models[idx]]; rt.saveConfig(); break;
      case "top": { const [moved] = config.models.splice(idx, 1); config.models.unshift(moved); rt.saveConfig(); break; }
      case "bottom": { const [moved] = config.models.splice(idx, 1); config.models.push(moved); rt.saveConfig(); break; }
      case "replace": {
        const replacement = await pickModelFromRegistry(ctx, rt);
        if (!replacement) break;
        const dupAt = config.models.findIndex((cm, i) => i !== idx && cm.provider === replacement.provider && cm.id === replacement.id);
        if (dupAt !== -1) { ctx.ui.notify(`⚠️ ${modelKey(replacement)} already at ${dupAt + 1}`, "warning"); break; }
        const old = config.models[idx];
        config.models[idx] = replacement;
        rt.saveConfig();
        ctx.ui.notify(`🔁 ${modelKey(old)} → ${modelKey(replacement)}`, "info");
        break;
      }
      case "remove": {
        const removed = config.models.splice(idx, 1)[0];
        rt.saveConfig();
        ctx.ui.notify(`🗑️ Removed ${modelKey(removed)}`, "info");
        break;
      }
    }
  }
}

async function testProvider(pi: ExtensionAPI, ctx: ExtensionContext, rt: PinballRuntime, model: PinballModel): Promise<TestResult> {
  const start = Date.now();
  try {
    const found = ctx.modelRegistry.find(model.provider, model.id);
    if (!found) return { model, status: "Error", message: "Not in registry", latencyMs: 0 };
    const success = await pi.setModel(found);
    const original = rt.getOriginalModel();
    if (original) {
      const orig = ctx.modelRegistry.find(original.provider, original.id);
      if (orig) await pi.setModel(orig);
    }
    return { model, status: success ? "ok" : "No-key", message: success ? "Available" : "No API key; use /login/env", latencyMs: Date.now() - start };
  } catch (err) {
    return { model, status: "Error", message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

async function testAllProviders(pi: ExtensionAPI, ctx: ExtensionContext, rt: PinballRuntime) {
  const config = rt.getConfig();
  if (config.models.length === 0) { ctx.ui.notify("No models. Use /pinball add.", "warning"); return; }
  ctx.ui.notify(`🧪 Testing ${config.models.length}…`, "info");
  const results: TestResult[] = [];
  for (const model of config.models) results.push(await testProvider(pi, ctx, rt, model));
  const lines = results.map((r) => `${r.status === "ok" ? "✅" : r.status === "No-key" ? "🔑" : "❌"} ${modelKey(r.model)}: ${r.message} (${r.latencyMs}ms)`);
  const okCount = results.filter((r) => r.status === "ok").length;
  ctx.ui.notify(`🧪 Results:\n${lines.join("\n")}\n\n${okCount}/${results.length} available`, "info");
}

async function showBounceLog(ctx: ExtensionContext, rt: PinballRuntime) {
  const log = rt.state.bounceLog;
  if (log.length === 0) { ctx.ui.notify("No bounces this session", "info"); return; }
  await selectFrom(ctx, `🔄 Bounce log (${log.length})`, log.slice(-20).reverse().map((entry) => ({
    value: "",
    label: `${entry.from} → ${entry.to}`,
    description: `${entry.reason} · ${formatDuration(Date.now() - entry.timestamp)} ago`,
  })));
}
