/* Timeline view — country lanes, scrubbable year, designer careers */
window.CarWebTimeline = (function () {
  "use strict";
  const CW = () => window.CarWeb;

  const LANES = [
    ["Italy", ["Italy"]],
    ["Germany", ["Germany"]],
    ["Britain", ["United Kingdom"]],
    ["France", ["France"]],
    ["Rest of Europe", ["Sweden", "Spain", "Netherlands", "Belgium", "Switzerland", "Austria",
      "Denmark", "Norway", "Czech Republic", "Poland", "Serbia", "Romania", "Ukraine", "Russia",
      "Croatia", "Greece", "Portugal", "Latvia", "Slovenia"]],
    ["Japan", ["Japan"]],
    ["Korea", ["South Korea"]],
    ["China", ["China", "Taiwan"]],
    ["America & Australia", ["United States", "Canada", "Mexico", "Australia", "Argentina", "Brazil"]],
    ["Rest of world", []],
  ];

  let built = false, svg, x, playYear = 2026, playing = false, raf = null;
  let dots = [], laneOf = new Map(), highlightMake = null;
  let W = 0, H = 0, M = { l: 46, r: 34, t: 26, b: 34 }, laneH = 0;
  const Y0 = 1880, Y1 = 2027;
  let dotSel = null, runG = null, selectedDot = null;

  // "Follow…" can now track either a person (by name) or a nameplate family
  // (by id) — the timeline draws the same kind of connecting line through
  // whichever cars match, in year order.
  let followKind = "", followId = "", followExpandedFam = null;
  function clearFollowExpand() {
    if (followExpandedFam) { CW().collapseFamily(followExpandedFam); followExpandedFam = null; }
  }
  function setFollow(kind, id) {
    clearFollowExpand();
    followKind = kind; followId = id;
    if (kind === "family") {
      const cw = CW();
      if (!cw.isFamilyExpanded(id)) { cw.expandFamily(id); followExpandedFam = id; }
    }
  }
  function clearFollow() { setFollow("", ""); }
  function matchFollow(m) {
    if (followKind === "person") return personOn(m, followId);
    if (followKind === "family") return m.type === "family" ? m.id === followId : m.familyOf === followId;
    return false;
  }
  function followLabel() {
    if (followKind === "person") return followId;
    if (followKind === "family") { const f = CW().byId.get(followId); return f ? `${f.make} ${f.label}` : ""; }
    return "";
  }

  function laneForCountry(c) {
    for (let i = 0; i < LANES.length; i++) if (LANES[i][1].includes(c)) return i;
    return LANES.length - 1;
  }

  // A collapsed nameplate family shows as ONE dot spanning its whole run
  // (family.year..family.end already cover the earliest..latest generation).
  // Expanding it (click) swaps that single dot for its individual generation
  // dots, each with its own debut year and run — the family dot itself is
  // hidden while expanded so the two never show side by side.
  function timelineNodes() {
    const cw = CW();
    return cw.nodes.filter(n => (n.type === "model" || n.type === "family") &&
      cw.nodeInLayer(n) && !(n.type === "family" && cw.isFamilyExpanded(n.id)));
  }
  function toggleFamily(id) {
    const cw = CW();
    if (cw.isFamilyExpanded(id)) cw.collapseFamily(id); else cw.expandFamily(id);
  }

  // dodge-pack dots per lane, from the current (family-aware) node set
  function layoutDots() {
    const items = timelineNodes();
    items.forEach(m => {
      if (laneOf.has(m.id)) return;
      const cw = CW();
      const mk = cw.byId.get("mk-" + slug(m.make)) || (cw.adj.get(m.id).find(a => a.l.type === "made") || {}).n;
      laneOf.set(m.id, laneForCountry(mk ? mk.country : ""));
    });
    dots = [];
    LANES.forEach((L, li) => {
      const laneMid = M.t + 40 + li * laneH + laneH / 2 - 3;
      const ms = items.filter(m => laneOf.get(m.id) === li).sort((a, b) => a.year - b.year || a.label.localeCompare(b.label));
      const slots = [];
      ms.forEach(m => {
        const px = x(m.year + (hash(m.id) % 10) / 12);
        let s = 0;
        for (; s < slots.length; s++) if (px - slots[s] > 6.5) break;
        if (s === slots.length) slots.push(0);
        slots[s] = px;
        const off = Math.ceil(s / 2) * 6.6 * (s % 2 ? -1 : 1);
        const py = laneMid + off;
        dots.push({ n: m, x: px, y: Math.max(M.t + 46, Math.min(H - M.b - 8, py)) });
      });
    });
    return dots;
  }

  function showRun(d) {
    runG.selectAll("*").remove();
    const end = d.n.end || 2026.5;
    runG.append("line").attr("class", "tl-run")
      .attr("x1", d.x).attr("x2", x(end)).attr("y1", d.y).attr("y2", d.y)
      .attr("stroke-width", 5).attr("stroke-linecap", "round");
    if (!d.n.end) runG.append("text").attr("x", x(2026.7)).attr("y", d.y + 3)
      .attr("font-size", 9).attr("fill", "#8a7f6c").text("→");
  }
  function pulse(d) {
    svg.append("circle").attr("cx", d.x).attr("cy", d.y).attr("r", 5)
      .attr("fill", "none").attr("stroke", "#c2451d").attr("stroke-width", 2)
      .transition().duration(700).attr("r", 22).style("opacity", 0).remove();
  }

  function renderDots() {
    dotSel = svg.select("#tl-dots").selectAll("circle").data(dots, d => d.n.id).join("circle")
      .attr("class", d => "tl-dot" + (d.n.type === "family" ? " family" : "") +
        (d.n.heritage ? " heritage" : "") + (d.n.db ? " db" : "") + (d.n.garage ? " garage" : ""))
      .attr("cx", d => d.x).attr("cy", d => d.y).attr("r", d => d.n.type === "family" ? 4.2 : 3.1)
      .on("pointerenter", (e, d) => { CW().showHover(d.n, e.clientX, e.clientY); showRun(d); })
      .on("pointermove", (e) => CW().positionHover(e.clientX, e.clientY))
      .on("pointerleave", () => { CW().hideHover(); if (!selectedDot) runG.selectAll("*").remove(); })
      .on("click", (e, d) => {
        if (d.n.type === "family") { toggleFamily(d.n.id); return; }
        selectedDot = d; CW().openDetail(d.n); showRun(d); pulse(d);
      });
    if (api._applyDim) api._applyDim();
  }

  // re-lays-out and re-binds dots after a family expand/collapse, without
  // tearing down the axes/lanes/playhead built once in build().
  function rebuildDots() {
    if (!built) return;
    layoutDots();
    renderDots();
    drawCareer();
  }

  function build() {
    const el = document.getElementById("tl-scroll");
    W = el.clientWidth; H = el.clientHeight - 8;
    laneH = (H - M.t - M.b - 40) / LANES.length;
    svg = d3.select("#tlsvg").attr("width", W).attr("height", H);
    svg.selectAll("*").remove();
    x = d3.scaleLinear().domain([Y0, Y1]).range([M.l, W - M.r]);

    laneOf = new Map();

    // decade watermarks + grid
    const g = svg.append("g");
    for (let d = 1890; d <= 2020; d += 10) {
      g.append("line").attr("x1", x(d)).attr("x2", x(d)).attr("y1", M.t + 18).attr("y2", H - M.b)
        .attr("stroke", "#d9cfbc").attr("stroke-width", 1).attr("stroke-dasharray", d % 20 ? "2 5" : null);
      g.append("text").attr("class", "tl-decade").attr("x", x(d) + 6).attr("y", M.t + 34).text(d);
    }

    // lanes
    LANES.forEach((L, i) => {
      const y = M.t + 40 + i * laneH;
      svg.append("line").attr("x1", M.l - 10).attr("x2", W - M.r).attr("y1", y + laneH - 6).attr("y2", y + laneH - 6)
        .attr("stroke", "#d9cfbc").attr("stroke-width", i === LANES.length - 1 ? 0 : 0.75);
      svg.append("text").attr("class", "tl-makelabel")
        .attr("x", M.l - 4).attr("y", y + 13)
        .text(L[0].toUpperCase());
    });

    // production runs (revealed on hover/select)
    runG = svg.append("g").attr("id", "tl-runs");
    svg.append("g").attr("id", "tl-dots");
    selectedDot = null;
    layoutDots();
    renderDots();

    // playhead
    const ph = svg.append("g").attr("class", "tl-playhead-grab");
    const phLine = ph.append("line").attr("class", "tl-playhead").attr("y1", M.t + 14).attr("y2", H - M.b + 6);
    const phGrab = ph.append("rect").attr("y", M.t).attr("width", 26, 0).attr("height", H - M.t - M.b + 10)
      .attr("fill", "transparent");
    const phFlag = ph.append("path").attr("d", "M0,0 l0,14 l9,-7 z").attr("fill", "#17140f");
    ph.call(d3.drag()
      .on("start drag", (e) => { setYear(Math.round(x.invert(e.x))); stopPlay(); }));
    svg.on("click", (e) => {
      if (e.target.tagName === "svg") { setYear(Math.round(x.invert(d3.pointer(e, svg.node())[0]))); stopPlay(); }
    });

    careerG = svg.append("g");

    function setYear(y) {
      playYear = Math.max(Y0 + 1, Math.min(2026, y));
      document.getElementById("tl-year").textContent = playYear;
      const px = x(playYear);
      phLine.attr("x1", px).attr("x2", px);
      phGrab.attr("x", px - 13);
      phFlag.attr("transform", `translate(${px + 1},${M.t + 14})`);
      applyDim();
    }
    api._setYear = setYear;

    function applyDim() {
      const dbOn = CW().dbFilterOn();
      dotSel.attr("opacity", d => {
        let o = d.n.year > playYear ? 0.13 : 1;
        if (followKind && !matchFollow(d.n)) o = Math.min(o, 0.08);
        if (highlightMake && d.n.make !== highlightMake) o = Math.min(o, 0.08);
        if (dbOn && !d.n.db) o = Math.min(o, 0.08);
        return o;
      }).attr("r", d => d.n.type === "family" ?
        (d.n.year === playYear ? 6.5 : 4.2) : (d.n.year === playYear ? 5.5 : 3.1));
    }
    api._applyDim = applyDim;
    setYear(2026);
    built = true;
  }

  // does this person appear on the model, within the active layer?
  function personOn(m, name) {
    const cw = CW(), L = cw.layer();
    const des = (m.designers || []).includes(name);
    const eng = (m.engineers || []).includes(name);
    if (L === "designers") return des;
    if (L === "engineers") return eng;
    return des || eng;
  }

  let careerG = null;
  function drawCareer() {
    careerG.selectAll("*").remove();
    if (!followKind) return;
    const pts = dots.filter(d => matchFollow(d.n)).sort((a, b) => a.n.year - b.n.year);
    if (pts.length < 1) return;
    const line = d3.line().x(d => d.x).y(d => d.y).curve(d3.curveCatmullRom.alpha(0.6));
    const path = careerG.append("path").attr("class", "tl-career").attr("d", line(pts));
    const len = path.node().getTotalLength();
    path.attr("stroke-dasharray", len).attr("stroke-dashoffset", len)
      .transition().duration(1400).ease(d3.easeCubicInOut).attr("stroke-dashoffset", 0);
    careerG.selectAll("circle").data(pts).join("circle").attr("class", "tl-careerdot")
      .attr("cx", d => d.x).attr("cy", d => d.y).attr("r", 0)
      .on("pointerenter", (e, d) => CW().showHover(d.n, e.clientX, e.clientY))
      .on("pointerleave", () => CW().hideHover())
      .on("click", (e, d) => CW().openDetail(d.n))
      .transition().delay((d, i) => i * (1400 / pts.length)).attr("r", 6);
    const span = d3.extent(pts, d => d.n.year);
    const noun = followKind === "family" ? "generations" : "cars in the web";
    document.getElementById("tl-caption").textContent =
      `${followLabel()}: ${pts.length} ${noun}, ${span[0]}–${span[1]}`;
  }

  function stopPlay() {
    playing = false; document.getElementById("tl-play").textContent = "▶";
    if (raf) cancelAnimationFrame(raf);
  }
  function play() {
    if (playing) { stopPlay(); return; }
    playing = true; document.getElementById("tl-play").textContent = "❚❚";
    if (playYear >= 2026) api._setYear(Y0 + 1);
    let last = 0;
    const step = (ts) => {
      if (!playing) return;
      if (ts - last > 130) { last = ts; api._setYear(playYear + 1); }
      if (playYear >= 2026) { stopPlay(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function slug(s) {
    return s.toLowerCase().replace(/[àáâä]/g, "a").replace(/[èéêë]/g, "e").replace(/[ìíîï]/g, "i")
      .replace(/[òóôö]/g, "o").replace(/[ùúûü]/g, "u").replace(/[çč]/g, "c").replace(/[šś]/g, "s")
      .replace(/ß/g, "ss").replace(/ž/g, "z").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

  function fillPicker() {
    const sel = document.getElementById("tl-designer");
    const cw = CW(), L = cw.layer();
    const role = L === "engineers" ? "engineer" : L === "designers" ? "designer" : null;
    const keep = followKind === "person" ? "p:" + followId : followKind === "family" ? "f:" + followId : "";
    sel.innerHTML = "";
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = "Follow…";
    sel.appendChild(o0);

    const peopleLabel = L === "engineers" ? "Engineers" : L === "designers" ? "Designers" : "People";
    const peopleGroup = document.createElement("optgroup");
    peopleGroup.label = peopleLabel;
    const ds = cw.nodes.filter(n => n.type === "person" && (!role || cw.hasRole(n, role)))
      .map(d => [d.label, cw.adj.get(d.id).length]).sort((a, b) => b[1] - a[1]).slice(0, 400);
    ds.forEach(([name, n]) => {
      const o = document.createElement("option");
      o.value = "p:" + name; o.textContent = `${name} (${n})`;
      peopleGroup.appendChild(o);
    });
    sel.appendChild(peopleGroup);

    const famGroup = document.createElement("optgroup");
    famGroup.label = "Nameplates";
    const fams = cw.nodes.filter(n => n.type === "family")
      .sort((a, b) => b.generations.length - a.generations.length);
    fams.forEach(f => {
      const o = document.createElement("option");
      o.value = "f:" + f.id; o.textContent = `${f.make} ${f.label} (${f.generations.length} gens)`;
      famGroup.appendChild(o);
    });
    sel.appendChild(famGroup);

    const valid = new Set([...ds.map(d => "p:" + d[0]), ...fams.map(f => "f:" + f.id)]);
    sel.value = keep && valid.has(keep) ? keep : "";
    if (sel.value !== keep) clearFollow();
  }

  const api = {
    init() {
      document.getElementById("tl-play").onclick = play;
      const sel = document.getElementById("tl-designer");
      fillPicker();
      sel.onchange = () => {
        const v = sel.value;
        highlightMake = null;
        if (!v) clearFollow();
        else setFollow(v.slice(0, 2) === "p:" ? "person" : "family", v.slice(2));
        if (built) { api._applyDim(); drawCareer(); }
        if (!followKind) document.getElementById("tl-caption").textContent =
          "drag the year, or press play — dots are model debuts; lines are production runs";
      };
      CW().onLayerChange(() => {
        fillPicker();
        if (built) { api._applyDim(); drawCareer(); }
      });
      CW().onDbFilterChange(() => { if (built) api._applyDim(); });
      // fillPicker() too, not just rebuildDots(): a family created live (an
      // LLM-confirmed generation split, applied without a reload) needs to
      // show up in the "Nameplates" follow-list right away, same as it
      // already does after a normal page load.
      CW().onFamilyChange(() => { fillPicker(); rebuildDots(); });
    },
    activate() {
      if (!built) build();
      else {
        const el = document.getElementById("tl-scroll");
        if (Math.abs(el.clientWidth - W) > 60) { built = false; build(); drawCareer(); }
      }
    },
    goto(n) {
      if (!built) build();
      if (n.type === "person") {
        setFollow("person", n.label);
        document.getElementById("tl-designer").value = "p:" + n.label;
        api._applyDim(); drawCareer(); return;
      }
      if (n.type === "make") {
        highlightMake = n.label; clearFollow();
        document.getElementById("tl-designer").value = "";
        api._applyDim();
        document.getElementById("tl-caption").textContent = `${n.label} models highlighted`;
        return;
      }
      const cw = CW();
      if (n.familyOf && !cw.isFamilyExpanded(n.familyOf)) cw.expandFamily(n.familyOf);  // reveals its dot
      api._setYear(n.year);
      CW().openDetail(n);
      const d = dots.find(d => d.n === n);
      if (d) {
        svg.append("circle").attr("cx", d.x).attr("cy", d.y).attr("r", 5)
          .attr("fill", "none").attr("stroke", "#c2451d").attr("stroke-width", 2.5)
          .transition().duration(900).attr("r", 30).style("opacity", 0).remove();
      }
    },
  };
  return api;
})();
