// A call the token ceiling cut short has to say so.
//
// Real failure, the Mercedes-Benz W108/W109. The entry read:
//
//   "llama.cpp returned something that isn't JSON: {"hasMultipleGenerations":
//    false, "generations": [{"code": "W108/W109", ... "en
//
// which is our own error formatter's 160-character slice, not where the model
// stopped -- so it said nothing about why. serve.py knew: it reads
// finish_reason and prints "CUT OFF at the 3000-token ceiling ... the model
// was looping, not answering." But that never left the terminal: the response
// it handed the page carried no finish_reason, the entry kept no copy of the
// reply, and the agent's own log filter dropped every [req-N] line.
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

const MK = "mk-cutoff", CAR = "m-cutoff-w108";
// Exactly the shape of the real one: valid up to the point it was stopped.
const TRUNCATED = '{"hasMultipleGenerations": false, "generations": [{"code": "W108/W109", '
  + '"yearStart": 1965, "yearEnd": 1972, "designers": ["Paul Bracq", "Friedrich Geiger"], "en';

let mode = "length";   // what serve.py will claim about the next call

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
window.fetch = (u, o) => {
  const s = String(u);
  if (s === "/api/llm-families" && o && o.method === "POST")
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  if (s === "/api/llm/chat") {
    // serve.py's shape, finish_reason and the ceiling included.
    return Promise.resolve({ ok: true, json: async () => ({
      model: "test",
      choices: [{ message: { role: "assistant", content: TRUNCATED }, finish_reason: mode }],
      maxTokens: 3000,
    }) });
  }
  if (/[?&]page=/.test(s)) {
    return Promise.resolve({ ok: true, json: async () => ({
      parse: { title: "Cutoff W108", wikitext: { "*": "{{Infobox automobile|name=W108}}\n== W108 ==\nText." } },
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
    D.nodes.push({ id: MK, type: "make", label: "Cutoff", year: 1900 });
    D.nodes.push({ id: CAR, type: "model", label: "W108", make: "Cutoff", wp: "Cutoff W108",
                   year: 1965, end: 1972, designers: [], engineers: [] });
    D.links.push({ source: MK, target: CAR, type: "made" });
    window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: true };
  }
  ev(f);
}
const cw = window.CarWeb;
cw.boot();
const LF = window.LlmFamilies;
const DATA = window.CARDATA;

(async () => {
  const car = cw.byId.get(CAR);
  const entry = await LF.checkNode(car, DATA.nodes);
  check("a cut-off call is still an error", entry && entry.status === "error", entry && entry.status);
  check("...that says the ceiling was hit, not that the model talks nonsense",
        /ran past the 3000-token ceiling/.test(entry.error || ""), entry.error);
  check("...and does not claim the reply 'isn't JSON'",
        !/isn't JSON/.test(entry.error || ""), entry.error);
  check("...and names the knob that changes it",
        /LLAMA_MAX_TOKENS/.test(entry.error || ""), entry.error);
  check("the whole reply is kept, not the 160 characters the message fits",
        entry.detail && entry.detail.raw === TRUNCATED, entry.detail && (entry.detail.raw || "").length);
  check("...flagged as a cut-off", entry.detail && entry.detail.cutOff === true);
  check("...with what the server reported", entry.detail && entry.detail.finishReason === "length");

  // Same broken text, but the model stopped on its own: that IS a bad reply.
  mode = "stop";
  LF.deleteEntry(CAR);
  const entry2 = await LF.checkNode(car, DATA.nodes);
  check("a reply that ended by itself and still will not parse says so",
        /isn't JSON/.test(entry2.error || ""), entry2.error);
  check("...and is not blamed on the ceiling",
        !/ceiling/.test(entry2.error || ""), entry2.error);
  check("...but its text is kept too", entry2.detail && entry2.detail.raw === TRUNCATED);

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
