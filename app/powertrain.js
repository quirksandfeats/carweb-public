// The powertrain view: engines, their variants, and the cars they went into.
//
// Real user request: "I want to have an additional view, independent of the
// main one, where the user can toggle between the main view that we've been
// working on this whole time (with cars, engineers, etc...) and now with
// specifically powertrain configurations, but for now specifically just the
// engine."
//
// Independent is the operative word, and it is enforced from the other side
// too: app.js's nodeInLayer/linkInLayer refuse every powertrain node and edge,
// so the main graph, the timeline, six degrees, the search and the footer
// counts carry on as if this layer did not exist. What is shared is the node
// ARRAY -- a car here is the same object as the car there, so a generation
// split made in the main view shows up in this one without anything syncing.
//
// Structurally it mirrors the main graph one level down: an engine is a
// nameplate, a variant is a generation, and the cars hang off whichever of the
// two the article named (see llm_families.js's planEngineEdges for that rule).
window.CarWebPower = (function () {
  const CW = () => window.CarWeb;
  let canvas, ctx, W = 0, H = 0, DPR = 1;
  let sim = null, nodes = [], links = [], t = d3.zoomIdentity;
  let hoverN = null, selected = null, built = false, raf = 0;

  const TYPES = { engine: "engine", enginevar: "enginevar" };
  const isEngine = n => n && (n.type === TYPES.engine || n.type === TYPES.enginevar);

  function css(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  // Everything this view draws: every engine and variant, plus only those cars
  // an engine actually reaches. A car with no engine on record has nothing to
  // say here and would just be 6,800 dots of noise.
  function collect() {
    const cw = CW();
    // Resolved against the node ARRAY rather than app.js's byId. A scan that
    // has just run has pushed its nodes but not necessarily been through
    // spliceIntoIndexes yet, and a view that silently drew nothing in that
    // window would look exactly like a scan that found nothing.
    const byId = new Map(cw.nodes.map(n => [n.id, n]));
    const idOf = e => (typeof e === "string" ? e : e && e.id);
    const keep = new Set();
    const chosen = [];
    const pLinks = [];
    for (const l of cw.links) {
      if (l.retired) continue;
      if (l.type !== "fitted" && l.type !== "enginegen" && l.type !== "enginesucc") continue;
      const s = byId.get(idOf(l.source)) || l.sn;
      const tg = byId.get(idOf(l.target)) || l.tn;
      if (!s || !tg || s.retired || tg.retired) continue;
      keep.add(s.id); keep.add(tg.id);
      pLinks.push({ source: s.id, target: tg.id, type: l.type, sn: s, tn: tg,
                    yearStart: l.yearStart || null, yearEnd: l.yearEnd || null, note: l.note || null });
    }
    for (const n of cw.nodes) {
      if (n.retired) continue;
      if (isEngine(n) || keep.has(n.id)) chosen.push(n);
    }
    return { nodes: chosen, links: pLinks };
  }

  function radius(n) {
    if (n.type === TYPES.engine) return 9;
    if (n.type === TYPES.enginevar) return 6;
    if (n.type === "family") return 5.5;
    return 4.5;
  }
  function colorOf(n) {
    if (n.type === TYPES.engine) return css("--accent", "#b4432c");
    if (n.type === TYPES.enginevar) return css("--accent2", "#d98b3a");
    return css("--ink", "#17140f");
  }

  function build() {
    const got = collect();
    nodes = got.nodes; links = got.links;
    // Positions seeded from the main graph where a car already has one, so
    // switching views does not scramble everything the eye had learned.
    nodes.forEach(n => {
      if (n.px == null) { n.px = n.x != null ? n.x : (Math.random() - 0.5) * 600; }
      if (n.py == null) { n.py = n.y != null ? n.y : (Math.random() - 0.5) * 600; }
    });
    const pn = nodes.map(n => ({ id: n.id, ref: n, x: n.px, y: n.py }));
    const byId = new Map(pn.map(p => [p.id, p]));
    const pl = links.map(l => ({ source: l.source, target: l.target, type: l.type, ref: l }))
                    .filter(l => byId.has(l.source) && byId.has(l.target));
    sim = d3.forceSimulation(pn)
      .force("link", d3.forceLink(pl).id(d => d.id)
        .distance(l => l.type === "enginegen" ? 26 : l.type === "enginesucc" ? 20 : 64)
        .strength(l => l.type === "enginegen" ? 0.7 : l.type === "enginesucc" ? 0.5 : 0.22))
      .force("charge", d3.forceManyBody().strength(-120).distanceMax(700))
      .force("collide", d3.forceCollide(d => radius(d.ref) + 3))
      .force("x", d3.forceX(0).strength(0.03))
      .force("y", d3.forceY(0).strength(0.04))
      .stop();
    for (let i = 0; i < 260; i++) sim.tick();
    pn.forEach(p => { p.ref.px = p.x; p.ref.py = p.y; });
    simNodes = pn; simLinks = pl;
    built = true;
  }
  let simNodes = [], simLinks = [];

  function resize() {
    if (!canvas) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.max(1, Math.round(W * DPR));
    canvas.height = Math.max(1, Math.round(H * DPR));
  }

  function fit() {
    if (!simNodes.length) { t = d3.zoomIdentity.translate(W / 2, H / 2); return; }
    const xs = d3.extent(simNodes, p => p.x), ys = d3.extent(simNodes, p => p.y);
    const k = Math.min(W / ((xs[1] - xs[0]) + 160), H / ((ys[1] - ys[0]) + 160), 2.4) || 1;
    t = d3.zoomIdentity.translate(W / 2, H / 2).scale(k)
      .translate(-(xs[0] + xs[1]) / 2, -(ys[0] + ys[1]) / 2);
  }

  function labelFor(n) {
    if (isEngine(n)) return n.label;
    return (n.make ? n.make + " " : "") + n.label;
  }

  function draw() {
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = css("--paper", "#f7f4ee");
    ctx.fillRect(0, 0, W, H);

    if (!simNodes.length) {
      ctx.fillStyle = css("--muted", "#8a8378");
      ctx.font = "13px " + css("--sans", "system-ui");
      ctx.textAlign = "center";
      ctx.fillText("No engines yet — scan one from a car's panel, or add one.", W / 2, H / 2);
      ctx.restore();
      return;
    }

    ctx.lineWidth = 1;
    simLinks.forEach(l => {
      const a = l.source, b = l.target;
      if (!a || !b || a.x == null) return;
      const p1 = t.apply([a.x, a.y]), p2 = t.apply([b.x, b.y]);
      ctx.beginPath();
      if (l.type === "fitted") {
        ctx.strokeStyle = css("--hairline", "#ccc5b9");
        ctx.setLineDash([3, 3]);
      } else {
        ctx.strokeStyle = css("--accent2", "#d98b3a");
        ctx.setLineDash([]);
      }
      ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    simNodes.forEach(p => {
      const n = p.ref, r = radius(n) * Math.min(t.k, 1.6);
      const q = t.apply([p.x, p.y]);
      ctx.beginPath();
      ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
      ctx.fillStyle = isEngine(n) ? colorOf(n) : css("--paper", "#f7f4ee");
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = colorOf(n);
      ctx.stroke();
    });

    // Labels: engines always, variants when there is room, cars only close in.
    ctx.font = "11px " + css("--sans", "system-ui");
    ctx.textAlign = "left";
    ctx.fillStyle = css("--ink", "#17140f");
    simNodes.forEach(p => {
      const n = p.ref;
      const show = n.type === TYPES.engine || (n.type === TYPES.enginevar && t.k > 0.7) ||
                   t.k > 1.25 || n === hoverN || n === selected;
      if (!show) return;
      const q = t.apply([p.x, p.y]);
      if (q[0] < -60 || q[0] > W + 60 || q[1] < -20 || q[1] > H + 20) return;
      ctx.fillStyle = n === hoverN || n === selected ? css("--accent", "#b4432c") : css("--ink", "#17140f");
      ctx.fillText(labelFor(n), q[0] + radius(n) + 4, q[1] + 3.5);
    });
    ctx.restore();
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function at(x, y) {
    let best = null, bestD = 18 * 18;
    for (const p of simNodes) {
      const q = t.apply([p.x, p.y]);
      const d = (q[0] - x) * (q[0] - x) + (q[1] - y) * (q[1] - y);
      if (d < bestD) { bestD = d; best = p.ref; }
    }
    return best;
  }

  function wire() {
    const zoom = d3.zoom().scaleExtent([0.15, 6]).on("zoom", ev => { t = ev.transform; schedule(); });
    d3.select(canvas).call(zoom);
    canvas.addEventListener("mousemove", ev => {
      const r = canvas.getBoundingClientRect();
      const n = at(ev.clientX - r.left, ev.clientY - r.top);
      if (n !== hoverN) { hoverN = n; canvas.style.cursor = n ? "pointer" : "default"; schedule(); }
    });
    canvas.addEventListener("mouseleave", () => { hoverN = null; schedule(); });
    canvas.addEventListener("click", ev => {
      const r = canvas.getBoundingClientRect();
      const n = at(ev.clientX - r.left, ev.clientY - r.top);
      selected = n || null;
      if (n) CW().openDetail(n);
      schedule();
    });
    window.addEventListener("resize", () => { if (canvas.offsetParent) { resize(); draw(); } });
  }

  return {
    init() {
      canvas = document.getElementById("ptcanvas");
      if (!canvas) return;
      ctx = canvas.getContext("2d");
      wire();
    },
    // Called whenever this layer gains something, so the view is never stale
    // behind a scan that happened while another tab was open.
    invalidate() { built = false; if (canvas && canvas.offsetParent) { build(); fit(); draw(); } },
    activate() {
      if (!canvas) return;
      resize();
      build();
      fit();
      draw();
    },
    counts() {
      const got = collect();
      return {
        engines: got.nodes.filter(n => n.type === TYPES.engine).length,
        variants: got.nodes.filter(n => n.type === TYPES.enginevar).length,
        cars: got.nodes.filter(n => !isEngine(n)).length,
        fitted: got.links.filter(l => l.type === "fitted").length,
      };
    },
  };
})();
