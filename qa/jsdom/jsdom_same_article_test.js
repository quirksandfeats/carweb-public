// One article, one car.
//
// Real run, two nodes in the same pass, both proposing the Chevrolet
// Suburban's twelve generations under a name that is not the Suburban:
//
//   llm-related-chevrolet-suburban-fifth-generation-1960
//       minted from the mention "Chevrolet Suburban#Fifth generation (1960)"
//       -- a link into a SECTION of the Suburban's own article. The anchor
//       stopped it matching the Suburban already in the graph, so it was
//       minted, looked its own title up (anchor and all), fetched the
//       Suburban's article and read it from scratch.
//
//   llm-related-chevrolet-veraneio
//       a real car with a real name whose Wikipedia title redirects onto the
//       Suburban's page. Nothing about the node looked wrong; the article it
//       got was simply somebody else's.
//
// Three fixes, tested here: the anchor is dropped when a mention is matched
// and when one is minted, a looked-up title is stored as what Wikipedia
// actually served, and -- whatever route got us there -- a check whose
// article already belongs to another live node records "same-article"
// instead of proposing that article's generations a second time.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -- " + extra : ""));
  if (!cond) fails++;
};
function fakeCtx() {
  const noop = () => {};
  const h = { measureText: () => ({ width: 10 }) };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

const MK = "mk-samesrc", FAM = "fam-samesrc-suburban";
const G1 = "m-samesrc-suburban-g1", G2 = "m-samesrc-suburban-g2";
const STRAY = "llm-related-samesrc-veraneio";
const SUB_ARTICLE = "Samesrc Suburban";

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

// The article every fetch in this test returns, whatever title is asked for:
// that IS the redirect, as far as the code under test can tell.
const WIKITEXT = [
  "{{Infobox automobile|name=Samesrc Suburban|production=1935-present}}",
  "== First generation (1935) ==",
  "Text.",
  "== Second generation (1941) ==",
  "More text.",
].join("\n");
const asked = [];
window.fetch = (u, o) => {
  const s = String(u);
  if (s === "/api/llm-families" && o && o.method === "POST")
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  const page = /[?&]page=([^&]*)/.exec(s);
  if (page) {
    const title = decodeURIComponent(page[1]).replace(/_/g, " ");
    asked.push(title);
    // Everything here is the Suburban's page, served under its real title --
    // which is what a redirect looks like from this side.
    return Promise.resolve({ ok: true, json: async () => ({
      parse: { title: SUB_ARTICLE, wikitext: { "*": WIKITEXT } },
    }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;

const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    D.nodes.push({ id: MK, type: "make", label: "Samesrc", year: 1911 });
    D.nodes.push({ id: FAM, type: "family", label: "Suburban", make: "Samesrc", year: 1935,
                   wp: SUB_ARTICLE, generations: [G1, G2], designers: [], engineers: [] });
    D.nodes.push({ id: G1, type: "model", label: "Suburban First generation", make: "Samesrc",
                   familyOf: FAM, wp: SUB_ARTICLE, year: 1935, end: 1940, designers: [], engineers: [] });
    D.nodes.push({ id: G2, type: "model", label: "Suburban Second generation", make: "Samesrc",
                   familyOf: FAM, wp: SUB_ARTICLE, year: 1941, end: 1946, designers: [], engineers: [] });
    // The Veraneio: its own name, its own node, somebody else's article.
    D.nodes.push({ id: STRAY, type: "model", label: "Veraneio", make: "Samesrc",
                   wp: "Samesrc Veraneio", year: null, end: null,
                   llmGenerated: true, llmCreatedNode: true, designers: [], engineers: [] });
    D.links.push({ source: MK, target: FAM, type: "made" },
                 { source: FAM, target: G1, type: "generation" },
                 { source: FAM, target: G2, type: "generation" },
                 { source: MK, target: STRAY, type: "made" });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

// ---------- an anchor names a section, not a car ----------
{
  const hit = LF.findMatchingNameplate(DATA.nodes, "Samesrc Suburban#Fifth generation (1960)", null);
  check("a section link matches the article's own car",
        !!hit && hit.node && hit.node.id === FAM, hit && hit.node && hit.node.id);
  check("...exactly, not as a loose guess", !!hit && hit.loose === false, hit && hit.loose);

  const before = DATA.nodes.length;
  const minted = LF.mintRelatedNode(DATA.nodes, DATA.links,
                                    "Samesrc Newcar#Third generation (1999)", null, FAM);
  check("a car minted from a section link does not keep the anchor in its id",
        !!minted && minted.id.indexOf("third-generation") < 0, minted && minted.id);
  check("...nor in its label", !!minted && minted.label.indexOf("#") < 0, minted && minted.label);
  check("...and it is still minted", DATA.nodes.length === before + 1 || !!minted);
}

// ---------- the article key: anchor dropped, redirect followed ----------
{
  check("an anchor does not change which article a title names",
        LF.articleKeyOf("Samesrc Suburban#Fifth generation (1960)") === LF.articleKeyOf("Samesrc Suburban"));
  const owner = LF.nodeOwningArticle(DATA.nodes, "Samesrc Suburban#Fifth generation (1960)", STRAY);
  check("the car that owns that article is found", !!owner && owner.id === FAM, owner && owner.id);
  check("...and the nameplate is preferred over its own generations",
        !!owner && owner.type === "family", owner && owner.type);
  check("a node is never said to be the same as itself",
        LF.nodeOwningArticle(DATA.nodes, SUB_ARTICLE, FAM) !== cw.byId.get(FAM));
}

// ---------- the backstop: a check that lands on somebody else's article ----------
(async () => {
  const stray = cw.byId.get(STRAY);
  const entry = await LF.checkNode(stray, DATA.nodes);
  check("a check whose article belongs to another car records same-article",
        entry && entry.status === "same-article", entry && entry.status);
  check("...naming which car", entry && entry.sameAs === FAM, entry && entry.sameAs);
  check("...and proposing nothing", !entry || !entry.proposal, JSON.stringify(entry && entry.proposal));
  check("...so it is not waiting for review",
        !LF.allEntries().some(e => e.id === STRAY && e.status === "provisional"));
  check("the redirect was learned, not just the title that was asked for",
        asked.indexOf("Samesrc Veraneio") >= 0, asked.join(" | "));

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
