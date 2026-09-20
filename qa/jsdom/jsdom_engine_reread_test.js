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

// The real dataset already carries this exact car -- "SL (R232)", a
// generation of the Mercedes-Benz SL nameplate -- and foldCodeDuplicateModels
// now recognises the seeded one as the same car by its chassis code and folds
// it in. That IS the behaviour under test elsewhere; here it just means the
// live node is the survivor, not the id that was seeded. See
// llm_families.js's supersedeStandalone.
const liveCar = () => {
  let n = cw.byId.get(CAR);
  for (let i = 0; n && n.retired && n.supersededBy && i < 5; i++) n = cw.byId.get(n.supersededBy);
  return n;
};

(async () => {
  // ---------- 1. the engine, as a car's infobox leaves it ----------
  {
    const car = liveCar();
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

  // ---------- 5. one page, three engines ----------
  // Real user point about the SL R232's card: "notice that the full engine is
  // listed as M176/M177/M178 M177, which in this case is not correct, since
  // it's simply taking the information about the wikipedia title and assuming
  // that it is the 'engine' name, when in reality M176, M177, and M178 are
  // technically separate, but all use the same wikipedia page."
  {
    const car = liveCar();
    // How the SL R232's own infobox writes it: the page, and which engine on
    // it this car actually has.
    const before = DATA.nodes.length, lbefore = DATA.links.length;
    LF.recordEngineMentionsFrom(
      [{ title: REAL_TITLE, name: "M178", variant: null }], car, DATA.nodes, DATA.links);
    cw.spliceIntoIndexes(before, lbefore);
    // One article is one engine node, and the code the car displayed is WHICH
    // VARIANT it has. Real user report: "M176 exists twice, once as an engine
    // and another time as an enginevar. the M176 was already researched under
    // the Mercedes-Benz M176/M177/M178 engine, and also clearly has more info
    // about it." Minting a node per code is what produced that pair -- the
    // article's own node with three variants, and an empty node beside it.
    const m178 = DATA.nodes.find(n => n.type === "engine" && /M176\/M177\/M178/.test(n.label));
    check("a mention of one engine on a shared page lands on that page's engine",
          !!m178 && m178.id === "eng-mercedes-benz-m176-m177-m178", m178 && m178.id);
    check("...with no second node minted for the code",
          !DATA.nodes.some(n => n.type === "engine" && !n.retired && n.label === "M178"),
          DATA.nodes.filter(n => n.type === "engine" && !n.retired).map(n => n.label).join(", "));
    check("...but which engine on the page is remembered",
          DATA.links.some(l => l.type === "fitted" && l.variantHint === "M178"),
          JSON.stringify(DATA.links.filter(l => l.type === "fitted").map(l => l.variantHint)));
    check("...pointing at the page it is documented on", m178.wp === REAL_TITLE, m178.wp);

    cw.openDetail(m178);
    const btn = [...doc.querySelectorAll(".dt-power button")]
      .find(b => /Read this engine's article/.test(b.textContent));
    btn.click();
    for (let i = 0; i < 160 && !LF.engineEntryFor(m178.id); i++) await sleep(20);
    await sleep(80);
    const art = LF.engineEntryFor(m178.id).article;
    // Read whole, the page's three engines are its three variants, each
    // holding its own section's applications -- which is what makes them
    // separate without being separate nodes.
    check("reading it splits the page into its three engines",
          art.variants.map(v => v.code).join(",") === "M176,M177,M178",
          art.variants.map(v => v.code).join(",") || "(none)");
    const v178 = art.variants.find(v => v.code === "M178") || { applications: [] };
    check("...each holding only its own section's cars",
          v178.applications.some(a => /Mercedes-AMG GT/.test(a.display)) &&
          !v178.applications.some(a => /BAIC BJ90|C 63/.test(a.display)),
          v178.applications.length + ": " + v178.applications.map(a => a.display).slice(0, 2).join(" | "));
    // Its table names its cars in plain text -- only the Valhalla is a link
    // -- so a link-based reading found one of nine. The chassis code in the
    // cell is what identifies the rest.
    check("...including the cars its table names without linking them",
          v178.applications.filter(a => !a.target).length >= 6,
          v178.applications.filter(a => !a.target).map(a => a.display).slice(0, 3).join(" | "));
    check("...and not the power and torque cells as if they were cars",
          !v178.applications.some(a => /kW|Nm|rpm/.test(a.display)),
          v178.applications.map(a => a.display).join(" | ").slice(0, 80));
    check("...and nothing is called 'M176/M177/M178 M178'",
          !art.variants.some(v => /M176\/M177\/M178/.test(v.code)),
          art.variants.map(v => v.code).join(" | ") || "(none)");
  }

  // ---------- 6. a car lists the variant, not the variant AND its engine ----------
  // "if the engine var is there for the car, then only show the engine var...
  // Only fall back to the engine name if there is no engine var, but dont
  // show both."
  {
    const car = liveCar();
    // Section 5 folded the code-named node into the article's own engine, so
    // that is the live one from here on.
    const eng = cw.byId.get("eng-mercedes-benz-m176-m177-m178");
    // The state that produced the report: the car has an edge to the engine
    // (from its infobox mention) AND to one of that engine's variants (from
    // reading the article).
    const vid = "engvar-test-m177-a";
    DATA.nodes.push({ id: vid, type: "enginevar", label: "M177 A", engineOf: eng.id,
                      wp: eng.wp, year: 2022, end: null });
    DATA.links.push({ source: vid, target: car.id, type: "fitted" });
    if (eng.variants.indexOf(vid) < 0) eng.variants.push(vid);
    DATA.links.push({ source: eng.id, target: car.id, type: "fitted", fromCar: true });
    cw.spliceIntoIndexes(DATA.nodes.length - 1, DATA.links.length - 2);

    cw.openDetail(car);
    const det = doc.querySelector(".dt-power details.dt-power-fold");
    det.open = true;
    const rows = [...det.querySelectorAll("button")].map(b => b.textContent.trim());
    check("the variant is listed", rows.some(r => /M177 A/.test(r)), rows.join(" | "));
    check("...and its engine is not listed as a second engine",
          rows.filter(r => /^M177\b/.test(r) && !/M177 A/.test(r)).length === 0,
          rows.join(" | "));
    // The count is of the rows, whatever they are. It is three here because
    // section 5 gave this car an M178 too, and bindCarsToVariants has since
    // moved that edge onto the M178 variant -- which is the point: the card
    // lists variants, never the family beside them.
    const shown = (det.querySelector("summary").textContent.match(/\((\d+)\)/) || [])[1];
    check("...so the count is of what is shown",
          Number(shown) === rows.filter(r => r).length,
          shown + " vs " + rows.filter(r => r).length + " rows");

    // On the canvas too: the engine-level edge is the redundant one, and
    // hiding it must not take the variant's edge with it.
    cw.switchView("power");
    // Expanded explicitly: in the powertrain layer an engine's variants are
    // its generations, and a collapsed engine draws none of their edges (see
    // powerSets). The question here is which of the two edges survives, not
    // whether the canvas happened to open this engine.
    cw.expandFamily(eng.id);
    cw.rebuildSim();
    cw.Graph.gotoNode(eng);
    const mine = new Set([eng.id, vid]);
    const toCar = DATA.links.filter(l => l.type === "fitted" && cw.linkInLayer(l) &&
      ((l.target.id || l.target) === car.id || (l.source.id || l.source) === car.id) &&
      (mine.has(l.source.id || l.source) || mine.has(l.target.id || l.target)));
    check("exactly one connection is drawn from that engine to that car",
          toCar.length === 1, toCar.length);
    check("...and it is the variant's, not the engine's",
          toCar.length === 1 && ((toCar[0].source.id || toCar[0].source) === vid ||
                                 (toCar[0].target.id || toCar[0].target) === vid),
          toCar.map(l => (l.source.id || l.source) + "->" + (l.target.id || l.target)).join(","));
    cw.Graph.clearFocus();
    cw.switchView("graph");
  }

  // ---------- 7. deleted, and what a re-read does about it ----------
  // Real user report: "I deleted all mentions of the m177 powertrain and its
  // parent (but not permanently cleared - was I supposed to?)... but the
  // terminal suggested it was finding the engine again" -- it said it had
  // found 3, 6, 6, 3, 4 and 2 engines across seven articles and then "0
  // engine(s), 0 connection(s)". Both true: every one already existed as a
  // retired node behind a retired edge, so nothing was created and nothing
  // became visible.
  {
    // Section 5 folded the code-named node into the article's own engine (one
    // article, one engine), so THAT is the node the connections hang off now.
    const ENG7 = "eng-mercedes-benz-m176-m177-m178";
    const eng = cw.byId.get(ENG7);
    const mine = l => l.type === "fitted" &&
      ((l.source.id || l.source) === eng.id || (l.target.id || l.target) === eng.id);
    LF.deleteNode(eng, DATA.nodes, DATA.links, "testing");
    check("(precondition) a plain delete hides the engine and its connections",
          eng.retired && DATA.links.filter(l => mine(l) && !l.retired).length === 0);

    // A boot replay must NOT undo it -- otherwise the engine could never be
    // deleted at all, it would just come back on the next page load.
    cw.recordEnginesLive();
    check("a boot replay leaves the delete alone", cw.byId.get(ENG7).retired);

    cw.openDetail(eng);
    const btn = [...doc.querySelectorAll(".dt-power button")]
      .find(b => /Read this engine's article|Read it again/.test(b.textContent));
    btn.click();
    for (let i = 0; i < 160 && cw.byId.get(ENG7).retired; i++) await sleep(20);
    await sleep(80);
    check("...but reading its article deliberately brings it back",
          !cw.byId.get(ENG7).retired);
    check("...with its connections, not as a bare node",
          DATA.links.filter(l => mine(l) && !l.retired).length > 0,
          DATA.links.filter(l => mine(l) && !l.retired).length);
    check("...and the delete record cleared, so it is not half-deleted",
          !LF.allDeletions().some(d => d.id === ENG7),
          LF.allDeletions().map(d => d.id).join(", "));

    // "Clear for good" is the blacklist, and it holds.
    LF.deleteNode(cw.byId.get(ENG7), DATA.nodes, DATA.links, "testing again");
    const purged = LF.purgeDeletion(ENG7, DATA.nodes, DATA.links);
    check("(precondition) clearing it for good purges it", purged.ok && cw.byId.get(ENG7).purged);
    cw.openDetail(cw.byId.get(ENG7));
    const again = [...doc.querySelectorAll(".dt-power button")]
      .find(b => /Read this engine's article|Read it again/.test(b.textContent));
    if (again) again.click();
    await sleep(300);
    check("...and a re-read does NOT bring that one back", cw.byId.get(ENG7).retired);
  }

  console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
  process.exit(fails === 0 ? 0 : 1);
})();
