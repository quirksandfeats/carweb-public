// Real user request: "there should also be an option for me to specify to
// the LLM a specific car make and model to further add to the knowledge
// graph. If the make doesn't exist, then create a new make. If the model
// doesn't exist, create a new model, and then have the local LLM attempt to
// find a wikipedia page associated with it. If it could not find a wikipedia
// page associated with it, then it should ask the user for a wikipedia link
// about the information on the car. From that link, it should then do the
// same as it does with other models: it determines whether it's a
// nameplate, finds the generations, and also looks for the designers and
// any cars or platforms related to it." Verifies the "Add Car" dropdown item
// (see app.js's initAddCarPanel/llm_families.js's findWikipediaTitleFor/
// titleFromWikipediaUrl/tryWikipediaTitle) end to end: direct-title-guess
// success (with the full nameplate/generations/designer discovery flow
// actually running afterward), guess-fails-but-search-succeeds, both-fail-
// so-asks-for-a-URL, the pasted-URL path, a rejected non-Wikipedia URL, and
// the "already in the graph" short-circuit.
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

// Only "DirectHit"'s article actually announces two distinct generations
// (plus a designer credit) -- every other scenario below is deliberately a
// plain, single-generation article, so minting it never cascades into extra
// generation/person nodes and each scenario's node-count delta stays simple
// and predictable.
const WIKITEXT_MULTI = "{{Infobox automobile|name=Test Car}}\n" +
  "== First generation (2001-2008) ==\nThe first generation launched in 2001, styled by Jane Doe.\n" +
  "== Second generation (2008-2015) ==\nThe second generation launched in 2008.\n";
const WIKITEXT_SINGLE = "{{Infobox automobile|name=Test Car}}\nJust a plain car with nothing distinguishing about it.\n";

// Titles this stub treats as REAL, resolvable Wikipedia articles, mapped to
// which article body they serve.
const REAL_TITLES = {
  "TestGuessMake DirectHit": WIKITEXT_MULTI,           // direct-guess path succeeds immediately
  "TestGuessMake SearchOnly (car)": WIKITEXT_SINGLE,    // only reachable via the search fallback
  "TestGuessMake FromUrl": WIKITEXT_SINGLE,             // only reachable via a user-pasted URL
};
let lastSearchQuery = null;
window.fetch = (url, opts) => {
  const u = String(url);
  if (u.includes("action=parse")) {
    const m = u.match(/page=([^&]+)/);
    const title = decodeURIComponent(m[1]);
    if (Object.prototype.hasOwnProperty.call(REAL_TITLES, title)) {
      return Promise.resolve({ ok: true, json: async () => ({ parse: { wikitext: { "*": REAL_TITLES[title] } } }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  if (u.includes("action=query") && u.includes("list=search")) {
    const m = u.match(/srsearch=([^&]+)/);
    lastSearchQuery = decodeURIComponent(m[1]);
    if (lastSearchQuery === "TestGuessMake SearchOnly") {
      return Promise.resolve({ ok: true, json: async () => ({ query: { search: [{ title: "TestGuessMake SearchOnly (car)" }] } }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ query: { search: [] } }) });
  }
  if (u === "/api/llm/chat") {
    const body = JSON.parse(opts.body);
    const promptStr = JSON.stringify(body.messages);
    const isMulti = promptStr.includes("First generation (2001");
    const payload = isMulti
      ? { hasMultipleGenerations: true, generations: [
          { code: "First generation", yearStart: 2001, yearEnd: 2008, designers: ["Jane Doe"], engineers: [] },
          { code: "Second generation", yearStart: 2008, yearEnd: 2015, designers: [], engineers: [] },
        ] }
      : { hasMultipleGenerations: false, generations: [] };
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
};
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
const EXIST_MAKE_ID = "mk-test-addcar-existing";
let existingMake = DATA.nodes.find(n => n.id === EXIST_MAKE_ID);
if (!existingMake) { existingMake = { id: EXIST_MAKE_ID, type: "make", label: "TestExistingMake", year: 1950 }; DATA.nodes.push(existingMake); }
const EXIST_MODEL_ID = "m-test-addcar-existing-model";
let existingModel = DATA.nodes.find(n => n.id === EXIST_MODEL_ID);
if (!existingModel) {
  existingModel = { id: EXIST_MODEL_ID, type: "model", label: "AlreadyHere", make: "TestExistingMake", year: 1990, end: 1999 };
  DATA.nodes.push(existingModel);
  DATA.links.push({ source: EXIST_MAKE_ID, target: EXIST_MODEL_ID, type: "made" });
}

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");
loadScript("platforms.js");

window.CarWeb.boot();
const cw = window.CarWeb;
cw.setYearRange(1900, cw.yearRange().max);

const btn = window.document.getElementById("addcarbtn");
check("Add Car dropdown item is visible (server available)", !!btn && !btn.hidden);

btn.onclick();
const panel = window.document.getElementById("addcar");
check("panel opens on click", panel && !panel.hidden);

const makeInput = window.document.getElementById("addcar-make");
const modelInput = window.document.getElementById("addcar-model");
const submitBtn = window.document.getElementById("addcar-submit");
const status = window.document.getElementById("addcar-status");
const urlSection = window.document.getElementById("addcar-url-section");
const urlInput = window.document.getElementById("addcar-url");
const useUrlBtn = window.document.getElementById("addcar-use-url");

function nodeCount() { return cw.nodes.length; }

// ---------- scenario 1: already exists -> just navigate, no duplicate minted ----------
const countBeforeExisting = nodeCount();
makeInput.value = "TestExistingMake";
modelInput.value = "AlreadyHere";
submitBtn.onclick();
setTimeout(() => {
  check("scenario 1: no new node minted for a car already in the graph", nodeCount() === countBeforeExisting, nodeCount());
  check("scenario 1: panel closed", panel.hidden);

  // ---------- scenario 2: direct title guess succeeds; full discovery flow runs ----------
  panel.hidden = false;
  makeInput.value = "TestGuessMake";
  modelInput.value = "DirectHit";
  submitBtn.onclick();

  // Give the mint + the immediately-kicked-off checkNode's stubbed LLM call
  // (opening the detail panel with LLM Check now armed triggers it exactly
  // like browsing to any other new car) a tick to resolve and auto-apply.
  setTimeout(() => {
    // (status text itself is reset along with the rest of the form once the
    // panel closes on success -- nothing left to show, since the user is
    // immediately flown to the new car's own detail panel instead.)
    check("scenario 2: panel closed after minting", panel.hidden);
    const genFam = cw.byId.get("usercar-testguessmake-directhit");
    check("scenario 2: the node was minted with the guessed title as its wp, and the LLM check determined it's a nameplate (full discovery flow ran, not just a bare mint)",
      !!genFam && genFam.wp === "TestGuessMake DirectHit" && genFam.type === "family" &&
      Array.isArray(genFam.generations) && genFam.generations.length === 2,
      genFam && { type: genFam.type, wp: genFam.wp, generations: genFam.generations });
    const mintedMake = cw.byId.get("usercar-make-testguessmake");
    check("scenario 2: a new make node was minted too", !!mintedMake && mintedMake.label === "TestGuessMake");
    const gen1 = genFam && genFam.generations && cw.byId.get(genFam.generations[0]);
    check("scenario 2: a designer credited on a generation's own Wikipedia text was captured too",
      gen1 && Array.isArray(gen1.designers) && gen1.designers.length > 0, gen1 && gen1.designers);

    // ---------- scenario 3: guess fails, Wikipedia SEARCH finds it ----------
    const countBefore3 = nodeCount();
    panel.hidden = false;
    makeInput.value = "TestGuessMake";
    modelInput.value = "SearchOnly";
    submitBtn.onclick();

    setTimeout(() => {
      check("scenario 3: search query was the plain guess text (make + model)", lastSearchQuery === "TestGuessMake SearchOnly", lastSearchQuery);
      const minted3 = cw.byId.get("usercar-testguessmake-searchonly");
      check("scenario 3: minted using the SEARCH result's title, not the failed direct guess",
        !!minted3 && minted3.wp === "TestGuessMake SearchOnly (car)", minted3 && minted3.wp);
      check("scenario 3: make reused (already minted in scenario 2), only the model node is new",
        nodeCount() === countBefore3 + 1, nodeCount() - countBefore3);

      // ---------- scenario 4: both guess and search fail -> asks for a URL ----------
      const countBefore4 = nodeCount();
      panel.hidden = false;
      makeInput.value = "TestGuessMake";
      modelInput.value = "NotOnWikipediaAtAll";
      submitBtn.onclick();

      setTimeout(() => {
        check("scenario 4: url-ask section becomes visible when nothing is found automatically", !urlSection.hidden);
        check("scenario 4: nothing was minted yet (still waiting on the user)", nodeCount() === countBefore4, nodeCount() - countBefore4);

        // user pastes a real link
        urlInput.value = "https://en.wikipedia.org/wiki/TestGuessMake_FromUrl";
        useUrlBtn.onclick();

        setTimeout(() => {
          const minted4 = cw.byId.get("usercar-testguessmake-notonwikipediaatall");
          check("scenario 4: minted using the title extracted from the pasted URL", !!minted4 && minted4.wp === "TestGuessMake FromUrl", minted4 && minted4.wp);
          check("scenario 4: panel closed after using the URL", panel.hidden);

          // ---------- scenario 5: a bogus (non-Wikipedia) URL is rejected with a clear message ----------
          const countBefore5 = nodeCount();
          panel.hidden = false;
          makeInput.value = "TestGuessMake";
          modelInput.value = "BogusUrlCase";
          urlSection.hidden = false;
          urlInput.value = "https://example.com/not-wikipedia";
          useUrlBtn.onclick();
          check("scenario 5: a non-Wikipedia URL is rejected without minting anything", nodeCount() === countBefore5, nodeCount() - countBefore5);
          check("scenario 5: a clear error message is shown", /doesn.?t look like a Wikipedia/i.test(status.textContent), status.textContent);

          console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
          process.exit(fails === 0 ? 0 : 1);
        }, 80);
      }, 80);
    }, 80);
  }, 80);
}, 80);
