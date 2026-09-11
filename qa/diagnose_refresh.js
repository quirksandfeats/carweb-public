/* Why does the DBpedia refresh keep finding the same thing?  (v3)
 *
 * Paste into the console with the app open, then click the footer status to
 * refresh. READ-ONLY -- it watches, it never writes.
 *
 * v1 and v2 asked whether the saved result was being applied. It is. So v3
 * asks the only question left, and answers it by id:
 *
 *     the refresh says N cars are new -- ARE they in the graph already?
 *
 * If they ARE, the comparison is broken and this prints which key missed.
 * If they are NOT, the saved result isn't reaching the graph and this prints
 * where it was lost. Those are different bugs with different fixes, and
 * nothing short of this distinguishes them.
 */
(function () {
  const LS_KEY = "carweb_live_snapshot_v1";
  const out = (...a) => console.log("%c[diag3]", "color:#b45309;font-weight:600", ...a);
  const lid = v => (v && typeof v === "object" && v.id) ? v.id : v;
  const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");

  const snapshotGraph = () => {
    const ids = new Set(), wps = new Map(), links = new Set();
    for (const n of window.CARDATA.nodes) { ids.add(n.id); if (n.wp) wps.set(norm(n.wp), n.id); }
    for (const l of window.CARDATA.links) {
      const s = lid(l.source), t = lid(l.target);
      links.add(s + "|" + t + "|" + l.type); links.add(t + "|" + s + "|" + l.type);
    }
    return { ids, wps, links };
  };
  const G = snapshotGraph();
  out("graph right now:", G.ids.size, "cars,", window.CARDATA.links.length, "connections");

  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) {}
  out("stored before this refresh:", prev
    ? `${(prev.newNodes || []).length} cars, ${(prev.newLinks || []).length} connections, ${Object.keys(prev.updates || {}).length} field updates`
    : "nothing");

  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    if (k !== LS_KEY) return realSet(k, v);
    let d = null; try { d = JSON.parse(v); } catch (e) {}
    const nodes = (d && d.newNodes) || [], links = (d && d.newLinks) || [], upd = (d && d.updates) || {};
    out("=== the refresh is saving:", nodes.length, "cars,", links.length, "connections,",
        Object.keys(upd).length, "field updates ===");

    const alreadyById = nodes.filter(n => G.ids.has(n.id));
    const alreadyByWp = nodes.filter(n => !G.ids.has(n.id) && n.wp && G.wps.has(norm(n.wp)));
    const genuinelyNew = nodes.filter(n => !G.ids.has(n.id) && !(n.wp && G.wps.has(norm(n.wp))));
    out("  cars -> already in graph by id:", alreadyById.length,
        "| same car under a DIFFERENT id:", alreadyByWp.length,
        "| genuinely absent:", genuinelyNew.length);
    if (alreadyById.length) out("    !! COMPARISON IS BROKEN — these are already in the graph by id:",
                                alreadyById.slice(0, 8).map(n => n.id));
    if (alreadyByWp.length) out("    !! SAME CAR, DIFFERENT ID — the graph has these under another id:",
                                alreadyByWp.slice(0, 8).map(n => n.id + " -> " + G.wps.get(norm(n.wp))));
    if (genuinelyNew.length) out("    genuinely absent (expected on a first run):",
                                 genuinelyNew.slice(0, 8).map(n => n.id));

    const linkPresent = links.filter(l => G.links.has(l.source + "|" + l.target + "|" + l.type));
    const linkDangling = links.filter(l => !G.ids.has(l.source) || !G.ids.has(l.target));
    out("  connections -> already in graph:", linkPresent.length,
        "| endpoint missing from graph:", linkDangling.length,
        "| genuinely new:", links.length - linkPresent.length - linkDangling.length);
    if (linkPresent.length) out("    !! COMPARISON IS BROKEN — already present:", linkPresent.slice(0, 6));
    if (linkDangling.length) out("    endpoints missing:", linkDangling.slice(0, 6));

    for (const id of Object.keys(upd).slice(0, 5)) {
      const node = window.CARDATA.nodes.find(n => n.id === id);
      out("  field update", id, JSON.stringify(upd[id]),
          node ? `-> car exists, end=${JSON.stringify(node.end)} designers=${(node.designers || []).length}`
               : "-> !! NO SUCH CAR — can never apply");
    }
    return realSet(k, v);
  };
  out("watching. Click the footer status now.");
})();
