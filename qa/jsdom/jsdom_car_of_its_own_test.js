// A car with its own article stays a car of its own, unless the title is the nameplate plus a
// code or generation (14 Oct and 5 Nov 2026). A list read for the first time folded it in.
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
const named = (id, type = "platform") => DATA.links.filter(l => !l.retired && !l.mirror && l.type === type && (idOf(l.source) === id || idOf(l.target) === id))
  .map(l => idOf(l.source) === id ? idOf(l.target) : idOf(l.source));

const live = id => !!N(id) && !N(id).retired && !N(id).familyOf;
const inPlate = (plate, re) => (N(plate).generations || []).some(id => N(id) && !N(id).retired && re.test(N(id).label));
const isRelated = (a, b) => DATA.links.some(l => !l.retired && l.type === "related" && [idOf(l.source), idOf(l.target)].sort().join() === [a, b].sort().join());

// Cars of their own
[["m-fiat-grande-panda", "m-fiat-panda", /Grande Panda/], ["m-ford-customline", "llm-related-ford-custom", /Customline/],
 ["m-hillman-super-minx", "m-hillman-minx", /Super Minx/], ["m-opel-olympia-rekord", "m-opel-rekord", /Olympia Rekord/],
 ["m-ruf-turbo-r", "m-ruf-ctr2", /Turbo R/], ["m-lincoln-mark-lt", "m-lincoln-mark-series", /Mark LT$/]].forEach(([car, plate, re]) => {
  check(N(car).label + " stands as a car", live(car));
  check(N(car).label + " is not in " + N(plate).label + "'s list, and is related to it", !inPlate(plate, re) && isRelated(car, plate));
});
check("the Hummer H1, H2 and H3 stand as cars", ["m-hummer-h1", "m-hummer-h2", "m-hummer-h3"].every(live));

// What the nameplate's article said goes with the car
const h2Mates = named("m-hummer-h2").map(id => N(id) && (N(id).make + " " + N(id).label));
check("the H2 keeps its platform-mates", h2Mates.includes("Chevrolet Silverado") && h2Mates.includes("GMC Sierra"), h2Mates.join(", "));
check("the H1 keeps its engines", DATA.links.some(l => !l.retired && l.type === "fitted" && [idOf(l.source), idOf(l.target)].includes("m-hummer-h1")));
check("the Hummer marque carries no engines", !DATA.links.some(l => !l.retired && l.type === "fitted" && [idOf(l.source), idOf(l.target)].includes("m-hummer-hummer")));
check("the old generation id points at the car", N("llm-m-fiat-panda-grande-panda").supersededBy === "m-fiat-grande-panda");
check("a list naming the make: the BMW 503 is not a 501", live("m-bmw-503") && !inPlate("m-bmw-501", /503/));

// What stays a generation
check("a heading that numbers it: the 350Z is a Fairlady Z", inPlate("fam-nissan-fairlady-z", /Z33/));
check("a code as the title: the W124 is an E-Class", inPlate("m-mercedes-benz-e-class", /W124/));
check("the nameplate and a word: the Twingo E-Tech and Scenic E-Tech are generations", inPlate("m-renault-twingo", /E-Tech/) && inPlate("m-renault-scenic", /E-Tech/));
check("a slice of another car's years: the Chevelle Nomad", inPlate("llm-related-chevrolet-nomad", /Chevelle/));
// The Baleno's page is a list of other articles (8 Nov): its read is not replayed, and a
// re-scan rebuilds it from the pages carrying its name. See jsdom_list_page_reads_test.js.
check("the Baleno's list-page read is not replayed", !(N("llm-related-suzuki-baleno").generations || []).length);
// The rule above leaves a rebadge list alone. Since 9 Nov the Clipper's Suzuki Every and
// Carry generations, from before there was a Clipper, go to the Suzuki cars themselves
// (scripts/other_make_generations.js; see jsdom_other_make_generations_test.js).
check("another maker's generations go to that maker's car: the Clipper's Every", !inPlate("llm-related-nissan-clipper", /Every/));

// BMW Z, by hand
check("the Z1 is one car", (N("m-bmw-z1").generations || []).filter(id => N(id) && !N(id).retired).length === 1 && N("m-bmw-z1").end === 1991);
check("the Z4 starts with the E85", N("fam-bmw-z4").year === 2002 && !inPlate("fam-bmw-z4", /E30|E36|E52/));
check("the Z3 and Z8 stand as cars", live("m-bmw-z3") && live("m-bmw-z8"));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
