/* Platforms — a separate, narrow view showing ONLY cars that actually share
   a platform with (or are a rebadge/twin of) some OTHER car, plus the
   designers/engineers credited on those specific cars, plus (see
   computeSubset's own comment) each included car's own make node as a
   labeled hub to connect to -- unrelated models and succession-only
   nameplates are still left out entirely, not just dimmed the way an
   unfocused Graph node is. Positions are read straight off the main
   Graph's own simulation (same pattern sixdeg.js already uses for its
   shortest-path view) rather than running a second physics simulation
   just for this subset. */
window.CarWebPlatforms = (function () {
  "use strict";
  const CW = () => window.CarWeb;

  let canvas, ctx, W = 0, H = 0, DPR = 1;
  let t = d3.zoomIdentity, zoom;
  let hoverN = null, selected = null;
  let subset = { nodes: [], links: [] };
  // Click-to-focus: clicking a model/family car node reveals exactly the
  // OTHER cars it shares a platform with (or is related/rebadged to) and
  // fits the viewport to that whole neighborhood, mirroring Graph's own
  // focusOn/flyToSet pattern but scoped to this view's own subset/zoom.
  // focusSet is a Set of node ids (the clicked car, its platform/related
  // neighbors, and each of their own make hubs so the hub-and-spoke
  // structure stays legible instead of looking like dead-end spokes).
  let focusSet = null, focusRoot = null;

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    W = r.width; H = r.height; DPR = window.devicePixelRatio || 1;
    canvas.width = W * DPR; canvas.height = H * DPR;
  }

  // Only "platform" and "related" links count as a real shared-hardware
  // connection here — deliberately NOT "succession" (a later generation
  // replacing an earlier one of the SAME nameplate isn't "sharing a
  // platform with another car", it just IS that car). Gated by the exact
  // same nodeInLayer/linkInLayer rules every other view already respects —
  // retired nodes/links, collapsed families, the designers/engineers/both/
  // none people-layer toggle — so this view is always a strict SUBSET of
  // what Graph would show for the same settings, never something Graph
  // itself couldn't also draw.
  function computeSubset() {
    const cw = CW();
    const carIds = new Set();
    const carLinks = [];
    for (const l of cw.links) {
      if (l.type !== "platform" && l.type !== "related") continue;
      if (l.retired) continue;
      if (!l.sn || !l.tn) continue;
      if (!cw.linkInLayer(l) || !cw.nodeInLayer(l.sn) || !cw.nodeInLayer(l.tn)) continue;
      carIds.add(l.sn.id); carIds.add(l.tn.id);
      carLinks.push(l);
    }
    const personLinks = [];
    if (carIds.size) {
      for (const l of cw.links) {
        if (l.type !== "designed" && l.type !== "engineered") continue;
        if (l.retired) continue;
        if (!l.sn || !l.tn) continue;
        if (!cw.linkInLayer(l) || !cw.nodeInLayer(l.sn) || !cw.nodeInLayer(l.tn)) continue;
        const carEnd = carIds.has(l.sn.id) ? l.sn.id : carIds.has(l.tn.id) ? l.tn.id : null;
        if (!carEnd) continue;
        personLinks.push(l);
      }
    }
    // Real user clarification: "I meant that there should exist that
    // center node with the make name, with the models connected to that
    // name, but the nodes themselves don't have any name on them, just
    // like how it's shown in the Graph tab." Graph's own quiet look comes
    // from a real make HUB node other cars connect to, not from text
    // stamped under every dot -- pull each included car's own make node in
    // too (and a "made" link to it), same structure Graph itself uses, so
    // labeling can move off individual car dots entirely and onto that one
    // shared anchor instead. A GENERATION (familyOf set) often has no
    // direct "made" link of its own -- only its family does -- so this
    // falls back to the family's own make link when the car itself doesn't
    // have one, same inheritance the rest of the app already treats a
    // generation as covered by.
    const allMadeLinks = cw.links.filter(l => l.type === "made" && l.sn && l.tn);
    function findMakeLink(id) {
      return allMadeLinks.find(l => l.sn.id === id || l.tn.id === id) || null;
    }
    const makeLinks = [];
    const makeIds = new Set();
    carIds.forEach(carId => {
      const car = cw.byId.get(carId);
      if (!car) return;
      const link = findMakeLink(carId) || (car.familyOf ? findMakeLink(car.familyOf) : null);
      if (!link) return;
      const makeNode = link.sn.type === "make" ? link.sn : link.tn;
      if (makeNode.type !== "make") return;
      makeIds.add(makeNode.id);
      // A synthetic link straight from THIS car to its make -- not the
      // original link object, which (for a generation inheriting its
      // family's own "made" link) would actually connect the family, not
      // the generation dot on screen.
      makeLinks.push({ source: carId, target: makeNode.id, type: "made", sn: car, tn: makeNode });
    });
    const nodeIds = new Set(carIds);
    personLinks.forEach(l => { nodeIds.add(l.sn.id); nodeIds.add(l.tn.id); });
    makeIds.forEach(id => nodeIds.add(id));
    const nodes = cw.nodes.filter(n => nodeIds.has(n.id));
    return { nodes, links: carLinks.concat(personLinks).concat(makeLinks) };
  }

  function fitToSubset(animMs) {
    if (!subset.nodes.length) return;
    const xs = d3.extent(subset.nodes, n => n.x), ys = d3.extent(subset.nodes, n => n.y);
    const k = Math.max(0.3, Math.min(3, Math.min(W / (xs[1] - xs[0] + 220), H / (ys[1] - ys[0] + 220))));
    const target = d3.zoomIdentity.translate(W / 2, H / 2).scale(k)
      .translate(-(xs[0] + xs[1]) / 2, -(ys[0] + ys[1]) / 2);
    if (animMs) d3.select(canvas).transition().duration(animMs).ease(d3.easeCubicInOut).call(zoom.transform, target);
    else { t = target; d3.select(canvas).call(zoom.transform, target); }
  }

  // Same bounding-box-and-animated-zoom-transform recipe as fitToSubset,
  // but for an arbitrary id set rather than the whole subset -- used to fit
  // just a clicked car's platform/related neighborhood into view.
  function flyToIds(idSet, animMs) {
    const arr = subset.nodes.filter(n => idSet.has(n.id));
    if (!arr.length) return;
    const xs = d3.extent(arr, n => n.x), ys = d3.extent(arr, n => n.y);
    const k = Math.max(0.3, Math.min(4, Math.min(W / (xs[1] - xs[0] + 220), H / (ys[1] - ys[0] + 220))));
    const target = d3.zoomIdentity.translate(W / 2, H / 2).scale(k)
      .translate(-(xs[0] + xs[1]) / 2, -(ys[0] + ys[1]) / 2);
    if (animMs) d3.select(canvas).transition().duration(animMs).ease(d3.easeCubicInOut).call(zoom.transform, target);
    else { t = target; d3.select(canvas).call(zoom.transform, target); }
  }

  // One-hop neighborhood through platform/related links only (this view's
  // own definition of "shares hardware with"), plus each neighbor's own
  // make hub so the spokes into the hub stay lit rather than dead-ending.
  function neighborhoodForFocus(n) {
    const set = new Set([n.id]);
    for (const l of subset.links) {
      if (l.type !== "platform" && l.type !== "related") continue;
      if (l.sn.id === n.id) set.add(l.tn.id);
      else if (l.tn.id === n.id) set.add(l.sn.id);
    }
    const carIds = [...set];
    for (const l of subset.links) {
      if (l.type !== "made") continue;
      if (carIds.includes(l.sn.id)) set.add(l.tn.id);
    }
    return set;
  }

  function focusOn(n) {
    focusRoot = n; selected = n;
    focusSet = neighborhoodForFocus(n);
    const btn = document.getElementById("platformsclearfocus");
    if (btn) btn.hidden = false;
    flyToIds(focusSet, 700);
    draw();
  }

  function clearFocus() {
    focusSet = null; focusRoot = null; selected = null;
    const btn = document.getElementById("platformsclearfocus");
    if (btn) btn.hidden = true;
    fitToSubset(700);
    draw();
  }

  function personStroke(cw, n, r) {
    const useEng = cw.hasRole(n, "engineer") && (cw.layer() === "engineers" || !cw.hasRole(n, "designer"));
    ctx.lineWidth = Math.max(2, r * 0.42);
    ctx.strokeStyle = useEng ? cw.C.engineer : cw.C.designer;
    ctx.stroke();
  }

  function draw() {
    const cw = CW(), C = cw.C;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const hint = document.getElementById("platformshint");
    if (hint) hint.hidden = subset.nodes.length > 0;
    if (!subset.nodes.length) return;
    ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);
    const k = t.k;

    for (const l of subset.links) {
      // When a car is focused, only edges with BOTH ends inside the
      // focus set (its platform/related neighbors and their make hubs)
      // stay at full strength -- everything else fades way down, same
      // dimming role Graph's own aSet/visible() plays for its focus mode.
      const dim = !focusSet || (focusSet.has(l.sn.id) && focusSet.has(l.tn.id)) ? 1 : 0.06;
      ctx.beginPath(); ctx.moveTo(l.sn.x, l.sn.y); ctx.lineTo(l.tn.x, l.tn.y);
      if (l.type === "platform") {
        ctx.strokeStyle = C.accent; ctx.globalAlpha = 0.8 * dim; ctx.lineWidth = 2.1 / k; ctx.setLineDash([5 / k, 4 / k]);
      } else if (l.type === "related") {
        ctx.strokeStyle = C.accent; ctx.globalAlpha = 0.5 * dim; ctx.lineWidth = 1.4 / k; ctx.setLineDash([2.5 / k, 4 / k]);
      } else if (l.type === "made") {
        ctx.strokeStyle = C.muted; ctx.globalAlpha = 0.4 * dim; ctx.lineWidth = 1 / k; ctx.setLineDash([]);
      } else if (l.type === "designed") {
        ctx.strokeStyle = C.designer; ctx.globalAlpha = 0.45 * dim; ctx.lineWidth = 1.3 / k; ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = C.engineer; ctx.globalAlpha = 0.6 * dim; ctx.lineWidth = 1.6 / k; ctx.setLineDash([]);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const n of subset.nodes) {
      const r = Math.max(n.r, 2.6 / k) * (n === hoverN ? 1.35 : 1);
      ctx.globalAlpha = !focusSet || focusSet.has(n.id) ? 1 : 0.12;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      if (n.type === "make") {
        ctx.fillStyle = C.ink; ctx.fill();
      } else if (n.type === "model") {
        ctx.fillStyle = n.heritage ? C.heritage : C.accent; ctx.fill();
      } else if (n.type === "family") {
        ctx.fillStyle = n.heritage ? C.heritage : C.accent; ctx.fill();
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 1.8 / k, 0, 2 * Math.PI);
        ctx.lineWidth = 1.1 / k; ctx.strokeStyle = C.ink; ctx.stroke();
      } else {
        ctx.fillStyle = C.card; ctx.fill();
        personStroke(cw, n, r);
      }
      if (n === selected) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 5 / k, 0, 2 * Math.PI);
        ctx.lineWidth = 1.6 / k; ctx.strokeStyle = C.ink; ctx.stroke();
      }
    }

    // Real user clarification: the make's name belongs on the hub node
    // itself (like Graph's own make bubbles), not repeated as text under
    // every single car dot. So: make nodes are always labeled; car (model/
    // family) dots carry NO label at all unless actually clicked -- the
    // floating hover tooltip (showHover, wired in pointermove below)
    // already surfaces a car's name on hover without adding to the
    // permanent on-canvas clutter. People are a small, always-relevant set
    // here (this view exists specifically to show who worked on what), so
    // their labels are unaffected. Still runs through the same
    // screen-space collision check Graph's own draw() uses, so a cluster
    // of make/person labels sitting close together thins itself out
    // instead of overlapping.
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const placed = [];
    const collides = (x, y, w, h) => {
      for (const r of placed)
        if (x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]) return true;
      placed.push([x, y, w, h]);
      return false;
    };
    function drawLabel(n, label, fs, font, col, skipCollision) {
      ctx.font = font;
      const r = Math.max(n.r, 2.6 / k);
      const y = n.y + r + 3.5 / k;
      const w = ctx.measureText(label).width;
      if (!skipCollision && collides((n.x - w / 2) * k + t.x, y * k + t.y, w * k, fs * 1.25 * k)) return;
      ctx.lineWidth = 3.4 / Math.min(k, 1); ctx.strokeStyle = C.paper; ctx.strokeText(label, n.x, y);
      ctx.fillStyle = col; ctx.fillText(label, n.x, y);
    }
    // Makes first, so they win any collision tie-break over a person label
    // sitting nearby -- the hub is the one anchor every car in this view is
    // meant to be read relative to.
    for (const n of subset.nodes) {
      if (n.type !== "make") continue;
      const fs = 13 / Math.min(k, 1.3);
      drawLabel(n, n.label.toUpperCase(), fs, `600 ${fs}px Inter, sans-serif`, C.ink, false);
    }
    for (const n of subset.nodes) {
      if (n.type !== "person") continue;
      const fs = 12 / Math.min(k, 1.3);
      const col = cw.hasRole(n, "engineer") && (cw.layer() === "engineers" || !cw.hasRole(n, "designer")) ? C.engineer : C.designer;
      drawLabel(n, n.label, fs, `italic 600 ${fs}px Georgia, serif`, col, false);
    }
    // Clicking a car reveals its whole platform/related neighborhood, not
    // just itself -- label every car in the focus set (not only the one
    // that was actually clicked), same "reveal" the dimming above implies.
    // Falls back to labeling just the plain `selected` car when nothing is
    // focused (e.g. right after a focus is released but a stray selection
    // lingers), matching the single-label behavior this view had before.
    if (focusSet) {
      for (const n of subset.nodes) {
        if ((n.type !== "model" && n.type !== "family") || !focusSet.has(n.id)) continue;
        const fs = 11.5 / Math.min(k, 1.3);
        drawLabel(n, `${n.make} ${n.label}`, fs, `500 ${fs}px Inter, sans-serif`, C.ink, true);
      }
    } else if (selected && (selected.type === "model" || selected.type === "family")) {
      const fs = 11.5 / Math.min(k, 1.3);
      drawLabel(selected, `${selected.make} ${selected.label}`, fs, `500 ${fs}px Inter, sans-serif`, C.ink, true);
    }
    ctx.globalAlpha = 1;
  }

  function pick(mx, my) {
    const [wx, wy] = t.invert([mx, my]);
    let best = null, bd = 14 / t.k + 4;
    for (const n of subset.nodes) {
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < n.r + 8 / t.k && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function refresh() {
    subset = computeSubset();
    // A layer toggle or family expand/collapse can change which cars even
    // qualify for this view -- if the currently-focused car dropped out of
    // the new subset entirely, release focus rather than hold onto stale
    // ids; otherwise recompute the neighborhood fresh (mirrors Graph's own
    // refreshFocus after a live structural change).
    if (focusRoot) {
      const stillThere = subset.nodes.some(n => n.id === focusRoot.id);
      if (stillThere) {
        focusSet = neighborhoodForFocus(focusRoot);
      } else {
        focusSet = null; focusRoot = null; selected = null;
        const btn = document.getElementById("platformsclearfocus");
        if (btn) btn.hidden = true;
      }
    }
    draw();
  }

  return {
    init() {
      canvas = document.getElementById("platformscanvas");
      ctx = canvas.getContext("2d");
      zoom = d3.zoom().scaleExtent([0.15, 6]).on("zoom", e => { t = e.transform; draw(); });
      d3.select(canvas).call(zoom).on("dblclick.zoom", null);

      let downPt = null, moved = false;
      canvas.addEventListener("pointerdown", e => { downPt = [e.clientX, e.clientY]; moved = false; });
      canvas.addEventListener("pointermove", e => {
        if (downPt && Math.hypot(e.clientX - downPt[0], e.clientY - downPt[1]) > 4) moved = true;
        const r = canvas.getBoundingClientRect();
        const n = pick(e.clientX - r.left, e.clientY - r.top);
        if (n !== hoverN) {
          hoverN = n; draw();
          canvas.style.cursor = n ? "pointer" : "grab";
          if (n) CW().showHover(n, e.clientX, e.clientY); else CW().hideHover();
        } else if (n) CW().positionHover(e.clientX, e.clientY);
      });
      canvas.addEventListener("pointerleave", () => { hoverN = null; CW().hideHover(); draw(); });
      canvas.addEventListener("click", e => {
        if (moved) return;
        const r = canvas.getBoundingClientRect();
        const n = pick(e.clientX - r.left, e.clientY - r.top);
        if (n) {
          // Only cars have a platform/related neighborhood worth revealing --
          // clicking a make hub or a person just selects it, same as before.
          if (n.type === "model" || n.type === "family") focusOn(n);
          else { selected = n; draw(); }
          CW().openDetail(n);
        } else if (focusSet) {
          clearFocus();
        }
      });
      const clearBtn = document.getElementById("platformsclearfocus");
      if (clearBtn) clearBtn.onclick = clearFocus;

      window.addEventListener("resize", () => { if (canvas.offsetParent) { resize(); draw(); } });
      // Recompute (not just redraw) on anything that can change which cars
      // qualify: the people-layer toggle changes which designed/engineered
      // links pass linkInLayer, and expanding/collapsing a nameplate swaps
      // which specific node (family vs. generation) a platform link's
      // endpoint resolves to.
      CW().onLayerChange(() => { if (canvas.offsetParent) refresh(); });
      CW().onFamilyChange(() => { if (canvas.offsetParent) refresh(); });
    },
    activate() {
      resize();
      subset = computeSubset();
      // A fresh entry into the tab always starts from the full overview,
      // same as switching to Graph doesn't carry over a stale focus ring
      // from three clicks ago.
      focusSet = null; focusRoot = null; selected = null;
      const btn = document.getElementById("platformsclearfocus");
      if (btn) btn.hidden = true;
      fitToSubset(false);
      draw();
    },
    touch() { if (canvas && canvas.offsetParent) refresh(); },
    // Exposes the currently-computed {nodes, links} subset -- same rationale
    // as Graph's own state() getter: lets the jsdom regression suite assert
    // on exactly what this view decided to show without having to inspect
    // canvas pixels.
    subset: () => subset,
    // Same rationale as Graph's own state() getter -- lets the jsdom suite
    // assert on the focus set/camera transform directly instead of
    // inspecting canvas pixels.
    state: () => ({ t, focusSet, focusRoot, selected }),
    focusOn,
    clearFocus,
  };
})();
