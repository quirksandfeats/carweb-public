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
// A recording context. Everything still no-ops, but the calls that decide
// what an edge LOOKS like are written down, because "the succession line is
// an arc along the rim" is not observable any other way in a headless test.
const drawn = [];
function fakeCtx() {
  const noop = () => {};
  const h = {
    measureText: () => ({ width: 10 }),
    beginPath: () => drawn.push(["begin"]),
    moveTo: (x, y) => drawn.push(["moveTo", x, y]),
    lineTo: (x, y) => drawn.push(["lineTo", x, y]),
    arc: (x, y, r, a1, a2, ccw) => drawn.push(["arc", x, y, r, a1, a2, ccw]),
    quadraticCurveTo: (cx, cy, x, y) => drawn.push(["quad", cx, cy, x, y]),
    stroke: () => drawn.push(["stroke"]),
  };
  return new Proxy(h, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}
// The path a single stroke was built from: everything between the beginPath
// that precedes it and the stroke itself.
function strokes() {
  const out = [];
  let cur = null;
  for (const op of drawn) {
    if (op[0] === "begin") { cur = []; continue; }
    if (op[0] === "stroke") { if (cur) out.push(cur); cur = null; continue; }
    if (cur) cur.push(op);
  }
  return out;
}
// The stroke for one specific edge: it has to START at one endpoint and END
// at the other. Matching the start alone is not enough -- a node with several
// edges produces several strokes that all begin in the same place, and the
// first of them is whichever happened to come earlier in the link array.
function endOf(op) {
  if (op[0] === "quad") return [op[3], op[4]];      // control point, then destination
  if (op[0] === "arc") {
    const [, cx, cy, r, , a2] = op;
    return [cx + Math.cos(a2) * r, cy + Math.sin(a2) * r];
  }
  return [op[1], op[2]];
}
function strokeBetween(a, b) {
  const near = (p, n) => Math.hypot(p[0] - n.x, p[1] - n.y) < 0.5;
  return strokes().find(sp => {
    if (sp.length < 2 || sp[0][0] !== "moveTo") return false;
    const from = [sp[0][1], sp[0][2]], to = endOf(sp[sp.length - 1]);
    return (near(from, a) && near(to, b)) || (near(from, b) && near(to, a));
  });
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

// Two things that must be pushed out of / bent around the five-generation
// bubble: a car parked right where the ring is about to appear, and an edge
// between two cars on opposite sides of it whose straight line would cut
// through the middle.
const INTRUDER = "m-test-rad-intruder", WEST = "m-test-rad-west", EAST = "m-test-rad-east";
DATA.nodes.push(
  { id: INTRUDER, type: "model", label: "Intruder", make: "TestRadial", year: 1990, end: 2000 },
  { id: WEST, type: "model", label: "West", make: "TestRadial", year: 1990, end: 2000 },
  { id: EAST, type: "model", label: "East", make: "TestRadial", year: 1990, end: 2000 });
DATA.links.push(
  { source: INTRUDER, target: MK, type: "made" },
  { source: WEST, target: MK, type: "made" },
  { source: EAST, target: MK, type: "made" },
  { source: WEST, target: EAST, type: "platform" });

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
// Park the three outsiders around the five-generation nameplate's centre
// BEFORE it is expanded: the intruder right on top of it, and the other two
// straddling it so the edge between them runs through the middle.
[[INTRUDER, 400 + 8, 250 - 5], [WEST, 400 - 400, 250], [EAST, 400 + 400, 250]]
  .forEach(([id, x, y]) => { const n = cw.byId.get(id); n.x = x; n.y = y; n.fx = null; n.fy = null; });

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

// ---------- the nameplate stays in the middle ----------
// "I want to make sure that the nameplate is always fixed in the center
// around the generations. This means when I expand the nameplate, the graph
// should also re-organize itself so that this always occurs." Without the pin
// the nameplate is the one node in the picture the simulation can still move,
// so the first reheat drags the centre out from inside its own ring.
{
  const f = cw.byId.get(five.id);
  check("the nameplate is pinned while it is expanded", f.fx === 400 && f.fy === 250,
        f.fx + "," + f.fy);
  const ring = cw.ringOf(five.id);
  check("...and the ring geometry is reported from that same centre",
        ring && ring.x === f.x && ring.y === f.y && ring.r > 40, ring && [ring.x, ring.y, ring.r].join(","));
  check("...with a clearance circle wider than the ring itself",
        ring.clear > ring.r, ring.clear.toFixed(1) + " vs " + ring.r.toFixed(1));
}

// ---------- nothing else is inside the bubble ----------
// "I want no other cars or models or anything to be coming between the space
// of the nameplates and its generations... making it look like a proper
// bubble."
{
  const ring = cw.ringOf(five.id);
  const intruder = cw.byId.get(INTRUDER);
  const d = Math.hypot(intruder.x - ring.x, intruder.y - ring.y);
  check("a car sitting where the ring appears is moved out past it",
        d >= ring.clear - 0.001, d.toFixed(1) + " vs clearance " + ring.clear.toFixed(1));
  const inside = cw.nodes.filter(n => n !== ring.fam && !ring.gens.has(n.id) &&
    Number.isFinite(n.x) && Math.hypot(n.x - ring.x, n.y - ring.y) < ring.clear - 0.001);
  check("...and nothing at all is left inside it", inside.length === 0,
        inside.slice(0, 4).map(n => n.id).join(", "));
  // The generations themselves are of course inside the clearance circle --
  // they are the ring. Proving they were not evicted along with everyone else.
  check("the generations are still exactly on the rim",
        five.gens.every(id => Math.abs(Math.hypot(cw.byId.get(id).x - ring.x,
                                                  cw.byId.get(id).y - ring.y) - ring.r) < 0.001));
}

// ---------- and neither is anything drawn ----------
{
  cw.graphDrawNow();
  const ring = cw.ringOf(five.id);
  const gens = five.gens.map(id => cw.byId.get(id));

  // 1. The succession lines follow the rim.
  const sp = strokeBetween(gens[0], gens[1]);
  check("a predecessor/successor line is drawn as an arc, not a straight line",
        !!sp && sp.some(op => op[0] === "arc"), sp && sp.map(o => o[0]).join(">"));
  const arc = sp && sp.find(op => op[0] === "arc");
  check("...on the generations' own circle, so it follows their curvature",
        !!arc && Math.abs(arc[1] - ring.x) < 0.5 && Math.abs(arc[2] - ring.y) < 0.5 &&
        Math.abs(arc[3] - ring.r) < 0.5, arc && arc.slice(1, 4).map(v => v.toFixed(1)).join(","));
  check("...the short way round, never the long way through the far side",
        !!arc && Math.abs(((arc[5] - arc[4]) + Math.PI * 3) % (Math.PI * 2) - Math.PI) <= Math.PI / 2 + 0.001,
        arc && (arc[5] - arc[4]).toFixed(3));

  // 2. An unrelated edge that would cut across is bowed around it.
  const west = cw.byId.get(WEST), east = cw.byId.get(EAST);
  const crossing = strokeBetween(west, east);
  check("an unrelated edge that would cross the bubble is curved around it",
        !!crossing && crossing.some(op => op[0] === "quad"),
        crossing && crossing.map(o => o[0]).join(">"));
  const q = crossing && crossing.find(op => op[0] === "quad");
  if (q) {
    // Sample the quadratic and check every point of it clears the circle.
    const p0 = crossing[0];
    let worst = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const mt = 1 - t;
      const x = mt * mt * p0[1] + 2 * mt * t * q[1] + t * t * q[3];
      const y = mt * mt * p0[2] + 2 * mt * t * q[2] + t * t * q[4];
      worst = Math.min(worst, Math.hypot(x - ring.x, y - ring.y));
    }
    check("...and the whole curve really does stay outside it",
          worst >= ring.r, worst.toFixed(1) + " vs ring radius " + ring.r.toFixed(1));
  }

  // 3. The stated exception: an edge that starts at the nameplate itself has
  //    to leave from the centre, so it is left alone.
  const made = strokeBetween(cw.byId.get(five.id), cw.byId.get(MK));
  check("an edge from the nameplate itself is left straight -- it begins at "
        + "the centre, so there is nothing to bend it around",
        !!made && made.every(op => op[0] === "moveTo" || op[0] === "lineTo"),
        made && made.map(o => o[0]).join(">"));
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
