/* Six Degrees — shortest path across all edge types, animated */
window.CarWebSix = (function () {
  "use strict";
  const CW = () => window.CarWeb;

  let canvas, ctx, W = 0, H = 0, DPR = 1;
  let from = null, to = null, path = null, lit = 0, anim = null;
  let t = d3.zoomIdentity;

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    W = r.width; H = r.height; DPR = window.devicePixelRatio || 1;
    canvas.width = W * DPR; canvas.height = H * DPR;
  }

  // Families participate in pathfinding directly. If someone is explicitly
  // routing to/from a specific (currently collapsed) generation, expand its
  // family first so nodeInLayer lets BFS reach it — same auto-expand pattern
  // used by Graph's api.goto and Timeline's goto.
  function ensureVisible(n) {
    const cw = CW();
    if (n && n.familyOf && !cw.isFamilyExpanded(n.familyOf)) cw.expandFamily(n.familyOf);
  }

  // BFS over the edges of the active people layer
  function shortestPath(a, b) {
    const cw = CW();
    const prev = new Map([[a.id, null]]);
    let q = [a.id];
    while (q.length) {
      const next = [];
      for (const id of q) {
        if (id === b.id) {
          const out = [];
          let cur = b.id;
          while (cur) { const p = prev.get(cur); out.unshift({ id: cur, via: p ? p.l : null }); cur = p ? p.from : null; }
          return out.map(s => ({ n: cw.byId.get(s.id), via: s.via }));
        }
        for (const { n, l } of cw.adj.get(id)) {
          if (!cw.nodeInLayer(n) || !cw.linkInLayer(l)) continue;
          if (!prev.has(n.id)) { prev.set(n.id, { from: id, l }); next.push(n.id); }
        }
      }
      q = next;
    }
    return null;
  }

  function verb(step, prevN) {
    const l = step.via;
    if (!l) return "";
    const forward = l.sn === prevN; // prev -> this
    if (l.type === "platform") return "shares a platform with";
    if (l.type === "related") return "is related to";
    if (l.type === "succession") return forward ? "was succeeded by" : "succeeds";
    if (l.type === "made") return forward ? "is made by" : "makes the";
    if (l.type === "generation") return forward ? "includes the generation" : "is part of the nameplate";
    if (l.type === "engineered") return forward ? "was engineered by" : "engineered the";
    return forward ? "was drawn by" : "drew the";
  }

  function fitPath(animMs) {
    const pts = path.map(s => s.n);
    const xs = d3.extent(pts, n => n.x), ys = d3.extent(pts, n => n.y);
    const k = Math.max(0.35, Math.min(2.6, Math.min(W / (xs[1] - xs[0] + 300), H / (ys[1] - ys[0] + 300))));
    const target = d3.zoomIdentity.translate(W / 2, H / 2).scale(k)
      .translate(-(xs[0] + xs[1]) / 2, -(ys[0] + ys[1]) / 2);
    tweenTo(target, animMs);
  }
  let tween = null;
  function tweenTo(target, ms) {
    const start = t, t0 = performance.now();
    const ix = d3.interpolateNumber(start.x, target.x),
          iy = d3.interpolateNumber(start.y, target.y),
          ik = d3.interpolateNumber(start.k, target.k);
    cancelAnimationFrame(tween);
    const step = now => {
      const u = Math.min(1, (now - t0) / ms), e = d3.easeCubicInOut(u);
      t = d3.zoomIdentity.translate(ix(e), iy(e)).scale(ik(e));
      draw();
      if (u < 1) tween = requestAnimationFrame(step);
    };
    tween = requestAnimationFrame(step);
  }

  function draw() {
    const cw = CW(), C = cw.C;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);
    const k = t.k;
    const onPath = new Set(path ? path.slice(0, lit + 1).map(s => s.n.id) : []);
    const litLinks = new Set(path ? path.slice(1, lit + 1).map(s => s.via) : []);

    for (const l of cw.links) {
      if (!cw.linkInLayer(l) || !cw.nodeInLayer(l.sn) || !cw.nodeInLayer(l.tn)) continue;
      const hot = litLinks.has(l);
      ctx.globalAlpha = hot ? 0.95 : 0.05;
      ctx.beginPath(); ctx.moveTo(l.sn.x, l.sn.y); ctx.lineTo(l.tn.x, l.tn.y);
      ctx.strokeStyle = hot ? C.accent : C.muted;
      ctx.lineWidth = (hot ? 3.4 : 0.8) / k;
      ctx.setLineDash(l.type === "platform" || l.type === "related" ? [6 / k, 4 / k] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of cw.nodes) {
      if (!cw.nodeInLayer(n)) continue;
      const hot = onPath.has(n.id);
      ctx.globalAlpha = hot ? 1 : 0.10;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r * (hot ? 1.3 : 1), 0, 2 * Math.PI);
      if (n.type === "make") { ctx.fillStyle = C.ink; ctx.fill(); }
      else if (n.type === "model" || n.type === "family") {
        ctx.fillStyle = n.heritage ? C.heritage : C.accent; ctx.fill();
        if (n.type === "family") {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r * (hot ? 1.3 : 1) + 1.6 / k, 0, 2 * Math.PI);
          ctx.lineWidth = 1 / k; ctx.strokeStyle = C.ink; ctx.stroke();
        }
        if (n.db) {
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r * (hot ? 1.3 : 1) + (n.type === "family" ? 3.6 : 2) / k, 0, 2 * Math.PI);
          ctx.lineWidth = 1.4 / k; ctx.strokeStyle = C.dbGold; ctx.stroke();
        }
      }
      else {
        ctx.fillStyle = C.card; ctx.fill(); ctx.lineWidth = Math.max(2, n.r * 0.42);
        ctx.strokeStyle = cw.hasRole(n, "engineer") && (cw.layer() === "engineers" || !cw.hasRole(n, "designer")) ? C.engineer : C.designer;
        ctx.stroke();
      }
      if (hot) {
        ctx.font = `600 ${13 / Math.sqrt(k)}px Georgia, serif`;
        ctx.textAlign = "center";
        const label = (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
        ctx.lineWidth = 4 / k; ctx.strokeStyle = C.paper;
        ctx.strokeText(label, n.x, n.y + n.r * 1.3 + 14 / k);
        ctx.fillStyle = C.ink;
        ctx.fillText(label, n.x, n.y + n.r * 1.3 + 14 / k);
      }
    }
    ctx.globalAlpha = 1;
  }

  function trace() {
    if (!from || !to || from === to) return;
    ensureVisible(from); ensureVisible(to);
    path = shortestPath(from, to);
    const steps = document.getElementById("sd-steps");
    steps.innerHTML = "";
    if (!path) { steps.innerHTML = "<li class='lit'>No path found — these live in separate webs.</li>"; draw(); return; }
    path.forEach((s, i) => {
      const li = document.createElement("li");
      const name = (s.n.type === "model" || s.n.type === "family") ? `${s.n.make} ${s.n.label}` : s.n.label;
      li.innerHTML = (i ? `<span class="verb">${verb(s, path[i - 1].n)}</span>` : `<span class="verb">start</span>`) +
        `<b>${name}</b>` + ((s.n.type === "model" || s.n.type === "family") ? ` <span class="verb" style="display:inline">· ${s.n.year}</span>` : "");
      li.onclick = () => CW().openDetail(s.n);
      steps.appendChild(li);
    });
    lit = 0;
    clearInterval(anim);
    fitPath(700);
    const items = [...steps.children];
    items[0].classList.add("lit");
    anim = setInterval(() => {
      lit++;
      if (lit >= path.length) { clearInterval(anim); fitPath(800); return; }
      items[lit].classList.add("lit");
      items[lit].scrollIntoView({ block: "nearest", behavior: "smooth" });
      const n = path[lit].n;
      const target = d3.zoomIdentity.translate(W / 2, H / 2).scale(Math.max(t.k, 1.5))
        .translate(-n.x, -n.y);
      tweenTo(target, 620);
    }, 760);
  }

  function picker(inputId, set) {
    const input = document.getElementById(inputId);
    const results = input.parentElement.querySelector(".sd-results");
    input.addEventListener("input", () => {
      CW().renderResults(results, CW().searchAll(input.value), n => {
        set(n);
        input.value = (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
        results.hidden = true;
        checkReady();
      });
    });
    input.addEventListener("blur", () => setTimeout(() => results.hidden = true, 150));
  }
  function checkReady() { document.getElementById("sd-go").disabled = !(from && to && from !== to); }

  function randomPair() {
    const cw = CW();
    const pool = cw.nodes.filter(n => n.type !== "make" && cw.nodeInLayer(n) && n.deg > 1);
    let a, b, p = null, tries = 0;
    do {
      a = pool[Math.random() * pool.length | 0];
      b = pool[Math.random() * pool.length | 0];
      p = a !== b ? shortestPath(a, b) : null;
      tries++;
    } while (tries < 30 && (!p || p.length < 5 || p.length > 9));
    if (!p) return;
    from = a; to = b;
    document.getElementById("sd-from").value = (a.type === "model" || a.type === "family") ? `${a.make} ${a.label}` : a.label;
    document.getElementById("sd-to").value = (b.type === "model" || b.type === "family") ? `${b.make} ${b.label}` : b.label;
    checkReady();
    trace();
  }

  return {
    init() {
      canvas = document.getElementById("sdcanvas");
      ctx = canvas.getContext("2d");
      picker("sd-from", n => from = n);
      picker("sd-to", n => to = n);
      document.getElementById("sd-go").onclick = trace;
      document.getElementById("sd-random").onclick = randomPair;
      window.addEventListener("resize", () => { if (canvas.offsetParent) { resize(); draw(); } });
      CW().onLayerChange(() => {
        if (!canvas.offsetParent) return;
        if (path && from && to) trace(); else draw();
      });
    },
    activate() {
      resize();
      // start fitted to everything
      const cw = CW();
      const xs = d3.extent(cw.nodes, n => n.x), ys = d3.extent(cw.nodes, n => n.y);
      const k = Math.min(W / (xs[1] - xs[0] + 200), H / (ys[1] - ys[0] + 200));
      t = d3.zoomIdentity.translate(W / 2, H / 2).scale(k)
        .translate(-(xs[0] + xs[1]) / 2, -(ys[0] + ys[1]) / 2);
      draw();
    },
  };
})();
