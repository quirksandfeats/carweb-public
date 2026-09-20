// Real user request: "Check in the 'unconfirmed relationships' cars and see if
// you can come up with even more rules that would correctly automatically
// confirm or deny a relationship. If you can't then that's also fine, leave it
// as it is."
//
// What was actually in the pile: 33 platform proposals, 32 filed with the same
// reason -- "proposed by overlapping production years only, on top of a
// nameplate name that only matched as a substring". That is the weakest
// evidence this file produces, which is why they were held back. But a
// proposal can be settled by the graph AROUND it rather than by more reading.
//
// Three rules, no model call:
//   confirm  both cars already share a platform with the same third car, at
//            the same time -- which is what the GM C-body chain and the
//            Stellantis CMP cluster in the real file are
//   reject   the two were never in production together
//   reject   a nameplate-level line duplicating a confirmed generation pair
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

const A = "m-testrel-a", B = "m-testrel-b", C = "m-testrel-c";
const OLD = "m-testrel-old";
const FAMX = "fam-testrel-x", GX = "m-testrel-x-gen";
const FAMY = "fam-testrel-y", GY = "m-testrel-y-gen";
// A third car that outlived both of a pair, which must NOT bridge two eras.
const K = "m-testrel-k", L = "m-testrel-l", LONG = "m-testrel-long";

const key = (a, b) => a + "|" + b + "|platform";
const rel = (a, b, status, extra) => Object.assign({
  status, checkedAt: "2026-01-01T00:00:00.000Z", relType: "platform",
  famA: a, famB: b, genIdA: a, genIdB: b, matchLevel: "generation",
  reason: "proposed by overlapping production years only, on top of a nameplate name that only matched as a substring",
}, extra || {});

const SEED = {
  families: {}, recheck: {}, __serverAvailable: true,
  relations: {
    // Two legs of a triangle, already decided; the third waiting.
    [key(A, C)]: rel(A, C, "confirmed"),
    [key(B, C)]: rel(B, C, "confirmed"),
    [key(A, B)]: rel(A, B, "provisional"),
    // A pair that cannot be: sixty years apart.
    [key(A, OLD)]: rel(A, OLD, "provisional"),
    // A generation pair, confirmed...
    [key(GX, GY)]: rel(GX, GY, "confirmed", { famA: FAMX, famB: FAMY }),
    // ...and the same fact again, at nameplate level.
    [key(FAMX, FAMY)]: rel(FAMX, FAMY, "provisional",
                           { genIdA: FAMX, genIdB: FAMY, matchLevel: "nameplate" }),
    // The long-lived third car's two legs, and the pair it must not confirm.
    [key(K, LONG)]: rel(K, LONG, "confirmed"),
    [key(L, LONG)]: rel(L, LONG, "confirmed"),
    [key(K, L)]: rel(K, L, "provisional"),
  },
};

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 1;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return window.document.body; } });
const posted = [];
window.fetch = (u, o) => {
  if (String(u) === "/api/llm-families" && o && o.method === "POST") {
    posted.push(JSON.parse(o.body));
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-testrel", type: "make", label: "TestRel", year: 1900 };
    D.nodes.push(mk);
    const car = (id, label, y, e, extra) => Object.assign(
      { id, type: "model", label, make: "TestRel", year: y, end: e, designers: [], engineers: [] }, extra || {});
    D.nodes.push(car(A, "Alpha", 2019, null), car(B, "Beta", 2020, null), car(C, "Gamma", 2018, null));
    D.nodes.push(car(OLD, "Ancient", 1955, 1962));
    D.nodes.push(car(K, "Kilo", 1965, 1970), car(L, "Lima", 2015, null),
                 car(LONG, "Longlived", 1960, null));
    D.nodes.push({ id: FAMX, type: "family", label: "Ex", make: "TestRel", year: 2010,
                   generations: [GX], designers: [], engineers: [] });
    D.nodes.push(car(GX, "Ex G1", 2010, 2018, { familyOf: FAMX }));
    D.nodes.push({ id: FAMY, type: "family", label: "Why", make: "TestRel", year: 2011,
                   generations: [GY], designers: [], engineers: [] });
    D.nodes.push(car(GY, "Why G1", 2011, 2019, { familyOf: FAMY }));
    [A, B, C, OLD, K, L, LONG, FAMX, FAMY].forEach(id =>
      D.links.push({ source: id, target: mk.id, type: "made" }));
    D.links.push({ source: FAMX, target: GX, type: "generation" },
                 { source: FAMY, target: GY, type: "generation" });
    window.LLM_FAMILIES = JSON.parse(JSON.stringify(SEED));
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;
const statusOf = k => (LF.allRelationEntries().find(e => e.id === k) || {}).status || "(gone)";

check("(precondition) four are waiting",
      LF.allRelationEntries().filter(e => e.status === "provisional").length === 4,
      LF.allRelationEntries().filter(e => e.status === "provisional").length);

const r = LF.reviewProvisionalRelations(DATA.nodes, DATA.links);

// ---------- confirm: the third side of a triangle ----------
{
  check("a pair whose two cars already share a platform with the same third car is confirmed",
        statusOf(key(A, B)) === "confirmed", statusOf(key(A, B)));
  check("...and it says which car settled it",
        r.confirmed.some(x => /Gamma/.test(x.why)), JSON.stringify(r.confirmed.map(x => x.why)));
}

// ---------- reject: never built at the same time ----------
{
  check("a pair built decades apart is rejected", statusOf(key(A, OLD)) === "(gone)", statusOf(key(A, OLD)));
  check("...saying how far apart", r.rejected.some(x => /years apart/.test(x.why)),
        JSON.stringify(r.rejected.map(x => x.why)));
}

// ---------- reject: the coarse copy of a settled pair ----------
{
  check("a nameplate-level line is dropped when a generation pair between the two is confirmed",
        statusOf(key(FAMX, FAMY)) === "(gone)", statusOf(key(FAMX, FAMY)));
  check("...while the generation pair itself is untouched",
        statusOf(key(GX, GY)) === "confirmed", statusOf(key(GX, GY)));
}

// ---------- what it must NOT do ----------
{
  // The triangle has to close at the same TIME, or every long-lived platform
  // confirms everything that ever touched it.
  check("a third car that outlived both does not confirm two cars fifty years apart",
        statusOf(key(K, L)) !== "confirmed", statusOf(key(K, L)));
}

check("the decisions are written to disk", posted.length > 0, posted.length);
check("...and it reports what it left alone", typeof r.left === "number", JSON.stringify({
  confirmed: r.confirmed.length, rejected: r.rejected.length, left: r.left }));

// ---------- the panel offers it ----------
{
  const btn = window.document.getElementById("unconfirmedrel-review");
  check("the Unconfirmed Relationships panel offers the pass", !!btn);
  const appSrc = fs.readFileSync(path.join(APP, "app.js"), "utf-8");
  check("...and wires what it confirms into the graph, not only into the store",
        /LF\.applyResolvedRelations\(nodes, links\);/.test(appSrc));
  check("...and reports every decision, rather than a bare count",
        /lines\.map\(esc\)\.join\("<br>"\)/.test(appSrc));
  const lfSrc = fs.readFileSync(path.join(APP, "llm_families.js"), "utf-8");
  check("...and a rejection is blacklisted, so it is not proposed again next boot",
        /function reviewProvisionalRelations[\s\S]{0,4000}?rejectRelation\(e\.id\);/.test(lfSrc));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
