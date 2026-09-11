// Real user request (superseding the original "Platforms" tab this file used
// to test): "take all of this from the Platforms tab and apply it back to
// the main Graph tab, since I don't want two knowledge graph pages... add a
// toggle which enables a 'only shared platform/relations' option which then
// shows the information that we were looking at in the Platforms page, only
// that now I can also use the rest of the features like the search as
// well." The standalone Platforms tab/canvas/module (platforms.js) is gone;
// this now exercises the SAME filtering rules (only cars that share a
// platform or are related/rebadged, plus their make hub and the designers/
// engineers credited on them) as one more gate folded straight into Graph's
// own inGraphView()/linkInLayer() choke points, via cw.setPlatformsOnly()
// and cw.graphPlatformsNodeIds().
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
}
function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
let makeNode = DATA.nodes.find(n => n.type === "make" && n.label === "TestMk-plat");
if (!makeNode) { makeNode = { id: "mk-test-plat", type: "make", label: "TestMk-plat", year: 1950 }; DATA.nodes.push(makeNode); }

// ---------- seed: platform pair (SHOULD show) ----------
const A_ID = "m-test-plat-a", B_ID = "m-test-plat-b";
const carA = { id: A_ID, type: "model", label: "Alpha", make: "TestMk-plat", year: 2010, end: null };
const carB = { id: B_ID, type: "model", label: "Beta", make: "TestMk-plat", year: 2010, end: null };
DATA.nodes.push(carA, carB);
DATA.links.push({ source: A_ID, target: makeNode.id, type: "made" }, { source: B_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: A_ID, target: B_ID, type: "platform" });

// ---------- seed: related pair (SHOULD show) ----------
const C_ID = "m-test-plat-c", D_ID = "m-test-plat-d";
const carC = { id: C_ID, type: "model", label: "Gamma", make: "TestMk-plat", year: 2012, end: null };
const carD = { id: D_ID, type: "model", label: "Delta", make: "TestMk-plat", year: 2012, end: null };
DATA.nodes.push(carC, carD);
DATA.links.push({ source: C_ID, target: makeNode.id, type: "made" }, { source: D_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: C_ID, target: D_ID, type: "related" });

// ---------- seed: succession-only pair (should NOT show -- not a platform/related fact) ----------
const E_ID = "m-test-plat-e", F_ID = "m-test-plat-f";
const carE = { id: E_ID, type: "model", label: "Epsilon I", make: "TestMk-plat", year: 2000, end: 2010 };
const carF = { id: F_ID, type: "model", label: "Epsilon II", make: "TestMk-plat", year: 2010, end: null };
DATA.nodes.push(carE, carF);
DATA.links.push({ source: E_ID, target: makeNode.id, type: "made" }, { source: F_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: E_ID, target: F_ID, type: "succession" });

// ---------- seed: lone, unconnected car (should NOT show) ----------
const G_ID = "m-test-plat-g";
const carG = { id: G_ID, type: "model", label: "Zeta", make: "TestMk-plat", year: 2015, end: null };
DATA.nodes.push(carG);
DATA.links.push({ source: G_ID, target: makeNode.id, type: "made" });

// ---------- seed: designer of A (SHOULD show), engineer of E (should NOT show) ----------
const P1_ID = "p-test-plat-designer", P2_ID = "p-test-plat-engineer";
const designer1 = { id: P1_ID, type: "person", label: "Test Platform Designer", roles: ["designer"], year: 1970 };
const engineer1 = { id: P2_ID, type: "person", label: "Test Platform Engineer", roles: ["engineer"], year: 1970 };
DATA.nodes.push(designer1, engineer1);
DATA.links.push({ source: P1_ID, target: A_ID, type: "designed" });
DATA.links.push({ source: P2_ID, target: E_ID, type: "engineered" });

// ---------- seed: family with a generation-level platform link, to prove collapse/expand is honored ----------
const FAM_ID = "fam-test-plat-h", H1_ID = "m-test-plat-h1", H2_ID = "m-test-plat-h2", I_ID = "m-test-plat-i";
const famH = { id: FAM_ID, type: "family", label: "Eta", make: "TestMk-plat", year: 2005, end: null, designers: [], engineers: [], generations: [H1_ID, H2_ID] };
const h1 = { id: H1_ID, type: "model", label: "Eta H1", make: "TestMk-plat", year: 2005, end: 2012, familyOf: FAM_ID };
const h2 = { id: H2_ID, type: "model", label: "Eta H2", make: "TestMk-plat", year: 2012, end: null, familyOf: FAM_ID };
const carI = { id: I_ID, type: "model", label: "Iota", make: "TestMk-plat", year: 2012, end: null };
DATA.nodes.push(famH, h1, h2, carI);
DATA.links.push({ source: FAM_ID, target: makeNode.id, type: "made" }, { source: I_ID, target: makeNode.id, type: "made" });
DATA.links.push({ source: FAM_ID, target: H1_ID, type: "generation" }, { source: FAM_ID, target: H2_ID, type: "generation" }, { source: H1_ID, target: H2_ID, type: "gensucc" });
DATA.links.push({ source: H2_ID, target: I_ID, type: "platform" }); // generation-specific, no coarse family-level mirror seeded

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);

console.log("\n--- toggling the filter on ---");
check("filter starts off", cw.platformsOnly() === false);
cw.setPlatformsOnly(true);
check("filter is now on", cw.platformsOnly() === true);
check("the toggle button shows active state", document.getElementById("platformsonly").classList.contains("active"));
let ids = cw.graphPlatformsNodeIds();

console.log("\n--- core filtering ---");
check("platform pair A included", ids.has(A_ID));
check("platform pair B included", ids.has(B_ID));
check("related pair C included", ids.has(C_ID));
check("related pair D included", ids.has(D_ID));
check("succession-only car E excluded (succession is not a platform/rebadge fact)", !ids.has(E_ID));
check("succession-only car F excluded", !ids.has(F_ID));
check("unconnected lone car G excluded", !ids.has(G_ID));
check("designer of an included car (A) is shown", ids.has(P1_ID));
check("engineer of an EXCLUDED car (E) is not shown", !ids.has(P2_ID));

console.log("\n--- make hub node (same real user clarification carried over from the old Platforms tab) ---");
check("the shared make node IS shown, as a hub every included car connects to", ids.has(makeNode.id));

console.log("\n--- other Graph features keep working while the filter is on ---");
const found = cw.searchAll("Alpha");
check("search still finds a qualifying car", found.some(n => n.id === A_ID));
const foundLone = cw.searchAll("Zeta");
check("search still finds an EXCLUDED car too (search itself isn't gated by the filter)", foundLone.some(n => n.id === G_ID));
cw.goto(G_ID);
check("navigating (via search/goto) to a car the filter is hiding turns the filter off rather than flying to nothing", cw.platformsOnly() === false);

console.log("\n--- people-layer toggle: cars stay, only people react ---");
cw.setPlatformsOnly(true);
cw.setLayer("none");
ids = cw.graphPlatformsNodeIds();
check("with layer=none, the platform-connected cars are STILL shown", ids.has(A_ID) && ids.has(B_ID));
check("with layer=none, the designer is no longer shown", !ids.has(P1_ID));
cw.setLayer("designers");
ids = cw.graphPlatformsNodeIds();
check("switching back to designers layer restores the designer", ids.has(P1_ID));

console.log("\n--- family collapse/expand precedence (same rules the rest of Graph follows) ---");
check("family not expanded by default", !cw.isFamilyExpanded(FAM_ID));
ids = cw.graphPlatformsNodeIds();
// This used to assert the connection was invisible while collapsed, on the
// premise that "no coarse mirror exists for this link". That premise no
// longer holds, and the reason it used to is a bug that has since been fixed:
// llm_families.js's applyResolvedRelations returned early whenever
// store.relations happened to be empty, which silently skipped
// mirrorRelationLinks along with it -- even though that rollup has nothing to
// do with resolved relations. Its entire purpose (see its own comment, and
// the README's "Cross-nameplate relation links are mirrored up to the family
// level") is that a connection must never be invisible just because you
// haven't expanded a nameplate yet. So a coarse mirror now exists here from
// boot, exactly as it always should have, and the generation's partner is
// reachable through it while collapsed.
check("COLLAPSED: the connection is visible through the coarse family-level mirror",
  ids.has(FAM_ID) && ids.has(I_ID));
check("COLLAPSED: but the specific H2 generation itself is still hidden (collapse gate intact)", !ids.has(H2_ID));
cw.expandFamily(FAM_ID);
ids = cw.graphPlatformsNodeIds();
check("EXPANDED: the H2 generation is now shown", ids.has(H2_ID));
check("EXPANDED: its platform partner Iota is now shown", ids.has(I_ID));
check("EXPANDED: the sibling generation H1 (no platform link of its own) is still excluded", !ids.has(H1_ID));
cw.collapseFamily(FAM_ID);

console.log("\n--- toggling off restores the full graph ---");
cw.setPlatformsOnly(false);
check("filter is off again", cw.platformsOnly() === false);
check("toggle button no longer shows active state", !document.getElementById("platformsonly").classList.contains("active"));

console.log("\n--- live structural mutation while the filter is on ---");
cw.setPlatformsOnly(true);
const J_ID = "m-test-plat-j", K_ID = "m-test-plat-k";
const carJ = { id: J_ID, type: "model", label: "Kappa", make: "TestMk-plat", year: 2018, end: null };
const carK = { id: K_ID, type: "model", label: "Lambda", make: "TestMk-plat", year: 2018, end: null };
cw.nodes.push(carJ, carK);
cw.byId.set(J_ID, carJ); cw.byId.set(K_ID, carK);
const newLink = { source: J_ID, target: K_ID, type: "platform" };
cw.links.push(newLink);
newLink.sn = carJ; newLink.tn = carK;
cw.adj.get(J_ID) ? cw.adj.get(J_ID).push({ n: carK, l: newLink }) : cw.adj.set(J_ID, [{ n: carK, l: newLink }]);
cw.adj.get(K_ID) ? cw.adj.get(K_ID).push({ n: carJ, l: newLink }) : cw.adj.set(K_ID, [{ n: carJ, l: newLink }]);
// Every real live-mutation code path (applyLlmConfirmSilent, etc.) calls
// Graph.touch() right after splicing new nodes/links in, which now
// recomputes this filter automatically -- toggling off/on is this test's
// stand-in for that same touch(), since Graph.touch() itself isn't exposed
// on the public api surface.
cw.setPlatformsOnly(false);
cw.setPlatformsOnly(true);
ids = cw.graphPlatformsNodeIds();
check("a brand-new platform pair added live is picked up once the filter recomputes", ids.has(J_ID) && ids.has(K_ID));

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
