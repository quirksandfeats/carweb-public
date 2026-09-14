// Real user request: "I want to reorganize the generations of a nameplate.
// Instead of a line of generations connected to one another nearby the
// nameplate node, the generations should exist 'around' the nameplate name,
// kind of like a radial, to somewhat separate it from looking like the cars
// that it's connected to/related to, etc... However, the line connecting the
// successor and the predecessor should still exist, so long as the
// generations are in a radial shape around the nameplate node."
//
// The old layout put every generation on one horizontal row beside the
// nameplate -- the same shape a platform sibling or a successor makes, so
// expanding a nameplate read as finding five new neighbours rather than
// opening one car up. This proves the ring: every generation the same
// distance from the nameplate, spread around it, with the gensucc chain still
// drawable and running first-to-last around the rim rather than across the
// middle.
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
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
function loadScript(f) { window.eval(fs.readFileSync(path.join(APP, f), "utf-8")); }
loadScript("d3.min.js");
loadScript("data.js");

const DATA = window.CARDATA;
const MK = "mk-test-rad", FAM = "fam-test-rad";
DATA.nodes.push({ id: MK, type: "make", label: "TestRadial", year: 1950 });

// Three nameplates: five generations, two, and one. The five-generation case
// is the shape the request is about; the other two are where a naive ring
// breaks (two generations diametrically opposite put the succession line
// straight through the nameplate, and one generation has no ring at all).
function nameplate(suffix, count) {
  const id = FAM + "-" + suffix;
  const gens = [];
  for (let i = 0; i < count; i++) {
    const gid = id + "-g" + i;
    gens.push(gid);
    DATA.nodes.push({ id: gid, type: "model", label: "Gen" + (i + 1), make: "TestRadial",
                      year: 1980 + i * 6, end: 1986 + i * 6, familyOf: id });
    DATA.links.push({ source: id, target: gid, type: "generation" });
    if (i) DATA.links.push({ source: gens[i - 1], target: gid, type: "gensucc" });
  }
  DATA.nodes.push({ id, type: "family", label: "Ring" + suffix, make: "TestRadial",
                    year: 1980, end: null, generations: gens });
  DATA.links.push({ source: id, target: MK, type: "made" });
  return { id, gens };
}
const five = nameplate("five", 5);
const two = nameplate("two", 2);
const one = nameplate("one", 1);

window.LLM_FAMILIES = { families: {}, relations: {}, recheck: {}, __serverAvailable: false };
loadScript("llm_families.js");
loadScript("app.js");
loadScript("timeline.js");
loadScript("sixdeg.js");

const cw = window.CarWeb;
cw.boot();
cw.setYearRange(1900, cw.yearRange().max);

function ringOf(fam) {
  const f = cw.byId.get(fam.id);
  f.x = 400; f.y = 250;                       // a known centre, so the numbers below mean something
  cw.expandFamily(fam.id);
  const gens = fam.gens.map(id => cw.byId.get(id));
  return { f, gens, d: gens.map(g => Math.hypot(g.x - f.x, g.y - f.y)) };
}

// ---------- five generations: a real ring ----------
{
  const { f, gens, d } = ringOf(five);
  const spread = Math.max(...d) - Math.min(...d);
  check("every generation sits the same distance from the nameplate", spread < 0.001,
        d.map(v => v.toFixed(1)).join(", "));
  check("...and that distance is a real gap, not zero", Math.min(...d) > 40, Math.min(...d).toFixed(1));

  // The old bug in one assertion: a straight row is every generation on the
  // nameplate's own y.
  const ys = new Set(gens.map(g => Math.round(g.y)));
  check("they are NOT all on one horizontal line beside the nameplate", ys.size > 1, [...ys].join(", "));
  const xs = new Set(gens.map(g => Math.round(g.x)));
  check("...nor stacked in one vertical column", xs.size > 1, [...xs].join(", "));

  // Spread around, not bunched on one side: the angles have to differ.
  const angles = gens.map(g => Math.atan2(g.y - f.y, g.x - f.x));
  const uniq = new Set(angles.map(a => a.toFixed(3)));
  check("each generation has its own direction from the nameplate", uniq.size === gens.length);

  // The nameplate is INSIDE its generations -- that is the whole point of the
  // shape. Every generation being on one side would still satisfy the
  // equal-distance test above.
  const cx = gens.reduce((s, g) => s + g.x, 0) / gens.length;
  const cy = gens.reduce((s, g) => s + g.y, 0) / gens.length;
  check("the nameplate sits inside the ring, not off to one edge of it",
        Math.hypot(cx - f.x, cy - f.y) < Math.min(...d) * 0.7,
        Math.hypot(cx - f.x, cy - f.y).toFixed(1) + " vs radius " + Math.min(...d).toFixed(1));

  // Consecutive generations must be NEIGHBOURS on the rim, so the succession
  // chain reads around the outside. If any consecutive pair were further
  // apart than a non-consecutive one, the chain would criss-cross the middle.
  const step = Math.hypot(gens[1].x - gens[0].x, gens[1].y - gens[0].y);
  const far = Math.hypot(gens[4].x - gens[0].x, gens[4].y - gens[0].y);
  check("consecutive generations are adjacent on the rim, first to last around it",
        step < far, step.toFixed(1) + " vs " + far.toFixed(1));
}

// ---------- the succession lines still exist and still draw ----------
{
  const links = cw.links.filter(l => l.type === "gensucc" &&
    five.gens.includes(l.sn && l.sn.id) && five.gens.includes(l.tn && l.tn.id));
  check("every predecessor/successor line is still there", links.length === 4, links.length);
  check("...and every one of them is drawable with the family expanded",
        links.every(l => cw.linkInLayer(l) && cw.nodeInLayer(l.sn) && cw.nodeInLayer(l.tn)));
}

// ---------- two generations: the case a naive full circle gets wrong ----------
{
  const { f, gens } = ringOf(two);
  // Opposite each other means the line between them passes through the
  // nameplate. The distance from the nameplate to that line is what proves it
  // does not.
  const [a, b] = gens;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const dist = Math.abs((b.x - a.x) * (a.y - f.y) - (a.x - f.x) * (b.y - a.y)) / len;
  check("with only two generations the succession line does not run through "
        + "the nameplate node", dist > 20, dist.toFixed(1));
}

// ---------- one generation: no ring to speak of, but still placed ----------
{
  const { f, gens, d } = ringOf(one);
  check("a single generation is still given a position off the nameplate",
        d[0] > 40 && Number.isFinite(gens[0].x) && Number.isFinite(gens[0].y), d[0].toFixed(1));
  check("...and it is pinned, like every other generation", gens[0].fx !== null && gens[0].fy !== null);
  check("...and the nameplate itself was not moved to make room for it", f.x === 400 && f.y === 250);
}

// ---------- collapsing releases them again ----------
{
  cw.collapseFamily(five.id);
  const gens = five.gens.map(id => cw.byId.get(id));
  check("collapsing unpins the generations so the simulation owns them again",
        gens.every(g => g.fx === null && g.fy === null));
}

console.log("\n" + (fails === 0 ? "ALL GREEN" : fails + " FAILURE(S)"));
process.exit(fails === 0 ? 0 : 1);
