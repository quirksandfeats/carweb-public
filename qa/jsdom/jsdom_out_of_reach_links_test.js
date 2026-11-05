// A link between cars too far apart in years to share anything: settleOutOfReachLinks.
// The car whose article gave the name stays; the car it named can be the wrong one.
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
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (/llm_families_data/.test(f)) continue;
  if (f === "llm_families.js") window.LLM_FAMILIES = Object.assign({}, shipped, { __serverAvailable: false });
  ev(f);
}
window.CarWeb.boot();
const LF = window.LlmFamilies, DATA = window.CARDATA;
const idOf = v => (typeof v === "string" ? v : v.id);
const pair = (ls, a, b, type = "platform") => ls.filter(l => !l.retired && l.type === type &&
  ((idOf(l.source) === a && idOf(l.target) === b) || (idOf(l.source) === b && idOf(l.target) === a)));

// Each case in its own small graph, so one rule is seen at a time.
const car = (id, make, label, year, end, more) => Object.assign({ id, type: "model", make, label, year, end }, more);
const plate = (id, make, label, year, end, generations) => ({ id, type: "family", make, label, year, end, generations });
const run = (nodes, source, target, type = "platform") => {
  const links = [{ source, target, type }];
  LF.settleOutOfReachLinks(nodes, links);
  return links;
};

let ls = run([
  car("t-nav", "Lincoln", "Navigator", 2018, 2024, { sharedPlatformTexts: ["Ford F-Series"] }),
  plate("t-f", "Ford", "F-Series", 1947, null, ["t-f1", "t-f13", "t-f14"]),
  car("t-f1", "Ford", "F-Series (first generation)", 1947, 1952, { familyOf: "t-f" }),
  car("t-f13", "Ford", "F-Series (thirteenth generation)", 2015, 2020, { familyOf: "t-f" }),
  car("t-f14", "Ford", "F-Series (fourteenth generation)", 2020, null, { familyOf: "t-f" }),
], "t-nav", "t-f1");
check("the generation built when this car started takes the link", pair(ls, "t-nav", "t-f13").length === 1);
check("the wrong era's link goes", pair(ls, "t-nav", "t-f1").length === 0);

ls = run([
  car("t-ave", "Jeep", "Avenger", 2022, null, { sharedPlatformTexts: ["Fiat 600"] }),
  car("t-600a", "Fiat", "600", 1955, 1969),
  car("t-600b", "Fiat", "600 (2023)", 2023, null),
], "t-ave", "t-600a");
check("a car of that make and name built alongside takes it", pair(ls, "t-ave", "t-600b").length === 1 && pair(ls, "t-ave", "t-600a").length === 0);

ls = run([
  car("t-qx", "Infiniti", "QX56", 2004, 2010, { sharedPlatformTexts: ["Nissan Armada"] }),
  car("t-ma", "Mahindra", "Armada", 1980, 1990),
  car("t-na", "Nissan", "Armada", 2003, 2015),
], "t-qx", "t-ma");
check("the make the article wrote wins over another make's car of that name", pair(ls, "t-qx", "t-na").length === 1);

ls = run([
  car("t-qi", "BAW", "Qishi", 2009, 2014, { sharedPlatformTexts: ["Jeep Wagoneer"] }),
  plate("t-w", "Jeep", "Wagoneer", 1963, null, ["t-wx", "t-ws"]),
  car("t-wx", "Jeep", "Wagoneer XJ", 1983, 1990, { familyOf: "t-w" }),
  car("t-ws", "Jeep", "Wagoneer (WS)", 2022, null, { familyOf: "t-w" }),
], "t-qi", "t-wx");
check("never a later car with no years in common: the nameplate instead", pair(ls, "t-qi", "t-w").length === 1 && pair(ls, "t-qi", "t-ws").length === 0);

ls = run([
  car("t-c", "Renault", "Clio X60", 2025, null, { familyOf: "t-cf", sharedPlatformTexts: ["Mitsubishi Grandis"] }),
  car("t-c2", "Renault", "Clio X65", 1998, 2012, { familyOf: "t-cf" }),
  plate("t-cf", "Renault", "Clio", 1990, null, ["t-c", "t-c2"]),
  car("t-g", "Mitsubishi", "Grandis", 2003, 2011),
], "t-c", "t-g");
check("the generation whose article gave the name is not swapped for another", pair(ls, "t-c2", "t-g").length === 0 && pair(ls, "t-cf", "t-g").length === 1);

const siblings = [
  car("t-j1", "Citroen", "Jumpy First", 1994, 2007, { familyOf: "t-j" }),
  car("t-j3", "Citroen", "Jumpy Third", 2016, null, { familyOf: "t-j", sharedPlatformTexts: ["Peugeot 806"] }),
  plate("t-j", "Citroen", "Jumpy", 1994, null, ["t-j1", "t-j3"]),
  car("t-806", "Peugeot", "806", 1994, 2002),
];
ls = [{ source: "t-j1", target: "t-806", type: "platform" }, { source: "t-j3", target: "t-806", type: "platform" }];
LF.settleOutOfReachLinks(siblings, ls);
check("a sibling already linked is enough", pair(ls, "t-j1", "t-806").length === 1 && pair(ls, "t-j3", "t-806").length === 0 && pair(ls, "t-j", "t-806").every(l => l.mirror));

ls = run([
  car("t-tipo", "Fiat", "Tipo (2015)", 2015, 2026, { sharedPlatformTexts: ["Morris Oxford Series III"] }),
  car("t-ox3", "Morris", "Oxford Series III", 1956, 1959, { familyOf: "t-ox" }),
  car("t-ox6", "Morris", "Oxford Series VI", 2010, 2020, { familyOf: "t-ox" }),
  plate("t-ox", "Morris", "Oxford", 1948, 2020, ["t-ox3", "t-ox6"]),
], "t-tipo", "t-ox3");
check("a generation named in full is not swapped for its sibling", pair(ls, "t-tipo", "t-ox3").length === 1 && pair(ls, "t-tipo", "t-ox6").length === 0);

ls = run([car("t-le", "Ecurie Ecosse", "LM69", 2019, null), car("t-xj", "Jaguar", "XJ13", 1966, 1966)], "t-le", "t-xj", "related");
check("two plain cars with nothing better stay: a tribute is a real link", pair(ls, "t-le", "t-xj", "related").length === 1);

ls = run([
  car("t-a", "Fiat", "Uno", 2010, 2021, { sharedPlatformTexts: ["FireFly"] }),
  car("t-b", "Alvis", "Firefly", 1932, 1934),
], "t-a", "t-b");
check("a bare word on another make's car goes", pair(ls, "t-a", "t-b").length === 0);

ls = run([car("t-n1", "BMW", "F30", 2012, 2019), car("t-n2", "BMW", "E36", 1990, 2000)], "t-n1", "t-n2");
check("within reach nothing moves: a 2012 car can sit on a platform from 2000", pair(ls, "t-n1", "t-n2").length === 1);

// The shipped graph.
const N = id => DATA.nodes.find(n => n.id === id);
const nameOf = n => n.make + " " + n.label;
const linksOf = id => DATA.links.filter(l => !l.retired && !l.mirror && l.type === "platform" && (idOf(l.source) === id || idOf(l.target) === id))
  .map(l => nameOf(N(idOf(l.source) === id ? idOf(l.target) : idOf(l.source))));
const nav = linksOf("llm-m-lincoln-navigator-fourth-generation-2018");
check("the Navigator sits on the thirteenth F-Series", nav.some(s => /F-Series \(thirteenth/.test(s)) && !nav.some(s => /F-Series \(first/.test(s)), nav.join("; "));
const ave = linksOf("m-jeep-avenger");
check("the Avenger's Fiat 600 is the 2023 one", ave.includes("Fiat 600 (2023)") && !ave.includes("Fiat 600"));
const far = (a, b) => Math.max(a.year - (b.end == null ? 9999 : b.end), b.year - (a.end == null ? 9999 : a.end));
const carsFar = DATA.links.filter(l => !l.retired && !l.mirror && (l.type === "platform" || l.type === "related")).filter(l => {
  const a = N(idOf(l.source)), b = N(idOf(l.target));
  return a && b && !a.retired && !b.retired && a.year != null && b.year != null && !a.familyOf && !b.familyOf && far(a, b) > 10;
});
check("what is left apart joins nameplates or plain cars", carsFar.length <= 75, carsFar.length);
const pinned = DATA.links.filter(l => !l.retired && !l.mirror && (l.type === "platform" || l.type === "related")).filter(l => {
  const a = N(idOf(l.source)), b = N(idOf(l.target));
  return a && b && !a.retired && !b.retired && a.year != null && b.year != null && (a.familyOf || b.familyOf) && far(a, b) > 10;
});
check("generations left apart are few", pinned.length <= 10, pinned.map(l => nameOf(N(idOf(l.source))) + " ~ " + nameOf(N(idOf(l.target)))).join("; "));

// A live pass, as a scan makes, changes nothing further.
const liveCount = () => DATA.links.filter(l => !l.retired && (l.type === "platform" || l.type === "related")).length;
const before = liveCount();
LF.applyResolvedRelations(DATA.nodes, DATA.links, { deferDecisions: true });
check("another pass of the relations settles nothing new", liveCount() === before, before + " -> " + liveCount());
const added = { source: "m-jeep-avenger", target: "m-lancia-gamma", type: "platform" };
DATA.links.push(added);
LF.applyResolvedRelations(DATA.nodes, DATA.links, { deferDecisions: true });
check("a link a live pass brings in is settled too", added.retired === true);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
