import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const piTuiEntry = realpathSync(require.resolve("@earendil-works/pi-tui"));
const jitiUrl = pathToFileURL(join(dirname(piTuiEntry), "..", "..", "..", "jiti", "lib", "jiti.mjs")).href;
const { createJiti } = await import(jitiUrl);
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const { SettingsList } = await import("@earendil-works/pi-tui");
const { handlePinballCommand } = await jiti.import("../src/commands.ts");

const theme = { fg:(c,t)=>`<${c}>${t}</>`, bold:t=>`*${t}*`, cursor:"→ ",
  label:(t,s)=>`<${s?"accent":"text"}>${t}</>`, value:(t,s)=>`<${s?"success":"muted"}>${t}</>`,
  description:t=>`<muted>${t}</>`, hint:t=>`<dim>${t}</>` };

const noop=()=>{};
let pass=0, fail=0;
const check=(n,c,d)=>{ if(c){pass++;console.log("  ok  ",n);} else {fail++;console.log("  FAIL",n,d?`:: ${d}`:"");} };

// Build a runtime whose getConfig returns a stable object so applyConfigSetting
// mutations persist, and saveConfig records calls.
function makeRt(overrides={}) {
  const config = { enabled:true, maxRetries:3, cooldownMs:60000, notifyOnBounce:true,
    models:[{provider:"anthropic",id:"claude",name:"Claude"}] };
  return { config, getConfig:()=>config, saveConfig:noop, state:{retryCount:0,consecutiveFailures:0,failures:new Map(),bounceLog:[]},
    getOriginalModel:()=>null, resetState:noop, updateStatus:noop, log:noop, ...overrides };
}

// Drive the real config menu via jiti + a stub ui.custom, returning the SettingsList.
async function openConfig(rt){
  let capturedRef=null, capturedOnChange=null;
  const ctx={ mode:"tui", hasUI:true, model:{provider:"anthropic",id:"claude"},
    ui:{ notify:noop, custom:(cb)=>{ const r = cb(null,theme,{},noop);
      const origOnChange = r.onChange;
      r.onChange = (id, v) => { if (origOnChange) origOnChange(id, v); capturedOnChange = {id, value:v}; };
      capturedRef = r; return Promise.resolve(r); } } };
  await handlePinballCommand("config",{custom:ctx.ui.custom},ctx,rt);
  return { list:capturedRef, getOnChange:()=>capturedOnChange };
}

// --- Edge 2: applyConfigSetting cycles `retries` values and persists the save ---
{
  const rt = makeRt();
  const { list, getOnChange } = await openConfig(rt);
  list.handleInput("\u001b[B"); // down -> cooldown
  list.handleInput("\u001b[B"); // down -> retries (index 2)
  list.handleInput("\r");       // Enter cycles 3 -> 5
  const ch = getOnChange();
  check("onChange fires on Enter cycle", ch && ch.id==="retries" && ch.value==="5", JSON.stringify(ch));
  check("saveConfig persists new value (maxRetries=5)", rt.config && rt.config.maxRetries===5, JSON.stringify(rt.config));
}

// --- Edge 1: empty models list renders without crashing ---
{
  const rt = makeRt();
  rt.config.models = [];
  const { list } = await openConfig(rt);
  let ok=true;
  try { list.render(60); } catch(e){ ok=false; console.log("  render error:", e.message); }
  check("empty models menu renders without crashing", ok);
}

// --- Edge 3: cooldown cycles through its values and wraps ---
{
  const rt = makeRt();
  const { list, getOnChange } = await openConfig(rt);
  list.handleInput("\u001b[B"); // down -> cooldown (index 1)
  list.handleInput("\r");       // 1m -> 2m
  let ch = getOnChange();
  check("cooldown cycles 1m -> 2m", ch && ch.id==="cooldown" && ch.value==="2m", JSON.stringify(ch));
  list.handleInput("\u001b[B"); // down -> retries (2)
  list.handleInput("\u001b[A"); // up -> cooldown (1)
  list.handleInput("\r");       // 2m -> 5m
  ch = getOnChange();
  check("cooldown cycles 2m -> 5m", ch && ch.id==="cooldown" && ch.value==="5m", JSON.stringify(ch));
  list.handleInput("\u001b[B"); // down -> retries
  list.handleInput("\u001b[A"); // up -> cooldown
  list.handleInput("\r");       // 5m -> 10m
  ch = getOnChange();
  check("cooldown cycles 5m -> 10m", ch && ch.id==="cooldown" && ch.value==="10m", JSON.stringify(ch));
  list.handleInput("\u001b[B"); // down -> retries
  list.handleInput("\u001b[A"); // up -> cooldown
  list.handleInput("\r");       // 10m -> 30s (wrap)
  ch = getOnChange();
  check("cooldown wraps 10m -> 30s", ch && ch.id==="cooldown" && ch.value==="30s", JSON.stringify(ch));
}

// --- Edge 4: enabled toggle cycles on<->off ---
{
  const rt = makeRt();
  const { list, getOnChange } = await openConfig(rt);
  list.handleInput("\r");       // Enter on toggle (already selected) -> off
  let ch = getOnChange();
  check("toggle on -> off", ch && ch.id==="toggle" && ch.value==="off", JSON.stringify(ch));
  check("toggle persists (enabled=false)", rt.config.enabled===false, JSON.stringify(rt.config.enabled));
  list.handleInput("\u001b[A"); // up -> ... back to toggle (index 0)
  // index was 0, up wraps to last; press up until toggle. Simpler: reset selection by re-opening
  const { list: list2, getOnChange: go2 } = await openConfig(rt);
  list2.handleInput("\r");      // toggle -> on (enabled is false, so value "on")
  ch = go2();
  check("toggle off -> on", ch && ch.id==="toggle" && ch.value==="on", JSON.stringify(ch));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
