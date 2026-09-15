// Real bug report: 'The "Read it again" and the "scan" button for engines seem
// to not work properly. When I click "read it again", it seems to not do
// anything at all... Also, the "read on ..." date should be updated
// accordingly when I re-read the article.'
//
// Nothing was broken about the reading. The result was landing somewhere else.
// An engine minted from a car's infobox is keyed by the title that infobox
// named -- "Mercedes-Benz M177 engine" -> eng-mercedes-benz-m177 -- while the
// article that title REDIRECTS to is "Mercedes-Benz M176/M177/M178 engine" ->
// eng-mercedes-benz-m176-m177-m178. The read created a second engine node and
// stored its verdict under the second id, so the card the user was looking at
// was untouched: still "not read yet", still no date, apparently inert.
//
// Also covers the two things asked for alongside: the button is the engine's
// own 🔄 LLM Re-check (nothing cached is reused), and the card carries the
// same Wikipedia-link fold the Graph tab's cards do.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const CACHE = path.join(ROOT, "qa", "wiki_cache");
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const M17X = fs.readFileSync(path.join(CACHE, "Mercedes-Benz_M176_M177_M178_engine.wikitext"), "utf-8");

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
window.alert = m => { alerts.push(String(m)); };
const alerts = [];

// The redirect is the whole point, so the stub performs one: asking for
// "Mercedes-Benz M177 engine" answers with the combined article, under its own
// title, exactly as Wikipedia's API does with redirects=1.
const REAL_TITLE = "Mercedes-Benz M176/M177/M178 engine";
const ASKED_TITLE = "Mercedes-Benz M177 engine";
const fetches = [];
window.fetch = (url) => {
  const u = String(url);
  const m = u.match(/[?&]page=([^&]+)/);
  if (m) {
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    fetches.push(title);
    if (title === ASKED_TITLE || title === REAL_TITLE) {
      return Promise.resolve({ ok: true, json: async () =>
        ({ parse: { title: REAL_TITLE, wikitext: { "*": M17X } } }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
const ev = f => window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));

const CAR = "m-mb-sl-r232";
const ENG = "eng-mercedes-benz-m177";   // as a car's infobox mention keys it
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") {
    const D = window.CARDATA;
    const mk = { id: "mk-mb3", type: "make", label: "Mercedes-Benz", year: 1926 };
    D.nodes.push(mk, { id: CAR, type: "model", label: "SL (R232)", make: "Mercedes-Benz",
                       year: 2021, end: null, designers: [], engineers: [] });
    D.links.push({ source: CAR, target: mk.id, type: "made" });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;
const doc = window.document;

(async () => {
  // ---------- 1. the engine, as a car's infobox leaves it ----------
  {
    const car = cw.byId.get(CAR);
    const r = LF.recordEngineMentionsFrom(
      [{ title: ASKED_TITLE, name: "M177", variant: null }], car, DATA.nodes, DATA.links);
    cw.spliceIntoIndexes(DATA.nodes.length - r.engines, DATA.links.length - r.fitted);
    const eng = cw.byId.get(ENG);
    check("(precondition) a mention keys the engine by the title it named",
          !!eng && eng.wp === ASKED_TITLE, eng && eng.id);
    check("...and nothing has read it yet",
          !LF.engineEntryFor(ENG) && !!eng.unresearched);
  }

  // ---------- 2. reading it lands on THAT engine ----------
  let firstDate = null;
  {
    const eng = cw.byId.get(ENG);
    cw.openDetail(eng);
    const btn = [...doc.querySelectorAll(".dt-power button")]
      .find(b => /Read this engine's article/.test(b.textContent));
    check("its card offers to read the article", !!btn,
          [...doc.querySelectorAll(".dt-power button")].map(b => b.textContent).join(" | "));
    btn.click();
    for (let i = 0; i < 120 && !LF.engineEntryFor(ENG); i++) await sleep(20);
    await sleep(120);

    check("no alert about it not being an engine article", alerts.length === 0, alerts.join(" | "));
    const entry = LF.engineEntryFor(ENG);
    check("the verdict is stored against the engine that was asked about",
          !!entry && entry.status === "confirmed", entry && entry.status);
    check("...naming the article the redirect actually reached",
          entry && entry.sourceTitle === REAL_TITLE, entry && entry.sourceTitle);
    check("no second engine node was created under the redirect's own id",
          DATA.nodes.filter(n => n.type === "engine").length === 1,
          DATA.nodes.filter(n => n.type === "engine").map(n => n.id).join(", "));
    check("...and it kept its own short name rather than the combined title",
          cw.byId.get(ENG).label === "M177", cw.byId.get(ENG).label);
    // NOT replaced with the resolved title. The redirect is the more
    // specific fact -- it is what says which of the three engines on that
    // page this node is -- and overwriting it made the next read a read of
    // the whole combined page: M176, M177 and M178 as one engine with three
    // variants. entry.sourceTitle is where the reading actually happened.
    check("the engine keeps the link that says WHICH engine it is",
          cw.byId.get(ENG).wp === ASKED_TITLE, cw.byId.get(ENG).wp);
    check("the cars the M177's own section names are connected",
          DATA.links.filter(l => l.type === "fitted" && !l.retired).length >= 10,
          DATA.links.filter(l => l.type === "fitted" && !l.retired).length);

    const card = doc.querySelector(".dt-power").textContent;
    check("the card stops saying nothing has read it", !/Nothing has read its own article/.test(card),
          card.slice(-80));
    check("...and says when it was read", /Read on \d{4}-\d{2}-\d{2}/.test(card),
          (card.match(/Read on [^.]*/) || [])[0]);
    firstDate = LF.engineEntryFor(ENG).checkedAt;
  }

  // ---------- 3. "Read it again" reads it again ----------
  {
    const eng = cw.byId.get(ENG);
    cw.openDetail(eng);
    const btn = [...doc.querySelectorAll(".dt-power button")]
      .find(b => /Read it again/.test(b.textContent));
    check("a read engine offers a re-read", !!btn,
          [...doc.querySelectorAll(".dt-power button")].map(b => b.textContent).join(" | "));
    const before = fetches.length;
    await sleep(20);
    btn.click();
    for (let i = 0; i < 120 && LF.engineEntryFor(ENG).checkedAt === firstDate; i++) await sleep(20);
    await sleep(120);

    // The 60-second article cache would otherwise serve the copy read a
    // moment ago -- a deliberate re-read is a person asking what the page
    // says NOW, which is what makes this the engine's own LLM Re-check.
    check("it really goes back to Wikipedia rather than serving the cached copy",
          fetches.length > before, (fetches.length - before) + " fetch(es)");
    check("the stored verdict is replaced, not left alone",
          LF.engineEntryFor(ENG).checkedAt !== firstDate,
          firstDate + " -> " + LF.engineEntryFor(ENG).checkedAt);
    check("...still on the same engine, still the only one",
          DATA.nodes.filter(n => n.type === "engine").length === 1);
    check("...and nothing is duplicated by the second pass",
          DATA.links.filter(l => l.type === "fitted" && !l.retired).length ===
          new Set(DATA.links.filter(l => l.type === "fitted" && !l.retired)
            .map(l => (l.source.id || l.source) + "|" + (l.target.id || l.target))).size);
  }

  // ---------- 4. the Wikipedia-link fold ----------
  // "on the serve.py side, there should be a similar small option at the
  // bottom of the info card that is a dropdown where the user can have the
  // 'change link' and 'find it' buttons similar to the graph tab."
  {
    cw.openDetail(cw.byId.get(ENG));
    const row = doc.querySelector(".dt-wplink .llm-wp-row");
    check("an engine's card carries the Wikipedia-link row", !!row);
    const fold = row && row.querySelector("details.llm-wp-tools");
    check("...with the controls behind a closed dropdown, as on a car",
          !!fold && !fold.open);
    check("...holding Change link and Find it",
          !!row.querySelector(".llm-wp-change") && !!row.querySelector(".llm-wp-find"),
          row && row.textContent.slice(0, 90));
    check("...and the link itself stays plainly readable",
          /Mercedes-Benz M177 engine/.test(row.querySelector(".llm-wp-current").textContent),
          row.querySelector(".llm-wp-current").textContent);

    // Changing the link has to take the verdict read from the old one with
    // it, or the card goes on reporting what a different article said, on a
    // date that has nothing to do with the link now on file.
    const stamp = LF.engineEntryFor(ENG).checkedAt;
    await sleep(20);
    await LF.setNodeWikiLink(ENG, REAL_TITLE, DATA.nodes, { force: true });
    check("changing the link drops the verdict read from the old one",
          !LF.engineEntryFor(ENG), LF.engineEntryFor(ENG) && LF.engineEntryFor(ENG).status);
    cw.openDetail(cw.byId.get(ENG));
    const again = [...doc.querySelectorAll(".dt-power button")]
      .find(b => /Read this engine's article|Read it again/.test(b.textContent));
    check("...and the card asks to be read again", !!again, again && again.textContent);
    again.click();
    for (let i = 0; i < 160 && !LF.engineEntryFor(ENG); i++) await sleep(20);
    check("...which fills it back in, from the new link",
          !!LF.engineEntryFor(ENG) && LF.engineEntryFor(ENG).checkedAt !== stamp,
          LF.engineEntryFor(ENG) && LF.engineEntryFor(ENG).sourceTitle);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
