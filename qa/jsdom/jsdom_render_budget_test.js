// "It seems that now that I've run a very extensive LLM search, there are many
// new nodes and matches, seemingly causing a large slowdown in rendering and
// refreshing and low frame rate."
//
// Measured on that graph (12,224 nodes, 32,544 links): one frame issued
// ~19,800 separate stroke() calls with a setLineDash each, ~10,100 fill()s
// and 10,135 font assignments to draw 150 labels. And every click reheated
// the WHOLE simulation for 26 frames at ~150 ms a step.
//
// Both are pinned here by what they cost, not by how they look:
//   - a frame's canvas calls grow with the number of STYLES, not the number
//     of edges and nodes;
//   - a click settles the patch around what was clicked, and nothing far
//     away moves.
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
const calls = {};
const counting = new Proxy({ measureText: s => ({ width: String(s).length * 6 }) }, {
  get(t, k) { if (k in t) return t[k]; return () => { calls[k] = (calls[k] || 0) + 1; }; },
  set(t, k) { calls["set:" + String(k)] = (calls["set:" + String(k)] || 0) + 1; return true; },
});

const dom = new JSDOM(html, { url: "http://localhost:8077/index.html", runScripts: "outside-only" });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function () { return counting; };
window.requestAnimationFrame = () => 1;
window.devicePixelRatio = 2;
window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.Element.prototype.getBoundingClientRect = () =>
  ({ width: 1400, height: 900, top: 0, left: 0, right: 1400, bottom: 900, x: 0, y: 0 });
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 40; } });
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
window.XMLHttpRequest = function () { this.open = () => {}; this.send = () => { throw new Error("no server"); }; };
global.window = window; global.document = window.document;
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
  if (f === "llm_families.js") window.LLM_FAMILIES = { families: {}, __serverAvailable: false };
  window.eval(fs.readFileSync(path.join(APP, f), "utf-8"));
}
const cw = window.CarWeb;
cw.boot();
const G = Object.values(cw).find(v => v && typeof v === "object" && v.drawNow && v.relaxStats);
check("the renderer exposes a frame and the relax to the suite", !!G);

// ---------- one frame costs a handful of calls per style ----------
{
  for (const k of Object.keys(calls)) delete calls[k];
  G.drawNow();
  const live = cw.nodes.filter(n => !n.retired).length;
  const edges = calls.lineTo || 0;
  check("the frame actually drew the graph (precondition)", edges > 1000 && (calls.arc || 0) > 1000,
        `${edges} edges, ${calls.arc} arcs, ${live} live nodes`);
  check("edges are stroked per style, not per edge", (calls.stroke || 0) <= 40,
        `${calls.stroke} strokes for ${edges} edges`);
  check("...so the dash pattern is set per style too", (calls.setLineDash || 0) <= 25, calls.setLineDash);
  check("nodes are filled per colour, not per node", (calls.fill || 0) <= 16,
        `${calls.fill} fills for ${calls.arc} arcs`);
  const labels = calls.fillText || 0;
  check("a label's font is only set for labels actually drawn", (calls["set:font"] || 0) <= labels + 3,
        `${calls["set:font"]} font sets for ${labels} labels`);
}

// ---------- a click settles a patch, not the whole graph ----------
{
  const target = cw.nodes.find(n => n.type === "family" && !n.retired && (n.generations || []).length >= 3);
  // Something far from the target, which a local relax must leave alone.
  const far = cw.nodes.filter(n => !n.retired && n.type === "model" && Number.isFinite(n.x))
    .sort((a, b) => Math.hypot(b.x - target.x, b.y - target.y) - Math.hypot(a.x - target.x, a.y - target.y))[0];
  const before = { x: far.x, y: far.y };
  G.gotoNode(target);
  const st = G.relaxStats();
  const total = cw.nodes.filter(n => !n.retired).length;
  check("clicking a nameplate relaxes a local patch", st && !st.skipped && st.size > 0,
        JSON.stringify(st));
  check("...a small fraction of the graph", st && st.size < total / 10, `${st && st.size} of ${total}`);
  const t0 = Date.now();
  G.relaxRun();
  const ms = Date.now() - t0;
  check("...cheap enough to run inside frames", ms < 1500, ms + " ms for the whole relax");
  check("...and nothing far away moved", far.x === before.x && far.y === before.y,
        `${far.label}: ${before.x.toFixed(1)},${before.y.toFixed(1)} -> ${far.x.toFixed(1)},${far.y.toFixed(1)}`);
  check("positions stay real numbers", cw.nodes.every(n => n.retired || !Number.isFinite(n.x) || Number.isFinite(n.y)));

  // The main simulation's own numbering is untouched: d3 indexes every node
  // it holds, and a second simulation over the same objects would renumber
  // them. One step of the main simulation afterwards must still work.
  let threw = null;
  try { G.simTick(1); } catch (e) { threw = String(e); }
  check("the main simulation still runs afterwards", !threw, threw);
}

console.log("\n" + fails + " failure(s)");
process.exit(fails ? 1 : 0);
