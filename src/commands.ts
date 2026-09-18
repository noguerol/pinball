import { Container, SelectList, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SelectItem<T> { value: T; label: string; description?: string }
interface ListTheme {
  selectedPrefix: (t: string) => string;
  selectedText: (t: string) => string;
  description: (t: string) => string;
  scrollInfo: (t: string) => string;
  noMatch: (t: string) => string;
}

// pi-tui's SelectList only renders item descriptions when `width > 40` and the
// space left after the label column exceeds 10 cells, so descriptions silently
// vanish on narrow terminals. This subclass keeps SelectList's key handling but
// renders every option on two lines (label + muted description) at any width,
// matching pi's built-in settings menu.
export class DescribedSelectList extends SelectList {
  private readonly sourceItems: Array<SelectItem<string>>;
  private readonly visibleCount: number;
  private readonly listTheme: ListTheme;
  private cursor = 0;

  constructor(items: Array<SelectItem<string>>, maxVisible: number, theme: ListTheme, layout?: object) {
    super(items as never, maxVisible, theme as never, layout as never);
    this.sourceItems = items;
    this.visibleCount = maxVisible;
    this.listTheme = theme;
    // Mirror the base list's cursor so we can render our own two-line rows.
    this.onSelectionChange = (item) => {
      const picked = item as SelectItem<string> | undefined;
      if (!picked) return;
      let i = this.sourceItems.indexOf(picked);
      if (i < 0) i = this.sourceItems.findIndex((it) => it.value === picked.value && it.label === picked.label);
      if (i >= 0) this.cursor = i;
    };
  }

  setSelectedIndex(index: number) {
    super.setSelectedIndex(index);
    this.cursor = Math.max(0, Math.min(index, this.sourceItems.length - 1));
  }

  render(width: number): string[] {
    const items = this.sourceItems;
    const theme = this.listTheme;
    if (items.length === 0) return [theme.noMatch("  No matching commands")];

    const total = items.length;
    const maxVisible = Math.max(1, Math.min(this.visibleCount, total));
    const selected = Math.min(Math.max(0, this.cursor), total - 1);
    const startIndex = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, total);
    const w = Math.max(12, width);

    const lines: string[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      const item = items[i];
      const isSelected = i === selected;
      const prefix = isSelected ? "\u2192 " : "  ";
      const label = truncateToWidth(item.label || String(item.value), Math.max(1, w - 2), "\u2026");
      lines.push(isSelected ? theme.selectedText(`${prefix}${label}`) : `${prefix}${label}`);
      if (item.description) {
        const desc = truncateToWidth(item.description.replace(/\s+/g, " ").trim(), Math.max(1, w - 4), "\u2026");
        lines.push(`  ${theme.description(desc)}`);
      }
    }
    if (startIndex > 0 || endIndex < total) {
      lines.push(theme.scrollInfo(`  (${selected + 1}/${total})`));
    }
    return lines;
  }
}

// Native-style submenu: a titled list where each option shows a muted
// description line beneath it, exactly like pi's built-in settings menu.
interface MenuOptions {
  title: string;
  description?: string;
  items: Array<SelectItem<string>>;
  hint?: string;
}
export class ConfigSubmenu extends Container {
  private list: SelectList;
  private items: Array<SelectItem<string>>;
  private onSelectCb?: (value: string | undefined) => void;
  private onCancelCb?: () => void;

  constructor(opts: MenuOptions, onSelect, onCancel, theme) {
    super();
    this.items = opts.items;
    this.onSelectCb = onSelect as (value: string | undefined) => void;
    this.onCancelCb = onCancel;
    // Title
    this.addChild(new Text(theme.bold(theme.fg("accent", opts.title)), 0, 0));
    // Description line
    if (opts.description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", opts.description), 0, 0));
    }
    // Select list (two lines per option: label + muted description)
    this.addChild(new Spacer(1));
    this.list = new DescribedSelectList(
      this.items.map((it) => ({ value: it.label, label: it.label, description: it.description })),
      Math.min(this.items.length, 6),
      {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("muted", t),
        noMatch: (t: string) => theme.fg("muted", t),
      },
      { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 },
    );
    this.list.onSelect = (item) => {
      const idx = this.items.findIndex((it) => it.label === item?.value);
      this.onSelectCb?.(idx >= 0 ? this.items[idx].value : undefined);
    };
    this.list.onCancel = () => this.onCancelCb?.();
    this.addChild(this.list);
    // Hint
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", opts.hint ?? "  Enter to select · Esc to go back"), 0, 0));
  }
  handleInput(data: string) {
    // SelectList already matches tui.select.up/down/confirm/cancel against the
    // live keybindings. Forward raw input directly; fall back to vi-style
    // k/j only when the terminal delivered an unmapped single char.
    if (data === "k" || data === "j") {
      this.list.handleInput(data === "k" ? "\u001b[A" : "\u001b[B");
    } else {
      this.list.handleInput(data);
    }
  }
}

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

function modelKey(m: { provider: string; id: string }) { return `${m.provider}/${m.id}`; }
function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

// Renders a native-style submenu and resolves with the chosen value.
// Each option displays a muted description line beneath its label,
// exactly like pi's built-in settings menu.
async function showSubmenu<T>(
  ctx: ExtensionContext,
  opts: MenuOptions,
): Promise<T | undefined> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
  const ui = ctx.ui as any;
  if (typeof ui.custom !== "function") {
    // Fallback to the built-in selector (no per-line descriptions).
    const strings = opts.items.map((it) => it.description ? `${it.label} — ${it.description}` : it.label);
    const picked = await ui.select(opts.title, strings);
    if (picked === undefined) return undefined;
    const idx = opts.items.findIndex((it) => it.label === picked);
    return (idx >= 0 ? opts.items[idx].value : undefined) as T;
  }
  return ui.custom<string>((_tui, theme, _keybindings, done) => {
    return new ConfigSubmenu<T>(opts, (v) => done(v as string), () => done(undefined), theme);
  });
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

function selectFrom<T>(
  ctx: ExtensionContext,
  title: string,
  items: Array<{ value: T; label: string; description?: string }>
): Promise<T | undefined> {
  return showSubmenu(ctx, {
    title,
    items: items.map((it) => ({ value: String(it.value), label: it.label, description: it.description })),
  }).then((picked) => {
    if (picked === undefined) return undefined;
    const idx = items.findIndex((it) => String(it.value) === picked);
    return idx >= 0 ? items[idx].value : undefined;
  });
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

async function showConfigMenu(pi: ExtensionAPI, ctx: ExtensionContext, rt: PinballRuntime) {
  const config = rt.getConfig();
  const action = await selectFrom(ctx, "🔄 Pinball", [
    { value: "toggle", label: config.enabled ? "🟢 Disable" : "🔴 Enable", description: config.enabled ? "Switch auto-failover off" : "Switch auto-failover on" },
    { value: "list", label: "📋 Models", description: `${config.models.length} models in bounce order` },
    { value: "add", label: "➕ Add", description: "Choose a provider/model to fail over to" },
    { value: "remove", label: "➖ Remove", description: "Drop a model from the bounce list" },
    { value: "test", label: "🧪 Test", description: "Probe connectivity / API keys" },
    { value: "cooldown", label: `⏱️ Cooldown: ${formatDuration(config.cooldownMs)}`, description: "How long a failed model rests after an error" },
    { value: "retries", label: `🔁 Retries: ${config.maxRetries}`, description: `Failover attempts per model (× ${config.models.length})` },
    { value: "notify", label: `🔔 Notify: ${config.notifyOnBounce ? "on" : "off"}`, description: "Pop up alerts when switching models" },
    { value: "reset", label: "🔃 Reset", description: "Clear cooldowns and retry counters" },
  ]);
  if (!action) return;

  switch (action) {
    case "toggle":
      config.enabled = !config.enabled; rt.saveConfig(); ctx.ui.notify(`pinball: ${config.enabled ? "on" : "off"}`, "info"); rt.updateStatus(ctx); break;
    case "list": await listModels(pi, ctx, rt); break;
    case "add": await addModelInteractive(ctx, rt); break;
    case "remove": await removeModelInteractive(ctx, rt); break;
    case "test": await testAllProviders(pi, ctx, rt); break;
    case "cooldown": {
      const picked = await selectFrom(ctx, "Cooldown", [
        { value: 30_000, label: "30s" }, { value: 60_000, label: "1m" }, { value: 120_000, label: "2m" },
        { value: 300_000, label: "5m" }, { value: 600_000, label: "10m" },
      ]);
      if (picked !== undefined) { config.cooldownMs = picked; rt.saveConfig(); ctx.ui.notify(`Cooldown: ${formatDuration(config.cooldownMs)}`, "info"); }
      break;
    }
    case "retries": {
      const picked = await selectFrom(ctx, "Retries/model", [
        { value: 1, label: "1" }, { value: 2, label: "2" }, { value: 3, label: "3" }, { value: 5, label: "5" }, { value: 10, label: "10" },
      ]);
      if (picked !== undefined) { config.maxRetries = picked; rt.saveConfig(); ctx.ui.notify(`Retries: ${config.maxRetries}`, "info"); }
      break;
    }
    case "notify":
      config.notifyOnBounce = !config.notifyOnBounce; rt.saveConfig(); ctx.ui.notify(`Notify: ${config.notifyOnBounce ? "on" : "off"}`, "info"); break;
    case "reset":
      rt.state.failures.clear(); rt.state.retryCount = 0; rt.state.consecutiveFailures = 0; rt.state.gaveUp = false;
      ctx.ui.notify("pinball: reset", "info"); rt.updateStatus(ctx); break;
  }
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
    const original = rt.getOriginalModel();
    const items = config.models.map((m, i) => {
      const key = modelKey(m);
      const failureTime = state.failures.get(key);
      const inCooldown = failureTime && Date.now() - failureTime < config.cooldownMs;
      const isOriginal = original?.provider === m.provider && original?.id === m.id;
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
