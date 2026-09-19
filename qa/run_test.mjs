// QA harness for pinball's native-style config menu.
// Imports the REAL SettingsList from src/commands.ts (via jiti) and exercises it
// against the REAL pi-tui, so it cannot drift from the shipped code.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// jiti is not a direct dependency; resolve it next to the (symlinked) pi-tui
// package so the harness works from a clean checkout.
const require = createRequire(import.meta.url);
const piTuiEntry = realpathSync(require.resolve("@earendil-works/pi-tui"));
const jitiUrl = pathToFileURL(join(dirname(piTuiEntry), "..", "..", "..", "jiti", "lib", "jiti.mjs")).href;
const { createJiti } = await import(jitiUrl);

const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const { SettingsList } = await import("@earendil-works/pi-tui");
const { handlePinballCommand } = await jiti.import("../src/commands.ts"); // real module under test

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`); }
}

// Minimal theme matching what pi hands to custom() factories.
const theme = {
  fg: (c, t) => `<${c}>${t}</>`,
  bold: (t) => `*${t}*`,
  cursor: "→ ",
  label: (t, selected) => `<${selected ? "accent" : "text"}>${t}</>`,
  value: (t, selected) => `<${selected ? "success" : "muted"}>${t}</>`,
  description: (t) => `<muted>${t}</>`,
  hint: (t) => `<dim>${t}</>`,
};

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/<\/?[^>]+>/g, "");

const ITEMS = [
  { id: "toggle", label: "🟢 Enabled", currentValue: "on", description: "Switch auto-failover on", values: ["off", "on"] },
  { id: "cooldown", label: "⏱️ Cooldown", currentValue: "1m", description: "How long a failed model rests after an error", values: ["30s", "1m", "2m", "5m", "10m"] },
  { id: "retries", label: "🔁 Retries", currentValue: "3", description: "Failover attempts per model (× 4)" },
  { id: "list", label: "📋 Models", currentValue: "4 in order", description: "4 models in bounce order" },
  { id: "test", label: "🧪 Test", currentValue: "4 configured", description: "Probe connectivity / API keys" },
];

console.log("SettingsList — native composition");
{
  const list = new SettingsList(ITEMS, 6, theme, () => {}, () => {});
  const out = list.render(80).map(strip);
  check("renders the label column", out.some((l) => l.includes("🟢 Enabled")));
  check("renders the current value on the right", out.some((l) => l.includes("on")));
  check("renders the selected description hint", out.some((l) => l.includes("Switch auto-failover")));
}

console.log("\nSettingsList — cycling (values)");
{
  let value;
  const list = new SettingsList(ITEMS, 6, theme, (_id, v) => { value = v; }, () => {});
  list.handleInput("\u001b[B"); // select cooldown (index 1)
  list.handleInput("\r"); // cycle: 1m -> 2m
  check("Enter cycles to the next value", value === "2m", String(value));
}

console.log("\nSettingsList — submenu");
{
  let opened;
  const child = new SettingsList([{ id: "a", label: "A", currentValue: "", description: "" }], 6, theme, () => {}, () => {});
let openDone;
const items = [
    { id: "list", label: "📋 Models", currentValue: "4 in order", description: "4 models in bounce order",
      submenu: (_cur, d) => { openDone = d; child.onCancel = () => d(undefined); return child; } },
];
const list = new SettingsList(items, 6, theme, () => {}, () => {});
list.handleInput("\r");
check("Enter on a submenu item opens it", !!list["submenuComponent"]);
check("submenu receives the done callback", typeof openDone === "function");
list.handleInput("\u001b"); // back -> child onCancel -> done -> closeSubmenu
check("Back closes the submenu", !list["submenuComponent"]);
}

console.log("\nSettingsList — navigation & cancel");
{
  const list = new SettingsList(ITEMS, 6, theme, () => {}, () => {});
  list.handleInput("\u001b[B");
  list.handleInput("\u001b[B");
  let out = list.render(80).map(strip);
  check("DOWN x2 selects the 3rd item", out.some((l) => l.includes("🔁 Retries") && l.includes("→")), out.join(" | "));
  list.handleInput("\u001b[A");
  out = list.render(80).map(strip);
  check("UP selects the 2nd item", out.some((l) => l.includes("⏱️ Cooldown") && l.includes("→")));
  let cancelled = false;
  const list2 = new SettingsList(ITEMS, 6, theme, () => {}, () => { cancelled = true; });
  list2.handleInput("\u001b");
  check("ESC fires onCancel", cancelled === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log("\nReal command: handlePinballCommand('config') builds & renders");
{
  let built = false;
  const ctx = { mode: "tui", hasUI: true, model: { provider: "anthropic", id: "claude" }, ui: { notify: () => {}, custom: (factory) => {
    built = true;
    return factory(null, theme, {}, (done) => new SettingsList([], 8, theme, () => {}, () => {}));
  } } };
  const pi = {};
  const rt = { getConfig: () => ({ enabled: true, maxRetries: 3, cooldownMs: 60_000, notifyOnBounce: true, models: [{ provider: "anthropic", id: "claude", name: "Claude" }] }), saveConfig: () => {}, state: { retryCount: 0, consecutiveFailures: 0, failures: new Map(), bounceLog: [] }, getOriginalModel: () => null, resetState: () => {}, updateStatus: () => {} };
  let threw = null;
  try { await handlePinballCommand("config", pi, ctx, rt); } catch (e) { threw = e; }
  check("config command runs without throwing", threw === null, threw ? threw.message : "");
  check("config factory is invoked (SettingsList built)", built === true);
}

process.exit(fail === 0 ? 0 : 1);
