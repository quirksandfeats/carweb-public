// Separate cars that carry one name are linked by it, from Wikipedia's index of the
// name (scripts/shared_names.js, app/shared_names.js; 8 Nov 2026). The Ford Capri
// lists the Capri (Australia), the Capri EV and the Lincoln Capri; the Chevrolet
// Blazer page only lists Blazers, and is shown as the name.
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
const DATA = window.CARDATA;
const idOf = v => (typeof v === "string" ? v : v.id);
const N = id => DATA.nodes.find(n => n.id === id);
const live = id => !!N(id) && !N(id).retired;
const ends = (l, a, b) => (idOf(l.source) === a && idOf(l.target) === b) || (idOf(l.source) === b && idOf(l.target) === a);
const linked = (a, b, type) => DATA.links.some(l => !l.retired && l.type === type && ends(l, a, b));
const nameLink = (a, b) => DATA.links.find(l => !l.retired && l.type === "name" && ends(l, a, b));
const gens = id => DATA.nodes.filter(n => !n.retired && n.familyOf === id);
const S = window.SHARED_NAMES || {};
check("the list of shared names is loaded", Object.keys(S).length >= 20, Object.keys(S).length);

// The Capri: its article is the 1968-1986 car; the others are cars of their own.
check("the Ford Capri keeps Mk I, II and III only", gens("m-ford-capri").map(g => g.label).join() === "Capri Mk I,Capri Mk II,Capri Mk III", gens("m-ford-capri").map(g => g.label).join());
check("the Ford Capri ends in 1986", N("m-ford-capri").end === 1986, N("m-ford-capri").end);
check("the Capri EV is a car of its own", live("m-ford-capri-ev") && !N("m-ford-capri-ev").familyOf);
for (const id of ["m-ford-capri-australia", "m-ford-capri-ev", "m-lincoln-capri", "m-mercury-capri-fox", "m-ford-consul-classic"]) {
  check("the Capri name links " + id, !!nameLink("m-ford-capri", id));
}
check("the Consul Classic is listed as the Ford Consul Capri", (nameLink("m-ford-capri", "m-ford-consul-classic") || {}).as === "Ford Consul Capri");
check("the Capri EV keeps its platform-mates", DATA.links.filter(l => !l.retired && l.type === "platform" && (idOf(l.source) === "m-ford-capri-ev" || idOf(l.target) === "m-ford-capri-ev")).length >= 4);
check("the Capri (Australia) keeps the Mazda 323", DATA.links.some(l => !l.retired && l.type === "platform" && (idOf(l.source) === "m-ford-capri-australia" || idOf(l.target) === "m-ford-capri-australia")));
check("the Capri (Australia) is not related to the Capri twice", !linked("m-ford-capri", "m-ford-capri-australia", "related"));

// The Blazer page only lists Blazers: the name, not a car.
const blazer = N("m-chevrolet-blazer");
check("the Chevrolet Blazer is shown as a name", blazer.nameIndex === 4, blazer.nameIndex);
for (const id of ["m-chevrolet-k5-blazer", "m-chevrolet-s-10-blazer", "m-chevrolet-blazer-crossover", "m-chevrolet-blazer-ev"]) {
  check("the Blazer name links " + id, !!nameLink("m-chevrolet-blazer", id));
}
check("the Tahoe is no Blazer (its Grand Blazer is a section with another name)", !nameLink("m-chevrolet-blazer", "m-chevrolet-tahoe"));
check("the old read's K5 line goes to the K5 Blazer", DATA.links.some(l => !l.retired && l.type === "platform" && ends(l, "m-chevrolet-k5-blazer", "llm-related-c-k-pickup")));
check("and leaves the name", !DATA.links.some(l => !l.retired && l.type === "platform" && ends(l, "m-chevrolet-blazer", "llm-related-c-k-pickup")));

// A badge is no namesake; a page that only lists cars is no place to match years.
check("the Plymouth Cricket is not linked to the Hillman Avenger by name", !nameLink("llm-related-plymouth-cricket", "m-hillman-avenger"));
check("the Ford Ranger keeps its six generations", gens("m-ford-ranger").length === 6, gens("m-ford-ranger").map(g => g.label).join(" | "));
check("the same car twice gets no name link: Falcon and Falcon (Australia)", !nameLink("fam-ford-falcon", "m-ford-falcon-australia"));
const ids = new Map(); DATA.nodes.forEach(n => ids.set(n.id, (ids.get(n.id) || 0) + 1));
check("no two nodes share an id", ![...ids.values()].some(v => v > 1), [...ids].filter(([, v]) => v > 1).map(([k]) => k).join());

// Where no car holds the name, the name is a node: the two Ford Pumas.
const puma = N("name-ford-puma");
check("the Ford Puma is a name of its own", !!puma && puma.nameOnly && puma.nameIndex === 2, puma && puma.nameIndex);
check("the Puma name links the coupé and the crossover", !!nameLink("name-ford-puma", "m-ford-puma-coupe") && !!nameLink("name-ford-puma", "m-ford-puma-crossover"));
check("a name of its own draws no platform links by name: Chrysler Pacifica", !DATA.links.some(l => !l.retired && l.type === "platform" && (idOf(l.source) === "name-chrysler-pacifica" || idOf(l.target) === "name-chrysler-pacifica")));
check("hatnotes join two cars of one name: Fiat 600 and Fiat 600 (2023)", !!nameLink("m-fiat-600", "m-fiat-600-2023"));
// What the review of 8 Nov found wrong stays out.
check("a licence-built copy is no namesake: Zastava 1300 and Fiat 1300", !nameLink("llm-related-zastava-1300", "m-fiat-1300-and-1500"));
check("a short name counts within its make only: Ford GT and FPV GT", !DATA.links.some(l => !l.retired && l.type === "name" && (idOf(l.source) === "m-ford-gt" || idOf(l.target) === "m-ford-gt")));
check("a section that is gone counts for nothing: Suzuki Landy and Carry", !nameLink("m-suzuki-landy", "llm-related-suzuki-carry"));
check("the name's own generation is no other car: Vantage (2005)", !nameLink("fam-aston-martin-vantage", "m-aston-martin-v8-vantage-2005"));
check("a car twice in the graph is not its own namesake: Ford LTD", !nameLink("llm-related-ford-ltd", "m-ford-ltd-americas"));
check("the old Maverick read's 1970-1977 line goes to that Maverick", DATA.links.some(l => !l.retired && l.type === "platform" && ends(l, "m-ford-maverick-1970-1977", "m-ford-mustang-first-generation")));

// The card and search.
window.CarWeb.openDetail(blazer);
const heads = () => [...window.document.querySelectorAll(".dt-connections h4")].map(h => h.textContent);
check("the Blazer card says it is a nameplate of 4 cars", /nameplate · 4 cars under this name/.test(window.document.querySelector(".dt-kicker").textContent), window.document.querySelector(".dt-kicker").textContent);
check("the Blazer card lists its cars under the name", heads().includes("cars under this name"), heads().join(" / "));
window.CarWeb.openDetail(N("m-ford-capri"));
check("the Capri card has a name section", heads().includes("name also used on"), heads().join(" / "));
check("the Capri card shows the Consul Capri's name", /as Ford Consul Capri/.test(window.document.querySelector(".dt-connections").textContent));
window.CarWeb.openDetail(N("m-ford-capri-ev"));
check("the Capri EV card points back to the name", heads().includes("shares its name with"), heads().join(" / "));
window.CarWeb.openDetail(N("m-ford-consul-classic"));
check("the listed name stays off the holder's row on the listed car's card", !/as Ford Consul Capri/.test(window.document.querySelector(".dt-connections").textContent));
const found = window.CarWeb.searchAll("consul capri").map(r => r.n || r[2] || r);
check("searching Consul Capri finds the Consul Classic", found.some(n => n && n.id === "m-ford-consul-classic"), found.slice(0, 3).map(n => n && n.id).join());

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
