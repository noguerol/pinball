// Adversarial QA harness for pinball's native-style config submenu.
// Imports the REAL classes from src/commands.ts (via jiti) and exercises them
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
const { DescribedSelectList, ConfigSubmenu } = await jiti.import("../src/commands.ts");

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
};
const listTheme = {
  selectedPrefix: (t) => theme.fg("accent", t),
  selectedText: (t) => theme.fg("accent", t),
  description: (t) => theme.fg("muted", t),
  scrollInfo: (t) => theme.fg("muted", t),
  noMatch: (t) => theme.fg("muted", t),
};

const ITEMS = [
  { value: "toggle", label: "🟢 Disable", description: "Switch auto-failover off" },
  { value: "list", label: "📋 Models", description: "4 models in bounce order" },
  { value: "add", label: "➕ Add", description: "Choose a provider/model to fail over to" },
  { value: "remove", label: "➖ Remove", description: "Drop a model from the bounce list" },
  { value: "test", label: "🧪 Test", description: "Probe connectivity / API keys" },
  { value: "cooldown", label: "⏱️ Cooldown: 1m", description: "How long a failed model rests after an error" },
  { value: "retries", label: "🔁 Retries: 3", description: "Failover attempts per model (× 4)" },
  { value: "notify", label: "🔔 Notify: on", description: "Pop up alerts when switching models" },
  { value: "reset", label: "🔃 Reset", description: "Clear cooldowns and retry counters" },
];

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const makeSubmenu = (onSelect = () => {}, onCancel = () => {}, items = ITEMS) =>
  new ConfigSubmenu({ title: "🔄 Pinball", items, hint: "  Enter to select · Esc to go back" }, onSelect, onCancel, theme);

console.log("DescribedSelectList — descriptions must render at ANY width");
for (const w of [20, 30, 40, 41, 44, 60, 80, 120]) {
  const list = new DescribedSelectList(ITEMS.slice(0, 3), 6, listTheme, {});
  const lines = list.render(w).map(strip);
  const shown = ITEMS.slice(0, 3).filter((it) =>
    lines.some((l) => l.includes(it.description.slice(0, Math.min(12, it.description.length)))),
  ).length;
  check(`width=${w} renders 3/3 descriptions`, shown === 3, `got ${shown}`);
}

console.log("\nDescribedSelectList — narration / selection");
{
  const list = new DescribedSelectList(ITEMS.slice(0, 3), 6, listTheme, {});
  list.handleInput("\u001b[B");
  list.handleInput("\u001b[B");
  const lines = list.render(80).map(strip);
  check("DOWN x2 selects the 3rd item", lines[4].includes("→") && lines[4].includes("➕ Add"), lines[4]);
  list.handleInput("\u001b[B");
  check("DOWN wraps to first item", strip(list.render(80)[0]).includes("→ 🟢"), strip(list.render(80)[0]));
  list.handleInput("\u001b[A");
  check("UP wraps to last item", strip(list.render(80)[4]).includes("→ ➕"), strip(list.render(80)[4]));
}
{
  const list = new DescribedSelectList(ITEMS, 6, listTheme, {});
  list.setSelectedIndex(5);
  const sel = list.render(80).map(strip).find((l) => l.includes("→"));
  check("setSelectedIndex(5) moves the cursor", !!sel && sel.includes("⏱️ Cooldown"), String(sel));
}
{
  const list = new DescribedSelectList(ITEMS, 6, listTheme, {});
  const out = list.render(80).map(strip);
  check("scroll indicator shown when items > maxVisible", out.some((l) => /\(\d+\/\d+\)/.test(l)));
}
{
  const list = new DescribedSelectList([], 6, listTheme, {});
  check("empty list renders the no-match notice", list.render(80)[0].includes("No matching commands"));
}

console.log("\nConfigSubmenu — full composition");
{
  const menu = makeSubmenu();
  const out = menu.render(80).map(strip);
  check("renders the title", out[0].includes("🔄 Pinball"), out[0]);
  check("renders every description", ITEMS.slice(0, 6).every((it) => out.some((l) => l.includes(it.description.slice(0, 10)))));
  check("renders the hint", out.some((l) => l.includes("Enter to select")));
}
{
  // Descriptions must survive a narrow terminal (the original bug).
  const out = makeSubmenu().render(24).map(strip);
  const withDesc = ITEMS.slice(0, 6).filter((it) => out.some((l) => l.includes(it.description.slice(0, 8)))).length;
  check("descriptions survive width=24", withDesc >= 4, `got ${withDesc}/6`);
}
{
  let selected;
  const menu = makeSubmenu((v) => { selected = v; });
  menu.handleInput("\u001b[B");
  menu.handleInput("\r");
  check("ENTER fires onSelect with the highlighted value", selected === ITEMS[1].value, String(selected));
}
{
  let cancelled = false;
  const menu = makeSubmenu(() => {}, () => { cancelled = true; });
  menu.handleInput("\u001b");
  check("ESC fires onCancel", cancelled === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
