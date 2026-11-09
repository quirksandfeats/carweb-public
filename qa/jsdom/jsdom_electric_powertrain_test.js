// The electric half of a powertrain: motor, battery and range off the infobox (9 Nov 2026).
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
let fails = 0;
const check = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const fakeCtx = () => { const noop = () => {}; return new Proxy({ measureText: () => ({ width: 10 }) }, { get(o, k) { return k in o ? o[k] : noop; }, set() { return true; } }); };
const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = fakeCtx;
window.requestAnimationFrame = () => 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "{}" });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
const shipped = JSON.parse(fs.readFileSync(path.join(APP, "llm_families.json"), "utf-8"));
// A stored read for one electric car, as the reader would leave it.
const EV = "m-renault-5-e-tech";
shipped.engineScans = Object.assign({}, shipped.engineScans, { [EV]: {
  checkedAt: "2026-11-09T00:00:00.000Z", sourceTitle: "Renault 5 E-Tech", status: "no-engines", engines: [], unlinked: [], v: 8,
  electric: { motors: ["90 kW externally-excited synchronous motor"], battery: ["52 kWh NMC"], range: ["410 km (WLTP)"], rangeKind: "electric" } } });
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") window.LLM_FAMILIES = Object.assign({}, shipped, { __serverAvailable: false });
  ev(f);
}
window.CarWeb.boot();
const LF = window.LlmFamilies;
const read = w => LF.electricMentions(w);
// An electric car's infobox.
const leaf = read(`{{Infobox automobile
| name = Nissan Leaf
| motor = 110&nbsp;kW [[Nissan EM motor|EM57]], [[synchronous motor]]<ref>a</ref>
| battery = 40 or 62&nbsp;kWh lithium-ion
| electric_range = {{unbulleted list|{{convert|259|mi|km|abbr=on}} (EPA)|{{convert|385|km|mi|abbr=on}} (WLTP)}}
| sp = uk
}}`);
check("reads the motor, in the infobox's words", leaf && leaf.motors[0] === "110 kW EM57, synchronous motor", leaf && JSON.stringify(leaf.motors));
check("reads the battery", leaf && leaf.battery[0] === "40 or 62 kWh lithium-ion", leaf && JSON.stringify(leaf.battery));
check("reads each electric range line", leaf && leaf.range.length === 2 && leaf.rangeKind === "electric" && /259 mi/.test(leaf.range[0]), leaf && JSON.stringify(leaf.range));
// Words heading a list stay with its items.
const tay = read(`| battery = 2024–present: {{ubl|89 kWh lithium-ion|105 kWh lithium-ion}}<br>2019–2024: {{ubl|79.2 kWh lithium-ion}}
| sp = us`);
check("a list's heading goes onto its items", tay && tay.battery.join(" / ") === "89 kWh lithium-ion (2024–present) / 105 kWh lithium-ion (2024–present) / 79.2 kWh lithium-ion (2019–2024)", tay && JSON.stringify(tay.battery));
// A plug-in hybrid: engine and motor both.
const phev = read(`| engine = 2.0 L [[Toyota M20A engine|M20A]] I4
| motor = 2× motor–generator
| battery = 13.6 kWh lithium-ion
| range = {{convert|600|mi|km}} (EPA)`);
check("a plug-in hybrid's motor and battery, and its range beside a battery", phev && phev.motors.length === 1 && phev.battery.length === 1 && phev.range.length === 1 && phev.rangeKind === "total", JSON.stringify(phev));
// A petrol car's range is how far a tank goes: not read.
check("no electric read off a petrol car", read(`| engine = 2.0 L I4\n| range = {{convert|500|km}}\n| sp = uk`) === null);
// A maker's name is no motor: "General Motors", "Leyland Motors".
check("an engine line naming General Motors is no electric motor", read(`| engine = [[Leyland Motors]] O.680 diesel\n| range = {{convert|600|km}}\n| sp = uk`) === null);
check("a motor written into the engine field is read: the Taycan", (read(`| engine = 2× [[Synchronous motor#Permanent-magnet|AC synchronous electric motors]]\n| battery = 93.4 kWh\n| sp = us`) || { motors: [] }).motors[0] === "2× AC synchronous electric motors");
// A field commented out is not read.
const cm = read(`| motor = PMSM\n| battery = 50 kWh<!--\n| range = -->\n| sp = uk`);
check("a commented-out field is not read, nor ends the one before it", cm && cm.battery.join() === "50 kWh" && !cm.range.length, cm && JSON.stringify(cm));
// A heading on a list's line heads that list only.
const hl = read(`| battery = 2019–2022: {{ubl|40 kWh|62 kWh}}<br>75 kWh\n| sp = uk`);
check("a list's heading stops where the list does", hl && hl.battery.join(" / ") === "40 kWh (2019–2022) / 62 kWh (2019–2022) / 75 kWh", hl && JSON.stringify(hl.battery));
// The card shows it.
const car = window.CARDATA.nodes.find(n => n.id === EV);
window.CarWeb.openDetail(car);
const power = (window.document.querySelector(".dt-power") || {}).textContent || "";
check("the card shows the electric motor, battery and range", /Electric motor/.test(power) && /52 kWh NMC/.test(power) && /410 km \(WLTP\)/.test(power) && /electric range/.test(power), power.slice(0, 300));
// A motor the engine list already names is listed there only.
const scans = LF.engineScanEntryFor(EV);
scans.unlinked = [{ name: "90 kW EESM", said: "90 kW externally-excited synchronous motor", specs: {} }];
window.CarWeb.openDetail(car);
const power2 = (window.document.querySelector(".dt-power") || {}).textContent || "";
check("a motor already in the engine list is not shown twice", /Engine/.test(power2) && !/externally-excited synchronous motor motor/.test(power2) && /52 kWh NMC/.test(power2), power2.slice(0, 300));
// A read set aside as another car's shows no electric fold.
scans.unlinked = []; scans.v = 0; scans.staleReason = "another car's page";
window.CarWeb.openDetail(car);
check("a read set aside shows nothing", !/Electric motor/.test((window.document.querySelector(".dt-power") || {}).textContent || ""));
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
