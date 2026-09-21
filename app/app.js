/* The Car Web — core + graph view */
window.CarWeb = (function () {
  "use strict";

  const C = {
    paper: "#f6f1e7", card: "#fffdf7", ink: "#17140f", ink2: "#4a4335",
    muted: "#8a7f6c", hairline: "#d9cfbc", accent: "#c2451d",
    designer: "#34586e", engineer: "#9a6b2f", heritage: "#9c8b6d",
    dbGold: "#b3891f", gensucc: "#2f7d5c",
    // The powertrain layer's second accent, for an engine variant -- the
    // same --accent2 the legend's swatch uses.
    engvar: "#c98b2e",
  };

  // ---------- data ----------
  const DATA = window.CARDATA;
  const nodes = DATA.nodes, links = DATA.links;
  // Real bug report: a car added by hand via the "Add Car" panel would
  // vanish on the very next page load -- clicking its make or searching for
  // it found nothing, because nothing about it was ever recorded anywhere
  // this boot-time rebuild (fresh off cars.json/data.js every single time)
  // could see. Must run FIRST, before applyConfirmed/applyAllFamilyOverrides
  // /applyResolvedRelations below -- any of those could target this exact
  // car (e.g. a confirmed generation split on a nameplate the user typed in
  // by hand), so its base node has to already exist before they run. See
  // llm_families.js's applyUserCars/registerUserCar for the full story.
  if (window.LlmFamilies) window.LlmFamilies.applyUserCars(nodes, links);
  // Real user request: "the info box should have a location for the user
  // to be able to put in the wikipedia link with the car associated" -- a
  // manually-pasted or automatically-discovered (see mintRelatedNode's own
  // background lookup) Wikipedia link for a node that had none needs to be
  // re-stamped back onto it every boot, same "nothing survives a reload
  // except by deterministic replay" reasoning as applyUserCars just above,
  // and run right alongside it since either could target a node the checks
  // below immediately care about (a freshly-linked node is eligible for a
  // real generation/platform check the moment it has a `wp`).
  if (window.LlmFamilies) window.LlmFamilies.applyWpLinks(nodes);
  // Replay every hand-driven "merge these models into one nameplate"
  // decision (Tools -> Modify Existing Car; see llm_families.js's
  // applyMerges/mergeModelsIntoNameplate). Runs here, alongside the other
  // two replays and before every check below, for exactly the same reason
  // they do: a merge turns a plain model into a FAMILY and adopts other
  // models as its generations, and applyConfirmed/applyAllFamilyOverrides/
  // applyResolvedRelations all branch on whether a node is a family, so they
  // have to see the final structure rather than the loose models it was
  // built from.
  if (window.LlmFamilies) window.LlmFamilies.applyMerges(nodes, links);
  // Apply any already-confirmed LLM-discovered generation splits (see
  // llm_families.js) before anything below indexes nodes/links — this turns
  // the affected model node into a family + mints its generation nodes in
  // place, so every other view treats it exactly like a build-time family.
  if (window.LlmFamilies) window.LlmFamilies.applyConfirmed(nodes, links);
  // Same idea, for any already-"applied" nameplate generation-list override
  // (see llm_families.js's checkFamily/applyFamilyOverride) -- without this,
  // clicking Accept on a cross-check discrepancy only ever took effect in
  // the live tab that clicked it, and reverted right back on the very next
  // reload since nodes/links are rebuilt fresh from cars.json/data.js every
  // boot. Runs after applyConfirmed (an override can target a family that
  // only exists because of an LLM-confirmed split) and before
  // applyResolvedRelations (a relation resolution should see the FINAL
  // generation set, not one an override is about to retire generations out
  // of).
  if (window.LlmFamilies) window.LlmFamilies.applyAllFamilyOverrides(nodes, links);
  // The powertrain layer, replayed from what was stored the same way every
  // other layer here is. Synchronous by design: the indexes below are built
  // from `nodes` a few lines later, so an engine that arrived a tick late
  // would be invisible to every one of them.
  if (window.LlmFamilies && window.LlmFamilies.applyEngines) {
    try {
      const r = window.LlmFamilies.applyEngines(nodes, links);
      // Plus every engine a checked car merely NAMED -- recorded when that car
      // was checked, never followed. These arrive unresearched, which is what
      // the Powertrain view shows as a bare engine with no variants.
      const m = window.LlmFamilies.applyEngineMentions(nodes, links);
      // Merges last: they fold one engine into another, so both have to exist
      // first -- the read ones from applyEngines, the merely-mentioned ones
      // from applyEngineMentions.
      const merged = window.LlmFamilies.applyEngineMerges
        ? window.LlmFamilies.applyEngineMerges(nodes, links) : 0;
      if (merged) console.info(`[carweb] powertrain: ${merged} engine merge(s) replayed`);
      // ...and the tidying that has to see every engine at once, read or not:
      // an engine still named after its maker or after the index it was found
      // in, a car drawn to a nameplate AND to one of its generations, and a
      // car that can now be moved onto the variant its own infobox named.
      // applyEngines only ever reached the engines with a stored article,
      // which in the real graph is eleven of a hundred and thirty-five.
      if (window.LlmFamilies.tidyPowertrain) {
        const t = window.LlmFamilies.tidyPowertrain(nodes, links);
        if (t.relabelled || t.dropped || t.bound) {
          console.info(`[carweb] powertrain: ${t.relabelled} renamed, ${t.dropped} link(s) ` +
                       `dropped from a nameplate its generation already covers, ` +
                       `${t.bound} car(s) moved onto a specific variant`);
        }
      }
      if (r.engines || m.engines) {
        console.info(`[carweb] powertrain: ${r.engines} engine(s) read, ${r.variants} variant(s), ` +
                     `${m.engines} mentioned but unread, ${r.fitted + m.fitted} fitted connection(s)`);
      }
    } catch (e) { console.warn("CarWeb: could not replay the powertrain layer", e); }
  }
  // A shared-platform/rebadge mention is often stated on only ONE of the
  // two nameplates' own Wikipedia articles (real bug report: the Infiniti
  // QX30's article says it shares a platform with the Mercedes-Benz
  // A-Class, but the A-Class's own article never mentions the QX30 back) --
  // this covers every already-checked "none" verdict (a nameplate that
  // never split into multiple generations, but still had a single-
  // generation platform mention worth acting on), so the connection exists
  // regardless of which of the two nameplates got checked. Must run before
  // applyResolvedRelations below, since it can mint brand new "confirmed"
  // relation entries of its own (via resolvePlatformMention) that need
  // wiring into the graph in the very same pass.
  // Real user report: "There are instances (like the Aston Martin Vantage
  // nameplate) where there are 2 nameplates that are exactly identical to
  // each other. They should automatically be merged if these exist." What's
  // in the data is a bare "umbrella" model node (Wikipedia's general
  // nameplate-overview article, harvested by DBpedia as a model in its own
  // right) sitting beside the family built from the per-generation articles
  // -- two dots, same make, same label. Folds the umbrella in as one more
  // generation of that family.
  //
  // Ordering matters and is the opposite of what it first looks like. This
  // ran BEFORE applyConfirmed in its first version, on the reasoning that
  // those passes branch on whether a node is already grouped -- which cost 15
  // real nameplates and 52 generations on the live dataset. The reason: a
  // bare model with a confirmed LLM split is ABOUT to become a family in its
  // own right, so folding it into a same-named sibling first destroys the
  // split before it can be applied. Running afterwards is both safer and
  // more accurate: by this point every node's final type is settled, so a
  // bare model still sitting as a plain model here genuinely is a leftover
  // umbrella article, and a group that has since become two real families is
  // correctly left alone (duplicateNameplatePairs only ever folds into a
  // group with exactly ONE family). Before applyResolvedRelations, though,
  // so relation wiring sees the final structure.
  if (window.LlmFamilies) window.LlmFamilies.mergeDuplicateNameplates(nodes, links);
  // Its companion for the case the name-based pass cannot see: the same
  // generation minted twice under two different spellings of the nameplate
  // ("Mercedes-Benz GLA-Class (X156)" beside the GLA's own "GLA X156"). The
  // chassis code is what identifies them as one car. See
  // foldCodeDuplicateModels.
  if (window.LlmFamilies && window.LlmFamilies.foldCodeDuplicateModels) {
    window.LlmFamilies.foldCodeDuplicateModels(nodes, links);
  }
  // A "same article" deferral is only good while the car it points at has
  // actually read that article. After every nameplate above is in place --
  // a family counts as having read its own -- drop any that point at a
  // deferral, a failure or a car never read, so those cars are checked again.
  // See repairSameArticleEntries.
  if (window.LlmFamilies && window.LlmFamilies.repairSameArticleEntries) {
    window.LlmFamilies.repairSameArticleEntries(nodes);
  }
  if (window.LlmFamilies) window.LlmFamilies.applySharedPlatformForSingleGen(nodes, links);
  // Its twin for the people half of a single-generation verdict -- the Audi
  // Nuvolari report, where the check found "Massimo Frascella" and the
  // Designers layer showed nothing. See applyPeopleForSingleGen's own comment.
  if (window.LlmFamilies) window.LlmFamilies.applyPeopleForSingleGen(nodes, links);
  // Same idea, for any already-confirmed generation-level relation
  // resolution (see llm_families.js's checkRelation/confirmRelation): wires
  // in the resolved generation<->generation link and retroactively tags the
  // original, less-specific connection so it hides once that family is
  // expanded. Must run after applyConfirmed (LLM-discovered generations
  // need to exist first) but before the byId/adj indexes below are built.
  if (window.LlmFamilies) window.LlmFamilies.applyResolvedRelations(nodes, links);
  // Real user request: "The 'Succeeds' and 'Succeeded by' information and
  // the edge links should also be transferred to the generations of a
  // nameplate. They should only revert to the nameplate itself if there is
  // no proper reference to a specific generation." A succession is the one
  // relation type whose specific generations are derivable outright -- the
  // predecessor's LAST generation hands over to the successor's FIRST -- so
  // this needs no LLM call and just runs deterministically at boot. Must run
  // AFTER applyResolvedRelations so a genuine LLM-resolved generation pair
  // is already in place and wins over the derived one (see
  // pushSuccessionToGenerations' own `specific` check), and after
  // applyConfirmed/applyAllFamilyOverrides so every family's generation list
  // is final before "newest"/"oldest" are computed off it.
  // A My Database car that was only ever matched onto a plain, not-yet-
  // split model at build time should move onto the specific generation the
  // instant that model becomes a real nameplate via the LLM split just
  // applied above (never removing the family-level fallback -- see
  // reconcileDbGenerations's own comment for why that also makes deletion
  // "just work" with no extra unwinding).
  if (window.LlmFamilies) window.LlmFamilies.reconcileDbGenerations(nodes);
  // Hand edits, replayed last so they win over every automatic layer above.
  // A rename has to come after everything that might have minted or relabeled
  // a node, and a deletion has to come after everything that might have
  // created the thing being deleted -- otherwise a car deleted by hand could
  // be quietly resurrected by the very next replay pass in the same boot.
  // See llm_families.js's deleteNode/renameNode for the full reasoning on why
  // both are records replayed onto an untouched snapshot rather than edits to
  // it (which is exactly what makes deletion recoverable).
  // Real user request: "an 'unmerge' option just like how there is a 'merge'
  // option in the 'modify existing car' section... This would unmerge all of
  // the generations of the car from the existing 'nameplate' of the car."
  // Runs after every layer above that can BUILD a nameplate (applyMerges,
  // applyConfirmed, applyAllFamilyOverrides, mergeDuplicateNameplates), since
  // the whole point of recording it as one decision is that it undoes all
  // four the same way -- see llm_families.js's applyUnmerges.
  if (window.LlmFamilies) window.LlmFamilies.applyUnmerges(nodes, links);
  if (window.LlmFamilies) window.LlmFamilies.applyRenames(nodes);
  if (window.LlmFamilies) window.LlmFamilies.applyDeletions(nodes, links);
  // The permanent half of deletion -- a car the user cleared out of "Deleted
  // so far" entirely. Most purged ids never get created at all (every mint
  // path checks the tombstone first), so this normally finds nothing; it's
  // here for the one case that can't be prevented at mint time, a HARVESTED
  // car that data.js rebuilds from scratch on every boot.
  if (window.LlmFamilies) window.LlmFamilies.applyPurges(nodes, links);
  // Deliberately last of the replay passes, not in the middle of them. It
  // reads every family's final generation list, and the four calls above are
  // the ones that retire generations -- an unmerge, a rename, a delete, a
  // purge. Running it before them left 128 derived succession links pointing
  // at generations that had since been retired, and the coarse nameplate
  // lines they had stepped aside for still deferring to them.
  if (window.LlmFamilies) window.LlmFamilies.pushSuccessionToGenerations(nodes, links);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const adj = new Map(nodes.map(n => [n.id, []]));
  links.forEach(l => {
    l.sn = byId.get(l.source); l.tn = byId.get(l.target);
    adj.get(l.source).push({ n: l.tn, l }); adj.get(l.target).push({ n: l.sn, l });
  });
  nodes.forEach(n => n.deg = adj.get(n.id).length);
  // ---------- data cleanup: bound every generation's end year ----------
  // A generation's "end" is often left null in the source data simply
  // because nobody bothered filling it in, not because it's genuinely still
  // in production -- e.g. "1968-" with no end, right next to a following
  // generation that starts in 1972, obviously means the first one ended in
  // 1972 too. Only the LAST (most recent) generation of a nameplate may
  // legitimately stay open-ended (still in production), or a nameplate with
  // only ONE generation total (nothing to infer a boundary from). Runs for
  // every family regardless of how it was formed -- build-time grouped or
  // LLM-discovered -- and again after any live mutation that changes a
  // family's generation set (see applyLlmConfirmSilent/
  // applyFamilyOverrideConfirm), so this stays true all session, not just
  // at boot. Also directly helps checkRelation's own year-overlap reasoning
  // (see llm_families.js's fmtGenList) — a bounded end year is a much
  // stronger year-adjacency signal than an open-ended one.
  function backfillGenerationEnds() {
    nodes.forEach(fam => {
      if (fam.type !== "family" || !fam.generations || fam.generations.length < 2) return;
      const gens = fam.generations.map(id => byId.get(id)).filter(g => g && !g.retired && g.year != null);
      gens.sort((a, b) => a.year - b.year);
      for (let i = 0; i < gens.length - 1; i++) {
        const g = gens[i], next = gens[i + 1];
        // Real user report, the A-Class: "the first generation seems to only
        // have the starting year. However the wikipedia has both starting and
        // end year." Not the model's doing -- the build-time DBpedia layer
        // gives some generations no end year at all, and others an end year
        // equal to their start (A-Class W176: "2012-2012", really 2012-2018).
        // A generation that is followed by another one years later did not
        // stop in its first year, so both shapes are treated as unknown and
        // bounded by the next generation's start. A genuinely one-year
        // generation followed immediately by its successor is left alone.
        const degenerate = g.end != null && g.end === g.year && next.year > g.year + 1;
        if (g.end == null || degenerate) g.end = next.year;
      }
      // ...and then the family's OWN end year, which build_family_layer.py
      // could only leave null: it closes a family solely when every member
      // already had an end year, and a single open-ended middle generation
      // was enough to stop that. Once the loop above has bounded the middle
      // ones, the only generation still allowed to be open is the last, so
      // the family is over exactly when the last generation is over. Without
      // this, 20 families rendered as still in production against their own
      // evidence -- BMW 5 Series (last generation ends 2023), Camaro (2023),
      // Thunderbird (2005), Taurus (2019), Accord (2017).
      if (fam.end == null && gens.length) {
        const ends = gens.map(g => g.end);
        if (ends.every(e => e != null)) fam.end = Math.max(...ends);
      }
    });
  }
  backfillGenerationEnds();
  // ---------- data cleanup: a family's own wp, from the right sibling generation ----------
  // dbSourceFor() (below) already falls back to a documented generation for
  // photo/specs display -- build_family_layer.py never gives a FAMILY node
  // its own wp, only individual generations have one -- but the Wikipedia
  // link/extract in the detail panel only ever checked the family's own
  // (always-empty) wp directly, so a My Database nameplate shown collapsed
  // never showed its Wikipedia page at all.
  //
  // The FIRST version of this backfill just grabbed n.dbGenerations[0]'s wp
  // -- wrong, and a real bug report: BMW X3's family node ended up wired to
  // "BMW X3 (G45)", the newest generation's OWN sub-article (all it has
  // documented in My Database), instead of the real general "BMW X3"
  // overview article that Wikipedia actually files the whole nameplate's
  // multi-generation history under -- which sits right there as a BARE,
  // un-suffixed sibling generation node (build_family_layer.py's own
  // "bare-fold" pass; see familyCheckTarget below for the exact same
  // preference already used for the recheck feature). Once fam.wp is wrong,
  // it stays wrong everywhere that trusts it outright -- including
  // familyCheckTarget's own "if (fam.wp) return fam" fast path -- so the LLM
  // generation-extraction prompt itself ends up reading only that one
  // generation's article and never finds the others. Always prefer the bare
  // sibling's wp when one exists; only fall back to a documented (My
  // Database) generation's wp, same as before, when no bare sibling exists
  // at all (still better than nothing, and no worse than before this fix).
  // Third fallback, for a family with neither a bare sibling article NOR any
  // My Database generation to borrow a link from -- real bug report: the
  // Mercedes-Benz SL-Class (and several other hand-curated/build-time
  // families whose individual generations -- R107, R129, R230, R231... --
  // were never given a shared, un-suffixed overview article at all, only
  // their own per-generation ones) showed NO Wikipedia link whatsoever on
  // the collapsed family node, even though a perfectly good general
  // nameplate-overview article usually does exist on Wikipedia at the
  // obvious "<Make> <Label>" title (e.g. "Mercedes-Benz SL-Class"). Guess
  // that title and let it resolve the same lazy, graceful way any other
  // n.wp already does (wiki() below simply shows nothing if the guess
  // doesn't resolve to a real article -- no worse than the current total
  // absence of a link, and correct far more often than not). Same guess
  // familyCheckTarget() below already makes for the LLM-check feature
  // specifically; this applies it to the ordinary hover-card/detail-panel
  // Wikipedia link too, for every family, not just ones being LLM-checked.
  nodes.forEach(n => {
    if (n.type !== "family" || n.wp || !n.generations || !n.generations.length) return;
    const gens = n.generations.map(id => byId.get(id)).filter(Boolean);
    const bare = gens.find(g => g.wp && looseEq(g.label, n.label));
    if (bare) { n.wp = bare.wp; return; }
    if (n.db && n.dbGenerations && n.dbGenerations.length) {
      const g = byId.get(n.dbGenerations[0]);
      if (g && g.wp) { n.wp = g.wp; return; }
    }
    if (n.make && n.label) n.wp = `${n.make} ${n.label}`;
  });
  // ---------- mirror-link replacement index ----------
  // A collapsed-view "mirror" link (build_family_layer.py's
  // mirror_relation_links, or the client-side equivalent tagged by
  // llm_families.js's applyResolvedRelations) is meant to hide as soon as
  // its family is expanded, TRUSTING that some other, more specific link
  // will independently become visible in its place -- either the untouched
  // build-time original or a freshly LLM-resolved generation<->generation
  // pair. That trust is deliberately optimistic already: in a both-sides-
  // grouped case (e.g. Porsche 911 <-> Boxster/Cayman) expanding just ONE
  // side hides the mirror even though the replacement's OTHER endpoint may
  // still be collapsed -- a small, accepted "briefly nothing drawn until
  // you expand the other side too" gap (see jsdom_relation_mirror_test.js),
  // not something worth eliminating by requiring strict full-visibility.
  // What that trust never anticipated: a replacement candidate's endpoint
  // being RETIRED FOR GOOD (Feature 4's applyFamilyOverride, which can
  // supersede a generation node no build-time link ever expected to
  // disappear) -- that's not "temporarily collapsed", nothing will ever
  // make it visible again, so a mirror whose only candidate replacement(s)
  // are ALL retired keeps showing instead of leaving the connection with
  // nothing to represent it, ever. Precomputed once here (and re-run after
  // any live mutation that adds links/retires nodes -- see
  // applyLlmConfirmSilent/applyRelationConfirm/applyFamilyOverrideConfirm)
  // rather than per animation frame in linkInLayer's hot path.
  //
  // ---------- performance: this is THE hot path during a live cascade ----------
  // Real bug report: "when the program is generating new connections live, it
  // seems that the viewfinder gets completely blocked and oftentimes goes
  // blank. The only way to regain control is by refreshing the page."
  //
  // Measured against the real graph (10,425 nodes / 20,258 links / 861
  // mirrors), this function used to take **1,093 ms per call** -- it ran a
  // full `links.filter(...)` scan INSIDE a `links.forEach(...)`, i.e.
  // O(mirrors x links) = 17.4M comparisons, each allocating two closures.
  // Every live apply calls it (applyLlmConfirmSilent, applyRelationConfirm,
  // applySharedPlatformLive, applyFamilyOverrideConfirm, refreshAfterLinkChange,
  // runGenerationResearch), so a cascade of ~20 applies blocked the main
  // thread for roughly **18 seconds** -- no rendering, no input, exactly the
  // reported "blocked and goes blank, only a refresh fixes it".
  //
  // Same answer, one pass: a replacement candidate is any non-mirror link of
  // the same type whose two endpoints belong to the same two families as the
  // mirror. That's a compound key, so it can be indexed once (O(links)) and
  // each mirror then answered with a single Map lookup (O(1)). The key is
  // built from the unordered family pair so a link stored in either direction
  // lands in the same bucket -- which is exactly what the old `(aMatch(sn) &&
  // bMatch(tn)) || (aMatch(tn) && bMatch(sn))` condition was expressing.
  function indexMirrorReplacements() {
    // Which family (if any) does this endpoint belong to? A generation
    // belongs to its own family; anything else stands for itself. This is the
    // one thing `belongsTo` was testing, just precomputed.
    const famKey = n => (n && (n.familyOf || n.id)) || null;
    // Separator is a pipe: node ids are slugs (m-..., fam-..., llm-...), so
    // it can never appear inside one and collapse two distinct pairs.
    const pairKey = (a, b, type) => (a < b ? a + "|" + b : b + "|" + a) + "|" + type;
    const byPair = new Map();
    for (const other of links) {
      if (other.mirror || !other.sn || !other.tn) continue;
      const a = famKey(other.sn), b = famKey(other.tn);
      if (!a || !b) continue;
      const k = pairKey(a, b, other.type);
      let arr = byPair.get(k);
      if (!arr) byPair.set(k, arr = []);
      arr.push(other);
    }
    // l.source/l.target start out as plain id strings but d3-force's link
    // force (via buildSim(), already run at least once by the time any live
    // mutation can get here) mutates them into direct node object
    // references the moment the simulation first initializes -- the same
    // gotcha already fixed in applyFamilyOverrideConfirm. mirrorSourceFam/
    // mirrorTargetFam are custom fields d3-force never touches, so those
    // stay safe strings; only the l.source/l.target FALLBACK (used when a
    // mirror's target was a plain, ungrouped model at build time, like the
    // BMW X4 case) needs normalizing back to a plain id.
    const idOf = v => typeof v === "string" ? v : (v && v.id);
    links.forEach(l => {
      if (!l.mirror) return;
      const famA = l.mirrorSourceFam || idOf(l.source), famB = l.mirrorTargetFam || idOf(l.target);
      const candidates = byPair.get(pairKey(famA, famB, l.type)) || [];
      l.mirrorAllRetired = candidates.length > 0 && candidates.every(rl => rl.sn.retired || rl.tn.retired);
    });
  }
  indexMirrorReplacements();
  const LABEL_ORDER = nodes.slice().sort((a, b) => {
    const rank = t => t === "make" ? 0 : t === "person" ? 1 : 2;
    return rank(a.type) - rank(b.type) || b.deg - a.deg;
  });

  // ---------- people layer (designers / engineers / both) ----------
  let layer = "designers";
  const isPerson = n => n.type === "person";
  const hasRole = (n, r) => n.roles && n.roles.includes(r);
  // The powertrain layer's own node and link types. Kept as one predicate so
  // "engines are not in the main graph" is one rule in one place rather than a
  // type check scattered through every view.
  const POWERTRAIN_NODES = new Set(["engine", "enginevar"]);
  const POWERTRAIN_LINKS = new Set(["fitted", "enginegen", "enginesucc"]);
  function isPowertrain(n) { return !!n && POWERTRAIN_NODES.has(n.type); }
  // Real user request, twice: "The Powertrain tab should function exactly the
  // same, have the same UI queues, and everything as the Graph Tab... I
  // repeat, I want exactly the same behavior, UI, node behavior, etc.. as the
  // graph tab view. It should look virtually identical."
  //
  // It cannot be identical while it is a second renderer -- that is what kept
  // drifting: its own forces, no radial ring, no force fields, every car on
  // screen at once. So it is not one any more. The Powertrain tab IS the
  // Graph, drawn from the same canvas, sim, hover card, focus, ring layout and
  // zoom, with this one flag deciding which layer nodeInLayer/linkInLayer
  // admit. powertrain.js is gone.
  //
  // The shapes line up one-for-one, which is what makes it work: an engine is
  // a nameplate, its variants are that nameplate's generations, and the cars
  // it was fitted to are the neighbours you reach by opening it.
  let graphMode = "main";
  const isPowerMode = () => graphMode === "power";
  function isHub(n) { return !!n && (n.type === "family" || n.type === "engine"); }
  function childIdsOf(n) {
    if (!n) return [];
    if (n.type === "family") return n.generations || [];
    if (n.type === "engine") return n.variants || [];
    return [];
  }
  function parentIdOf(n) {
    if (!n) return null;
    if (n.type === "model") return n.familyOf || null;
    if (n.type === "enginevar") return n.engineOf || null;
    return null;
  }
  // Which cars are on screen in the powertrain layer: those an OPEN engine
  // reaches, and no others. Same rule as a nameplate's generations -- "I want
  // that the car models associated with the engines only appear once I have
  // clicked on a particular engine" -- so it uses the same expandedFamilies
  // set rather than a second notion of open.
  //
  // Memoised because nodeInLayer runs per node per frame and this walks the
  // link array; invalidated wherever expansion or the arrays change.
  // A link's endpoint, resolved even when the graph is mid-mutation. byId is
  // filled by spliceIntoIndexes, which runs a step AFTER the nodes are pushed
  // -- and a layer that silently showed nothing in that window would look
  // exactly like a scan that found nothing, which is the bug the old
  // powertrain renderer carried a comment about. Falls back to the node array.
  let arrayIndex = null, arrayIndexLen = -1;
  function endOf(l, which) {
    const direct = which === "source" ? l.sn : l.tn;
    if (direct) return direct;
    const raw = l[which];
    const id = typeof raw === "string" ? raw : (raw && raw.id);
    if (!id) return null;
    const hit = byId.get(id);
    if (hit) return hit;
    if (arrayIndexLen !== nodes.length) {
      arrayIndex = new Map(nodes.map(n => [n.id, n]));
      arrayIndexLen = nodes.length;
    }
    return arrayIndex.get(id) || null;
  }
  let powerVis = null;
  function invalidatePowerVis() { powerVis = null; }
  function powerSets() {
    if (powerVis) return powerVis;
    const shown = new Set(), reached = new Set(), suppressedEdges = new Set();
    // Every (engine, car) edge this layer knows about, so the two rules below
    // can be applied per engine and per car rather than per link.
    const edges = [];
    for (const l of links) {
      if (l.retired || l.type !== "fitted") continue;
      const a = endOf(l, "source"), b = endOf(l, "target");
      if (!a || !b) continue;
      const eng = isPowertrain(a) ? a : isPowertrain(b) ? b : null;
      if (!eng) continue;
      const car = eng === a ? b : a;
      if (!car || isPowertrain(car) || car.retired) continue;
      const hubId = eng.type === "enginevar" ? eng.engineOf : eng.id;
      if (!hubId) continue;
      edges.push({ l, eng, hubId, car });
    }
    // Rule one, per engine. Real user report, with a screenshot of the M119:
    // "in the engine search, you can see both the nameplate and the
    // individual generation of that nameplate (for example, the e class and
    // the w124 e class). I don't want the nameplate to be shown at all if the
    // generation is shown."
    //
    // planEngineEdges applies this when an engine ARTICLE is read -- but that
    // edge came from an engine MENTION on a car's infobox, which never passes
    // through it. So it is applied here, where every edge ends up.
    const famsCovered = new Map();   // hub id -> set of nameplate ids its generations cover
    for (const { hubId, car } of edges) {
      if (!car.familyOf) continue;
      if (!famsCovered.has(hubId)) famsCovered.set(hubId, new Set());
      famsCovered.get(hubId).add(car.familyOf);
    }
    // Rule two, the same thing one level down on the engine's own side: a car
    // reached both by an engine and by one of that engine's variants is
    // connected to the variant only. "if the engine var is there for the car,
    // then only show the engine var... Only fall back to the engine name if
    // there is no engine var, but dont show both."
    const varsCovered = new Map();   // car id -> set of engine ids a variant covers
    for (const { eng, car } of edges) {
      if (eng.type !== "enginevar" || !eng.engineOf) continue;
      if (!varsCovered.has(car.id)) varsCovered.set(car.id, new Set());
      varsCovered.get(car.id).add(eng.engineOf);
    }
    for (const e of edges) {
      const byFam = famsCovered.get(e.hubId);
      const byVar = varsCovered.get(e.car.id);
      // Kept as the edge OBJECT rather than a key: an engine's own id is also
      // its variants' hub id, so any id-pair key would hide the variant's
      // edge along with the engine's.
      if ((byFam && byFam.has(e.car.id)) ||
          (byVar && e.eng.type === "engine" && byVar.has(e.eng.id))) {
        suppressedEdges.add(e.l);
        continue;
      }
      reached.add(e.car.id);
      if (expandedFamilies.has(e.hubId)) shown.add(e.car.id);
    }
    powerVis = { shown, reached, suppressedEdges };
    return powerVis;
  }
  // Drawn: only the cars an open engine reaches.
  function powerVisibleCars() { return powerSets().shown; }
  // Is this fitted edge the redundant one? See powerSets' two rules.
  function powerEdgeSuppressed(l) {
    return !!l && l.type === "fitted" && powerSets().suppressedEdges.has(l);
  }
  // Simulated: every car any engine reaches, open or not -- exactly as a
  // collapsed nameplate's generations stay in the main layer's simulation.
  // The alternative throws: d3's link force resolves both endpoints up front
  // and a fitted edge to a car the simulation does not hold is a hard
  // "node not found" that leaves no usable sim at all.
  function powerSimCars() { return powerSets().reached; }
  function nodeInLayer(n) {
    // Retired by a user-confirmed nameplate generation-list override (see
    // llm_families.js's applyFamilyOverride) -- superseded by a fresh
    // generation set, kept in the arrays only so anything already pointing
    // at its id doesn't break, never shown anywhere. Checked first since it
    // overrides every other layer/expansion rule below.
    if (n.retired) return false;
    // The powertrain layer lives in its own view. Real user answer, asked
    // where engines should appear: "New view only" -- the main graph is
    // untouched, same nodes, same counts, same layout. This is the single
    // choke point that makes that true for the graph, the timeline, six
    // degrees, the search and the footer counts at once.
    if (isPowerMode()) {
      // Engines always; a variant once its engine is open, exactly as a
      // generation appears once its nameplate is; a car once something it is
      // fitted to is open. Nobody else -- no makes, no designers.
      if (n.type === "engine") return true;
      if (n.type === "enginevar") return expandedFamilies.has(n.engineOf);
      if (n.type === "model" || n.type === "family") return powerVisibleCars().has(n.id);
      return false;
    }
    if (isPowertrain(n)) return false;
    if (n.type === "model" && n.familyOf && !expandedFamilies.has(n.familyOf)) return false;
    if (!isPerson(n)) return true;
    if (layer === "none") return false;
    if (layer === "both") return true;
    return hasRole(n, layer === "designers" ? "designer" : "engineer");
  }
  // Does some generation of this expanded family carry the same person credit
  // as the family-level link `l`? Walked from the PERSON's adjacency, which is
  // the short side -- a designer has a handful of cars, a family has a handful
  // of generations, and this runs per link per frame.
  function creditCoveredByGeneration(l) {
    const fam = l.sn, person = l.tn;
    if (!fam || !person || !fam.generations || !fam.generations.length) return false;
    for (const { l: other } of adj.get(person.id) || []) {
      if (other === l || other.retired || other.type !== l.type) continue;
      const car = other.tn === person ? other.sn : other.tn;
      if (car && car.familyOf === fam.id) return true;
    }
    return false;
  }
  function linkInLayer(l) {
    // Real user request: "When I delete an entry (whether that's a nameplate
    // or a model or a relationship), it should also reflect that in the
    // graph and information cards as well, thereby reverting them to before
    // the LLM generation." Deleting a relationship used to only ever remove
    // its persisted entry -- the actual line stayed on screen until a full
    // reload, which is exactly what "I deleted it but it still appeared and
    // didn't seem to actually get deleted" describes. llm_families.js's
    // severRelationLinks marks the link retired instead of splicing it out
    // (nothing holding an index into `links` gets invalidated mid-frame, and
    // an undo is a flag flip rather than a rebuild); this is the single
    // choke point that makes that flag actually mean "gone" for every view,
    // the same way nodeInLayer's own `n.retired` check already does for
    // nodes. Checked first, since it overrides every rule below.
    if (l.retired) return false;
    if (isPowerMode()) {
      if (!POWERTRAIN_LINKS.has(l.type)) return false;
      if (powerEdgeSuppressed(l)) return false;   // the nameplate rule, see powerSets
      // Both ends have to be on screen, or a fitted edge would be drawn to a
      // car that is not there yet -- same reason the main layer hides a
      // family-level credit link while its generation carries it.
      return nodeInLayer(l.sn) && nodeInLayer(l.tn);
    }
    if (POWERTRAIN_LINKS.has(l.type)) return false;   // see isPowertrain
    if (l.type === "designed" && (layer === "engineers" || layer === "none")) return false;
    if (l.type === "engineered" && (layer === "designers" || layer === "none")) return false;
    // Every family mirrors its generations' designed/engineered links up to
    // itself (build_family_layer.py / llm_families.js), so while a nameplate
    // is COLLAPSED the family-level line is the only one that can ever draw
    // (its generations are hidden by nodeInLayer). Once that nameplate is
    // EXPANDED, though, both the family-level line AND the more specific
    // generation-level line become simultaneously visible -- e.g. selecting
    // a designer while their car's nameplate happens to be expanded would
    // show a line to both the nameplate and the individual generation. Per
    // spec: the generation-level connection should win once expanded; the
    // family-level (nameplate) line only shows while collapsed.
    //
    // ...but only when there really IS a more specific line to take over.
    // Real user report, on the Buick Invicta: "I see who drew them in the
    // info card but not a link." The rule above rests on "every family
    // mirrors its generations' designed/engineered links up to itself", and
    // that is not true of a nameplate the LLM has just split. Its designers
    // came from DBpedia's article about the NAMEPLATE and were never
    // attributed to any one generation -- the minted generations carry
    // designers: [] -- so hiding the family-level line left the card saying
    // "drawn by Justin Thompson · Richard Duff" with no line anywhere on the
    // canvas.
    //
    // Per the user's own call: "that's fine to fall back on linking the
    // designer directly to the nameplate instead of the generation." So the
    // specific line still wins WHEN IT EXISTS, and otherwise the credit stays
    // drawn where it is actually known -- on the nameplate.
    if ((l.type === "designed" || l.type === "engineered") &&
        l.sn && l.sn.type === "family" && expandedFamilies.has(l.sn.id) &&
        creditCoveredByGeneration(l)) {
      return false;
    }
    // Same precedence, generalized to platform/related/succession links:
    // build_family_layer.py's mirror_relation_links (and the client-side
    // mirrorRelationLink helper for LLM-discovered families) mirrors any
    // such link whose real endpoint got folded into a collapsed nameplate
    // up to that nameplate's own family node too -- e.g. BMW X1 (F48)'s
    // direct "related" link to the Zinoro 60H rebadge also gets a
    // fam-bmw-x1 -> Zinoro 60H mirror, so the collapsed "X1" dot still
    // shows SOME connection. `mirrorSourceFam`/`mirrorTargetFam` record
    // which side(s) got promoted; once that specific family is expanded,
    // hide the mirror in favor of the untouched original (which draws on
    // its own the moment both of ITS real endpoints are visible) -- never
    // both at once, and the original is never deleted, so if a family
    // can't be resolved down to a specific generation the mirror is simply
    // never superseded and keeps showing at the collapsed level forever.
    if (l.mirror && ((l.mirrorSourceFam && expandedFamilies.has(l.mirrorSourceFam)) ||
                      (l.mirrorTargetFam && expandedFamilies.has(l.mirrorTargetFam)))) {
      // Normal case: hide, trusting a more specific link to take over (see
      // indexMirrorReplacements above for exactly what this trusts and the
      // one case -- every replacement candidate retired -- where it keeps
      // showing instead.
      if (l.mirrorAllRetired) return true;
      return false;
    }
    return true;
  }
  const layerListeners = [];
  function setLayer(v) {
    if (v === layer) return;
    layer = v;
    document.querySelectorAll("#layertoggle button").forEach(b =>
      b.classList.toggle("active", b.dataset.layer === v));
    // computeYearFilterSet() below decides whether a designer/engineer is
    // "in range" by checking linkInLayer() on their designed/engineered
    // links -- which reads this same `layer` value. Without recomputing
    // here, yearFilterSet stays stale from whatever layer was active when
    // it was last built, so e.g. an engineer-only person (like Andreas
    // Preuninger) switched into view via the Engineers toggle would stay
    // invisible until something else (like nudging the year slider)
    // happened to force a recompute.
    if (typeof refreshYearFilter === "function") refreshYearFilter();
    layerListeners.forEach(f => f());
  }
  function personRoleWord(n) {
    if (n.kind === "studio") return "design house";
    const d = hasRole(n, "designer"), e = hasRole(n, "engineer");
    return d && e ? "designer & engineer" : e ? "engineer" : "designer";
  }

  // ---------- "My Database" filter (Andy's personally documented cars) ----------
  // Families inherit db from their generations (build_family_layer.py), so a
  // documented generation stays reachable via its (collapsed) family here too.
  const DB_IDS = new Set(nodes.filter(n => (n.type === "model" || n.type === "family") && n.db).map(n => n.id));
  let dbFilterOn = false;
  const dbFilterListeners = [];
  function setDbFilter(v) {
    v = !!v;
    if (v === dbFilterOn) return;
    dbFilterOn = v;
    const btn = document.getElementById("dbfilter");
    if (btn) btn.classList.toggle("active", dbFilterOn);
    dbFilterListeners.forEach(f => f());
  }

  // ---------- LLM generation-check toggle ----------
  // Off by default: with it off, opening a model's detail panel behaves
  // exactly as before. Switched on, opening an eligible (ungrouped) model
  // for the first time asks the local LLM (via serve.py -> llama-server) whether
  // its Wikipedia article describes multiple generations DBpedia never
  // split out. Remembered across sessions so you don't have to re-enable it
  // every reload; still requires serve.py + llama-server actually running.
  let llmCheckOn = localStorage.getItem("cw-llm-check") === "1";
  // Real user request: once LLM Check is on and you select a car, the
  // toggle should disengage right away -- on by itself, it's too easy to
  // rack up unintended llama.cpp calls just by browsing from car to car.
  // But "the current LLM task should continue until its completion" --
  // that includes cascading steps for the SAME car (checking whether a
  // related nameplate it just turned out to connect to is itself hiding
  // generations, then disambiguating which specific generations pair up --
  // see renderOneRelationCheck below), which would otherwise wrongly get
  // cut off by the toggle flipping off before those later steps even run
  // (they happen on a LATER render, after the initial check resolves and
  // auto-applies). llmCheckArmedFor remembers which node's task is still
  // allowed to keep cascading even with the toggle now off; it's checked
  // alongside llmCheckOn everywhere a cascade/relation check is gated.
  let llmCheckArmedFor = null;
  // Background LLM work (a minted car's article lookup + check, year/bio
  // backfill, a related partner's own generation check) is authorised while
  // the toggle is on, AND while the specific car whose check is still
  // finishing keeps cascading -- app.js turns the toggle off the instant a
  // check starts (disengageLlmCheckFor), so gating on the raw toggle alone
  // would cut off the very work the user just asked for. Pushed into
  // llm_families.js rather than read from there, so there's one owner of the
  // "did the user ask for this?" question. See setBackgroundAllowed.
  function syncLlmAuthorized() {
    if (window.LlmFamilies && window.LlmFamilies.setBackgroundAllowed) {
      window.LlmFamilies.setBackgroundAllowed(llmCheckOn || llmCheckArmedFor !== null);
    }
  }
  function setLlmCheck(v) {
    v = !!v;
    llmCheckOn = v;
    // Turning it off by hand also withdraws authorisation for any armed car:
    // an explicit "stop" should stop everything, not just new checks.
    if (!v && !llmCheckSuppressArmedClear) llmCheckArmedFor = null;
    syncLlmAuthorized();
    localStorage.setItem("cw-llm-check", v ? "1" : "0");
    const btn = document.getElementById("llmcheck");
    if (btn) btn.classList.toggle("active", v);
    // The toggle's own item now lives inside the collapsed #toolsmenu, so its
    // "active" state is invisible while the menu is closed. #toolsmenu-armed-dot
    // on the trigger button itself is the at-a-glance replacement.
    const dot = document.getElementById("toolsmenu-armed-dot");
    if (dot) dot.hidden = !v;
  }
  // Called right when a fresh check is kicked off for nodeId (see the two
  // renderLlmCheck/renderLlmCheckFamily call sites) -- disengages the
  // persistent toggle so opening ANOTHER car afterward won't silently start
  // yet another check, while leaving this specific car's own task free to
  // keep cascading through its later steps.
  // setLlmCheck(false) normally clears llmCheckArmedFor too (an explicit
  // "stop" should stop everything). This auto-disengage is the one case that
  // must NOT -- the whole point is that this car's own task keeps going.
  let llmCheckSuppressArmedClear = false;
  function disengageLlmCheckFor(nodeId) {
    llmCheckArmedFor = nodeId;
    llmCheckSuppressArmedClear = true;
    setLlmCheck(false);
    llmCheckSuppressArmedClear = false;
    syncLlmAuthorized();
  }
  // Moving away from a car ends its cascade's authorisation: anything already
  // in flight still completes, but nothing NEW gets scheduled on its behalf.
  function disarmLlmCheck() {
    if (llmCheckArmedFor === null) return;
    llmCheckArmedFor = null;
    syncLlmAuthorized();
  }
  // Real bug report: "even though I clear the positive (and negative) llm
  // messages, they reappear after a refresh." This used to be a plain
  // session-only in-memory Set by original design -- reasoned as fine since
  // "a fresh check/retry naturally shows a box again since it's a genuinely
  // new result" -- but that reasoning doesn't hold for a PAGE REFRESH,
  // which isn't a new check at all, just re-rendering the exact same
  // already-decided entry. Backed by window.LlmFamilies's persisted
  // store.dismissed now (round-tripped through serve.py like every other
  // LLM-layer decision) so a dismissal survives a refresh; still kept as a
  // local Set too, seeded from the persisted list at boot, purely so every
  // .has() check below stays a synchronous, instant lookup rather than
  // needing to go through window.LlmFamilies on every render. Two different
  // "Close" behaviors read this, both below: a dead-end verdict
  // ("none"/error) is dismissed to nothing at all, while a message
  // reporting a completed match (a resolved relation, an applied nameplate
  // correction) collapses to a small persistent disclaimer instead of
  // disappearing outright, so the fact it came from the local LLM +
  // Wikipedia is never fully lost.
  const dismissedLlm = new Set(
    window.LlmFamilies && window.LlmFamilies.allDismissed ? window.LlmFamilies.allDismissed() : []
  );
  function markLlmDismissed(key) {
    dismissedLlm.add(key);
    if (window.LlmFamilies && window.LlmFamilies.dismiss) window.LlmFamilies.dismiss(key);
  }
  function llmCloseBtn(key, extraClass) {
    return `<button class="llm-btn llm-close${extraClass ? " " + extraClass : ""}" data-key="${esc(key)}" title="dismiss">✕</button>`;
  }
  function wireLlmClose(container, key, onClose) {
    const btn = container.querySelector(`.llm-close[data-key="${key.replace(/"/g, '\\"')}"]`);
    if (btn) btn.onclick = () => { markLlmDismissed(key); onClose(); };
  }
  // Shared "see what it said" debug disclosure, reused by every LLM result
  // box (generation check, relation check, nameplate recheck) instead of
  // each hand-rolling its own copy.
  function debugToggleHtml(dbg) {
    if (!dbg) return "";
    // `raw` is null for a check that deliberately never asked the model at
    // all (checkRelation's no-evidence short-circuit -- see its own comment
    // for the Pontiac G5 / Marcos TSO case). There's still plenty worth
    // disclosing there: which codes each side offered, and the explanation
    // of why the call was skipped. Without this the disclosure vanished
    // exactly when a "none" verdict is most in need of explaining -- it
    // would look like the check silently did nothing.
    const has = dbg.raw || (dbg.dropped && dbg.dropped.length) ||
      dbg.skippedForLackOfEvidence || dbg.availableCodesA || dbg.availableCodesB;
    return has ? `<button class="llm-btn llm-debug-toggle">see what it said</button>` : "";
  }
  function wireDebugToggle(container, dbg) {
    const btn = container.querySelector(".llm-debug-toggle");
    if (!btn || !dbg) return;
    btn.onclick = () => {
      const box = container.querySelector(".llm-debug");
      if (!box) return;
      box.hidden = !box.hidden;
      if (box.hidden) return;
      const droppedHtml = (dbg.dropped && dbg.dropped.length)
        ? `<div class="llm-debug-dropped">claimed but dropped (not found verbatim in the article): ${esc(JSON.stringify(dbg.dropped))}</div>` : "";
      const codesHtml = (dbg.availableCodesA || dbg.availableCodesB)
        ? `<div class="llm-debug-dropped">codes offered — A: ${esc(JSON.stringify(dbg.availableCodesA || []))}, B: ${esc(JSON.stringify(dbg.availableCodesB || []))}</div>` : "";
      const rawHtml = dbg.skippedForLackOfEvidence && !dbg.raw
        ? `<div class="llm-debug-dropped">The local LLM was never asked about this pair: neither article mentions the other car, no chassis/generation code was found in either one, and no note was supplied — so there was nothing to resolve a specific generation pair from, and production-year overlap alone is never sufficient evidence. Use Retry above with a hint if you know which generations this is about.</div>`
        : `<pre class="llm-debug-pre">${esc(JSON.stringify(dbg.raw, null, 1))}</pre>`;
      box.innerHTML = `${rawHtml}${droppedHtml}${codesHtml}`;
    };
  }

  // ---------- nameplate families (collapsed generations) ----------
  // A "family" node (e.g. VW Golf) stands in for its individual generation
  // nodes (Golf Mk1..Mk8), which stay hidden — everywhere: graph, timeline,
  // six degrees — until that family is expanded. nodeInLayer() is the single
  // choke point that hides them; expanding/collapsing just toggles membership
  // in expandedFamilies and every view already checks nodeInLayer.
  const expandedFamilies = new Set();
  const familyListeners = [];
  function isFamilyExpanded(id) { return expandedFamilies.has(id); }
  // How big the ring is, for a given number of generations. Shared, because
  // three separate things need the same answer and a second copy would drift:
  // the layout that places them, the force that keeps everything else out of
  // the circle, and the edge drawing that has to bend around it.
  //
  // Spacing along the rim stays roughly what the old straight line used
  // between neighbours, so an eight-generation nameplate gets a wider ring
  // rather than eight nodes crammed onto a small one.
  const RING_GAP = 78, RING_MIN = 56, RING_CLEARANCE = 26;
  function ringSlots(count) { return count + 1; }
  function ringRadius(count) {
    if (count <= 1) return RING_MIN;
    return Math.max(RING_MIN, (RING_GAP * ringSlots(count)) / (Math.PI * 2));
  }
  // The ring of an expanded family, or null. `r` is where the generations
  // sit; `clear` is the circle nothing else may be inside.
  function ringOf(famId) {
    if (!expandedFamilies.has(famId)) return null;
    const fam = byId.get(famId);
    if (!fam || !Number.isFinite(fam.x) || !Number.isFinite(fam.y)) return null;
    const gens = childIdsOf(fam).filter(id => byId.has(id));
    if (!gens.length) return null;
    const r = ringRadius(gens.length);
    return { fam, gens: new Set(gens), x: fam.x, y: fam.y, r, clear: r + RING_CLEARANCE };
  }
  function eachRing(f) { expandedFamilies.forEach(id => { const ring = ringOf(id); if (ring) f(ring); }); }

  // Real user request: "Instead of a line of generations connected to one
  // another nearby the nameplate node, the generations should exist 'around'
  // the nameplate name, kind of like a radial, to somewhat separate it from
  // looking like the cars that it's connected to/related to."
  //
  // The line read as a chain of separate cars hanging off the nameplate --
  // the same shape a platform sibling or a successor makes -- so expanding a
  // nameplate looked like discovering five new neighbours rather than opening
  // one car up. A ring centred on the nameplate says "these ARE it" instead:
  // the nameplate sits inside its own generations, and nothing else in this
  // graph is drawn that way.
  //
  // Laid out over n+1 slots rather than n, leaving one slot of the ring
  // empty. That is what keeps the succession chain readable: with the full
  // circle divided n ways, two generations land diametrically opposite each
  // other and the predecessor/successor line between them runs straight
  // through the nameplate node in the middle. With a gap, consecutive
  // generations are always neighbours on the rim, so every succession line
  // is a short arc around the outside and the chain reads first to last
  // around it. The arc is centred on straight up, so the first generation
  // starts on the left and the newest ends on the right.
  //
  // The nameplate itself is pinned too -- real user request: "I want to make
  // sure that the nameplate is always fixed in the center around the
  // generations. This means when I expand the nameplate, the graph should
  // also re-organize itself so that this always occurs." Without the pin it
  // stays under the simulation's control while its generations do not, so the
  // first reheat after expanding drags the centre out from inside its own
  // ring.
  // Which way round should the ring face? Real user request: "try your best
  // to have as little crossover of edges as possible, to make the entire
  // graph seem more cleaned up... right now the jumble of edges looks like
  // they're crossing over each other more than they necessarily need to."
  //
  // The order around the ring is fixed -- oldest to newest, that is what makes
  // the succession chain readable -- but the ORIENTATION is free, and it is
  // most of the mess. A generation whose platform siblings all sit to the
  // south-west, placed on the north-east of the ring, drags its edges right
  // across the whole bubble and through everyone else's.
  //
  // So the whole ring is rotated as one piece, keeping the order, to whichever
  // angle puts each generation closest to the cars it actually connects to.
  // Shorter external edges is a good proxy for fewer crossings and a much
  // cheaper thing to compute than crossings themselves: two edges that barely
  // leave their endpoints have little opportunity to cross anything.
  //
  // Squared distance rather than distance, deliberately: it punishes the one
  // generation dragged right across the graph far harder than it rewards
  // shaving a few pixels off several short edges, and that long edge is what
  // actually crosses things.
  const RING_ROTATIONS = 24;
  function bestRingRotation(fam, gens, step, R) {
    // Where each generation's own outside connections are, relative to the
    // nameplate. Anything inside the family (its own generations, the
    // nameplate) is skipped: those edges are the ring's own and are drawn as
    // arcs along it, so they cannot be improved by turning it.
    const own = new Set(gens.map(g => g.id));
    own.add(fam.id);
    const partners = gens.map(g => (adj.get(g.id) || [])
      .map(({ n }) => n)
      .filter(n => n && !own.has(n.id) && Number.isFinite(n.x) && Number.isFinite(n.y))
      .map(n => ({ x: n.x - fam.x, y: n.y - fam.y })));
    if (!partners.some(list => list.length)) return null;   // nothing outside to face; keep the default
    let best = null, bestCost = Infinity;
    for (let t = 0; t < RING_ROTATIONS; t++) {
      const rot = (t / RING_ROTATIONS) * Math.PI * 2;
      let cost = 0;
      for (let i = 0; i < gens.length; i++) {
        if (!partners[i].length) continue;
        const a = rot + i * step;
        const gx = Math.cos(a) * R, gy = Math.sin(a) * R;
        for (const p of partners[i]) {
          const dx = gx - p.x, dy = gy - p.y;
          cost += dx * dx + dy * dy;
        }
      }
      if (cost < bestCost) { bestCost = cost; best = rot; }
    }
    return best;
  }

  function layoutGenerationsRadial(fam) {
    const gens = childIdsOf(fam).map(id => byId.get(id)).filter(Boolean);
    if (!gens.length) return;
    fam.fx = fam.x; fam.fy = fam.y;
    if (gens.length === 1) {
      gens[0].x = gens[0].fx = fam.x;
      gens[0].y = gens[0].fy = fam.y - RING_MIN;
      return;
    }
    const slots = ringSlots(gens.length);
    const step = (Math.PI * 2) / slots;
    const R = ringRadius(gens.length);
    // The fallback when there is nothing outside to face: the arc centred on
    // straight up, so the oldest generation starts on the left and the newest
    // ends on the right.
    const plain = -Math.PI / 2 - ((gens.length - 1) * step) / 2;
    const start = bestRingRotation(fam, gens, step, R);
    const base = start == null ? plain : start;
    gens.forEach((g, i) => {
      const a = base + i * step;
      g.x = g.fx = fam.x + Math.cos(a) * R;
      g.y = g.fy = fam.y + Math.sin(a) * R;
    });
  }
  function unpinGenerations(fam) {
    fam.fx = null; fam.fy = null;
    childIdsOf(fam).forEach(id => {
      const g = byId.get(id);
      if (g) { g.fx = null; g.fy = null; }
    });
  }

  // Real user request: "I want no other cars or models or anything to be
  // coming between the space of the nameplates and its generations. All car
  // nodes should be connected from the outside of the ring, which leaves
  // clean empty space in between the nameplate and its generations, making it
  // look like a proper 'bubble'."
  //
  // Two halves. This is the positional one: anything that is not the
  // nameplate or one of its own generations is moved out past the rim, as a
  // hard shove at the moment of expanding (so the bubble is clean on the very
  // first frame, not once a simulation settles) and again as a force below
  // (so it stays clean through any later reheat). Once nothing else is inside
  // the circle, an edge from an outside car to a generation necessarily
  // arrives from outside, which is the rest of what was asked for.
  //
  // Pinned nodes are left alone: they belong to some other ring, which has
  // its own claim on where they are. Two overlapping rings is a layout
  // problem, not a licence to drag someone else's generations around.
  //
  // The other half -- edges that would cut across the circle -- is in the
  // renderer, since bending a line is a drawing decision, not a position.
  function clearRing(ring) {
    if (!ring) return;
    nodes.forEach(n => {
      if (n === ring.fam || ring.gens.has(n.id)) return;
      if (n.fx != null || n.fy != null) return;
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
      let dx = n.x - ring.x, dy = n.y - ring.y;
      let d = Math.hypot(dx, dy);
      if (d >= ring.clear) return;
      if (d < 0.001) {   // sitting exactly on the centre: pick a direction rather than dividing by zero
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a); dy = Math.sin(a); d = 1;
      }
      n.x = ring.x + (dx / d) * ring.clear;
      n.y = ring.y + (dy / d) * ring.clear;
    });
  }
  // The same rule as a force, so a reheat cannot walk anything back inside.
  //
  // Real bug report, with a screenshot: "it still seems to have some cars that
  // are within the concentric circle, especially when there are so many cars
  // that are associated with a particular nameplate." Exactly the case that
  // breaks a polite version of this. The first attempt nudged velocities, and
  // it was in a tug of war it could not win: every platform sibling is joined
  // to the nameplate by a link the layout wants to be 46px long, and the
  // clearance circle round a seven-generation ring is 125px. The link force
  // pulls inward on every tick, this pushed outward on every tick, and they
  // settled somewhere in between -- inside the bubble. More siblings, more
  // inward pull, which is why the crowded nameplates looked worst.
  //
  // So it does not negotiate. A node inside the circle is placed ON it, and
  // the part of its velocity heading further in is dropped so it does not
  // simply dive back next tick. Same shape as d3's own collision force, which
  // moves nodes rather than asking them: an overlap is not a preference to be
  // weighed against other preferences, and neither is this.
  function ringClearanceForce() { ringClearanceOver(nodes); }
  // The same rule over just some nodes: a local relax only moves its own
  // patch, so only that patch can have wandered into a bubble. Checking all
  // twelve thousand every step was most of what a local step cost.
  function ringClearanceOver(list) {
    if (!expandedFamilies.size) return;
    eachRing(ring => {
      list.forEach(n => {
        if (n === ring.fam || ring.gens.has(n.id)) return;
        // Pinned: it belongs to some other ring, which has its own claim on
        // where it is. Two overlapping rings is a layout problem, not a
        // licence to drag someone else's generations around.
        if (n.fx != null || n.fy != null) return;
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
        let dx = n.x - ring.x, dy = n.y - ring.y;
        let d = Math.hypot(dx, dy);
        // Where this node is about to BE, not where it is. d3 runs every
        // force first and only then moves each node by its velocity, so a
        // clamp that only looks at the current position is always one step
        // behind: a node sitting just outside with a strong pull inward is
        // untouched here and is then carried straight through the rim by the
        // integration step, which is how cars kept turning up a few pixels
        // inside the bubble even with a hard clamp. Predicting with the full
        // velocity (d3 damps it before applying) over-estimates the step
        // slightly, which errs on the side of keeping the bubble clean.
        const vx = n.vx || 0, vy = n.vy || 0;
        const ndx = dx + vx, ndy = dy + vy;
        if (d >= ring.clear && Math.hypot(ndx, ndy) >= ring.clear) return;
        if (d < 0.001) {   // exactly on the centre: pick a direction rather than dividing by zero
          const a = Math.random() * Math.PI * 2;
          dx = Math.cos(a); dy = Math.sin(a); d = 1;
        }
        const ux = dx / d, uy = dy / d;
        if (d < ring.clear) {
          n.x = ring.x + ux * ring.clear;
          n.y = ring.y + uy * ring.clear;
        }
        // Drop the inward part of the velocity; keep whatever is tangential,
        // so a node slides around the rim instead of juddering against it.
        const inward = vx * ux + vy * uy;
        if (inward < 0) { n.vx = vx - inward * ux; n.vy = vy - inward * uy; }
      });
    });
  }

  function expandFamily(famId) {
    if (expandedFamilies.has(famId)) return;
    expandedFamilies.add(famId);
    invalidatePowerVis();
    const fam = byId.get(famId);
    if (fam) {
      layoutGenerationsRadial(fam);
      clearRing(ringOf(famId));
    }
    familyListeners.forEach(f => f(famId, true));
  }
  function collapseFamily(famId) {
    if (!expandedFamilies.has(famId)) return;
    expandedFamilies.delete(famId);
    invalidatePowerVis();
    const fam = byId.get(famId);
    if (fam) unpinGenerations(fam);
    familyListeners.forEach(f => f(famId, false));
  }

  // ---------- "from my database" hover/detail block ----------
  const DB_SPEC_ROWS = [["Power", "power"], ["Torque", "torque"], ["0–100", "accel0to100"],
    ["Top speed", "topSpeed"], ["Weight", "weight"], ["Price", "price"], ["Consumption", "consumption"]];
  // A family's own db flag is just inherited from a documented generation
  // (build_family_layer.py doesn't merge per-car specs/photos onto the
  // family node itself); fall through to that generation's data so the
  // collapsed nameplate's card isn't a bare, content-less "From my database" label.
  function dbSourceFor(n) {
    if ((!n.dbspecs && !n.dbphoto) && n.type === "family" && n.dbGenerations && n.dbGenerations.length) {
      return byId.get(n.dbGenerations[0]) || n;
    }
    return n;
  }
  function dbBlockHTML(n) {
    const src = dbSourceFor(n);
    const s = src.dbspecs || {};
    const rows = DB_SPEC_ROWS.filter(([, k]) => s[k])
      .map(([label, k]) => `<div class="db-row"><span>${label}</span><b>${s[k]}</b></div>`).join("");
    const foot = s.testDate ? `<div class="db-foot">tested · ${s.testDate}${s.testType ? " · " + s.testType : ""}</div>` : "";
    const gens = n.type === "family" && n.dbGenerations && n.dbGenerations.length > 1
      ? `<div class="db-foot">${n.dbGenerations.length} generations documented</div>` : "";
    const page = src.dbPage
      ? `<a class="db-page-link" href="${src.dbPage}" target="_blank" rel="noopener">Full overview ↗</a>` : "";
    return `<div class="db-label">✦ From my database</div>${rows}${foot}${gens}${page}`;
  }

  // An LLM-invented generation node (see llm_families.js) shares its parent
  // article's Wikipedia title (there's no separate article to harvest a
  // distinct thumbnail from) but may carry its own `wikiFile` — a filename
  // found right next to that generation's own text in the source article.
  // When present, this beats the generic per-article thumbnail so each
  // generation shows its own photo instead of every one of them (plus the
  // now-collapsed parent family) all showing the same lead image.
  function genPhotoUrl(n) {
    if (!n.wikiFile || !window.LlmFamilies) return null;
    return window.LlmFamilies.filePathUrl(n.wikiFile, 480);
  }
  // Real user report: "The thumbnails for the individual cars -- particularly
  // ones that are nameplates, still don't seem to match the generations it's
  // describing. Oftentimes the same picture will be used for each generation,
  // which might confuse the user."
  //
  // The fix for that lives in llm_families.js's findGenerationImage, which now
  // reads each generation's OWN infobox image out of the article (see its own
  // comment) rather than leaving most generations with nothing. This layer
  // deliberately does NOT suppress the nameplate's photo when a generation
  // still ends up without one -- a first attempt did, and Andy's correction
  // was explicit: "it's okay to fall back on whatever picture does exist, even
  // if it doesn't correspond to the correct picture in this case." A generic
  // photo beats an empty box; the real work is making the generic case rare.

  // ---------- wikipedia (live, lazy, graceful) ----------  // ---------- wikipedia (live, lazy, graceful) ----------
  const wikiCache = new Map();
  const API = "https://en.wikipedia.org/w/api.php?format=json&origin=*&redirects=1";

  // fallback for articles with no designated page image (common on
  // multi-generation nameplates like the Nissan Serena): take the first real
  // photo from the article's lead section / infobox.
  function apiThumb(title) {
    return fetch(API + "&action=parse&section=0&prop=images&page=" + encodeURIComponent(title))
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        const ims = (j && j.parse && j.parse.images || [])
          .filter(f => /\.(jpe?g|png|webp)$/i.test(f) &&
                       !/(logo|badge|icon|flag|map|emblem|wordmark|montage|animation)/i.test(f));
        if (!ims.length) return null;
        return fetch(API + "&action=query&prop=imageinfo&iiprop=url&iiurlwidth=420&titles=" +
                     encodeURIComponent("File:" + ims[0]))
          .then(r => r.ok ? r.json() : null)
          .then(j2 => {
            const p = j2 && j2.query && Object.values(j2.query.pages)[0];
            return p && p.imageinfo && p.imageinfo[0]
              ? (p.imageinfo[0].thumburl || p.imageinfo[0].url) : null;
          });
      })
      .catch(() => null);
  }

  function wiki(title) {
    if (wikiCache.has(title)) return wikiCache.get(title);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const p = fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" +
        encodeURIComponent(title.replace(/ /g, "_")) + "?redirect=true",
        { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(async j => {
        clearTimeout(t);
        if (!j) { wikiCache.delete(title); return null; }  // transient — retry on next hover
        let thumb = j.thumbnail ? j.thumbnail.source : null;
        if (!thumb) thumb = await apiThumb(title);
        return {
          thumb,
          extract: j.extract || "",
          url: j.content_urls ? j.content_urls.desktop.page : null,
        };
      })
      .catch(() => { wikiCache.delete(title); return null; });  // timeout/offline — retry later
    wikiCache.set(title, p);
    return p;
  }

  // ---------- hover card ----------
  const hc = document.getElementById("hovercard");
  const hcImg = hc.querySelector(".hc-img"), hcMono = hc.querySelector(".hc-monogram");
  const hcKick = hc.querySelector(".hc-kicker"), hcTitle = hc.querySelector(".hc-title");
  const hcMeta = hc.querySelector(".hc-meta"), hcNote = hc.querySelector(".hc-note");
  const hcDb = hc.querySelector(".hc-db");
  let hcNode = null;

  // Real user request: "for cars that are the same start and end year,
  // simply have them set as the year. Instead of '2016-2016', just do
  // '2016'." A single-year production run (a concept-car-style one-off, or
  // just a generation whose infobox gives the same year twice) used to
  // always render as a redundant "start–end" range -- this collapses it to
  // the bare year instead, while a genuine multi-year or still-in-
  // production range ("2016–2019" / "2016–") is untouched.
  function fmtYearRun(start, end) {
    if (start == null) return "";
    if (end == null) return `${start}–`;
    if (end === start) return `${start}`;
    return `${start}–${end}`;
  }
  function nodeKicker(n) {
    if (n.type === "engine") {
      const vars = (n.variants || []).length;
      const bits = [];
      if (vars) bits.push(vars + " variant" + (vars === 1 ? "" : "s"));
      // Not "no variants" -- see isEngineUnread. The M276 card read "NOT READ
      // YET" directly above its own displacement, configuration and a list of
      // seventeen cars, because it happens to have no sub-variants.
      if (isEngineUnread(n)) bits.push("not read yet");
      return ["engine"].concat(bits).join(" · ");
    }
    if (n.type === "enginevar") return "engine variant";
    if (n.type === "family") return (n.garage ? "my garage · " : "") + "nameplate · " + n.generations.length + " generations";
    if (n.type === "model") return (n.garage ? "my garage · " : n.heritage ? "heritage · " : "") + n.year;
    if (n.type === "make") return "marque" + (n.country ? " · " + n.country : "");
    return personRoleWord(n) + (n.born ? ` · ${n.born}–${n.died || ""}` : "");
  }
  // ---------- task #124: one car, counted once, at its most specific level ----------
  // Real user request (verbatim): "when I click on a designer or an engineer
  // and it counts how many cars that a given person (or group) worked on, it
  // should not count the nameplate of the car and then a generation of the
  // nameplate separately. In the case where the person (or group) is
  // associated with both, then it should only be counted once, and it should
  // explicitly display only the generation of the nameplate of the car, not
  // necessarily the nameplate itself... Naturally, if a nameplate doesn't
  // have further info about who designed the generations but only has info
  // on the nameplate itself, then fall back to the nameplate linking."
  //
  // The double count is deliberate upstream and correct there: both
  // build_family_layer.py (at build time) and llm_families.js's
  // applyConfirmed (at runtime, see its famPersonLinks rollup) mirror the
  // deduped set of generation-level designed/engineered credits UP to the
  // nameplate node, precisely so a collapsed nameplate still shows who drew
  // it. linkInLayer() already gives the generation-level line precedence in
  // the GRAPH once a family is expanded -- but a person's own card never had
  // an equivalent rule, so it read its raw adjacency list and counted
  // "G-Class" and "G-Class W463" as two separate cars, listing both.
  //
  // Collapsing here rather than at link-creation time is what preserves the
  // fallback the request ends on: the family-level link is never removed, so
  // a nameplate whose generations carry no credits of their own (nothing
  // more specific exists) still counts and displays exactly as before.
  // Returns [{node, link}] in adjacency order; callers sort as they like.
  function personCreditedCars(personId) {
    const out = [];
    const seen = new Set();
    (adj.get(personId) || []).forEach(({ n: o, l }) => {
      if (!o || o.retired || l.retired) return;
      if (l.type !== "designed" && l.type !== "engineered") return;
      if (o.type !== "model" && o.type !== "family") return;
      const key = o.id + "|" + l.type;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ node: o, link: l });
    });
    // Which nameplates does this person already have a GENERATION-level
    // credit on? Those are the ones whose family-level mirror is redundant.
    // Scoped per link type, so a person credited as ENGINEER on the
    // nameplate and DESIGNER on one generation keeps both facts.
    const specific = new Set(out.filter(c => c.node.familyOf).map(c => c.node.familyOf + "|" + c.link.type));
    return out.filter(c => !(c.node.type === "family" && specific.has(c.node.id + "|" + c.link.type)));
  }
  function nodeMeta(n) {
    if (n.type === "model" || n.type === "family") {
      const run = fmtYearRun(n.year, n.end);
      const d = n.designers && n.designers.length ? `<br>drawn by ${n.designers.join(" · ")}` : "";
      const e = n.engineers && n.engineers.length ? `<br>engineered by ${n.engineers.join(" · ")}` : "";
      return `${n.make} · ${run}${d}${e}`;
    }
    // An engine fell through to the person branch below and came out
    // "· 0 cars in the web" -- personCreditedCars knows nothing about a
    // fitted edge, so it counted none of the cars the card then listed.
    if (n.type === "engine" || n.type === "enginevar") {
      const index = powertrainNodeIndex();
      const sources = n.type === "engine"
        ? [n].concat((n.variants || []).map(id => index.get(id)).filter(Boolean))
        : [n];
      const cars = new Set();
      sources.forEach(src => powertrainEdgesFor(src, index)
        .filter(e => !isPowertrain(e.other))
        .forEach(e => cars.add(e.other.familyOf || e.other.id)));
      // Real user request: "I want that the engine details for the enginevar
      // to contain some basic info about the engine... The specs include
      // displacement, power output, number of cylinders, and formation (like
      // V pattern, inline, etc...). These should appear in the information
      // card about the engine or engine var... If there is no information
      // about this for a particular engine then do not try to make up
      // information."
      //
      // Read from the article when it was scanned (see llm_families.js's
      // engineSpecsFor): a standalone engine states its own, a family's
      // variants each state theirs. Anything the article does not say is
      // simply absent from this line.
      const LFam = window.LlmFamilies;
      const read = LFam && LFam.engineSpecsFor ? LFam.engineSpecsFor(n) : null;
      const fromArticle = (LFam && LFam.engineSpecSummary) ? LFam.engineSpecSummary(read) : "";
      const specs = [fromArticle || [n.configuration, n.displacement].filter(Boolean).join(" · "),
                     fmtYearRun(n.year, n.end)].filter(Boolean).join(" · ");
      const fitted = `fitted to ${cars.size} car${cars.size === 1 ? "" : "s"} in the web`;
      return [specs, fitted].filter(Boolean).join(" · ");
    }
    if (n.type === "make") {
      const m = adj.get(n.id).filter(a => a.l.type === "made" && !a.l.retired && a.n && !a.n.retired).length;
      return `${n.year ? "founded " + n.year + " · " : ""}${m} model${m - 1 ? "s" : ""} in the web`;
    }
    // Counted over the deduped credit set, not raw adjacency -- see
    // personCreditedCars above.
    //
    // Counting by NAMEPLATE identity (`familyOf || id`) rather than by node
    // id is the last piece of "it should only be counted once". The
    // per-role precedence in personCreditedCars is what the LIST needs --
    // an engineer credit that only exists at the nameplate level is a real
    // fact and shouldn't be dropped just because a DESIGNER credit happens
    // to exist on one generation. But those two entries are still one car,
    // and the count is a count of cars: "how many cars that a given person
    // (or group) worked on". So the list can legitimately show both rows
    // while the number stays 1.
    const m = new Set(personCreditedCars(n.id).map(c => c.node.familyOf || c.node.id)).size;
    return `${n.country || ""} · ${m} car${m - 1 ? "s" : ""} in the web`;
  }

  function showHover(n, x, y) {
    hcNode = n;
    hc.dataset.type = n.type;
    hcKick.textContent = nodeKicker(n);
    hcTitle.textContent = (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
    hcMeta.innerHTML = nodeMeta(n);
    hcNote.textContent = n.note || "";
    hcDb.innerHTML = n.db ? dbBlockHTML(n) : "";
    hc.classList.remove("hasimg");
    // Always clear any image left over from whichever node was hovered
    // before this one -- previously this was only ever overwritten when a
    // NEW image was actually found for `n`, so a node with no image of its
    // own (no My Database photo, no LLM generation photo, no Wikipedia
    // thumbnail — or one that's simply still loading) kept showing whatever
    // picture happened to be sitting in this shared <div> from the last
    // hover that had one. Clearing it up front means "no image" always
    // means no image, immediately, not a stale one bleeding through under
    // the monogram.
    hcImg.style.backgroundImage = "";
    hcMono.textContent = ((n.type === "model" || n.type === "family") ? n.make : n.label).slice(0, 1);
    hc.hidden = false;
    positionHover(x, y);
    const imgwrap = hc.querySelector(".hc-imgwrap");
    if (n.type === "make") { imgwrap.style.display = "none"; return; } // makes never show an image/placeholder area at all
    // Otherwise always show the image slot -- either the real photo (once
    // found) or, failing that, the monogram placeholder standing in for the
    // name (never a leftover image from a different node; see above).
    imgwrap.style.display = "block";
    const dbPhoto = n.dbphoto || (n.db ? dbSourceFor(n).dbphoto : null);
    const genPhoto = genPhotoUrl(n);
    if (dbPhoto) { hcImg.style.backgroundImage = `url("${dbPhoto}")`; hc.classList.add("hasimg"); }
    else if (genPhoto) { hcImg.style.backgroundImage = `url("${genPhoto}")`; hc.classList.add("hasimg"); }
    else if (n.wp) {
      wiki(n.wp).then(w => {
        // `n` may no longer be the hovered node by the time this resolves
        // (the user moved on, possibly to a node with no image at all) --
        // never apply a photo fetched for a node we've since moved away
        // from, or it's exactly the same stale-image bug one hover later.
        if (hcNode !== n) return;
        if (w && w.thumb) { hcImg.style.backgroundImage = `url("${w.thumb}")`; hc.classList.add("hasimg"); }
      });
    }
  }
  function positionHover(x, y) {
    const w = 250, h = hc.offsetHeight || 200;
    hc.style.left = Math.min(x + 18, innerWidth - w - 14) + "px";
    hc.style.top = Math.min(Math.max(10, y - h / 2), innerHeight - h - 14) + "px";
  }
  function hideHover() { hcNode = null; hc.hidden = true; }

  // ---------- detail panel ----------
  const dt = document.getElementById("detail");
  const verbs = { made: ["made by", "maker of"], designed: ["drawn by", "designed"],
    engineered: ["engineered by", "engineered"],
    platform: ["shares platform with", "shares platform with"],
    succession: ["succeeded by", "succeeds"],
    related: ["related to", "related to"],
    generation: ["generations", "part of"],
    gensucc: ["next generation", "previous generation"] };
  let dtNode = null;
  // Walking away from a car with an undecided LLM proposal (switching
  // straight to a different node, same as closing the panel outright)
  // discards it rather than letting it get silently written to disk later.
  function switchDetailAway() {
    if (dtNode && window.LlmFamilies) window.LlmFamilies.discardPending(dtNode.id);
    // ...and stop authorising background work on that car's behalf. Without
    // this, llmCheckArmedFor stayed set forever after the first check of the
    // session, so every later click kept the background schedulers live even
    // with the toggle visibly off.
    disarmLlmCheck();
  }
  // "A card was opened." Same subscribe-to-a-list shape as onFamilyChange /
  // onDbFilterChange. Added for the request panel, which retargets itself when
  // you click a different car while it is open -- so clicking around the graph
  // and then asking for "this one" works without going back to its text box.
  const detailListeners = [];
  function onDetailOpen(f) { detailListeners.push(f); }
  // ---------- the powertrain block on a detail card ----------
  // On a car: which engines it ran, and a way into each. On an engine: its
  // spec card, its variants, the cars it reached, and the button that reads
  // its article. Real user request: "The user can also now search for
  // individual engines (or, they can 'add a new engine' to the graph), and
  // have the LLM look through it."
  // Built fresh per render rather than read out of byId. An engine that a scan
  // has just created is in `nodes` and not yet in any index, and a card that
  // silently listed no engines in that window looks exactly like a car that
  // has none -- which is the report this whole pass came from.
  function powertrainNodeIndex() {
    const m = new Map();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }
  function powertrainEdgesFor(node, index) {
    const out = [];
    const byIdLocal = index || powertrainNodeIndex();
    const idOf = e => (typeof e === "string" ? e : e && e.id);
    for (const l of links) {
      if (l.retired || l.type !== "fitted") continue;
      const sid = idOf(l.source), tid = idOf(l.target);
      if (sid !== node.id && tid !== node.id) continue;
      const s = byIdLocal.get(sid) || l.sn;
      const t = byIdLocal.get(tid) || l.tn;
      if (!s || !t) continue;
      if (s === node) out.push({ other: t, l });
      else if (t === node) out.push({ other: s, l });
    }
    return out;
  }
  function engineOfVariant(n, index) {
    if (!n || !n.engineOf) return null;
    return (index ? index.get(n.engineOf) : byId.get(n.engineOf)) ||
           nodes.find(x => x.id === n.engineOf) || null;
  }

  function renderPowertrain(n) {
    const box = dt.querySelector(".dt-power");
    if (!box) return;
    box.innerHTML = "";
    const LFam = window.LlmFamilies;
    if (!LFam || !LFam.checkEngine) return;
    const index = powertrainNodeIndex();
    const look = id => index.get(id);

    const row = (label, sub, onclick, cls, parent) => {
      const b = document.createElement("button");
      b.className = "dt-conn" + (cls ? " " + cls : "");
      b.innerHTML = `${esc(label)}${sub ? ` <span class="verb">${esc(sub)}</span>` : ""}`;
      if (onclick) b.onclick = onclick; else b.disabled = true;
      (parent || box).appendChild(b);
      return b;
    };
    const head = text => {
      const h = document.createElement("h4"); h.textContent = text; box.appendChild(h); return h;
    };

    if (isPowertrain(n)) {
      const eng = n.type === "enginevar" ? engineOfVariant(n, index) : n;
      const entry = eng && LFam.engineEntryFor ? LFam.engineEntryFor(eng.id) : null;
      if (n.type === "enginevar" && eng) {
        head("Engine");
        row(eng.label, "variant of", () => api.goto(eng.id));
      }
      if (n.type === "engine") {
        // The specs line lives in the card's own meta row now (see nodeMeta),
        // which is where every other node type puts that sort of thing --
        // printing it here as well put it on the card twice.
        const vars = (n.variants || []).map(look).filter(Boolean);
        if (vars.length) {
          head("Variants");
          vars.forEach(v => row(v.label, null, () => api.goto(v.id), "dt-gen"));
        }
      }
      // On an engine, roll the variants up. The applications belong to the
      // variants -- that is where the article puts them -- so an engine's own
      // card was reporting "Fitted to 1 car" while its three variants held
      // nineteen between them.
      const sources = n.type === "engine"
        ? [n].concat((n.variants || []).map(look).filter(Boolean))
        : [n];
      const fitted = [];
      const seenCar = new Set();
      sources.forEach(src => {
        powertrainEdgesFor(src, index).filter(e => !isPowertrain(e.other)).forEach(e => {
          const key = e.other.id + "|" + (e.l.yearStart || "") + "|" + (e.l.yearEnd || "");
          if (seenCar.has(key)) return;
          seenCar.add(key);
          fitted.push(Object.assign({ via: src === n ? null : src }, e));
        });
      });
      // The nameplate rule, so the card agrees with the canvas: a nameplate
      // whose own generation is in this list does not appear itself. See
      // powerSets for the report behind it.
      const coveredFams = new Set();
      fitted.forEach(f => { if (f.other.familyOf) coveredFams.add(f.other.familyOf); });
      for (let i = fitted.length - 1; i >= 0; i--) {
        if (coveredFams.has(fitted[i].other.id)) fitted.splice(i, 1);
      }
      if (fitted.length) {
        head(fitted.length === 1 ? "Fitted to 1 car" : `Fitted to ${fitted.length} cars`);
        fitted.sort((a, b) => (a.l.yearStart || 0) - (b.l.yearStart || 0));
        fitted.forEach(({ other, l, via }) => {
          const run = fmtYearRun(l.yearStart, l.yearEnd);
          row(`${other.make ? other.make + " " : ""}${other.label}`,
              [run, via ? via.label : null, l.note].filter(Boolean).join(" · "),
              () => api.goto(other.id));
        });
      }
      // The scan. An engine that arrived as a mention has no article read yet,
      // which is exactly the state this button exists for.
      // Real user request: "The 'Request Scan' button should once again be the
      // only button that allows the user to do a scan of an existing entry,
      // including for engines. Therefore, the web user should not have access
      // to 'read this engine's article' or 'Merge another engine in'. This
      // should only be available within serve.py."
      //
      // They were the only LLM controls in this file not gated this way, so on
      // the hosted site they offered work that had nowhere to run and nothing
      // to save to. Reading an engine's article from the web goes through the
      // request queue now, same as a car.
      if (n.type === "engine" && LFam.serverAvailable) {
        const wrap = document.createElement("div");
        wrap.className = "llm-actions";
        const btn = document.createElement("button");
        btn.className = "llm-btn";
        const unread = isEngineUnread(n);
        btn.textContent = unread ? "Read this engine's article" : "Read it again";
        btn.onclick = () => scanEngine(n.wp || n.label, btn, n);   // n carries its own name
        wrap.appendChild(btn);
        // Folding another engine in, and undoing it. Same shape as a
        // nameplate merge: the other engine's variants become this one's.
        const mergedInto = (window.LlmFamilies.allEngineMerges || (() => []))()
          .find(r => r.id === n.id);
        if (mergedInto) {
          const undo = document.createElement("button");
          undo.className = "llm-btn";
          undo.textContent = "Un-merge";
          undo.title = "put back the engine(s) folded into this one";
          undo.onclick = () => {
            window.LlmFamilies.undoEngineMerge(n.id);
            window.alert("Un-merged. Reload to see it separate again.");
          };
          wrap.appendChild(undo);
        }
        const mergeBtn = document.createElement("button");
        mergeBtn.className = "llm-btn";
        mergeBtn.textContent = "Merge another engine in…";
        mergeBtn.onclick = () => mergeEnginePrompt(n);
        wrap.appendChild(mergeBtn);
        box.appendChild(wrap);
        const note = document.createElement("div");
        note.className = "llmdebug-note dt-power-note";
        note.textContent = unread
          ? "Named by a car that was checked. Nothing has read its own article yet — "
            + "doing that finds its variants and every car it went into."
          : "Read on " + String((entry && entry.checkedAt) || "").slice(0, 10) + ".";
        box.appendChild(note);
      } else if (n.type === "engine") {
        const note = document.createElement("div");
        note.className = "llmdebug-note dt-power-note";
        note.textContent = isEngineUnread(n)
          ? "Named by a car that was checked. Nothing has read its own article yet — "
            + "use ⚡ Request scan to have the machine read it."
          : "Read on " + String((entry && entry.checkedAt) || "").slice(0, 10) + ".";
        box.appendChild(note);
      }
      return;
    }

    // An ordinary car. Real user request: "for the engines within the Graph
    // Tab, I want them to be contained in a dropdown within the info card,
    // not expanded by default, with the user to expand it at their
    // choosing." A car with a dozen engines pushed everything else on the
    // card -- designers, relations, the LLM controls -- off the bottom.
    //
    // Open on the Powertrain tab, where engines are the whole point of
    // looking, and shut on every other tab.
    let engines = powertrainEdgesFor(n, index).filter(e => isPowertrain(e.other));
    // Real user report on the SL R232's card: "notice that the engine and the
    // enginevar is specified in the list of engines... if the engine var is
    // there for the car, then only show the engine var... Only fall back to
    // the engine name if there is no engine var, but dont show both."
    //
    // The same rule as a nameplate and its generation, one level down: an
    // engine whose own variant is fitted to this car is not listed itself.
    {
      const covered = new Set();
      engines.forEach(e => { if (e.other.type === "enginevar") covered.add(e.other.engineOf); });
      if (covered.size) engines = engines.filter(e => !covered.has(e.other.id));
    }
    // Engines the car's own list names with no article behind them. The
    // Suburban's 1973 infobox names seven and links one: the other six are
    // real engines with nothing to follow, so they are shown as the line
    // stated them -- no node, no link, nothing to click. See
    // unlinkedEngineMentions.
    const scan = LFam.engineScanEntryFor ? LFam.engineScanEntryFor(n.id) : null;
    const unlinked = (scan && scan.unlinked) || [];
    if (!engines.length && !unlinked.length) return;
    const det = document.createElement("details");
    det.className = "dt-power-fold";
    if (activeView === "power") det.open = true;
    const sum = document.createElement("summary");
    const total = engines.length + unlinked.length;
    sum.textContent = total === 1 ? "Engine" : `Engines (${total})`;
    det.appendChild(sum);
    box.appendChild(det);
    engines.forEach(({ other, l }) => {
      const eng = other.type === "enginevar" ? engineOfVariant(other, index) : other;
      // A car runs several engines off one article far more often than not:
      // the 1960 Suburban's infobox names three Turbo-Thrifts, 230, 250 and
      // 292 cu in. Each is its own row, so each has to say WHICH -- until
      // the article is read and they become named variants, the only thing
      // that tells them apart is what the car's own line said.
      const said = l.saidSpecs || {};
      const which = other.type === "enginevar" ? other.label
                  : (l.variantHint || said.displacement || null);
      const sub = [which,
                   other.type !== "enginevar" && l.variantHint && said.displacement &&
                     String(l.variantHint).toLowerCase().replace(/[^a-z0-9]/g, "") !==
                     String(said.displacement).toLowerCase().replace(/[^a-z0-9]/g, "")
                       ? said.displacement : null,
                   fmtYearRun(l.yearStart, l.yearEnd),
                   isEngineUnread(eng) ? "not read yet" : null].filter(Boolean).join(" · ");
      row(eng ? eng.label : other.label, sub, () => api.goto(other.id), null, det);
    });
    // row() with no click handler renders disabled, which is exactly right:
    // there is nothing to open.
    unlinked.forEach(u => {
      const sp = u.specs || {};
      const b = row(u.name, [fmtYearRun(sp.yearStart, sp.yearEnd), "no article"]
                              .filter(Boolean).join(" · "), null, null, det);
      b.title = u.said || u.name;
    });
  }
  // Whether an engine's own article has actually been read. `unresearched` is
  // set when a car names an engine and cleared by a scan, but an engine whose
  // article yields no VARIANTS kept looking unread on the card while plainly
  // showing its specs and seventeen applications -- the flag was being second-
  // guessed by a variant count. The store entry is the real answer.
  function isEngineUnread(eng) {
    if (!eng) return false;
    const LFam = window.LlmFamilies;
    const entry = LFam && LFam.engineEntryFor ? LFam.engineEntryFor(eng.id) : null;
    return !entry || entry.status !== "confirmed";
  }

  // Fold another engine into this one. Named rather than picked from a list
  // because the powertrain view is small and an engine's name is the thing
  // anyone would type: "M256", "Mercedes-Benz M256".
  function mergeEnginePrompt(primary) {
    const others = nodes.filter(n => n.type === "engine" && !n.retired && n !== primary);
    if (!others.length) { window.alert("There is no other engine in the graph to merge in."); return; }
    const typed = window.prompt(
      `Fold which engine into ${primary.label}?` + "\n\n" +
      "Its variants become this engine's, and everything it was fitted to comes with it.\n\n" +
      "Known: " + others.map(n => n.label).slice(0, 25).join(", "));
    const want = String(typed || "").trim();
    if (!want) return;
    const hit = others.find(n => n.label.toLowerCase() === want.toLowerCase()) ||
                others.find(n => n.label.toLowerCase().includes(want.toLowerCase()));
    if (!hit) { window.alert(`No engine here matches "${want}".`); return; }
    const nodesBefore = nodes.length, linksBefore = links.length;
    const r = window.LlmFamilies.mergeEngines(primary.id, [hit.id], nodes, links);
    if (!r.ok) { window.alert(r.error || "could not merge those"); return; }
    spliceIntoIndexes(nodesBefore, linksBefore);
    powertrainChanged();
    dtNode = null; openDetail(primary);
    console.info(`[carweb] merged ${hit.label} into ${primary.label}; ${r.variants} variant(s) now`);
  }

  // Read an engine article and put what it finds in the graph. The only place
  // in the UI that reaches the network for this layer.
  // `node` is the engine whose card asked for this. Real bug report: '"Read
  // it again" seems to not do anything at all', and the "Read on ..." date
  // never moved -- because a redirect put the result on a different id (see
  // llm_families.js's applyEngineArticleWith). Passing the node pins it.
  function scanEngineNow(title, btn, node) {
    const LFam = window.LlmFamilies;
    if (!LFam || !LFam.checkEngine || !title) return Promise.resolve();
    if (btn) { btn.disabled = true; btn.textContent = "reading…"; }
    // Reading an engine is a person asking for LLM work in as many words, so
    // the cars it names are allowed to be checked in the background off the
    // back of it -- the same permission clicking "LLM Check" on a car grants.
    // See llm_families.js's setBackgroundAllowed and scheduleEngineCascade.
    if (LFam.setBackgroundAllowed) LFam.setBackgroundAllowed(true);
    const nodesBefore = nodes.length, linksBefore = links.length;
    // Real user request: "the 'scan' should essentially act like an 'llm
    // recheck' for whatever it is looking at. In this case it's supposed to be
    // the engine." So this button is the engine's 🔄 LLM Re-check: the stored
    // read and the cached article are dropped first, and nothing in flight is
    // reused.
    // `name` is what says WHICH engine, when the article covers several:
    // "M177" out of the M176/M177/M178 page. See llm_families.js's
    // splitMultiEngineTitle.
    const opts = { mintCars: true, revive: true, id: node ? node.id : undefined,
                   name: node ? node.label : undefined };
    const run = LFam.forceRecheckEngine
      ? LFam.forceRecheckEngine(title, nodes, links, opts)
      : LFam.checkEngine(title, nodes, links, opts);
    // Returned, not fired and forgotten: the work queue needs to know when
    // this pass is actually over before it starts the next one.
    return run.then(r => {
      if (r && r.status === "not-an-engine") {
        if (btn) { btn.disabled = false; btn.textContent = "Read this engine's article"; }
        window.alert(`"${title}" is not an engine article.`);
        return;
      }
      if (!r || r.status !== "confirmed") {
        if (btn) { btn.disabled = false; btn.textContent = "Try again"; }
        console.warn("CarWeb: engine scan failed", r);
        return;
      }
      spliceIntoIndexes(nodesBefore, linksBefore);
      if (nodes.length !== nodesBefore) buildSim();
      powertrainChanged();
      refreshCounts();
      Graph.touch();
      // Re-opened so the card is rebuilt from the fresh entry -- the variant
      // list, the cars, and the "Read on ..." date all come from it.
      const eng = r.engine || byId.get(r.id) || node;
      if (eng) { dtNode = null; openDetail(eng); }
      console.info(`[carweb] read ${title}: ${r.variants} variant(s), ${r.fitted} car(s)` +
                   (r.queued ? `, ${r.queued} car(s) queued for their own check` : ""));
    }).catch(e => {
      if (btn) { btn.disabled = false; btn.textContent = "Try again"; }
      console.warn("CarWeb: engine scan threw", e);
    });
  }
  // The button's entry point: ask for it, don't run it. See the work queue in
  // llm_families.js for why every user-initiated pass goes through this.
  function scanEngine(title, btn, node) {
    if (!title) return;
    const label = node ? ((node.make ? node.make + " " : "") + node.label) : String(title);
    return enqueueLlmJob({ kind: "engine-read", targetId: (node && node.id) || "engine:" + title,
                           label, detail: { title, nodeId: node ? node.id : null } }, btn);
  }

  function openDetail(n) {
    if (dtNode && dtNode !== n) switchDetailAway();
    dtNode = n;
    detailListeners.forEach(f => { try { f(n); } catch (e) {} });
    if (window.LlmFamilies) window.LlmFamilies.setEngaged(n.id);
    dt.hidden = false;
    dt.querySelector(".dt-kicker").textContent = nodeKicker(n);
    dt.querySelector(".dt-title").textContent = (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
    const img = dt.querySelector(".dt-imgwrap");
    img.classList.remove("show"); img.style.backgroundImage = "";
    dt.querySelector(".dt-meta").innerHTML = nodeMeta(n) + (n.note ? `<br><i>${n.note}</i>` : "");
    dt.querySelector(".dt-db").innerHTML = n.db ? dbBlockHTML(n) : "";
    const ex = dt.querySelector(".dt-extract"); ex.textContent = "";
    const dbPhoto = n.dbphoto || (n.db ? dbSourceFor(n).dbphoto : null);
    const genPhoto = genPhotoUrl(n);
    if (dbPhoto) { img.style.backgroundImage = `url("${dbPhoto}")`; img.classList.add("show"); }
    else if (genPhoto) { img.style.backgroundImage = `url("${genPhoto}")`; img.classList.add("show"); }
    if (n.wp) wiki(n.wp).then(w => {
      if (dt.hidden) return;
      if (w && w.thumb && !dbPhoto && !genPhoto) { img.style.backgroundImage = `url("${w.thumb}")`; img.classList.add("show"); }
      if (w && w.extract) ex.innerHTML = w.extract.split(". ").slice(0, 2).join(". ") +
        (w.url ? `. <a href="${w.url}" target="_blank" rel="noopener">Wikipedia ↗</a>` : "");
    });
    renderPowertrain(n);
    const genWrap = dt.querySelector(".dt-generations");
    genWrap.innerHTML = "";
    if (n.type === "family" && n.generations && n.generations.length) {
      const h = document.createElement("h4"); h.textContent = "Generations"; genWrap.appendChild(h);
      n.generations.map(id => byId.get(id)).filter(Boolean).forEach(g => {
        const b = document.createElement("button");
        b.className = "dt-conn dt-gen";
        const run = fmtYearRun(g.year, g.end);
        b.innerHTML = `${g.label} <span class="verb">${run}</span>`;
        b.onclick = () => api.goto(g.id);
        genWrap.appendChild(b);
      });
    }
    const groups = {};
    // Task #124: a person's card counts and lists cars through the deduped
    // credit set (see personCreditedCars), so a nameplate and one of its own
    // generations never both appear for the same credit -- the generation
    // wins, the nameplate is the fallback. Every other node type reads its
    // raw adjacency exactly as before; the collapse is only ever meaningful
    // from the person's side, since it's the person node that carries both
    // the generation-level link and its family-level mirror at once.
    // `|| []` because adj only holds what has been spliced into it, and a
    // node can legitimately be in the graph a moment before it is indexed --
    // an engine recorded mid-scan is the case. Without it, opening that card
    // threw and took the whole panel with it.
    const conns = n.type === "person"
      ? personCreditedCars(n.id).map(c => ({ n: c.node, l: c.link }))
      : (adj.get(n.id) || []);
    // Real user question: "Where does the engineer data come from? Is it truly
    // not coming from the LLM wikipedia pages at all?"
    //
    // Fair question, and the honest answer was "mostly". The BUILD-time
    // engineers layer is hand-compiled (data_src/d_engineers.py -- documented
    // chief-engineer and project-lead attributions, which is why the footer
    // calls it hand-verified) and DBpedia contributes none of it: harvest.py
    // does not query any engineer predicate at all. But the LLM generation
    // check reads designers AND engineers off the article, and those credits
    // go into the graph the same way, as ordinary designed/engineered links.
    //
    // Which meant the two were indistinguishable once in: a name read off a
    // Wikipedia paragraph by a 9B model sat in the same list, in the same
    // style, as one that had been checked by hand. Every credit the LLM layer
    // creates now carries llmDiscovered, and this is where that shows.
    const creditIsLlmSourced = l => !!(l && l.llmDiscovered &&
      (l.type === "designed" || l.type === "engineered"));
    const llmCredited = new Set();
    conns.forEach(({ n: o, l }) => {
      if (o.retired) return;  // superseded by a nameplate generation-list override, see nodeInLayer
      // A link severed along with its deleted LLM-discovered relationship
      // (see llm_families.js's severRelationLinks) is invisible in the graph
      // from the same moment -- it must not keep showing up as a live
      // connection on either endpoint's card either, which is exactly the
      // "I deleted it but it still appeared" half of the Ford Focus / VW
      // Jetta bug report.
      if (l.retired) return;
      // Powertrain edges have their own section on this same card (see
      // renderPowertrain), which names them properly -- "Engines", "Fitted to
      // 17 cars". Here they fell through to the generic fallback verb and
      // came out as a second "linked to" list holding exactly the same rows,
      // on both the Graph and the Powertrain tab. One place each.
      if (POWERTRAIN_LINKS.has(l.type) || isPowertrain(o)) return;
      if (l.type === "generation" && n.type === "family") return;  // shown separately above for families;
      // for an individual generation, the reverse of this same link ("part of")
      // is exactly how it points back up to its family, so it stays.
      const dir = l.sn === n ? 0 : 1;
      let verb = (verbs[l.type] || ["linked to", "linked to"])[dir];
      if (l.type === "engineered" && l.note) verb = `engineered by · ${l.note}`;
      if (creditIsLlmSourced(l)) llmCredited.add(verb + "|" + o.id);
      (groups[verb] = groups[verb] || []).push(o);
    });
    // One car, one row. Real bug report: the Cupra Terramar's "shares platform
    // with" list showed "Volkswagen Tiguan 2007" twice and Škoda Kodiaq three
    // times. The underlying cause was duplicate links (see llm_families.js's
    // mirrorRelationLinks, where an undirected relation was being keyed
    // source-first), and that's fixed at the source -- but this list is built
    // one row per LINK while the canvas draws one line per PAIR (linkInLayer's
    // mirror-vs-real precedence), so the card had no equivalent of that rule
    // and would surface any future double-link the same way. Deduping by node
    // id here means it can't, whatever the reason for the second link.
    Object.keys(groups).forEach(verb => {
      const seen = new Set();
      groups[verb] = groups[verb].filter(o => !seen.has(o.id) && seen.add(o.id));
    });
    const conn = dt.querySelector(".dt-connections");
    conn.innerHTML = "";
    Object.entries(groups).forEach(([verb, arr]) => {
      const h = document.createElement("h4"); h.textContent = verb; conn.appendChild(h);
      arr.sort((a, b) => (a.year || 0) - (b.year || 0)).forEach(o => {
        const b = document.createElement("button");
        b.className = "dt-conn";
        const fromLlm = llmCredited.has(verb + "|" + o.id);
        b.innerHTML = `${(o.type === "model" || o.type === "family") ? o.make + " " + o.label : o.label}` +
          ((o.type === "model" || o.type === "family") ? ` <span class="verb">${o.year}</span>` : "") +
          (fromLlm ? ` <span class="conn-llm" title="read off the Wikipedia article by the local model, not from the hand-verified engineers table">🤖</span>` : "");
        if (fromLlm) b.classList.add("from-llm");
        b.onclick = () => api.goto(o.id);
        conn.appendChild(b);
      });
    });
    renderLlmCheck(n);
    renderRelationChecks(n);
  }
  document.getElementById("detail-close").onclick = () => {
    switchDetailAway();
    if (window.LlmFamilies) window.LlmFamilies.setEngaged(null);
    dt.hidden = true; dtNode = null;
    Graph.clearSelection();
  };

  // ---------- LLM generation-check UI (see llm_families.js) ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Splits into a BODY (the check's own status/proposal/error UI, which
  // several async handlers freely replace wholesale via innerHTML) and a
  // persistent Wikipedia-link ROW appended after it -- see renderWpLinkRow
  // for why that row has to live outside the body rather than inside it.
  function renderLlmCheck(n) {
    const el = dt.querySelector(".dt-llmcheck");
    if (!el) return;
    el.innerHTML = "";
    // The link row now lives at the very bottom of the card (its own
    // .dt-wplink container, after the connections list) rather than inside
    // .dt-llmcheck -- so it has to be cleared here too, or every re-render
    // would stack another copy of it.
    const wpEl = dt.querySelector(".dt-wplink");
    if (wpEl) wpEl.innerHTML = "";
    if (!window.LlmFamilies || !window.LlmFamilies.serverAvailable) return;
    const body = document.createElement("div");
    el.appendChild(body);
    renderLlmCheckBody(body, n);
    // Real user report: "Currently with car marks that are brand new and the
    // LLM cannot find a link, I as the user cannot enter a link after the
    // fact. However, I should be able to add a wikipedia link to it." Makes
    // were excluded here purely because none of the three LLM checks apply to
    // one -- but the link row isn't a check, it's the card's own "what
    // article is this?" control, and a make (especially one minted by
    // mintRelatedNode from a related car's badge) needs it just as much. Its
    // link drives the hover card's photo and extract like any other node's.
    // Real user request: "on the serve.py side, there should be a similar
    // small option at the bottom of the info card that is a dropdown where
    // the user can have the 'change link' and 'find it' buttons similar to
    // the graph tab." An engine's article is the single thing its whole card
    // is derived from, and a mention can easily name the wrong one -- so it
    // gets the same fold, and the same local-only gate every other write
    // control has.
    if ((n.type === "model" || n.type === "family" || n.type === "make" ||
         n.type === "engine") && wpEl) renderWpLinkRow(wpEl, n, body);
  }
  // ---------- re-run whichever kind of check this node is actually eligible for ----------
  // Three different questions, three different entry points, one caller-
  // facing action ("check this car again, now"): a plain model asks whether
  // it hides multiple generations (checkNode), a nameplate asks whether its
  // generation list is still right (forceRecheckFamily), and a specific
  // generation asks what its OWN article says about who built it and what
  // it's related to (researchGeneration). Used by the Wikipedia-link row
  // below (after a link is corrected) and by the Modify Existing Car panel,
  // so neither has to know which case it's looking at.
  // ---------- asking for LLM work: the queue ----------
  // Real user request: "If I want to add further cars for the LLM to check
  // (in serve.py, or in the web version, or anywhere), make sure that the
  // request is properly added to the queue in a way that it does not ruin any
  // scanning or have data loss. I want there to also be a queuing system
  // everywhere, including serve.py, for if I want to request several
  // different models to be checked and I want to request to scan them while
  // others are already currently being scanned."
  //
  // Every button that asks for LLM work now calls enqueueLlmJob instead of
  // starting a pass, and llm_families.js runs them one at a time in order and
  // keeps the waiting ones on disk. See its own "work queue" section for why
  // two passes at once lost data rather than merely being slow.
  //
  // The runners below are the passes themselves, unchanged -- they are
  // registered rather than called. Each one re-finds the element it writes
  // into instead of being handed one: by the time a queued job runs, the card
  // it was asked from may be closed, or on a different car, or re-rendered
  // from scratch by the pass before it. Same reason deepRecheckGenerations
  // re-finds its own progress row.
  function llmCheckBody(targetId) {
    if (!dtNode || dtNode.id !== targetId) return null;
    const el = dt.querySelector(".dt-llmcheck");
    return (el && el.firstElementChild) || el || null;
  }
  function initLlmJobRunners() {
    const LF = window.LlmFamilies;
    if (!LF || !LF.registerJobRunner) return;
    LF.registerJobRunner("node-check", async job => {
      const n = byId.get(job.targetId);
      if (!n || n.retired) return;
      const el = llmCheckBody(n.id);
      if (el) el.innerHTML = `<div class="llm-status">🤖 checking Wikipedia for hidden generations…</div>`;
      // explicit: the user clicked this car's own check. Keep the result even
      // if they navigate or the page reloads while it runs -- see checkNode.
      await LF.checkNode(n, nodes, { explicit: true });
      afterLlmCheck(n);
    });
    LF.registerJobRunner("family-recheck", async job => {
      const n = byId.get(job.targetId);
      if (!n || n.retired) return;
      await runManualRecheckNow(n, llmCheckBody(n.id), false);
    });
    LF.registerJobRunner("family-recheck-deep", async job => {
      const n = byId.get(job.targetId);
      if (!n || n.retired) return;
      await runManualRecheckNow(n, llmCheckBody(n.id), true);
    });
    LF.registerJobRunner("gen-research", async job => {
      const n = byId.get(job.targetId);
      if (!n || n.retired) return;
      await runGenerationResearchNow(n, llmCheckBody(n.id));
    });
    LF.registerJobRunner("engine-read", async job => {
      const d = job.detail || {};
      // Pinned to the node where there is one: a redirect would otherwise
      // land the read on a different id. See scanEngineNow's own note.
      const n = d.nodeId ? byId.get(d.nodeId) : null;
      const title = d.title || (n && (n.wp || n.label));
      if (!title) return;
      await scanEngineNow(title, null, n || undefined);
    });
    LF.registerJobRunner("engine-scan", async job => {
      const n = byId.get(job.targetId);
      if (!n || n.retired) return;
      recordEnginesLive();
      await scanEnginesLive(n);
    });
    LF.onJobChange(() => { refreshQueueUi(); });
  }

  // A job asked for, and whatever the card should say about it right now.
  // Without this, pressing a button while something else ran looked exactly
  // like pressing a button that does nothing -- which is what it used to be.
  function enqueueLlmJob(spec, btn, el) {
    const LF = window.LlmFamilies;
    if (!LF || !LF.enqueueJob) return null;
    const res = LF.enqueueJob(spec);
    if (!res) return null;
    const say = msg => {
      if (el && el.isConnected) el.innerHTML = `<div class="llm-status">${msg}</div>`;
      if (btn) { btn.disabled = true; btn.textContent = "queued"; }
    };
    if (res.error === "queue-full") {
      const msg = `The queue is full (${res.limit} waiting). Let some of it run first.`;
      if (el && el.isConnected) el.innerHTML = `<div class="llm-status llm-error">${msg}</div>`;
      else window.alert(msg);
      return res;
    }
    if (res.duplicate) { say(`⏳ already asked for — ${queuePhrase(res)}`); return res; }
    const pos = LF.jobPositionFor(spec.targetId, spec.kind);
    // Position 0 means it started immediately, and the runner's own status
    // line is already on screen -- don't overwrite it with "1st in line".
    if (pos > 0) say(`⏳ queued — ${queuePhrase(res)}`);
    return res;
  }
  function queuePhrase(job) {
    const LF = window.LlmFamilies;
    const pos = LF && LF.jobPositionFor ? LF.jobPositionFor(job.targetId, job.kind) : -1;
    if (pos === 0) return "running now";
    if (pos < 0) return "not in the queue";
    const running = LF.runningJob && LF.runningJob();
    return (pos === 1 ? "next in line" : ordinalWord(pos) + " in line") +
           (running ? ` (${esc(running.label)} is running now)` : "");
  }
  function ordinalWord(n) {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Which pass a node's own "check it" means. One dispatcher, used by the
  // card's controls, by the link-change row, and by the queue panel's "Send
  // request" -- so asking for a car from any of them asks for the same work.
  function llmJobSpecFor(n) {
    const LF = window.LlmFamilies;
    if (!n || n.retired || n.type === "make") return null;
    const label = (n.make ? n.make + " " : "") + n.label;
    if (n.type === "engine") {
      return { kind: "engine-read", targetId: n.id, label,
               detail: { title: n.wp || n.label, nodeId: n.id } };
    }
    if (LF.isEligibleForRecheck(n)) return { kind: "family-recheck", targetId: n.id, label };
    if (LF.isEligibleForGenerationResearch && LF.isEligibleForGenerationResearch(n)) {
      return { kind: "gen-research", targetId: n.id, label };
    }
    return { kind: "node-check", targetId: n.id, label };
  }
  function recheckNodeNow(n, el) {
    // A make has no LLM check of its own -- setting its link is the whole
    // action, and openDetail (already re-run by the caller) is what picks up
    // the new article's photo and extract.
    const spec = llmJobSpecFor(n);
    if (!spec) { if (el) el.innerHTML = ""; return; }
    return enqueueLlmJob(spec, null, el);
  }
  // ---------- generation-level research (see llm_families.js's researchGeneration) ----------
  // researchGeneration writes straight into the live nodes/links arrays
  // (person nodes, designed/engineered links, and whatever
  // resolvePlatformMention resolves or mints for the related cars its own
  // article names) -- so everything it added has to be spliced into this
  // file's indexes before anything reads them again, exactly like every
  // other live mutation here. applyRelationConfirm afterwards is what wires
  // in the relation entries it resolved and re-opens the panel in place.
  function runGenerationResearchNow(gen, el) {
    const LF = window.LlmFamilies;
    const fam = gen.familyOf ? byId.get(gen.familyOf) : null;
    const nodesBefore = nodes.length, linksBefore = links.length;
    if (el) el.innerHTML = `<div class="llm-status">🤖 looking for this generation's own Wikipedia article, then reading it…</div>`;
    return LF.researchGeneration(gen, fam, nodes, links).then(res => {
      spliceIntoIndexes(nodesBefore, linksBefore);
      if (nodes.length !== nodesBefore) buildSim();
      refreshYearFilter();
      indexMirrorReplacements();
      refreshCounts();
      applyRelationConfirm(gen); // wires any relation this just resolved + re-renders the panel
      // Real bug report: "When I do 'research this generation' for a
      // particular generation, it seems to not do research for the engine
      // information for a generation." researchGeneration does record the
      // engines its article names -- see its own `engines` field -- but
      // nothing put them in the graph, so they sat in the store until some
      // later pass or the next reload happened to pick them up.
      recordEnginesLive();
      const eng = scanEnginesLive(gen);
      if (dtNode === gen && res && res.status === "error" && el && el.isConnected) {
        el.innerHTML = `<div class="llm-status llm-error">Generation research failed: ${esc(res.error || "unknown error")}</div>`;
      }
      // Awaited so the queue does not start the next pass while this one is
      // still reading and splicing engines.
      return eng;
    });
  }
  function runGenerationResearch(gen, el) {
    return enqueueLlmJob({ kind: "gen-research", targetId: gen.id,
                           label: (gen.make ? gen.make + " " : "") + gen.label }, null, el);
  }
  function renderGenerationResearch(el, gen) {
    const LF = window.LlmFamilies;
    const entry = LF.genResearchEntryFor ? LF.genResearchEntryFor(gen.id) : null;
    const row = document.createElement("div");
    row.className = "llm-recheck-row";
    // Real user request: "the user should also be able to do an LLM search
    // on an individual generation as well, and should have the ability to
    // use the LLM to research about it." Always available (like the
    // nameplate's own 🔄 LLM Re-check button, and unlike the automatic
    // toggle-gated checks) -- this is an explicit, deliberate action on one
    // specific car, not a background probe, so there's nothing to protect
    // against by hiding it.
    row.innerHTML = `<button type="button" class="llm-btn llm-genresearch-btn" title="find this generation's own Wikipedia article (rather than the nameplate's general one) and read it for designers, engineers and related cars">🔎 Research this generation</button>`;
    el.appendChild(row);
    row.querySelector(".llm-genresearch-btn").onclick = () => runGenerationResearch(gen, row);
    if (!entry || entry.status !== "done") return;
    const key = "genresearch:" + gen.id;
    if (dismissedLlm.has(key)) return;
    const bits = [];
    if (entry.upgradedArticle) bits.push(`now reading its own article, <b>${esc(entry.upgradedArticle)}</b>, instead of the nameplate's`);
    if (entry.relatedTexts && entry.relatedTexts.length) bits.push(`related cars found: ${esc(entry.relatedTexts.join(", "))}`);
    if (entry.peopleAdded && entry.peopleAdded.length) {
      bits.push(`credits added: ${esc(entry.peopleAdded.map(p => `${p.name} (${p.role})`).join(", "))}`);
    }
    if (!bits.length) bits.push("nothing new found beyond what's already here");
    const done = document.createElement("div");
    done.className = "llm-status llm-applied";
    done.innerHTML = `${llmCloseBtn(key)}✓ Researched — ${bits.join(" · ")}`;
    el.insertBefore(done, row);
    wireLlmClose(done, key, () => { done.remove(); });
  }
  function renderLlmCheckBody(el, n) {
    if (window.LlmFamilies.isEligibleForRecheck(n)) return renderLlmCheckFamily(el, n);
    // A specific generation of a nameplate isn't eligible for either of the
    // two nameplate-level checks (it can't hide further generations, and it
    // has no generation list of its own to cross-check) -- but it does have
    // its own article worth reading. See researchGeneration in
    // llm_families.js for the Mercedes-Benz W211 bug report behind this.
    if (window.LlmFamilies.isEligibleForGenerationResearch &&
        window.LlmFamilies.isEligibleForGenerationResearch(n)) return renderGenerationResearch(el, n);
    if (!window.LlmFamilies.isEligible(n)) return;
    const entry = window.LlmFamilies.entryFor(n.id);
    if (!entry) {
      // Real bug report: "the Ford Maverick model is in my knowledge graph
      // but has no wikipedia link, and I cannot even do an LLM search on it
      // for some reason." Exactly right, and this was the reason: a car with
      // no `wp` and no entry yet fell through the `if (!llmCheckOn) return`
      // below and rendered NOTHING AT ALL -- no paste field, no "find it"
      // button, no explanation. The only way to reach the paste UI was to
      // arm 🤖 LLM Check first, which then immediately burned the check on
      // recording a "no-wiki-link" dead end. Offering the link UI is free
      // (it makes no LLM call by itself), so it's now shown unconditionally
      // whenever there's genuinely nothing to check against.
      if (!n.wp) return renderLlmNoWikiLink(el, n);
      if (!llmCheckOn) return;
      // Through the queue like every other pass. This one is automatic --
      // 🤖 LLM Check is armed and a card was opened -- which makes it the
      // likeliest of all of them to land on top of something already
      // running: clicking through four cars used to start four passes.
      enqueueLlmJob({ kind: "node-check", targetId: n.id,
                      label: (n.make ? n.make + " " : "") + n.label }, null, el);
      disengageLlmCheckFor(n.id);
      return;
    }
    if (entry.status === "provisional") {
      // Real user request: "if a car is creating a nameplate for the first
      // time... you do not need my approval to turn it into a nameplate.
      // Simply do so without my request." A plain, not-yet-split model the
      // LLM found hides multiple generations gets auto-applied immediately
      // -- exactly what a manual "Yes, accurate" click used to do, and
      // nothing further shows here afterward, same as it never did after a
      // manual confirm either (entry.status flips straight to "confirmed",
      // see the fallthrough comment below). Manual approval is still
      // required when an EXISTING nameplate's generation list gets
      // corrected or extended instead -- see
      // renderLlmCheckFamily/renderFamilyDiscrepancy -- since that rewrites
      // data someone may already be relying on, unlike a plain model nobody
      // had any expectations about yet.
      window.LlmFamilies.confirmNode(n.id);
      applyLlmConfirm(n);
      return;
    }
    if (entry.status === "error") {
      // A call the token ceiling cut short is a different problem from a
      // model that answered nonsense, and what it actually said is the only
      // way to tell which -- kept on the entry since the W108/W109, where
      // neither was recoverable after the fact. See errorDetail.
      const d = entry.detail || {};
      el.innerHTML = `<div class="llm-status llm-error">Local LLM check failed: ${esc(entry.error || "unknown error")}
          ${d.raw ? debugToggleHtml({ raw: d.raw }) : ""}</div>
        <div class="llm-debug" hidden></div>
        <div class="llm-actions"><button class="llm-btn llm-retry-plain">Try again</button></div>`;
      if (d.raw) wireDebugToggle(el, { raw: d.raw });
      el.querySelector(".llm-retry-plain").onclick = () => {
        el.innerHTML = `<div class="llm-status">🤖 trying again…</div>`;
        window.LlmFamilies.retryNode(n, "", nodes).then(() => afterLlmCheck(n));
      };
      return;
    }
    if (entry.status === "none") return renderLlmNone(el, n, entry);
    if (entry.status === "same-article") return renderLlmSameArticle(el, n, entry);
    if (entry.status === "no-wiki-link") return renderLlmNoWikiLink(el, n);
    // "confirmed" (already a real family by now), "deleted"
    // (nameplate undone, designers/engineers fell back to the plain model --
    // see llm_families.js applyConfirmed), "rejected", "max-attempts" -> nothing to show
  }
  // ---------- "no Wikipedia link on file" paste-a-link UI ----------
  // Real user request: "If the wikipedia page is not available and the
  // program isn't able to find it, then the info box should have a location
  // for the user to be able to put in the wikipedia link with the car
  // associated." Shared by both the plain-model check just above and the
  // nameplate cross-check below (renderFamilyNoWikiLink) -- same paste/
  // verify pattern Add Car's own #addcar-url/handleUseUrl flow already uses
  // (see initAddCarPanel), just aimed at a node/family that's already IN the
  // graph instead of minting a new one. `onUse(title)` runs whatever
  // re-check is appropriate for the caller once a verified title is in hand.
  function renderWpPasteUi(el, label, onUse) {
    el.innerHTML = `
      <div class="llm-status">🤖 ${esc(label)}</div>
      <div class="llm-retry-row">
        <input type="text" class="llm-reason llm-wp-url" placeholder="paste a Wikipedia article link…">
        <button class="llm-btn llm-wp-use">Use link</button>
      </div>
      <div class="llm-attempts llm-wp-status"></div>`;
    const input = el.querySelector(".llm-wp-url");
    const useBtn = el.querySelector(".llm-wp-use");
    const status = el.querySelector(".llm-wp-status");
    useBtn.onclick = async () => {
      const url = input.value.trim();
      if (!url) return;
      const title = window.LlmFamilies.titleFromWikipediaUrl(url);
      if (!title) { status.textContent = "That doesn't look like a Wikipedia article link."; return; }
      useBtn.disabled = true;
      status.textContent = "Checking that link…";
      try {
        const ok = await window.LlmFamilies.tryWikipediaTitle(title);
        if (!ok) { status.textContent = `Couldn't load "${title}" — check the link and try again.`; useBtn.disabled = false; return; }
        status.textContent = "Found it — checking…";
        await onUse(title);
      } catch (e) {
        status.textContent = "Something went wrong — try again.";
        useBtn.disabled = false;
      }
    };
  }
  function renderLlmNoWikiLink(el, n) {
    renderWpPasteUi(el, "no Wikipedia link on file for this car — paste one to run a real check", async (title) => {
      await window.LlmFamilies.setNodeWikiLink(n.id, title, nodes, { force: true });
      enqueueLlmJob({ kind: "node-check", targetId: n.id,
                      label: (n.make ? n.make + " " : "") + n.label }, null, el);
    });
  }
  // ---------- persistent "this car's Wikipedia link" row ----------
  // Real user request: "If a card doesn't have a wikipedia link to it
  // (either because it was added as a model and simply doesn't have that
  // info, or because there was never a wikipedia link in the first place),
  // there should be an option in the card itself to add a wikipedia link...
  // I should be able to do an LLM search on it if I click on it with the LLM
  // search button (and should therefore attempt to find a wikipedia link for
  // it), or I should be able to give it a wikipedia link by hand if the LLM
  // could not find the proper link for it. If a wikipedia link was found by
  // the LLM at any point, then the user should have the option to change the
  // wikipedia link in case it's inaccurate. Then, if the user presses
  // 'recheck with llm' then it should recheck it with the new wikipedia link
  // provided."
  //
  // Before this there were two separate, both-incomplete paths: a paste
  // field that only ever appeared for a car with NO link (and even then only
  // once a check had already run and recorded a "no-wiki-link" verdict), and
  // no way whatsoever to correct a link that existed but pointed at the
  // wrong article. This is one row, always present on any model/family/
  // generation card, offering all three actions -- see the link, replace it,
  // or ask the LLM to go find one -- with a re-check wired to each so a
  // corrected link takes effect immediately rather than being recorded and
  // ignored (setNodeWikiLink's `force` option is what makes the next check
  // actually re-read the NEW article instead of short-circuiting on the
  // stale verdict from the old one).
  //
  // Lives OUTSIDE the check's own body element on purpose: nearly every
  // async handler in this section replaces its container's innerHTML
  // wholesale, which would wipe this row mid-flight if it were nested in
  // there. `body` is passed in so a re-check can render its own progress
  // into the right place.
  function renderWpLinkRow(el, n, body) {
    const LF = window.LlmFamilies;
    const row = document.createElement("div");
    row.className = "llm-wp-row";
    const title = n.wp || null;
    const href = title ? "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(title).replace(/ /g, "_")) : null;
    // Real user request: "I want that the buttons for 'change link' and 'find
    // it' to be at the very bottom of an information card, hidden by a
    // compacted dropdown button, since I don't want the user to have it be as
    // accessible as it currently is, to prevent misclicks or mistakes."
    //
    // Both buttons rewrite which article this car is checked against and then
    // immediately re-run the check, so a stray click costs a real LLM round
    // trip and can replace a correct link with a worse guess. The link ITSELF
    // stays plainly visible and clickable -- reading it is the common action
    // and shouldn't cost a click -- while the two controls that change it sit
    // behind a closed <details>. Native disclosure rather than a custom
    // widget: it's keyboard-accessible and correctly announced for free, and
    // it cannot be triggered by a single mis-aimed click.
    row.innerHTML = `
      <div class="llm-wp-line">
        <span class="llm-wp-current">${title
          ? `Wikipedia: <a href="${href}" target="_blank" rel="noopener">${esc(title)}</a>`
          : `<i>no Wikipedia link on file</i>`}</span>
      </div>
      <details class="llm-wp-tools">
        <summary title="change which Wikipedia article this car is checked against">⚙ Wikipedia link options</summary>
        <div class="llm-wp-toolrow">
          <button type="button" class="llm-btn llm-wp-change">${title ? "Change link" : "Add link"}</button>
          <button type="button" class="llm-btn llm-wp-find" title="ask the app to look this car's article up on Wikipedia automatically">🔎 Find it</button>
        </div>
        <div class="llm-wp-edit" hidden></div>
        <div class="llm-attempts llm-wp-rowstatus"></div>
      </details>`;
    el.appendChild(row);
    const edit = row.querySelector(".llm-wp-edit");
    const status = row.querySelector(".llm-wp-rowstatus");
    const useTitle = async (t) => {
      await LF.setNodeWikiLink(n.id, t, nodes, { force: true });
      // The hover card / detail extract both read n.wp directly, so
      // re-opening the panel is what makes the new article's thumbnail and
      // summary appear too -- not just the check result.
      if (dtNode === n) openDetail(n);
      recheckNodeNow(n, body);
    };
    row.querySelector(".llm-wp-change").onclick = () => {
      edit.hidden = false;
      renderWpPasteUi(edit, title ? "paste the correct Wikipedia article link for this car" : "paste a Wikipedia article link for this car", useTitle);
    };
    row.querySelector(".llm-wp-find").onclick = async () => {
      status.textContent = "Searching Wikipedia…";
      try {
        // For a make there's no make/model pair to join -- the marque's own
        // name IS the article title to look for.
        const found = n.type === "make"
          ? await LF.findWikipediaTitleFor("", n.label)
          // An engine's article is almost never filed under a bare code:
          // "M177" is a disambiguation page, "Mercedes-Benz M177 engine" is
          // the redirect that reaches the real one. Ask with the word.
          : n.type === "engine"
          ? await LF.findWikipediaTitleFor(n.make || "", n.label + " engine")
          : await LF.findWikipediaTitleFor(n.make, n.label);
        if (!found) {
          status.textContent = "Couldn't find one automatically — paste the link by hand instead.";
          edit.hidden = false;
          renderWpPasteUi(edit, "paste a Wikipedia article link for this car", useTitle);
          return;
        }
        if (title && looseEq(found, title)) { status.textContent = `Wikipedia's best match is the link already on file ("${found}").`; return; }
        status.textContent = `Found "${found}" — using it and re-checking…`;
        await useTitle(found);
      } catch (e) {
        status.textContent = "Wikipedia lookup failed — try pasting the link by hand.";
      }
    };
  }
  // A "none" verdict ("didn't find multiple generations") used to be a dead
  // end — no way to challenge it short of wiping llm_families.json by hand,
  // which is exactly what came up with the Dacia Logan (a real multi-
  // generation nameplate the local model missed). This gives it the same
  // retry-with-feedback loop the provisional flow has, plus a "see what it
  // said" disclosure — the raw model output and anything it claimed that
  // got dropped by the hallucination guard — so it's possible to tell a
  // genuine miss from the guard just being strict.
  // The article this car points at is already another car's article -- a
  // section link ("...#Fifth generation (1960)") or a redirect. Whatever it
  // says has been read there, so nothing is proposed here. Said out loud,
  // with a way over to the car that does own it, because a silent skip looks
  // exactly like a check that found nothing.
  function renderLlmSameArticle(el, n, entry) {
    const key = "same:" + n.id;
    if (dismissedLlm.has(key)) return;
    const owner = byId.get(entry.sameAs);
    const name = esc(entry.sameAsLabel || (owner ? (owner.make ? owner.make + " " : "") + owner.label : "another car"));
    el.innerHTML = `
      <div class="llm-status">${llmCloseBtn(key)}🤖 this is the same Wikipedia article as
        ${owner ? `<a href="#" class="llm-sameas">${name}</a>` : name} — read it there</div>
      <div class="llm-attempts">${esc(entry.sourceTitle || "")}</div>`;
    wireLlmClose(el, key, () => { el.innerHTML = ""; });
    const a = el.querySelector(".llm-sameas");
    if (a) a.onclick = (ev) => { ev.preventDefault(); dtNode = null; openDetail(owner); };
  }

  function renderLlmNone(el, n, entry) {
    const key = "none:" + n.id;
    if (dismissedLlm.has(key)) return;
    const dbg = entry.debug || {};
    const canRetry = (entry.attempts || 1) < 4;
    el.innerHTML = `
      <div class="llm-status">${llmCloseBtn(key)}🤖 local LLM found no multiple generations here ${debugToggleHtml(dbg)}</div>
      <div class="llm-debug" hidden></div>
      ${canRetry ? `<div class="llm-retry-row">
        <input type="text" class="llm-reason" placeholder="think it missed something? tell it what to look for…">
        <button class="llm-btn llm-retry">Retry</button>
      </div>` : `<div class="llm-attempts">no attempts left (max ${entry.attempts})</div>`}`;
    wireDebugToggle(el, dbg);
    wireLlmClose(el, key, () => { el.innerHTML = ""; });
    if (canRetry) {
      el.querySelector(".llm-retry").onclick = () => {
        const reason = el.querySelector(".llm-reason").value.trim();
        if (!reason) return;
        el.innerHTML = `<div class="llm-status">🤖 trying again with your feedback…</div>`;
        window.LlmFamilies.retryNode(n, reason, nodes).then(() => afterLlmCheck(n));
      };
    }
  }
  // renderLlmProvisional (the old Yes/No/Retry review box for a first-time
  // nameplate-creation proposal) no longer exists -- the "provisional"
  // branch in renderLlmCheck above auto-applies immediately instead of
  // rendering it. A bad auto-applied split is still correctable afterward
  // through the ordinary EXISTING-nameplate recheck flow just below (this
  // nameplate is real now, so it's eligible), or by deleting the entry
  // outright from the LLM Debug panel.

  // ---------- nameplate generation cross-check UI (see llm_families.js's checkFamily) ----------
  // A DIFFERENT question from the "does this plain model hide multiple
  // generations" flow above: this asks "is the generation list an EXISTING
  // nameplate already shows here actually correct?" — catches a bad
  // build-time grouping (e.g. a bare, un-suffixed "BMW X3" article wrongly
  // folded in as if it were its own generation, right alongside the real
  // X3 (G01)/(F25)/...) as well as an LLM-discovered split that's since
  // gone stale. Runs automatically the same way the model-level check does
  // (open the detail panel with 🤖 LLM Check on), but only ever surfaces
  // something when it actually finds a discrepancy — silent otherwise.
  function currentGenNodes(fam) {
    return (fam.generations || []).map(id => byId.get(id)).filter(Boolean);
  }
  function looseEq(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }
  // Build-time family nodes don't carry their own `wp` (only their
  // individual generations do — build_family_layer.py never gives the
  // family node a Wikipedia link of its own). Prefer a bare-titled sibling
  // generation's article if one exists (that's usually the general overview
  // article Wikipedia actually files the multi-generation prose under — the
  // BMW X3 case is exactly a bare "BMW X3" article existing at all), else
  // fall back to a plain "make label" guess matching Wikipedia's normal
  // nameplate-article naming. A guess that doesn't resolve to a real
  // article just surfaces as an ordinary "check failed" error, same as any
  // other fetch failure this layer already handles.
  function familyCheckTarget(fam, genNodes) {
    if (fam.wp) return fam;
    const bare = (genNodes || currentGenNodes(fam)).find(g => g.wp && looseEq(g.label, fam.label));
    const wp = (bare && bare.wp) || `${fam.make} ${fam.label}`;
    return Object.assign({}, fam, { wp });
  }
  // Real user request: "at any time, even if the LLM has already been run
  // on a specific model before, it should also be able to perform an 'LLM
  // re-check'... The user will then be prompted with any differences to
  // the current relationships or models (or generations) that are
  // showing." Unlike everything else in this section (which only ever
  // shows up automatically, gated on the 🤖 LLM Check toggle, and only
  // ONCE per family -- see checkFamily's own comment), this button works
  // regardless of that toggle and regardless of how settled the existing
  // entry is. Its generation-side result reuses the exact same
  // store.recheck entry shape/UI as the automatic flow (renderFamilyDiscrepancy
  // just below already knows how to show it), so no separate review UI is
  // needed for that half; the relation-side "potential re-work" results
  // show up over in the Unconfirmed Relationships panel instead (see
  // initUnconfirmedRelPanel).
  // Real user request: "I think it would be useful that for a nameplate,
  // there is a lighter llm recheck button and a more extensive one, which
  // includes reading through the generations' own articles again."
  //
  // The split is about where the reading happens, and it is a real
  // difference in cost. The light one re-reads the NAMEPLATE's article: one
  // model call, plus the depth-1 cascade over related cars. The deep one
  // then goes on to re-read every generation's OWN article (the W211 page
  // rather than the general E-Class one), which is where the fuller
  // designer/engineer/related-car lists live -- one more model call per
  // generation, so six on an E-Class.
  //
  // Generation research was the one thing a re-check never redid: it runs
  // from a button on each generation's own card, once, and stays "✓
  // Researched" forever afterwards.
  // What the last deep re-check of each nameplate found, for as long as the
  // page is open. Held here rather than written into the row, because ANY
  // later panel render rebuilds that row -- and several things render it
  // moments after a deep pass ends (renderRelationChecks, the relation
  // checks it in turn kicks off, the engine scan's own re-render), so a
  // summary written straight into the element reliably vanished a beat after
  // appearing. Not persisted: it describes one run, not a decision.
  const deepRecheckSummary = new Map();
  function renderManualRecheckButton(el, fam) {
    const summary = deepRecheckSummary.get(fam.id);
    if (summary && !dismissedLlm.has("deeprecheck:" + fam.id)) {
      const done = document.createElement("div");
      done.className = "llm-status llm-applied";
      done.innerHTML = `${llmCloseBtn("deeprecheck:" + fam.id)}✓ Deep re-check complete — ${esc(summary)}`;
      el.appendChild(done);
      wireLlmClose(done, "deeprecheck:" + fam.id, () => { done.remove(); });
    }
    const row = document.createElement("div");
    row.className = "llm-recheck-row";
    const nGens = currentGenNodes(fam).length;
    row.innerHTML =
      `<button type="button" class="llm-btn llm-recheck-btn" title="re-read this nameplate's own Wikipedia article and re-derive its generations, relations and engines. One LLM call, plus its related cars.">🔄 LLM Re-check</button>` +
      `<button type="button" class="llm-btn llm-recheck-btn llm-deep-recheck-btn" title="everything the ordinary re-check does, and then re-reads each generation's OWN Wikipedia article for designers, engineers and related cars it only names there. Roughly one extra LLM call per generation${nGens ? ` (${nGens} here)` : ""}, so it takes a while.">🔬 Deep re-check</button>`;
    row.querySelector(".llm-deep-recheck-btn").onclick = () => runManualRecheck(fam, row, true);
    row.querySelector(".llm-recheck-btn").onclick = () => runManualRecheck(fam, row, false);
    el.appendChild(row);
  }
  function runManualRecheckNow(fam, row, deep) {
    {
      if (row) row.innerHTML = `<div class="llm-status">🤖 re-checking Wikipedia for anything that's changed…</div>`;
      const genNodes = currentGenNodes(fam);
      const LF = window.LlmFamilies;
      // forceRecheckFamily writes straight into the live nodes/links arrays
      // -- applyFreshPeopleCredits mints a designer this pass newly credits,
      // reworkRelationsForFamily can mint a related car -- and nothing here
      // ever indexed them. Found by a deep re-check walking into
      // computeYearFilterSet and throwing on `adj.get(id).some` for a person
      // node that was in `nodes` but in no index, with its two designed
      // links dropped by the next buildSim as having no endpoint. So a
      // credit the manual re-check discovered was invisible, and unlinked,
      // until the next page load.
      const nodesBefore = nodes.length, linksBefore = links.length;
      // Real user request: "when I hit 'llm re-check', I want it to essentially
      // do a re-check of the entire car that I selected, as well as its cascade
      // max depth length that I would normally do when I check a car using LLM
      // for the first time."
      //
      // Before this, the button re-read one article and stopped. Three separate
      // things were quietly holding the rest back, and all three are exactly
      // what a first-time click sets up: the car has to be the cascade's
      // origin (setEngaged makes it depth 0), background work has to be
      // authorised (otherwise every partner lookup is refused as unprompted --
      // see setBackgroundAllowed), and the session's accumulated distances have
      // to be cleared, or a car that was itself reached as someone else's
      // partner earlier starts at depth 1 and its own partners fall outside the
      // budget. renderRelationChecks afterwards is what actually walks them.
      if (LF.setEngaged) LF.setEngaged(fam.id);
      if (LF.resetCascadeFrom) LF.resetCascadeFrom(fam.id);
      if (LF.setBackgroundAllowed) LF.setBackgroundAllowed(true);
      return LF.forceRecheckFamily(familyCheckTarget(fam, genNodes), genNodes, nodes, links).then(async res => {
        if (dtNode === fam) renderLlmCheck(fam);
        const sayRow = m => { if (row && row.isConnected) row.innerHTML = `<div class="llm-status llm-error">${m}</div>`; };
        if (res && res.status === "no-wiki-link") sayRow("No Wikipedia link on file for this nameplate to re-check against.");
        if (res && res.status === "unavailable") sayRow("Local LLM server isn't reachable right now.");
        spliceIntoIndexes(nodesBefore, linksBefore);
        if (nodes.length !== nodesBefore) buildSim();
        refreshYearFilter();
        indexMirrorReplacements();
        refreshCounts();
        Graph.touch();
        // The powertrain half. forceRecheckFamily has just dropped this
        // nameplate's stored engine-scan records (see clearEngineScansFor),
        // so this genuinely re-reads each generation's article rather than
        // skipping every one already scanned -- which is why a re-check used
        // to come back with no engines at all.
        recordEnginesLive();
        await scanEnginesLive(fam);
        // The depth-1 half: expand every directly-related car into its own
        // generations (checking it if it has never been checked) and match
        // generation-to-generation. Same call the ordinary detail-panel render
        // makes, so there is one code path for both, not two that can drift.
        if (dtNode === fam) renderRelationChecks(fam);
        if (deep && res && res.status !== "unavailable" && res.status !== "no-wiki-link") {
          // Awaited: the deep half is the longer half, and a queue that
          // started the next request while six generation articles were still
          // being read would be back to running two passes at once.
          await deepRecheckGenerations(fam, row);
        }
        return res;
      });
    }
  }
  function runManualRecheck(fam, row, deep) {
    return enqueueLlmJob({ kind: deep ? "family-recheck-deep" : "family-recheck", targetId: fam.id,
                           label: (fam.make ? fam.make + " " : "") + fam.label }, null, row);
  }
  // The deep half: each generation's own article, in turn. Read AFTER the
  // nameplate re-check above rather than alongside it, because that pass is
  // what mints any generation this article has gained since -- a new one
  // would otherwise be missed by exactly the pass meant to be thorough.
  //
  // Sequential on purpose: llama-server runs a single slot (see serve.py's
  // LLAMA_PARALLEL_EFFECTIVE), so firing six at once only queues them while
  // making the progress line useless.
  function deepRecheckGenerations(fam, row) {
    const LF = window.LlmFamilies;
    if (!LF.researchGeneration || !LF.isEligibleForGenerationResearch) return Promise.resolve();
    const gens = currentGenNodes(fam).filter(g => LF.isEligibleForGenerationResearch(g));
    if (!gens.length) return Promise.resolve();
    if (LF.note) LF.note(`deep re-check: ${fam.label} -- reading ${gens.length} generation article(s)`);
    let done = 0, upgraded = 0, credits = 0, related = 0;
    // Re-found each time rather than held: the nameplate re-check that just
    // finished calls renderLlmCheck, which rebuilds the whole block and
    // detaches the row this started from -- so writing progress into the
    // original element put it somewhere nobody can see.
    const liveRow = () => {
      if (dtNode !== fam) return null;
      return document.querySelector(".dt-llmcheck .llm-recheck-row") || (row.isConnected ? row : null);
    };
    const status = () => {
      const r = liveRow();
      if (!r) return;
      r.innerHTML = `<div class="llm-status">🔬 deep re-check: reading generation ` +
        `${Math.min(done + 1, gens.length)} of ${gens.length} (${esc(gens[Math.min(done, gens.length - 1)].label)})…</div>`;
    };
    status();
    return (async () => {
      for (const gen of gens) {
        const nodesBefore = nodes.length, linksBefore = links.length;
        let res = null;
        try { res = await LF.researchGeneration(gen, fam, nodes, links); }
        catch (e) { console.warn("CarWeb: generation research failed", gen.id, e); }
        spliceIntoIndexes(nodesBefore, linksBefore);
        if (nodes.length !== nodesBefore) buildSim();
        if (res && res.status === "done") {
          if (res.upgradedArticle) upgraded++;
          credits += (res.peopleAdded || []).length;
          related += (res.relatedTexts || []).length;
        }
        done++;
        status();
      }
      refreshYearFilter();
      indexMirrorReplacements();
      refreshCounts();
      Graph.refreshFocus();
      Graph.touch();
      // The generations may have gained their own articles just now, which
      // is where the engines are -- so this is the pass most likely to find
      // engines the nameplate's page never named.
      recordEnginesLive();
      await scanEnginesLive(fam);
      if (LF.note) {
        LF.note(`deep re-check: ${fam.label} done -- ${gens.length} generation article(s), ` +
                `${upgraded} upgraded, ${credits} credit(s), ${related} related car(s)`);
      }
      const bits = [`${gens.length} generation article(s) re-read`];
      if (upgraded) bits.push(`${upgraded} now reading their own article`);
      if (credits) bits.push(`${credits} credit(s) added`);
      if (related) bits.push(`${related} related car(s) named`);
      deepRecheckSummary.set(fam.id, bits.join(" · "));
      dismissedLlm.delete("deeprecheck:" + fam.id);
      if (dtNode !== fam) return;
      renderLlmCheck(fam);       // shows the summary above, via the map
      renderRelationChecks(fam); // re-renders too, and the summary survives it
    })();
  }
  function renderLlmCheckFamily(el, fam) {
    if (!window.LlmFamilies.isEligibleForRecheck(fam)) return;
    renderLlmCheckFamilyBody(el, fam);
    renderManualRecheckButton(el, fam);
  }
  function renderLlmCheckFamilyBody(el, fam) {
    const entry = window.LlmFamilies.recheckEntryFor(fam.id);
    if (!entry) {
      if (!llmCheckOn) return;
      el.innerHTML = `<div class="llm-status">🤖 cross-checking this nameplate's generations against Wikipedia…</div>`;
      const genNodes = currentGenNodes(fam);
      window.LlmFamilies.checkFamily(familyCheckTarget(fam, genNodes), genNodes, nodes).then(() => { if (dtNode === fam) renderLlmCheck(fam); });
      disengageLlmCheckFor(fam.id); // same auto-disengage as the plain-model check above -- see its comment
      return;
    }
    // A cross-check that only ADDS generations is applied without asking --
    // see llm_families.js's additiveRecheck for why only that shape.
    if (entry.status === "provisional" && autoAcceptAdditiveRecheck(fam)) {
      if (dtNode === fam) renderLlmCheck(fam);
      return;
    }
    if (entry.status === "provisional") return renderFamilyDiscrepancy(el, fam, entry);
    // In practice familyCheckTarget (above) always hands checkFamily SOME
    // wp guess (a bare sibling generation's article, or a plain "make
    // label" string), so this is rare -- but a genuinely empty make/label
    // can still get here, and it's exactly the same "nothing to check
    // against" situation the plain-model flow already has a fix for.
    if (entry.status === "no-wiki-link") return renderFamilyNoWikiLink(el, fam);
    if (entry.status === "error") {
      el.innerHTML = `<div class="llm-status llm-error">Local LLM cross-check failed: ${esc(entry.error || "unknown error")}</div>
        <div class="llm-actions"><button class="llm-btn llm-retry-plain">Try again</button></div>`;
      el.querySelector(".llm-retry-plain").onclick = () => {
        el.innerHTML = `<div class="llm-status">🤖 trying again…</div>`;
        const genNodes = currentGenNodes(fam);
        window.LlmFamilies.retryFamilyCheck(familyCheckTarget(fam, genNodes), genNodes, "", nodes).then(() => { if (dtNode === fam) renderLlmCheck(fam); });
      };
      return;
    }
    if (entry.status === "applied") {
      // Without this the panel just goes blank the instant Accept is
      // clicked -- functionally correct (there's nothing left to decide)
      // but indistinguishable from nothing having happened at all, which is
      // exactly the confusing "did that actually do anything?" experience
      // this is fixing. Persists across reopening the panel (and a reload,
      // now that applyAllFamilyOverrides re-applies this at boot too) since
      // it's driven by the same persisted entry, not transient UI state.
      // Closeable like every other LLM-generated message. Real user
      // request: "I don't need the text 'via local LLM + Wikipedia' to
      // remain. I just want to clear the message and have it be cleared
      // simply" -- closing now empties the box outright instead of
      // collapsing to a small persistent disclaimer.
      const key = "applied:" + fam.id;
      if (dismissedLlm.has(key)) { el.innerHTML = ""; return; }
      el.innerHTML = `<div class="llm-status llm-applied">${llmCloseBtn(key)}✓ Applied — this nameplate's generation list was corrected from Wikipedia${entry.appliedAt ? " on " + esc(entry.appliedAt.slice(0, 10)) : ""}</div>`;
      wireLlmClose(el, key, () => { el.innerHTML = ""; });
      return;
    }
    // "none" (Wikipedia agrees with what's already shown) -> nothing worth showing.
  }
  function renderFamilyNoWikiLink(el, fam) {
    renderWpPasteUi(el, "no Wikipedia link on file for this nameplate — paste one to run a real cross-check", async (title) => {
      await window.LlmFamilies.setNodeWikiLink(fam.id, title, nodes, { force: true });
      el.innerHTML = `<div class="llm-status">🤖 cross-checking this nameplate's generations against Wikipedia…</div>`;
      const genNodes = currentGenNodes(fam);
      window.LlmFamilies.checkFamily(familyCheckTarget(fam, genNodes), genNodes, nodes).then(() => { if (dtNode === fam) renderLlmCheck(fam); });
    });
  }
  function renderFamilyDiscrepancy(el, fam, entry) {
    const current = currentGenNodes(fam).slice().sort((a, b) => (a.year || 0) - (b.year || 0))
      .map(g => `${esc(g.label)} <span class="verb">${fmtYearRun(g.year, g.end) || "?"}</span>`).join("<br>") || "(none)";
    const gens = (entry.proposal && entry.proposal.generations) || [];
    const proposed = gens.map(g => {
      const run = fmtYearRun(g.yearStart, g.yearEnd);
      return `${esc(g.code)} <span class="verb">${esc(run)}</span>`;
    }).join("<br>") || "(none)";
    const dbg = entry.debug || {};
    el.innerHTML = `
      <div class="llm-label">🤖 Cross-check found a discrepancy here — unverified ${debugToggleHtml(dbg)}</div>
      <div class="llm-debug" hidden></div>
      <div class="llm-status">${esc(entry.discrepancy || "")}</div>
      <div class="llm-gens"><b>Currently shown here:</b><br>${current}<br><br><b>Wikipedia currently describes:</b><br>${proposed}</div>
      <div class="llm-actions">
        <button class="llm-btn llm-yes">✓ Apply Wikipedia's version</button>
        <button class="llm-btn llm-no">✗ Keep what's here</button>
      </div>
      <div class="llm-retry-row">
        <input type="text" class="llm-reason" placeholder="or tell it what's wrong, and it'll try again…">
        <button class="llm-btn llm-retry">Retry</button>
      </div>
      <div class="llm-attempts">attempt ${entry.attempts}</div>`;
    wireDebugToggle(el, dbg);
    el.querySelector(".llm-yes").onclick = () => applyFamilyOverrideConfirm(fam);
    el.querySelector(".llm-no").onclick = () => {
      // Same "forget it happened, re-checkable later" semantics as the
      // plain-model flow's "No" -- and the same signal to stop probing more
      // cars right now.
      window.LlmFamilies.rejectFamilyRecheck(fam.id);
      setLlmCheck(false);
      renderLlmCheck(fam);
    };
    el.querySelector(".llm-retry").onclick = () => {
      const reason = el.querySelector(".llm-reason").value.trim();
      if (!reason) return;
      el.innerHTML = `<div class="llm-status">🤖 trying again with your feedback…</div>`;
      const genNodes = currentGenNodes(fam);
      window.LlmFamilies.retryFamilyCheck(familyCheckTarget(fam, genNodes), genNodes, reason, nodes).then(() => { if (dtNode === fam) renderLlmCheck(fam); });
    };
  }
  // ---------- live-apply a user-confirmed generation-list override ----------
  // Unlike applyLlmConfirm/applyRelationConfirm below (both purely
  // additive), llm_families.js's applyFamilyOverride can both mint new
  // generation nodes AND retire old ones (flagged, never spliced out — see
  // its own comment). That's real structural churn, not just new rows
  // appended to nodes/links, so the simplest correct response is to
  // recompute every index from scratch rather than trying to patch them
  // incrementally — this is a rare, deliberate user action, not a hot path.
  // Real user request: "If the llm looks at a nameplate and finds from the
  // wikipedia that there are more generations than currently listed, then
  // automatically accept those changes and do not need to ask for my manual
  // approval." Goes through the same confirm path a click would, so the
  // indexes, the simulation and the "Applied" state are all handled the one
  // way. Returns whether it applied. A diff that also drops a generation is
  // left alone -- that is not "more generations than currently listed", and
  // retiring one deserves a human.
  function autoAcceptAdditiveRecheck(fam) {
    if (!window.LlmFamilies || !window.LlmFamilies.additiveRecheck) return false;
    let verdict = null;
    try { verdict = window.LlmFamilies.additiveRecheck(fam.id, currentGenNodes(fam), nodes); }
    catch (e) { return false; }
    if (!verdict) return false;
    applyFamilyOverrideConfirm(fam);
    console.info(`[carweb] ${fam.make ? fam.make + " " : ""}${fam.label}: Wikipedia lists ` +
                 `${verdict.now} generations where this had ${verdict.had} — applied without asking ` +
                 `(added ${verdict.added.join(", ")})`);
    return true;
  }
  function applyFamilyOverrideConfirm(fam) {
    window.LlmFamilies.applyFamilyOverride(fam.id, nodes, links);
    // Real gap found while adding multi-relation support: applyFamilyOverride
    // above can resolve a shared-platform mention straight to "confirmed" in
    // store.relations (same as the other two discovery flows), but that's
    // only ever a STORE write -- something still has to read it back out and
    // actually push a real link into nodes/links. Every other flow that can
    // produce a fresh "confirmed" relation already does this
    // (applySharedPlatformLive, applyRelationConfirm); this one never did,
    // so an override's own platform discovery silently never showed up in
    // the live graph until the next full reload. Called before the full
    // index rebuild below so any link just pushed here gets its
    // adj/sn/tn wiring done by that same rebuild pass, not a second one.
    window.LlmFamilies.applyResolvedRelations(nodes, links);
    adj.forEach((_, k) => adj.set(k, []));
    nodes.forEach(n2 => { byId.set(n2.id, n2); if (!adj.has(n2.id)) adj.set(n2.id, []); });
    links.forEach(l => {
      if (l.retired) return;
      // d3-force's link force (via buildSim(), which has already run at
      // least once by the time this can fire) mutates link.source/target
      // from plain id STRINGS into direct NODE OBJECT references the first
      // time the simulation initializes -- byId.get() only ever understood
      // the string form. Reading byId.get(l.source) unconditionally here
      // silently returned undefined for essentially every pre-existing link
      // in the whole graph (not just the ones this override touched),
      // which then crashed Graph's draw loop the moment it tried to read
      // .x/.y off an undefined l.sn/l.tn -- the "whole screen goes blank"
      // bug. Handle both forms, and normalize back to the plain id string
      // afterward so every OTHER piece of code in this file (which assumes
      // link.source/target are ids, e.g. resolvePlatformMention's dedup
      // checks) keeps working regardless of whether the sim has run yet.
      const s = typeof l.source === "string" ? l.source : (l.source && l.source.id);
      const t = typeof l.target === "string" ? l.target : (l.target && l.target.id);
      l.sn = byId.get(s); l.tn = byId.get(t);
      if (l.sn) l.source = l.sn.id;
      if (l.tn) l.target = l.tn.id;
      if (l.sn && l.tn) { adj.get(l.source).push({ n: l.tn, l }); adj.get(l.target).push({ n: l.sn, l }); }
    });
    nodes.forEach(n2 => {
      n2.deg = adj.get(n2.id).length;
      n2.r = radius(n2);
      if (n2.db) DB_IDS.add(n2.id);
      if (LABEL_ORDER.indexOf(n2) < 0) LABEL_ORDER.unshift(n2);
    });
    refreshYearFilter();
    backfillGenerationEnds(); // the override may have changed which generation is newest,
                               // or added one after a previously-open-ended one
    indexMirrorReplacements(); // a retired generation may have just orphaned a mirror's
                                // only replacement candidate, or a freshly-minted
                                // generation may have just become one
    buildSim();
    Graph.refreshFocus();
    Graph.touch();
    refreshCounts(); // retired generations/links and possibly newly-minted ones changed the numbers
    // Real user request: "after I have confirmed that I want to adopt
    // wikipedia's generations, the LLM should also search for all
    // relationships automatically rather than requiring me to do an llm check
    // on the nameplate again afterwards."
    //
    // Adopting an override is the moment the generation list becomes
    // trustworthy, which is exactly when relation matching becomes worth
    // doing -- previously it stopped here and the user had to re-arm the
    // check by hand to get any of it. Keeping the background gate armed for
    // this nameplate is what lets the relation boxes openDetail() is about to
    // render actually run their checks, rather than sitting there waiting for
    // another click.
    //
    // Scope is unchanged: this authorises work for THIS car, and every check
    // it starts still goes through the same depth budget as before (see
    // llm_families.js's scheduleWpLookupAndCheck). It removes a manual step,
    // it does not widen the walk.
    if (window.LlmFamilies.setEngaged) window.LlmFamilies.setEngaged(fam.id);
    if (window.LlmFamilies.setBackgroundAllowed) window.LlmFamilies.setBackgroundAllowed(true);
    openDetail(fam);
  }

  // ---------- live-apply a just-confirmed LLM generation split ----------
  // No reload: mints the new generation nodes in place (via llm_families.js's
  // applyConfirmed, which is idempotent per-node so calling it again here
  // only touches the just-confirmed entry), wires them into every index the
  // rest of the app relies on (byId/adj/deg/r/LABEL_ORDER), expands the
  // family so the new generations are visible immediately, rebuilds the
  // sim so it knows about the new nodes, and redraws every view. `n` is the
  // exact same object already open in the detail panel (family nodes reuse
  // the original model's id), so re-running openDetail(n) on it keeps the
  // panel — and the user — right where they were, just showing the new
  // Generations list instead of the provisional LLM proposal.
  // Does all the graph-mutation work of confirming n's generation split
  // WITHOUT touching the detail panel -- split out from applyLlmConfirm
  // (below) so a CASCADE split of some OTHER, related car (see
  // "cascading nameplate discovery" further down) can mint its generations
  // in place without hijacking whatever detail panel the user actually has
  // open right now.
  // ---------- shared, crash-proof "splice whatever just got added into every index" ----------
  // Real bug report: "when the llm is trying to find matches, sometimes the
  // viewfinder periodically freezes and then goes blank, forcing me to do a
  // refresh of the page. Also, this occurs when I accept or decline an
  // approval from the LLM on a specific model/nameplate."
  //
  // Four separate functions here (applyLlmConfirmSilent, applyRelationConfirm,
  // applySharedPlatformLive, initAddCarPanel's mintAndOpen) each hand-rolled
  // the same nodes/links index-rebuild loop, and three of them assumed
  // something that isn't always true: that `adj` already has an entry for
  // every id a newly-pushed link points at. `adj.get(id).push(...)` throws a
  // bare TypeError the moment it doesn't -- and that happens for real, e.g.
  // when llm_families.js mints a node inside applyResolvedRelations/
  // mirrorRelationLinks (a family-level mirror to a node this pass never
  // registered) or follows a supersededBy redirect to a node that was
  // retired after the last index rebuild. Thrown from inside a click
  // handler, that exception aborted the apply HALFWAY: some links wired,
  // others not, buildSim()/Graph.touch() never reached. The render loop's
  // own try/catch then caught the resulting inconsistency on every
  // subsequent frame, logging and skipping each one -- a canvas that
  // silently stops updating, which is exactly "freezes and then goes
  // blank... forcing me to do a refresh."
  //
  // One implementation, defensive at every step: an id with no adj entry
  // gets one rather than throwing, and a link whose endpoints can't be
  // resolved at all is skipped and reported instead of taking the whole
  // apply down with it. Returns the number of links it couldn't wire, purely
  // for logging.
  function spliceIntoIndexes(nodesBefore, linksBefore) {
    let unwired = 0;
    for (let i = nodesBefore; i < nodes.length; i++) {
      const nn = nodes[i];
      if (!nn || !nn.id) continue;
      byId.set(nn.id, nn);
      if (!adj.has(nn.id)) adj.set(nn.id, []);
    }
    for (let i = linksBefore; i < links.length; i++) {
      const l = links[i];
      if (!l) continue;
      // d3-force's link force mutates source/target from id STRINGS into
      // node OBJECT references once the sim has initialized -- handle both,
      // and normalize back to ids so the rest of this file (which assumes
      // strings) keeps working. Same gotcha applyFamilyOverrideConfirm
      // already documents.
      const s = typeof l.source === "string" ? l.source : (l.source && l.source.id);
      const t = typeof l.target === "string" ? l.target : (l.target && l.target.id);
      l.sn = byId.get(s); l.tn = byId.get(t);
      if (!l.sn || !l.tn) { unwired++; continue; }  // dangling endpoint -- skip it, never throw
      l.source = l.sn.id; l.target = l.tn.id;
      if (!adj.has(l.source)) adj.set(l.source, []);
      if (!adj.has(l.target)) adj.set(l.target, []);
      adj.get(l.source).push({ n: l.tn, l });
      adj.get(l.target).push({ n: l.sn, l });
    }
    // Degree/radius for everything a new link touched, new or pre-existing.
    const touched = new Set();
    for (let i = linksBefore; i < links.length; i++) {
      const l = links[i];
      if (l && l.sn) touched.add(l.sn);
      if (l && l.tn) touched.add(l.tn);
    }
    for (let i = nodesBefore; i < nodes.length; i++) if (nodes[i]) touched.add(nodes[i]);
    touched.forEach(nn => { nn.deg = (adj.get(nn.id) || []).length; nn.r = radius(nn); });
    for (let i = nodesBefore; i < nodes.length; i++) {
      const nn = nodes[i];
      if (!nn) continue;
      if (LABEL_ORDER.indexOf(nn) < 0) LABEL_ORDER.unshift(nn);
      if (nn.db) DB_IDS.add(nn.id);
    }
    if (unwired) console.warn(`CarWeb: skipped ${unwired} link(s) with an unresolvable endpoint while splicing in a live change`);
    return unwired;
  }
  // The footer's data line. The DBpedia live layer used to own this element
  // and wrote its own status into it; with the layer gone, the only thing
  // worth saying here is which bake the page is showing -- and that matters,
  // because initAutoRefresh reloads the page when a new one lands.
  function setDataStatus() {
    const el = document.getElementById("datastatus");
    if (!el || !DATA.meta) return;
    el.textContent = "snapshot \u00b7 built " + DATA.meta.generated;
    el.title = "the build this page was generated from";
  }
  // The live layer kept its findings in localStorage between reloads. Nothing
  // reads them now, so give the quota back rather than leaving two dead keys
  // in every browser that ever ran a refresh.
  function dropLiveLayerStorage() {
    try {
      localStorage.removeItem("carweb_live_snapshot_v1");
      localStorage.removeItem("carweb_live_checked_v1");
    } catch (e) { /* private window, or storage blocked -- nothing to clean up */ }
  }

  // Engines a freshly-checked car named, into the graph now rather than at the
  // next reload. Idempotent, so calling it after every check costs a pass over
  // the stored entries and nothing else. spliceIntoIndexes matters here even
  // though none of this is drawn: byId is what buildSim tests a link against,
  // and an engine node missing from it would see its own edges deleted.
  function recordEnginesLive() {
    const LFam = window.LlmFamilies;
    if (!LFam || !LFam.applyEngineMentions) return;
    const nodesBefore = nodes.length, linksBefore = links.length;
    let r = null;
    try { r = LFam.applyEngineMentions(nodes, links); }
    catch (e) { console.warn("CarWeb: could not record engine mentions", e); return; }
    if (!r || (!r.engines && !r.fitted)) return;
    spliceIntoIndexes(nodesBefore, linksBefore);
    powertrainChanged();
    console.info(`[carweb] powertrain: noted ${r.engines} engine(s) and ${r.fitted} connection(s) ` +
                 "from the car just checked");
  }

  // Go and read the engines for a car that was just checked -- from each
  // generation's OWN article, which is where they are. A nameplate's umbrella
  // page does not list engines (the real E-Class one has no engine field at
  // all), which is why hooking this to whatever article the generation check
  // happened to fetch found nothing for a split nameplate.
  //
  // No model call: an infobox field is a regex. The cost is one Wikipedia
  // fetch per generation, once ever, and the result is stored.
  function scanEnginesLive(node) {
    const LFam = window.LlmFamilies;
    if (!LFam || !LFam.scanEnginesFor || !node) return Promise.resolve();
    const nodesBefore = nodes.length, linksBefore = links.length;
    // Returned so a caller that is itself a queued job can await it. Not
    // queued itself: it is called from INSIDE those passes, and a job that
    // waits for a job the queue will not start until it finishes is a
    // deadlock. It makes no model call either -- infobox only.
    return LFam.scanEnginesFor(node, nodes, links).then(r => {
      if (!r || (!r.engines && !r.fitted && !r.revived)) {
        if (r && r.scanned) {
          console.info(`[carweb] powertrain: read ${r.scanned} article(s) for ` +
                       `${node.label}; ` +
                       (r.deleted ? `${r.deleted} engine(s) named there are permanently cleared`
                                  : "none of them names an engine"));
        }
        return;
      }
      spliceIntoIndexes(nodesBefore, linksBefore);
      powertrainChanged();
      if (dtNode === node || (dtNode && dtNode.familyOf === node.id)) renderPowertrain(dtNode);
      Graph.touch();
      console.info(`[carweb] powertrain: ${r.engines} engine(s) and ${r.fitted} connection(s) ` +
                   `from ${r.scanned} article(s) for ${node.label}`);
    }).catch(e => console.warn("CarWeb: engine scan failed", e));
  }

  function applyLlmConfirmSilent(n) {
    const nodesBefore = nodes.length, linksBefore = links.length;
    window.LlmFamilies.applyConfirmed(nodes, links);
    // If n itself carries My Database data, this may resolve it straight
    // onto the generation whose year covers Andy's own car (see
    // reconcileDbGenerations) -- do it before the loops below so the newly
    // db-flagged generation gets picked up by the same DB_IDS/ring-drawing
    // refresh as everything else new.
    window.LlmFamilies.reconcileDbGenerations(nodes);
    // applyConfirmed's own resolvePlatformMention pass can resolve a
    // shared-platform mention straight to "confirmed" in store.relations --
    // but that's only ever a STORE write; something still has to read it back
    // and push the real link into nodes/links. Nothing here did.
    //
    // The order is what hid it: renderLlmCheck's auto-apply runs INSIDE
    // afterLlmCheck, which has already called applySharedPlatformLive() (and
    // therefore applyResolvedRelations) on the way in -- so the wiring pass
    // ran a moment BEFORE the entry it needed to wire even existed, and
    // nothing ran it again. The connection then existed only in the store
    // until some unrelated later action happened to trigger another pass, or
    // until the next page load. Found while tracing the Honda Odyssey / Acura
    // MDX report: after both nameplates split correctly, there was still no
    // link of any kind between them. Same reasoning as
    // applyFamilyOverrideConfirm, which already calls this for exactly this
    // reason; run before spliceIntoIndexes so anything pushed here gets its
    // adj/sn/tn wiring from that same pass.
    window.LlmFamilies.applyResolvedRelations(nodes, links);
    // Handles all of it -- new nodes into byId/adj/LABEL_ORDER/DB_IDS, new
    // links wired into adj/sn/tn, and degree/radius refreshed for every node
    // a new link touched (including a pre-existing designer/engineer node
    // that just gained a connection here). See its own comment for the
    // "canvas freezes and goes blank" bug the defensive version fixes.
    spliceIntoIndexes(nodesBefore, linksBefore);
    n.deg = (adj.get(n.id) || []).length;
    n.r = radius(n);
    // A succession link on the model that just became a nameplate can now be
    // resolved down to its first/last generation -- see
    // pushSuccessionToGenerations' own comment.
    if (window.LlmFamilies.pushSuccessionToGenerations) {
      const succBefore = links.length;
      window.LlmFamilies.pushSuccessionToGenerations(nodes, links);
      spliceIntoIndexes(nodes.length, succBefore);
    }
    expandFamily(n.id);       // lines up + un-hides the new generations right away
    refreshYearFilter();       // newly-minted generations aren't in the precomputed
                                // in-range set yet -- without this they'd be silently
                                // hidden by the year slider until the user next drags it
    backfillGenerationEnds();  // the freshly-split generations likely include open-ended years
    indexMirrorReplacements(); // the new generation-level links may now stand in for
                                // some existing coarse mirror link's connection
    buildSim();                // reinitializes the sim over the larger nodes/links arrays
    Graph.refreshFocus();      // if Graph is focused on n, pull the new generations into the focus set too
    Graph.touch();
    refreshCounts();           // new generation/person nodes + links (and possibly a
                                // de-dup-retired standalone) just changed every number
    // The generations only came into existence a few lines above, and THEIR
    // own articles are where the engines are -- the nameplate's umbrella page
    // does not list any. See llm_families.js's scanEnginesFor.
    scanEnginesLive(n);
    // An engine read earlier could only connect to this car as one undivided
    // model. Now that it has generations, its engines move down onto them --
    // the Buick Riviera case. See llm_families.js's restitchEngineEdges.
    restitchEnginesLive();
  }
  function restitchEnginesLive() {
    const LFam = window.LlmFamilies;
    if (!LFam || !LFam.restitchEngineEdges) return;
    const nodesBefore = nodes.length, linksBefore = links.length;
    let r = null;
    try { r = LFam.restitchEngineEdges(nodes, links); }
    catch (e) { console.warn("CarWeb: could not re-place engine edges", e); return; }
    if (!r || (!r.fitted && !r.dropped)) return;
    spliceIntoIndexes(nodesBefore, linksBefore);
    buildSim();
    powertrainChanged();
    Graph.touch();
    console.info(`[carweb] powertrain: moved ${r.dropped} engine link(s) down to a generation, ` +
                 `${r.fitted} new connection(s)`);
  }
  function applyLlmConfirm(n) {
    applyLlmConfirmSilent(n);
    openDetail(n);              // re-render the panel in place, still on n
  }

  // ---------- generation-level relation disambiguation UI (see llm_families.js) ----------
  // A platform/related/succession connection between two nameplates that
  // ALREADY both have real generations is only known at the collapsed,
  // nameplate-wide level unless something resolves which specific
  // generation of each the fact actually applies to (e.g. "Porsche 911 and
  // Boxster/Cayman share a platform" -> which 911 generation, which
  // Boxster/Cayman generation). Order-independent so the same pair always
  // maps to the same stored decision regardless of which side is viewed.
  function relationKey(idA, idB, relType) { return [idA, idB].sort().join("|") + "|" + relType; }
  function familyGenInfo(fam) {
    return {
      // wp carries the nameplate's own Wikipedia article title through to
      // llm_families.js's checkRelation, which uses it to actually go read
      // BOTH sides' articles for an explicit generation-code mention before
      // asking the LLM to guess from a bare list of codes -- see its own
      // gatherRelationEvidence comment for the real bug report this fixes.
      id: fam.id, make: fam.make, label: fam.label, wp: fam.wp || null,
      generations: (fam.generations || []).map(id => byId.get(id)).filter(Boolean)
        .map(g => ({ id: g.id, code: g.label, year: g.year, end: g.end })),
    };
  }
  // A plain (not-yet-split) model, or a node that's already a specific
  // generation of some OTHER family, has exactly one possible "generation"
  // to disambiguate to: itself. Building the SAME {id, make, label,
  // generations:[...]} shape checkRelation already expects for a real
  // family lets the one disambiguation flow handle every combination —
  // family<->family (both sides genuinely ambiguous), family<->model, and
  // family<->already-specific-generation — without a second code path.
  // Individual generations always take priority over the bare nameplate;
  // when the other side isn't a nameplate at all, the connection is simply
  // to that model itself (see llm_families.js's checkRelation, which
  // accepts a single-option side outright rather than asking the model to
  // pick from a list of one).
  function relationGenInfo(n) {
    if (n.type === "family") return familyGenInfo(n);
    return { id: n.id, make: n.make, label: n.label, wp: n.wp || null,
             generations: [{ id: n.id, code: n.label, year: n.year, end: n.end }] };
  }
  // A family<->family connection where BOTH sides have real generations is
  // genuinely ambiguous on both ends. A family<->model connection is only
  // ambiguous on the FAMILY's side — which of ITS generations does this
  // apply to — since a plain model (or an already-specific generation of
  // some other nameplate) has no ambiguity of its own; still worth asking,
  // so the family side gets pinned down to its own most-specific generation
  // instead of leaving the nameplate-wide line as the only connection.
  // Shared by the two relation scans below: an original link's endpoint may
  // since have been retired as a standalone duplicate of some family's
  // generation (see llm_families.js's supersedeStandalone). Follow the
  // recorded supersededBy pointer to the living replacement so the relation
  // check runs against (and displays) a node that actually exists on
  // screen; a retired node with no replacement is skipped outright rather
  // than offered as a checkable-but-invisible endpoint.
  function liveRelationEndpoint(o) {
    let hops = 0;
    while (o && o.retired && o.supersededBy && hops++ < 5) {
      const next = byId.get(o.supersededBy);
      if (!next || next === o) break;
      o = next;
    }
    return o && !o.retired ? o : null;
  }
  function unresolvedFamilyRelations(n) {
    // Real user request: "even if the selected car does not find multiple
    // generations, it should still continue doing the depth search of 1 of any
    // related cars, and should still find out whether those cars are models or
    // nameplates, like any other instance of llm checking."
    //
    // This used to require the selected car to be a nameplate, so a car that
    // turned out to have only one generation -- the Fiat Topolino, most cars
    // -- got no relation checks at all, and the search simply stopped. But
    // having one generation says nothing about whether the cars it's related
    // to have several, which is exactly what the user wants found.
    //
    // A plain model is already handled downstream: relationGenInfo gives it a
    // single "generation" standing for itself, and checkRelation accepts a
    // one-option side outright rather than asking the model to choose from a
    // list of one. So this only had to stop excluding them.
    if ((n.type !== "family" && n.type !== "model") || n.familyOf || !window.LlmFamilies) return [];
    const out = [];
    const seen = new Set();
    adj.get(n.id).forEach(({ n: o, l }) => {
      if (l.type !== "platform" && l.type !== "related" && l.type !== "succession") return;
      // A link severed along with its rejected relationship (llm_families.js's
      // severRelationLinks) must not be re-offered for checking. Without this
      // the panel loops: the check returns "none", autoRejectUnbackedRelation
      // severs the link and re-opens the panel, this scan finds the same
      // (now-retired) link, sees no stored entry (the rejection just deleted
      // it), and starts the identical check over again -- which then recreates
      // the very entry the rejection removed.
      if (l.retired) return;
      if (o.type !== "family" && o.type !== "model") return;
      o = liveRelationEndpoint(o);
      if (!o) return;
      // Real bug report: "couldn't confidently match a specific generation
      // pair for the related connection to Holden Nova" kept showing, and
      // claiming "it still shows at the nameplate level", even though a
      // real, specific Holden Nova <-> Toyota Corolla (E100) link already
      // exists and is live in the graph. Root cause: Nova is a PLAIN
      // MODEL, not a family -- it has no generations of its own, so once
      // ANY of this family's real generations already has a real link of
      // this exact type directly to it, that side is fully resolved and
      // there's nothing left to disambiguate; re-offering the prompt (and
      // describing the connection as still nameplate-level, which is no
      // longer even true once a specific link exists) is both redundant
      // and misleading.
      //
      // Deliberately scoped to o.type === "model" only -- when the OTHER
      // side is itself a family, it can legitimately have SEVERAL distinct
      // valid pairings across different generations/eras at once (e.g.
      // Porsche 911 and Boxster/Cayman share different platform-level
      // connections at different points in each nameplate's history), so a
      // family<->family connection should keep offering the disambiguation
      // prompt even after one specific pair is already resolved -- that's
      // what makes exhaustive multi-pair discovery between two long-running
      // nameplates possible at all, and this fix must not suppress it.
      if (o.type === "model" && (n.generations || []).some(genId => {
        const gen = byId.get(genId);
        return gen && (adj.get(gen.id) || []).some(({ n: gn, l: gl }) => gn === o && gl.type === l.type);
      })) return;
      const key = relationKey(n.id, o.id, l.type);
      if (seen.has(key)) return;
      seen.add(key);
      const existing = window.LlmFamilies.relationEntryFor(key);
      if (existing && existing.status === "confirmed") return; // already resolved and wired into the graph
      out.push({ key, famA: n, famB: o, relType: l.type, note: l.note, existing });
    });
    // llm_families.js's resolvePlatformMention can propose a specific-
    // generation platform match WITHOUT ever creating an ordinary graph link
    // first (it only ever writes into store.relations, leaving the actual
    // link creation to confirmRelation/applyResolvedRelations) -- so the
    // adj-based scan above, which only ever finds pairs that ALREADY have a
    // real link between them, can miss it entirely. Without this, such a
    // proposal was reachable by nothing: not shown, not confirmable, not
    // rejectable, and (before the fix to resolvePlatformMention itself)
    // previously wasn't even a proposal at all -- it just wrote "confirmed"
    // straight to disk with no review. Merge in anything from that layer
    // that's still awaiting a decision and touches this family, oriented so
    // famA is always this node (`n`) and famB is always the other side,
    // regardless of which order llm_families.js originally stored them in.
    if (window.LlmFamilies.relationsTouching) {
      window.LlmFamilies.relationsTouching(n.id).forEach(entry => {
        if (entry.status !== "provisional") return;
        const otherId = entry.famA === n.id ? entry.famB : entry.famA;
        const o = liveRelationEndpoint(byId.get(otherId));
        if (!o) return;
        // Real user request: two DIFFERENT generations of the same
        // nameplate pair (e.g. Mazda Familia's 3rd/4th generations each
        // corresponding to a DIFFERENT Ford Escort generation) must each
        // show up and be confirmable/rejectable independently -- using
        // entry.key (this specific provisional entry's own storage key,
        // now keyed by the actual generation pair -- see
        // llm_families.js's resolveOnePlatformMention) instead of a
        // recomputed nameplate-level key means every distinct pair gets
        // its own row here, and Yes/No acts on the right one specifically
        // rather than colliding on one shared key for the whole nameplate
        // pair the way a coarser key would.
        const key = entry.key;
        if (seen.has(key)) return;
        seen.add(key);
        const oriented = entry.famA === n.id ? entry
          : Object.assign({}, entry, { codeA: entry.codeB, codeB: entry.codeA, genIdA: entry.genIdB, genIdB: entry.genIdA });
        out.push({ key, famA: n, famB: o, relType: entry.relType, note: null, existing: oriented });
      });
    }
    return out;
  }
  // Companion to unresolvedFamilyRelations above: relation pairs touching
  // `n` that ARE already confirmed (either through the interactive Yes
  // click above, or automatically at generation-check time by
  // llm_families.js's resolvePlatformMention — a shared-platform/rebadge
  // mention that resolved unambiguously by production-year overlap never
  // even shows an unresolved box, it goes straight to "confirmed"). Shown
  // as a small, non-interactive confirmation line so accepting one doesn't
  // just make the panel go silently blank — before this there was no way to
  // tell, later, that anything had happened at all.
  function resolvedFamilyRelations(n) {
    if (n.type !== "family" || !window.LlmFamilies) return [];
    const out = [];
    const seen = new Set();
    adj.get(n.id).forEach(({ n: o, l }) => {
      if (l.type !== "platform" && l.type !== "related" && l.type !== "succession") return;
      if (l.retired) return; // severed alongside a rejected relationship -- see unresolvedFamilyRelations
      if (o.type !== "family" && o.type !== "model") return;
      o = liveRelationEndpoint(o);
      if (!o) return;
      const key = relationKey(n.id, o.id, l.type);
      if (seen.has(key)) return;
      seen.add(key);
      const existing = window.LlmFamilies.relationEntryFor(key);
      if (existing && existing.status === "confirmed") out.push({ key, famA: n, famB: o, relType: l.type, entry: existing });
    });
    return out;
  }
  function renderResolvedRelation(el, c) {
    const key = "resolved:" + c.key;
    // Real user request: closing one of these should just clear the
    // message, not collapse to a lingering "via local LLM + Wikipedia"
    // disclaimer -- once dismissed, render nothing at all for it.
    if (dismissedLlm.has(key)) return;
    const div = document.createElement("div");
    div.className = "llm-resolved";
    // entry.codeA/codeB are already fully-descriptive generation labels
    // (e.g. "911 (964)", "Nameplate Gen1") -- only prefix with the
    // family/make label when the code doesn't already start with it, so a
    // resolution doesn't read as "Nameplate Nameplate Gen1".
    const aText = (c.entry.codeA && c.entry.codeA.startsWith(c.famA.label)) ? c.entry.codeA
      : `${c.famA.label}${c.entry.codeA ? " " + c.entry.codeA : ""}`;
    const bBase = c.famB.make ? `${c.famB.make} ${c.famB.label}` : c.famB.label;
    const bText = (c.entry.codeB && c.entry.codeB.startsWith(c.famB.label)) ? (c.famB.make ? c.famB.make + " " : "") + c.entry.codeB
      : `${bBase}${c.entry.codeB && c.entry.codeB !== c.famB.label ? " " + c.entry.codeB : ""}`;
    div.innerHTML = `${llmCloseBtn(key)}<span class="llm-resolved-text">✓ ${esc(aText)} ↔ ${esc(bText)} (${esc(c.relType)})</span>`;
    el.appendChild(div);
    wireLlmClose(div, key, () => { div.remove(); });
  }
  function renderRelationChecks(n) {
    const el = dt.querySelector(".dt-relations");
    if (!el) return;
    el.innerHTML = "";
    if (!window.LlmFamilies || !window.LlmFamilies.serverAvailable) return;
    unresolvedFamilyRelations(n).forEach(c => renderOneRelationCheck(el, c));
    resolvedFamilyRelations(n).forEach(c => renderResolvedRelation(el, c));
  }
  // ---------- cascading nameplate discovery ----------
  // The BMW X3/X4 case that prompted this: X3 gets corrected/split into
  // real generations (G01, F25...), and it turns out X3 has always carried
  // a coarse "related" connection to a BMW X4 -- but X4 itself has never
  // been checked and is still just one plain, ungrouped model. Left alone,
  // the relation-check above would happily resolve "which X3 generation"
  // against X4 as a single bare option and call it done -- technically
  // correct, but missing that X4 (G02) specifically is the real match, not
  // "X4" as a whole. Before disambiguating the relationship at all, check
  // whether the OTHER side is itself hiding multiple generations too; if it
  // is and the user accepts, both sides are now real nameplates and the
  // normal disambiguation below naturally asks for (and gets) a genuine
  // generation<->generation pairing instead. Designers/engineers need no
  // special handling here -- they're already attached per-generation by the
  // ordinary generation-check machinery the moment X4 gets split.
  // Real bug report: "It seems that the LLM doesn't properly find the
  // generations for other nameplates. For example, I selected the Honda
  // Odyssey Nameplate, and saw that it made a connection [to] the Acura MDX.
  // In this case, the LLM should have also looked at the Acura MDX and also
  // checked its wikipedia page and search for generations, and split up the
  // Acura MDX into generations, to then make the links between the
  // generations of the Acura MDX nameplate and the Honda Odyssey nameplate."
  //
  // That's exactly what this cascade is for, and it had been silently
  // disabled for precisely the cars that need it most -- by a feature added
  // in the same session as itself. `schedulePartnerCheck` (the Toyota Crown
  // fix) runs a background check on a matched partner and stores the result;
  // `checkNodeCascade` keeps a "provisional" verdict in memory rather than
  // discarding it, waiting for someone to apply it. But the gate below asked
  // only "does an entry exist?", so as soon as that background check had
  // stored its provisional split, this returned false, the cascade branch was
  // skipped, and the relation was disambiguated against the still-unsplit
  // partner. The generations were found and then thrown away.
  //
  // A partner with an unapplied provisional split is now the strongest reason
  // to take this branch, not a reason to skip it: the answer is already in
  // hand and just needs applying.
  function needsCascadeCheck(c) {
    if (c.famB.type !== "model" || c.famB.familyOf) return false;
    if (!window.LlmFamilies.isEligible(c.famB)) return false;
    // The same one-hop budget the background partner check honours (see
    // llm_families.js's cascadeMaxDepth). In practice this panel only ever
    // renders for the car the user is looking at, so it's normally depth 0 ->
    // 1 and always allowed -- but keeping both paths on one rule means the
    // budget can't be silently escaped through the UI, and raising
    // CASCADE_MAX_DEPTH in serve.py loosens both together rather than one.
    if (window.LlmFamilies.cascadeAllowedFrom && !window.LlmFamilies.cascadeAllowedFrom(c.famA.id)) return false;
    const entry = window.LlmFamilies.entryFor(c.famB.id);
    return !entry || entry.status === "provisional";
  }
  // A cascade/relation check for c belongs to whichever nameplate (c.famA)
  // the user actually selected to arrive here -- allowed to run either
  // while the toggle is still on, or when it's this exact node's own task
  // still finishing out (see disengageLlmCheckFor's comment above).
  function llmCheckAllowedFor(nodeId) { return llmCheckOn || llmCheckArmedFor === nodeId; }
  function renderOneRelationCheck(el, c) {
    const box = document.createElement("div");
    box.className = "llm-relation";
    if (needsCascadeCheck(c)) {
      if (!llmCheckAllowedFor(c.famA.id)) return; // same gate as the single-car generation check
      el.appendChild(box);
      box.innerHTML = `<div class="llm-status">🤖 checking if ${esc(c.famB.make + " " + c.famB.label)} is also a nameplate…</div>`;
      window.LlmFamilies.checkNodeCascade(c.famB, nodes).then(entry => {
        applySharedPlatformLive(); // a "none" cascade result can still carry its own single-generation platform mention
        if (dtNode !== c.famA) return;
        if (entry.status === "provisional") {
          // Same "no approval needed for a first-time nameplate" rule as
          // the primary generation-check flow above -- c.famB is
          // incidentally discovered here (while checking c.famA's relation
          // to it), but it's still becoming a real nameplate for the very
          // first time, so it auto-applies the same way.
          window.LlmFamilies.confirmNode(c.famB.id);
          applyLlmConfirmSilent(c.famB); // mints c.famB's generations WITHOUT switching the open panel away from c.famA
          // The other half of the Honda Odyssey / Acura MDX fix: a relation
          // verdict recorded BEFORE the partner had generations was answering
          // a different question ("which Odyssey generation relates to the
          // MDX as a whole"), and proceedWithRelationCheck would render that
          // stale answer instead of asking the real one now that both sides
          // are nameplates. Forgetting it is what makes the check actually
          // re-run against the new generation list. keepCoarse, because this
          // isn't a rejection of the connection -- it's a re-ask.
          if (c.existing) {
            window.LlmFamilies.rejectRelation(c.key, { keepCoarse: true });
            c.existing = null;
          }
          box.innerHTML = "";
          proceedWithRelationCheck(box, c); // both sides real nameplates now -> genuine generation<->generation disambiguation
        }
        else proceedWithRelationCheck(box, c); // not actually hiding generations (or the check failed) -- disambiguate against it as a plain model, same as before this existed
      });
      return;
    }
    el.appendChild(box);
    proceedWithRelationCheck(box, c);
  }
  const linkIdOf = v => (typeof v === "string" ? v : (v && v.id));
  // Every live link currently representing the coarse, nameplate-level
  // version of relation-check candidate `c`.
  function coarseLinksFor(c) {
    return links.filter(l => l.type === c.relType && !l.retired &&
      ((linkIdOf(l.source) === c.famA.id && linkIdOf(l.target) === c.famB.id) ||
       (linkIdOf(l.source) === c.famB.id && linkIdOf(l.target) === c.famA.id)));
  }
  // ---------- a relation the LLM itself couldn't back up shouldn't stay on the graph ----------
  // Real bug report, with the raw model output attached: "the program states
  // that the ford focus and the vw jetta are related, even though they are
  // not. It made the connection to the edge even when this is what the
  // playground was reporting [resolved:false, codeA:null, codeB:null,
  // reason: '...we cannot definitively map the specific codes... Therefore,
  // I must return false because the text does not explicitly link the
  // specific codes, and year overlap is insufficient.'] Based on this
  // information, it should have automatically rejected the connection.
  // However, it didn't."
  //
  // The edge came from resolveOnePlatformMention's coarse fallback: the
  // Jetta's article genuinely contains the words "Ford Focus" (in a sentence
  // about the rear suspension resembling it), the model dutifully listed it
  // under sharedPlatforms, the nameplate name matched exactly, and no
  // specific generation could be pinned down -- so a plain nameplate-level
  // "platform" link was pushed and left there permanently. Everything after
  // that point behaved correctly and changed nothing: the relation check ran,
  // said "none", and the coarse link it was checking simply stayed.
  //
  // That fallback is right for a link that came from somewhere trustworthy
  // (a DBpedia-harvested fact, a build-time curated relation) -- an
  // unresolvable generation pair is no reason to throw the underlying fact
  // away. It is NOT right for a link whose only reason for existing was the
  // LLM's own reading of the article, when a second, more focused LLM pass
  // over that same article has now explicitly declined to support it. That
  // case has no evidence behind it at all any more, so it's severed rather
  // than left standing. Scoped strictly to `llmDiscovered` links for exactly
  // that reason -- a genuine harvested fact is never auto-deleted here.
  function autoRejectUnbackedRelation(c, entry) {
    const LF = window.LlmFamilies;
    if (!entry || entry.status !== "none" || !LF.severRelationEntryLinks) return false;
    const ls = coarseLinksFor(c);
    if (!ls.length || !ls.every(l => l.llmDiscovered)) return false;
    LF.rejectRelation(c.key);
    LF.severRelationEntryLinks({ famA: c.famA.id, famB: c.famB.id, relType: c.relType }, links);
    refreshAfterLinkChange();
    return true;
  }
  // Shared post-mutation refresh for anything that RETIRES links rather than
  // adding them (severing a rejected relation, retracting a confirmed one).
  // No index rebuild is needed -- a retired link stays in `links`/`adj` and
  // is simply filtered out by linkInLayer/openDetail -- but every derived
  // view still has to be recomputed.
  function refreshAfterLinkChange() {
    refreshYearFilter();
    indexMirrorReplacements();
    Graph.refreshFocus();
    Graph.touch();
    refreshCounts();
  }
  // Real user request: "if the program is checking the relation to another
  // car model which is also a nameplate, it should first verify with the
  // wikipedia of that nameplate to make sure that the generations are in
  // order. Only after the generations are fixed ... then the matches should
  // be continued between Car A and Car B."
  //
  // Asking the model to pick a generation out of a list the database hasn't
  // kept up to date is the failure this closes: it identifies a real
  // generation, that generation isn't in the list, and the check dead-ends
  // through no fault of the answer. So before spending the match call, ask
  // each nameplate side's own Wikipedia article whether the stored list is
  // missing anything, and if so run that nameplate's ordinary generation
  // check first and let it settle.
  //
  // Bounded deliberately:
  //   - only a side that IS a nameplate, and only one that hasn't already
  //     been generation-checked -- this never re-litigates a settled one
  //   - one level, never recursive: fixing B's generations does not go on to
  //     fix everything B is related to (that is what cascadeMaxDepth already
  //     guards for the relation walk itself)
  //   - entirely best effort. An offline article, a rename, a model that
  //     declines -- any of them just means the match proceeds with the list
  //     as it stands, exactly as before. Nothing here can block a check from
  //     happening, only improve what it is given.
  async function freshenGenerationsBeforeMatch(box, c) {
    const LF = window.LlmFamilies;
    if (!LF || !LF.generationGapFor || !LF.checkNode) return;
    const sides = [c.famA, c.famB].filter(n => n && n.wp && !LF.entryFor(n.id));
    if (!sides.length) return;
    let gaps;
    try {
      gaps = await Promise.all(sides.map(n =>
        LF.generationGapFor(relationGenInfo(n)).catch(() => null)));
    } catch (e) { return; }
    for (let i = 0; i < sides.length; i++) {
      const gap = gaps[i];
      if (!gap || !gap.missing.length) continue;
      const node = sides[i];
      // Same budget as every other automatic check. Without this the
      // generation freshening was its own uncounted hop: it ran a full check
      // on the partner, which discovered ITS partners, and so on -- see
      // scheduleWpLookupAndCheck's comment for the runaway this belongs to.
      if (LF.cascadeAllowedFrom && !LF.cascadeAllowedFrom(c.famA.id)) continue;
      if (box && document.body.contains(box)) {
        box.innerHTML = `<div class="llm-status">🤖 ${esc(gap.label)}'s generation list looks out of date — Wikipedia names ${gap.wikiCount}, the database has ${gap.heldCount}. Checking that first…</div>`;
      }
      try {
        await LF.checkNode(node, nodes);
      } catch (e) { /* best effort -- fall through and match with what we have */ }
    }
  }
  function proceedWithRelationCheck(box, c) {
    if (!c.existing) {
      if (!llmCheckAllowedFor(c.famA.id)) { box.remove(); return; }
      box.innerHTML = `<div class="llm-status">🤖 checking which generation relates to ${esc(c.famB.make + " " + c.famB.label)}…</div>`;
      // relationGenInfo is read AFTER the freshen step, not before: the whole
      // point is that the generation list may have grown in between.
      freshenGenerationsBeforeMatch(box, c)
        .then(() => window.LlmFamilies.checkRelation(c.key, relationGenInfo(c.famA), relationGenInfo(c.famB), c.relType, c.note, { nodes, links }))
        .then(entry => {
          if (dtNode !== c.famA) return;
          // Real user request: a match grounded in an explicit code found
          // directly in one of the two articles' own text (status
          // "confirmed" straight out of checkRelation -- see
          // computeRelationEntry's autoConfirmed) shouldn't sit around
          // waiting for a Yes click. Wire it in immediately, same as
          // clicking Yes would; a genuine LLM-only guess still lands on
          // "provisional" and goes through renderRelationEntry's normal
          // Yes/No review below.
          if (entry.status === "confirmed") { applyRelationConfirm(c.famA); return; }
          // The Ford Focus / VW Jetta fix -- see autoRejectUnbackedRelation.
          // Only fires for a connection the LLM itself invented and has now
          // declined to stand behind; anything else falls through to the
          // ordinary retry/dismiss box below exactly as before.
          if (autoRejectUnbackedRelation(c, entry)) {
            box.innerHTML = `<div class="llm-status">🤖 the ${esc(c.relType)} connection to ${esc(c.famB.make + " " + c.famB.label)} couldn't be backed up on a second read, so it was removed — it was only ever proposed by the LLM in the first place ${debugToggleHtml(entry.debug || {})}</div>
              <div class="llm-debug" hidden></div>`;
            wireDebugToggle(box, entry.debug || {});
            if (dtNode === c.famA) openDetail(c.famA);
            return;
          }
          renderRelationEntry(box, c, entry);
        });
      return;
    }
    // "none" used to just box.remove() here -- silently giving up with no
    // way for the user to ever get this connection made, and no visible
    // sign the check had even run. renderRelationEntry's own "none" branch
    // now offers a retry instead, so route every status through it
    // uniformly (a previously-persisted "none" gets the exact same retry
    // chance a freshly-checked one does, just below).
    renderRelationEntry(box, c, c.existing);
  }
  // renderCascadeProposal (the old Yes/No/Retry review box for a cascade-
  // discovered nameplate) no longer exists -- see the auto-apply branch in
  // renderOneRelationCheck above.
  function renderRelationEntry(box, c, entry) {
    if (entry.status === "provisional") {
      const dbg = entry.debug || {};
      // entry.codeA/codeB can already be a fully-descriptive label on their
      // own (e.g. when a side has only one possible "generation" -- a plain,
      // not-yet-split model standing in for itself -- checkRelation sets its
      // code to that model's own label, see llm_families.js's checkRelation)
      // -- only prefix with the family/model's own label when the code
      // doesn't already start with it, same guard renderResolvedRelation
      // already uses below. Real bug report: without this guard, a plain
      // model's self-standing code produced a literally doubled label, e.g.
      // "Grand Cherokee Grand Cherokee ↔ Commander (XK) Commander (XK)".
      const aText = (entry.codeA && entry.codeA.startsWith(c.famA.label)) ? entry.codeA
        : `${c.famA.label}${entry.codeA ? " " + entry.codeA : ""}`;
      const bText = (entry.codeB && entry.codeB.startsWith(c.famB.label)) ? entry.codeB
        : `${c.famB.label}${entry.codeB ? " " + entry.codeB : ""}`;
      box.innerHTML = `
        <div class="llm-label">🤖 possible specific match for the ${esc(c.relType)} connection to ${esc(c.famB.make + " " + c.famB.label)} — unverified ${debugToggleHtml(dbg)}</div>
        <div class="llm-debug" hidden></div>
        <div class="llm-status"><b>${esc(aText)}</b> ↔ <b>${esc(bText)}</b></div>
        ${entry.reason ? `<div class="llm-gen-people">${esc(entry.reason)}</div>` : ""}
        <div class="llm-actions">
          <button class="llm-btn llm-rel-yes">✓ Yes, accurate</button>
          <button class="llm-btn llm-rel-no">✗ No, inaccurate</button>
        </div>`;
      wireDebugToggle(box, dbg);
      box.querySelector(".llm-rel-yes").onclick = () => {
        window.LlmFamilies.confirmRelation(c.key);
        applyRelationConfirm(c.famA);
      };
      box.querySelector(".llm-rel-no").onclick = () => {
        window.LlmFamilies.rejectRelation(c.key);
        // "When I delete an entry... it should also reflect that in the
        // graph and information cards as well." Declining used to only drop
        // the stored proposal and remove this box -- if a coarse
        // LLM-discovered link had already been pushed for the same pair (see
        // resolveOnePlatformMention's fallback branch), it stayed on the
        // graph looking exactly like the rejection hadn't taken.
        if (window.LlmFamilies.severRelationEntryLinks) {
          window.LlmFamilies.severRelationEntryLinks(
            { famA: c.famA.id, famB: c.famB.id, relType: c.relType }, links);
          refreshAfterLinkChange();
        }
        box.remove();
        if (dtNode === c.famA) openDetail(c.famA);
      };
      return;
    }
    // "error" and "none" are both dead-ends for now, just for different
    // reasons -- both closeable so they don't sit in view forever (the
    // coarse nameplate-level connection keeps showing on its own regardless,
    // see indexMirrorReplacements), and dismissal is remembered so
    // reopening the SAME undecided panel doesn't bring it right back;
    // a fresh retry clears it below since that's a genuinely new result.
    const key = (entry.status === "error" ? "relerror:" : "relnone:") + c.key;
    if (dismissedLlm.has(key)) { box.remove(); return; }
    if (entry.status === "error") {
      box.innerHTML = `
        <div class="llm-status llm-error">${llmCloseBtn(key)}Local LLM relation check failed: ${esc(entry.error || "unknown error")}</div>
        <div class="llm-retry-row">
          <input type="text" class="llm-reason" placeholder="tell it what's wrong, and it'll try again…">
          <button class="llm-btn llm-rel-retry">Retry</button>
        </div>`;
    } else {
      // "none" -- the LLM couldn't confidently resolve which SPECIFIC
      // generation pair this applies to (most often: one side has several
      // real generations and the exact code string it echoed back didn't
      // match one exactly). Used to just box.remove() here, both on a fresh
      // check (which left the box stuck on "checking..." forever, looking
      // exactly like a silent hang -- the promise really had resolved,
      // nothing ever said so) and on an already-persisted "none" (which
      // just never showed up at all) -- either way, the connection could
      // never actually get made and the user had no way to know why or try
      // again. The coarse nameplate-level connection keeps showing on its
      // own regardless -- this box exists purely to offer another shot at
      // the specific generation<->generation pair, plus a way to see why it
      // didn't match (debug toggle) and to dismiss it (close button).
      const dbg = entry.debug || {};
      box.innerHTML = `
        <div class="llm-status">${llmCloseBtn(key)}🤖 couldn't confidently match a specific generation pair for the ${esc(c.relType)} connection to ${esc(c.famB.make + " " + c.famB.label)} — it still shows at the nameplate level ${debugToggleHtml(dbg)}</div>
        <div class="llm-debug" hidden></div>
        <div class="llm-retry-row">
          <input type="text" class="llm-reason" placeholder="tell it which generations, and it'll try again…">
          <button class="llm-btn llm-rel-retry">Retry</button>
        </div>`;
      wireDebugToggle(box, dbg);
    }
    wireLlmClose(box, key, () => { box.remove(); });
    wireRelationRetry(box, c);
  }
  // Shared by both the "none" and "error" retry rows above: forgets the
  // stuck verdict (same "not a permanent no" semantics rejectRelation
  // already has for a rejected provisional) and re-checks with whatever the
  // user typed folded into the note the LLM sees, alongside anything the
  // original coarse link's own note already said.
  function wireRelationRetry(box, c) {
    box.querySelector(".llm-rel-retry").onclick = () => {
      const reason = box.querySelector(".llm-reason").value.trim();
      if (!reason) return;
      box.innerHTML = `<div class="llm-status">🤖 trying again with your feedback…</div>`;
      // keepCoarse: this is "forget that verdict and try again with a hint",
      // not a rejection of the connection itself -- blacklisting the coarse
      // nameplate-level key here would delete the very link the retry exists
      // to resolve. See rejectRelation's own comment.
      window.LlmFamilies.rejectRelation(c.key, { keepCoarse: true });
      const note = c.note ? `${c.note} ${reason}` : reason;
      freshenGenerationsBeforeMatch(box, c)
        .then(() => window.LlmFamilies.checkRelation(c.key, relationGenInfo(c.famA), relationGenInfo(c.famB), c.relType, note, { nodes, links }))
        .then(entry2 => {
          if (dtNode !== c.famA) return;
          if (entry2.status === "confirmed") { applyRelationConfirm(c.famA); return; }
          renderRelationEntry(box, c, entry2);
        });
    };
  }
  // No reload: wires the newly-resolved generation<->generation link (and
  // retroactively tags the original, now-superseded-when-visible connection)
  // straight into the live graph, same no-reload philosophy as
  // applyLlmConfirm above.
  function applyRelationConfirm(viewedNode) {
    const nodesBefore = nodes.length, linksBefore = links.length;
    window.LlmFamilies.applyResolvedRelations(nodes, links);
    // Was three hand-rolled loops that assumed adj already had an entry for
    // every endpoint -- the exact assumption that threw mid-accept and left
    // the canvas permanently stuck. See spliceIntoIndexes' own comment.
    spliceIntoIndexes(nodesBefore, linksBefore);
    if (nodes.length !== nodesBefore) buildSim(); // applyResolvedRelations followed a
                                                  // supersededBy redirect onto a node this
                                                  // pass hadn't registered yet
    refreshYearFilter();
    indexMirrorReplacements(); // the just-resolved generation<->generation link may now
                                // be the replacement that lets a coarse mirror finally hide
    Graph.refreshFocus();
    Graph.touch();
    refreshCounts(); // the newly-wired generation<->generation link changed the connection count
    if (dtNode === viewedNode) openDetail(viewedNode);
  }
  // Symmetric counterpart to applyRelationConfirm above, for the manual
  // "LLM re-check" flow's reworkPending "remove" proposals (see
  // llm_families.js's reworkRelationsForFamily/retractConfirmedRelation):
  // live-apply retracting an already-CONFIRMED relation the re-check could
  // no longer back up. `entrySnapshot` is the plain summary object
  // allRelationEntries() returns (id/famA/famB/relType), captured BEFORE
  // LlmFamilies.retractConfirmedRelation() deletes the real store entry,
  // since nothing here needs anything beyond those four fields.
  function applyRelationRetract(entrySnapshot, viewedNode) {
    const idOf2 = v => (typeof v === "string" ? v : (v && v.id));
    const idx = links.findIndex(l => l.llmResolvedKey === entrySnapshot.id);
    if (idx !== -1) {
      const l = links[idx];
      const sId = idOf2(l.source), tId = idOf2(l.target);
      links.splice(idx, 1);
      [sId, tId].forEach(id => {
        const arr = adj.get(id);
        if (!arr) return;
        const i2 = arr.findIndex(e => e.l === l);
        if (i2 !== -1) arr.splice(i2, 1);
        const n2 = byId.get(id);
        if (n2) { n2.deg = arr.length; n2.r = radius(n2); }
      });
    }
    // If no OTHER confirmed relation of this same type still ties these two
    // nameplates together at the family level, the family-level mirror line
    // mirrorRelationLinks minted alongside the retracted link is now stale
    // -- drop it too rather than leaving a dangling line with nothing real
    // backing it up once both generations collapse back into their
    // nameplates. mirrorRelationLinks itself is purely additive/idempotent
    // (see its own comment), so this is the only place that ever removes
    // one.
    const stillTied = (window.LlmFamilies.allRelationEntries() || []).some(o =>
      o.status === "confirmed" && o.id !== entrySnapshot.id && o.relType === entrySnapshot.relType &&
      ((o.famA === entrySnapshot.famA && o.famB === entrySnapshot.famB) || (o.famA === entrySnapshot.famB && o.famB === entrySnapshot.famA)));
    if (!stillTied) {
      for (let i = links.length - 1; i >= 0; i--) {
        const l = links[i];
        if (!l.mirror || l.type !== entrySnapshot.relType) continue;
        const sId = idOf2(l.source), tId = idOf2(l.target);
        const matches = (sId === entrySnapshot.famA && tId === entrySnapshot.famB) || (sId === entrySnapshot.famB && tId === entrySnapshot.famA);
        if (!matches) continue;
        links.splice(i, 1);
        [sId, tId].forEach(id => {
          const arr = adj.get(id);
          if (!arr) return;
          const i2 = arr.findIndex(e => e.l === l);
          if (i2 !== -1) arr.splice(i2, 1);
          const n2 = byId.get(id);
          if (n2) { n2.deg = arr.length; n2.r = radius(n2); }
        });
      }
    }
    refreshYearFilter();
    indexMirrorReplacements();
    Graph.refreshFocus();
    Graph.touch();
    refreshCounts();
    if (dtNode === viewedNode) openDetail(viewedNode);
  }
  // Same no-reload live-apply, for a shared-platform mention discovered on a
  // nameplate that turned out to have only ONE generation (see
  // llm_families.js's applySharedPlatformForSingleGen) -- run after every
  // plain generation check/retry completes, regardless of whether it landed
  // on "provisional" or "none", since "none" is exactly the case this
  // exists for. Cheap and idempotent (resolvePlatformMention's own dedup
  // guards do the real work) so calling it liberally is fine.
  function applySharedPlatformLive() {
    if (!window.LlmFamilies) return;
    // Task #53: a shared-platform mention naming a car that doesn't exist
    // ANYWHERE in the graph yet now mints a brand-new node
    // (llm_families.js's mintRelatedNode) instead of being dropped -- this
    // is the ONLY path a mint can arrive through (the single-generation
    // "none"/plain-check path), so nodesBefore must be tracked here too,
    // not just linksBefore, mirroring applyLlmConfirmSilent's own
    // byId/adj/deg/r/LABEL_ORDER wiring for newly-minted nodes above.
    const nodesBefore = nodes.length, linksBefore = links.length;
    window.LlmFamilies.applySharedPlatformForSingleGen(nodes, links);
    // The people half of the same verdict, live and in the same pass: a
    // single-generation check that found a designer or engineer must credit
    // them NOW, not only on the next page load (the Audi Nuvolari report --
    // "whenever I do an LLM search, I want that the information about the
    // designers and engineers also be added to the database"). Mints person
    // nodes, which is why it sits inside the nodesBefore/linksBefore window.
    window.LlmFamilies.applyPeopleForSingleGen(nodes, links);
    window.LlmFamilies.applyResolvedRelations(nodes, links); // wires any newly "confirmed" entry just minted above
    if (links.length === linksBefore && nodes.length === nodesBefore) return; // nothing new -- skip the rest of the refresh work
    spliceIntoIndexes(nodesBefore, linksBefore);
    if (nodes.length !== nodesBefore) buildSim(); // new node(s) -- sim must be reinitialized over the larger arrays
    refreshYearFilter();
    indexMirrorReplacements();
    Graph.refreshFocus();
    Graph.touch();
    refreshCounts(); // any newly-discovered platform link changed the connection count
  }
  // Shared by every place a plain generation check/retry can conclude --
  // runs the shared-platform live-apply above first (so a "none" verdict's
  // own single-generation platform mention takes effect immediately, not
  // just on next reload), then re-renders if the panel is still on this car.
  function afterLlmCheck(n) {
    recordEnginesLive();
    scanEnginesLive(n);
    applySharedPlatformLive();
    if (dtNode === n) renderLlmCheck(n);
  }

  // ---------- Graph year-range filter UI: dual-thumb slider ----------
  function initYearFilterUI() {
    const lo = document.getElementById("yf-lo");
    const hi = document.getElementById("yf-hi");
    const loLabel = document.getElementById("yf-lo-label");
    const hiLabel = document.getElementById("yf-hi-label");
    const rangeBar = document.getElementById("yf-range-bar");
    if (!lo || !hi) return;
    const { min, max } = api.yearRange();
    lo.min = hi.min = min; lo.max = hi.max = max;
    function render() {
      const r = api.yearRange();
      lo.value = r.lo; hi.value = r.hi;
      loLabel.textContent = r.lo; hiLabel.textContent = r.hi === r.max ? r.hi + "" : r.hi;
      const span = Math.max(1, r.max - r.min);
      rangeBar.style.left = ((r.lo - r.min) / span * 100) + "%";
      rangeBar.style.right = (100 - (r.hi - r.min) / span * 100) + "%";
    }
    // One year of clearance, both ways -- see setYearRange, which enforces it
    // for every caller. Done here too so the thumb stops where it will land
    // rather than snapping back a year after the fact.
    lo.addEventListener("input", () => {
      const v = Math.min(+lo.value, +hi.value - 1);
      api.setYearRange(v, +hi.value);
      render();
    });
    hi.addEventListener("input", () => {
      const v = Math.max(+hi.value, +lo.value + 1);
      api.setYearRange(+lo.value, v);
      render();
    });
    api.onYearFilterChange(render);
    render();
  }

  // ---------- LLM debug panel: reset the whole layer, or one car at a time ----------
  // For re-running a test (e.g. after a code change to the extraction logic)
  // without hand-editing llm_families.json. A confirmed/applied split that
  // gets deleted here has already rewired the live in-memory graph in this
  // tab, and unwinding that cleanly is a lot more machinery than a debug
  // tool warrants — so both actions reload the page once the on-disk file
  // is updated, same as any other "start over" action. On a static file://
  // build there's no server to write to, so the panel is inspect-only there.
  function initLlmDebugPanel() {
    const LF = window.LlmFamilies;
    const btn = document.getElementById("llmdebugbtn");
    const panel = document.getElementById("llmdebug");
    if (!btn || !panel || !LF) return;
    const note = panel.querySelector(".llmdebug-note");
    const sel = document.getElementById("llmdebug-select");
    const clearBtn = document.getElementById("llmdebug-clearall");
    const clearPositiveBtn = document.getElementById("llmdebug-clearpositive");
    const deleteBtn = document.getElementById("llmdebug-deleteone");

    // Three separate layers share this one panel: `families` (does a plain
    // model hide multiple generations at all), `recheck` (is an EXISTING
    // nameplate's generation list actually correct — see llm_families.js's
    // checkFamily/applyFamilyOverride), and `relations` (which SPECIFIC
    // generation pair a coarse platform/related/succession connection
    // actually resolves to — see checkRelation/resolvePlatformMention). All
    // three need to be visible and clearable here, or "Clear ALL"/an
    // individual delete silently leaves one of them behind with no way to
    // tell it's even there — exactly the bug report this fixes: BMW X3 kept
    // showing already-verified relation matches after "Clear ALL", because
    // that layer had no presence in this panel (or in resetAll() itself) at
    // all. Dropdown option values are prefixed (`gen:<id>` / `recheck:<id>`
    // / `rel:<key>`) so delete routes to the right store. A relation entry
    // has no human-readable title of its own (see allRelationEntries), so
    // it's formatted here from the two involved nodes' own labels.
    function relationEntryLabel(e) {
      const a = byId.get(e.famA), b = byId.get(e.famB);
      const aLabel = a ? (a.make ? `${a.make} ${a.label}` : a.label) : e.famA;
      const bLabel = b ? (b.make ? `${b.make} ${b.label}` : b.label) : e.famB;
      return `${aLabel} ↔ ${bLabel} (${e.relType}) — ${e.status}`;
    }
    // Real user report: "when I look at the 'Delete one at a time' cars,
    // they should be in alphabetical order. Currently they are not and it's
    // hard to find car brands and models." Three separate lists were
    // appended one after another, each sorted only within itself and by a
    // different key -- generation/override entries by their Wikipedia
    // sourceTitle (close to alphabetical, but not the label shown anywhere
    // else in the app) and relations by checkedAt, i.e. discovery order,
    // which is effectively random from a reader's point of view. Now all
    // three are merged and sorted together by the exact text the option
    // actually displays, and a checked car is labelled with its real graph
    // name ("Make Model") rather than an article title, so scanning for a
    // brand finds everything about that brand in one place regardless of
    // which of the three layers an entry happens to belong to.
    function nodeLabelFor(id, fallback) {
      const n = byId.get(id);
      if (!n) return fallback || id;
      return n.make ? `${n.make} ${n.label}` : n.label;
    }
    // Decisions whose car is no longer in the graph. See llm_families.js's
    // orphanedEntries for what counts and why deletions are excluded.
    //
    // This exists because a rebuild is the one operation that can silently
    // detach your work: node ids come from make and label, so a rebuild
    // reproduces them -- but if DBpedia renames an article or changes a
    // manufacturer, that car's id moves and every decision pointing at the old
    // one is aimed at nothing. Nothing breaks, which is the problem: the split
    // just stops applying, and the nameplate quietly goes back to being one
    // model. A number you can look at after a rebuild beats noticing in a
    // month.
    //
    // Only the RENAMED kind is listed. The placeholder kind is gone by the
    // time this runs (pruneStandInOrphans, from boot) -- and listing the two
    // together under one explanation is what made this panel actively
    // misleading: "I figured that if i re-scanned the mercedes GLA nameplate,
    // that the entry would disappear from the list", which for a placeholder
    // it never would. The old copy also offered a per-row delete that has
    // never existed; there is one button now, and it says what it deletes.
    function renderOrphans() {
      const box = document.getElementById("llmdebug-orphans");
      const noteEl = document.getElementById("llmdebug-orphans-note");
      const listEl = document.getElementById("llmdebug-orphans-list");
      const summary = document.getElementById("llmdebug-orphans-summary");
      if (!box || !listEl || !LF.orphanedEntries) return;
      let all = [];
      try { all = LF.orphanedEntries(byId) || []; } catch (e) { return; }
      // Anything still classed "stand-in" here means the boot prune could not
      // run (an older store, or it threw) -- list it rather than hide it, but
      // the copy below is written for the renamed kind, which is the one a
      // person can actually act on.
      const items = all.filter(it => it.kind !== "stand-in");
      box.hidden = items.length === 0;
      if (!items.length) return;
      if (noteEl) {
        const one = items.length === 1;
        noteEl.textContent = items.length + (one ? " decision points" : " decisions point") +
          " at a car whose id has moved. An id is built from a car's make and " +
          "label, so when DBpedia renames the article or changes the manufacturer, " +
          "the next rebuild picks the car up under a new id and the decision is left " +
          "aimed at the old one — and for a nameplate or generation this layer " +
          "created itself, the same happens when the split behind it changes. The " +
          "car still exists and nothing is broken: the work simply stopped applying, " +
          "so a nameplate you split is a plain model again. Re-checking " +
          (one ? "that car" : "those cars") + " under " + (one ? "its" : "their") +
          " current name redoes the work; the button below throws " +
          (one ? "it" : "them") + " away instead.";
      }
      if (summary) summary.textContent = "show the " + items.length;
      listEl.innerHTML = "";
      items.slice(0, 200).forEach(it => {
        const li = document.createElement("li");
        const b = document.createElement("b");
        b.textContent = it.what;
        li.appendChild(b);
        li.appendChild(document.createTextNode(" — " + it.label));
        listEl.appendChild(li);
      });
      if (items.length > 200) {
        const li = document.createElement("li");
        li.textContent = "…and " + (items.length - 200) + " more";
        listEl.appendChild(li);
      }
      wireOrphanClear(items.length);
    }
    // One button for the whole list. Two-step, like the rebuild button, since
    // it throws away completed work -- including decisions typed by hand.
    function wireOrphanClear(count) {
      const btn = document.getElementById("orphans-clear");
      const yes = document.getElementById("orphans-clear-confirm");
      const no = document.getElementById("orphans-clear-cancel");
      const say = document.getElementById("orphans-clear-status");
      if (!btn || !yes || !no || !LF.clearRenamedOrphans) return;
      const armed = on => { btn.hidden = on; yes.hidden = !on; no.hidden = !on; };
      armed(false);
      if (say) say.textContent = "";
      btn.textContent = "Delete " + (count === 1 ? "it" : "all " + count) + "…";
      btn.onclick = () => {
        armed(true);
        if (say) {
          say.textContent = "This deletes " + (count === 1 ? "this decision" : "these " + count +
            " decisions") + " for good. Re-checking the car later redoes the work, " +
            "but any Wikipedia link or rename you typed yourself is gone. Continue?";
        }
      };
      no.onclick = () => { armed(false); if (say) say.textContent = ""; };
      yes.onclick = () => {
        let r = { cleared: 0 };
        try { r = LF.clearRenamedOrphans(byId) || r; }
        catch (e) { if (say) say.textContent = "could not delete them: " + e.message; return; }
        armed(false);
        renderOrphans();
        if (say) say.textContent = "deleted " + r.cleared +
          (r.cleared === 1 ? " decision" : " decisions");
      };
    }

    function refresh() {
      renderOrphans();
      const genEntries = LF.allEntries();
      const recheckEntries = LF.allRecheckEntries ? LF.allRecheckEntries() : [];
      const relationEntries = LF.allRelationEntries ? LF.allRelationEntries() : [];
      const total = genEntries.length + recheckEntries.length + relationEntries.length;
      btn.hidden = total === 0 && !LF.serverAvailable;
      sel.innerHTML = "";
      const options = [
        ...genEntries.map(e => ({ value: "gen:" + e.id, text: `${nodeLabelFor(e.id, e.sourceTitle)} — ${e.status}` })),
        ...recheckEntries.map(e => ({ value: "recheck:" + e.id, text: `${nodeLabelFor(e.id, e.sourceTitle)} — generation-list override, ${e.status}` })),
        ...relationEntries.map(e => ({ value: "rel:" + e.id, text: relationEntryLabel(e) })),
      ];
      // localeCompare with numeric collation, so "Series 2" sorts before
      // "Series 10" rather than lexicographically after it.
      options.sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: "base" }));
      options.forEach(({ value, text }) => {
        const o = document.createElement("option");
        o.value = value; o.textContent = text;
        sel.appendChild(o);
      });
      const empty = total === 0;
      sel.disabled = empty; deleteBtn.disabled = empty; clearBtn.disabled = empty;
      note.textContent = LF.serverAvailable
        ? `${genEntries.length} car${genEntries.length === 1 ? "" : "s"} checked, ${recheckEntries.length} generation-list override${recheckEntries.length === 1 ? "" : "s"}, ${relationEntries.length} relation match${relationEntries.length === 1 ? "" : "es"} so far.`
        : `Read-only static snapshot (${total} entr${total === 1 ? "y" : "ies"}) — run ` +
          `python3 serve.py to make changes here.`;
      if (!LF.serverAvailable) { clearBtn.disabled = true; deleteBtn.disabled = true; }
      // "Positive" messages -- the two closeable, non-error, actually-matched
      // message kinds ("applied:"+id from a nameplate's corrected generation
      // list, "resolved:"+key from a confirmed shared-platform/related/
      // succession match; see renderLlmCheckFamily/renderResolvedRelation).
      // Deliberately excludes "none"/"relnone"/"relerror" dead-ends -- those
      // aren't matches, so a "clear POSITIVE messages" button shouldn't
      // silently sweep them up too.
      if (clearPositiveBtn) {
        const positiveKeys = [
          ...recheckEntries.filter(e => e.status === "applied").map(e => "applied:" + e.id),
          ...relationEntries.filter(e => e.status === "confirmed").map(e => "resolved:" + e.id),
        ];
        clearPositiveBtn.disabled = positiveKeys.length === 0;
        clearPositiveBtn.onclick = () => {
          positiveKeys.forEach(k => dismissedLlm.add(k));
          if (window.LlmFamilies && window.LlmFamilies.dismissMany) window.LlmFamilies.dismissMany(positiveKeys);
          // Only the currently-open detail panel actually has these messages
          // rendered right now -- re-render it so the clear is visible
          // immediately; every other panel already checks dismissedLlm on
          // open, so nothing further to do for the rest.
          if (dtNode) { renderLlmCheck(dtNode); renderRelationChecks(dtNode); }
          refresh();
        };
      }
    }

    btn.onclick = () => { refresh(); panel.hidden = !panel.hidden; };
    document.getElementById("llmdebug-close").onclick = () => { panel.hidden = true; };
    clearBtn.onclick = async () => {
      if (!confirm("Clear ALL checked cars, generation-list overrides, AND relation matches from the LLM layer? This can't be undone.")) return;
      await LF.resetAll();
      location.reload();
    };
    deleteBtn.onclick = async () => {
      if (!sel.value) return;
      const [kind, id] = [sel.value.slice(0, sel.value.indexOf(":")), sel.value.slice(sel.value.indexOf(":") + 1)];
      if (kind === "recheck") await LF.deleteRecheckEntry(id);
      else if (kind === "rel") {
        // Snapshot BEFORE the delete -- rejectRelation removes the store
        // entry, and severing the live links needs its famA/famB/genIdA/
        // genIdB to know which links represented it. Harmless here (this
        // path reloads immediately afterwards, so the graph is rebuilt from
        // scratch either way) but it keeps this call site honest with the
        // in-place ones, and means the reload is a convenience rather than
        // the only thing making the delete visible.
        const snapshot = (LF.allRelationEntries() || []).find(e => e.id === id);
        await LF.rejectRelation(id);
        if (snapshot && LF.severRelationEntryLinks) LF.severRelationEntryLinks(snapshot, links);
      }
      else await LF.deleteEntry(id);
      location.reload();
    };
    refresh();
  }

  // ---------- LLM playground ----------
  // See llm_families.js's own "manual LLM testing" section (buildNodePrompt
  // / previewNodeResult / applyNodeResult and the relation equivalents) for
  // the actual logic. This just wires that up to the panel markup in
  // index.html: pick a car (or two, for a relation), build the exact prompt
  // a real check would send, either call this session's own llama-server
  // directly ("Run it here") or paste in a response typed/copied from
  // anywhere else, then preview how it resolves or apply it into the review
  // layer exactly like a real check would (still needs the usual Yes/No on
  // the car's own detail panel afterward). Unlike the llmdebugbtn panel
  // above, this one is useful even with no server reachable this session --
  // building a prompt and previewing a hand-typed result don't need
  // llama-server, only Wikipedia fetches -- so its visibility isn't gated
  // on serverAvailable.
  function initLlmPlaygroundPanel() {
    const LF = window.LlmFamilies;
    const btn = document.getElementById("llmplaygroundbtn");
    const panel = document.getElementById("llmplayground");
    if (!btn || !panel || !LF) return;

    let mode = "node";
    let nodeA = null, nodeB = null; // node mode uses nodeA only; relation mode uses both

    const modeBtns = [...panel.querySelectorAll(".llmpg-mode")];
    const nodeSection = panel.querySelector('.llmpg-section[data-for="node"]');
    const relSection = panel.querySelector('.llmpg-section[data-for="relation"]');
    const nodePick = document.getElementById("llmpg-node-pick");
    const relAPick = document.getElementById("llmpg-rel-a");
    const relBPick = document.getElementById("llmpg-rel-b");
    const relType = document.getElementById("llmpg-rel-type");
    const systemTa = document.getElementById("llmpg-system");
    const userTa = document.getElementById("llmpg-user");
    const responseTa = document.getElementById("llmpg-response");
    const output = document.getElementById("llmpg-output");

    function setMode(m) {
      mode = m;
      modeBtns.forEach(b => b.classList.toggle("active", b.dataset.mode === m));
      nodeSection.hidden = m !== "node";
      relSection.hidden = m !== "relation";
      output.innerHTML = "";
    }
    modeBtns.forEach(b => b.onclick = () => setMode(b.dataset.mode));

    function picker(input, set) {
      const results = input.parentElement.querySelector(".llmpg-results");
      input.addEventListener("input", () => {
        renderResults(results, searchAll(input.value), n => {
          set(n);
          input.value = (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
          results.hidden = true;
        });
      });
      input.addEventListener("blur", () => setTimeout(() => { results.hidden = true; }, 150));
    }
    picker(nodePick, n => { nodeA = n; });
    picker(relAPick, n => { nodeA = n; });
    picker(relBPick, n => { nodeB = n; });

    function showError(msg) { output.innerHTML = `<div class="llmpg-result llmpg-result-error">${msg}</div>`; }

    document.getElementById("llmpg-build").onclick = async () => {
      output.innerHTML = "";
      try {
        if (mode === "node") {
          if (!nodeA) return showError("Pick a car first.");
          const { messages } = await LF.buildNodePrompt(nodeA);
          systemTa.value = messages[0].content; userTa.value = messages[1].content;
        } else {
          if (!nodeA || !nodeB) return showError("Pick both cars first.");
          const { messages } = await LF.buildRelationPrompt(relationGenInfo(nodeA), relationGenInfo(nodeB), relType.value, null);
          systemTa.value = messages[0].content; userTa.value = messages[1].content;
        }
      } catch (e) { showError("Couldn't build the prompt: " + e.message); }
    };

    document.getElementById("llmpg-run").onclick = async () => {
      if (!LF.serverAvailable) return showError("No local server reachable this session — run python3 serve.py, or paste a response from your own LLM below instead.");
      if (!systemTa.value || !userTa.value) return showError("Build the prompt first.");
      output.innerHTML = `<div class="llmpg-result">Asking llama.cpp…</div>`;
      try {
        const raw = await LF.askLlamaCpp([{ role: "system", content: systemTa.value }, { role: "user", content: userTa.value }]);
        responseTa.value = JSON.stringify(raw, null, 2);
        output.innerHTML = `<div class="llmpg-result">Response received — click Preview to see how it resolves.</div>`;
      } catch (e) { showError("llama.cpp call failed: " + e.message); }
    };

    function parseResponse() {
      if (!responseTa.value.trim()) { showError("Paste a response first."); return undefined; }
      try { return JSON.parse(responseTa.value); }
      catch (e) { showError("That's not valid JSON: " + e.message); return undefined; }
    }

    function renderNodeResult(preview) {
      const gens = preview.clean.generations;
      let html = `<div class="llmpg-result"><b>${preview.wp}</b><br>` +
        (gens.length > 1
          ? `${gens.length} generations kept: ${gens.map(g => g.code).join(", ")}`
          : (gens.length === 1 ? `Single generation: ${gens[0].code} (not split)` : `Nothing kept — everything was dropped, or the response had no generations`));
      if (preview.dropped.length) {
        html += `<div class="llmpg-result-error">Dropped (not found verbatim in the article): ${preview.dropped.map(g => g && g.code).join(", ")}</div>`;
      }
      output.innerHTML = html + "</div>";
    }
    function renderRelationResult(entry) {
      let html = `<div class="llmpg-result">Status: <b>${entry.status}</b>`;
      if (entry.status !== "none") {
        html += `<br>Match level: <b>${entry.matchLevel}</b> — code A: ${entry.codeA || "—"} · code B: ${entry.codeB || "—"}`;
      }
      if (entry.reason) html += `<br>Reason: ${entry.reason}`;
      html += `<br><span style="color:var(--muted)">Fetched article A: ${entry.debug.fetchedArticleA ? "yes" : "no"} · article B: ${entry.debug.fetchedArticleB ? "yes" : "no"}</span></div>`;
      output.innerHTML = html;
    }

    document.getElementById("llmpg-preview").onclick = async () => {
      const raw = parseResponse();
      if (raw === undefined) return;
      output.innerHTML = `<div class="llmpg-result">Checking…</div>`;
      try {
        if (mode === "node") {
          if (!nodeA) return showError("Pick a car first.");
          renderNodeResult(await LF.previewNodeResult(nodeA, raw));
        } else {
          if (!nodeA || !nodeB) return showError("Pick both cars first.");
          renderRelationResult(await LF.previewRelationResult(relationGenInfo(nodeA), relationGenInfo(nodeB), relType.value, null, raw));
        }
      } catch (e) { showError("Couldn't parse this result: " + e.message); }
    };

    document.getElementById("llmpg-apply").onclick = async () => {
      if (!LF.serverAvailable) return showError("No local server reachable this session — nothing to write to.");
      const raw = parseResponse();
      if (raw === undefined) return;
      output.innerHTML = `<div class="llmpg-result">Applying…</div>`;
      try {
        if (mode === "node") {
          if (!nodeA) return showError("Pick a car first.");
          await LF.applyNodeResult(nodeA, raw);
          output.innerHTML = `<div class="llmpg-result">Saved. Open <b>${nodeA.make ? nodeA.make + " " : ""}${nodeA.label}</b>'s detail panel to review and confirm it, same as a real check.</div>`;
        } else {
          if (!nodeA || !nodeB) return showError("Pick both cars first.");
          const key = relationKey(nodeA.id, nodeB.id, relType.value);
          await LF.applyRelationResult(key, relationGenInfo(nodeA), relationGenInfo(nodeB), relType.value, null, raw);
          output.innerHTML = `<div class="llmpg-result">Saved. Open either car's detail panel to review and confirm the match.</div>`;
        }
      } catch (e) { showError("Couldn't apply: " + e.message); }
    };

    btn.hidden = false;
    btn.onclick = () => { panel.hidden = !panel.hidden; };
    document.getElementById("llmpg-close").onclick = () => { panel.hidden = true; };
  }

  // ---------- Unconfirmed Relationships browser ----------
  // Real user request: "I want another menu that lets me see all of the
  // unconfirmed relationships that I have not yet confirmed yet and were not
  // automatically approved. If I click on one of these unconfirmed
  // relationships it will then move the window viewfinder to focus on these
  // two cars within the window." A "provisional" relation entry (see
  // llm_families.js's checkRelation/resolvePlatformMention) is exactly that:
  // the LLM found a specific generation-pair match confident enough to
  // propose, but not confident enough to auto-confirm -- it's sitting on a
  // car's own detail panel as a Yes/No prompt, easy to miss unless you've
  // opened that particular car lately. This is a standing list of every one
  // of those, reachable from anywhere in the app.
  function initUnconfirmedRelPanel() {
    const LF = window.LlmFamilies;
    const btn = document.getElementById("unconfirmedrelbtn");
    const panel = document.getElementById("unconfirmedrel");
    const list = document.getElementById("unconfirmedrel-list");
    if (!btn || !panel || !list || !LF) return;
    const note = panel.querySelector(".llmdebug-note");
    const reviewBtn = document.getElementById("unconfirmedrel-review");
    const reviewOut = document.getElementById("unconfirmedrel-reviewed");
    if (reviewBtn) {
      reviewBtn.onclick = () => {
        const nodesBefore = nodes.length, linksBefore = links.length;
        let r = null;
        try { r = LF.reviewProvisionalRelations(nodes, links); }
        catch (e) {
          if (reviewOut) { reviewOut.className = "lrq-status err"; reviewOut.textContent = "Couldn't review those: " + e.message; }
          return;
        }
        // A confirmed relation is only a stored decision until something
        // wires it into the graph -- the same call boot makes.
        if (LF.applyResolvedRelations) LF.applyResolvedRelations(nodes, links);
        spliceIntoIndexes(nodesBefore, linksBefore);
        buildSim();
        refreshCounts();
        Graph.touch();
        if (reviewOut) {
          const lines = []
            .concat(r.confirmed.map(x => `✓ ${label2(x.e)} — ${x.why}`))
            .concat(r.rejected.map(x => `✕ ${label2(x.e)} — ${x.why}`));
          reviewOut.className = "lrq-status" + (lines.length ? " ok" : "");
          reviewOut.innerHTML = lines.length
            ? `<b>${r.confirmed.length} confirmed, ${r.rejected.length} rejected, ${r.left} left for you.</b><br>` +
              lines.map(esc).join("<br>")
            : `Nothing the graph can settle on its own — all ${r.left} still need you.`;
        }
        refresh();
      };
    }
    const label2 = e => {
      const { aLabel, bLabel } = labelsFor(e);
      return `${aLabel} ↔ ${bLabel}`;
    };

    // No human-readable title lives on a relation entry itself (just the two
    // involved node ids + relType) -- same division of labor as the LLM
    // Debug panel's relationEntryLabel: app.js has the node labels in memory
    // via byId, so it formats display text here rather than in llm_families.js.
    function labelsFor(e) {
      const a = byId.get(e.famA), b = byId.get(e.famB);
      return {
        aLabel: a ? (a.make ? `${a.make} ${a.label}` : a.label) : e.famA,
        bLabel: b ? (b.make ? `${b.make} ${b.label}` : b.label) : e.famB,
      };
    }

    function refresh() {
      // Real user request: "[the LLM re-check's potential re-works] should
      // also be in the 'unconfirmed relationships' button, except that this
      // time it should explicitly mention that these are potential
      // re-works." Two different shapes now show up here: an ordinary
      // `status === "provisional"` entry (first-time proposal, possibly
      // itself tagged `rework: true` if a manual re-check is what found
      // it), and an already-CONFIRMED entry carrying `reworkPending` (the
      // re-check could no longer back up a match the user already
      // accepted) -- see llm_families.js's reworkRelationsForFamily.
      const pending = (LF.allRelationEntries ? LF.allRelationEntries() : [])
        .filter(e => e.status === "provisional" || e.reworkPending);
      btn.hidden = !LF.serverAvailable;
      if (note) {
        note.textContent = pending.length === 0
          ? "Nothing waiting on you right now."
          : `${pending.length} relationship${pending.length === 1 ? "" : "s"} the LLM proposed but hasn't been confirmed or rejected yet.`;
      }
      // Real user request: "Check in the 'unconfirmed relationships' cars and
      // see if you can come up with even more rules that would correctly
      // automatically confirm or deny a relationship." Offered here, where
      // the pile is, rather than run quietly at boot: every decision it makes
      // is an ordinary confirm or reject and is undone the ordinary way, so
      // it is worth showing what it did. See llm_families.js's
      // reviewProvisionalRelations.
      if (reviewBtn) {
        const real = pending.filter(e => e.status === "provisional").length;
        reviewBtn.hidden = !(LF.serverAvailable && LF.reviewProvisionalRelations && real);
      }
      list.innerHTML = "";
      if (pending.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ucr-empty";
        empty.textContent = "None right now — check back after browsing a few more cars.";
        list.appendChild(empty);
        return;
      }
      pending.forEach(e => {
        const { aLabel, bLabel } = labelsFor(e);
        // Real user request: "within the 'unconfirmed relationships'
        // dropdown button, the user should directly be able to accept or
        // decline this relationship" -- rather than having to click through
        // to the graph, open the detail panel, and find the same Yes/No box
        // there. A <button> can't contain nested <button>s (invalid HTML,
        // browsers silently un-nest them and break the layout), so this row
        // is now a plain container div with three separate clickable
        // pieces: the pair label (still flies the graph to both cars, same
        // as before) and two new inline action buttons.
        const isRemoveRework = !!e.reworkPending;
        const row = document.createElement("div");
        row.className = "ucr-row";
        const metaBits = [esc(e.relType)];
        if (isRemoveRework) metaBits.push(`<span class="ucr-rework">potential re-work — ${esc(e.reworkPending.reason || "the LLM's re-check could no longer confirm this match")}</span>`);
        else if (e.rework) metaBits.push(`<span class="ucr-rework">potential re-work</span>`);
        if (e.checkedAt) metaBits.push("checked " + esc(new Date(e.checkedAt).toLocaleDateString()));
        // Real user request: "Within the 'unconfirmed relationships', for
        // each car there should also be an explanation by the LLM for why it
        // thinks the relationship exists which it found." Every discovery
        // path already records one -- an explicit chassis code found in the
        // article, a verified quote, an ordinal counted against the
        // generation list, the sanity check's verdict, or the model's own
        // words -- but this list only ever showed "A ↔ B (platform)", so the
        // only way to see WHY was to go find the car in the graph and open
        // its panel. Shown inline now, together with the two specific
        // generation codes being proposed, so the decision can actually be
        // made from here. Deliberately placed inside the pair button (which
        // still flies the graph to both cars) so the whole row stays one
        // click target for "show me these two".
        const codeBits = (e.codeA || e.codeB)
          ? `<span class="ucr-codes">${esc(e.codeA || aLabel)} ↔ ${esc(e.codeB || bLabel)}</span>` : "";
        const reasonHtml = e.reason ? `<span class="ucr-reason">${esc(e.reason)}</span>` : "";
        row.innerHTML = `
          <button type="button" class="ucr-pair-btn">
            <span class="ucr-pair">${esc(aLabel)} ↔ ${esc(bLabel)}</span>
            <span class="ucr-meta">${metaBits.join(" — ")}</span>
            ${codeBits}
            ${reasonHtml}
          </button>
          <div class="ucr-actions">
            ${isRemoveRework
              ? `<button type="button" class="ucr-yes" title="retract this relationship -- the LLM's re-check says it may no longer hold">✓ Remove</button>
                 <button type="button" class="ucr-no" title="keep this relationship as-is, dismiss the re-check's concern">✕ Keep</button>`
              : `<button type="button" class="ucr-yes" title="accept this relationship">✓ Accept</button>
                 <button type="button" class="ucr-no" title="decline this relationship">✕ Decline</button>`}
          </div>`;
        row.querySelector(".ucr-pair-btn").onclick = () => {
          panel.hidden = true;
          if (activeView !== "graph") switchView("graph");
          Graph.focusPair(e.famA, e.famB);
        };
        if (isRemoveRework) {
          row.querySelector(".ucr-yes").onclick = () => {
            LF.retractConfirmedRelation(e.id);
            applyRelationRetract(e, byId.get(e.famA));
            // applyRelationRetract splices out the resolved link and (when
            // nothing else ties the pair together) its family-level mirror,
            // but a coarse llmDiscovered link that predates the resolution
            // isn't either of those -- sever that too, or accepting a
            // "remove" re-work visibly changes nothing.
            if (LF.severRelationEntryLinks) { LF.severRelationEntryLinks(e, links); refreshAfterLinkChange(); }
            refresh();
          };
          row.querySelector(".ucr-no").onclick = () => {
            LF.dismissRework(e.id);
            refresh();
          };
        } else {
          row.querySelector(".ucr-yes").onclick = () => {
            // allRelationEntries() names the relation key "id", not "key" --
            // e.key was silently undefined here, which made confirmRelation()
            // a no-op (relationEntryFor(undefined) always misses).
            LF.confirmRelation(e.id);
            applyRelationConfirm(byId.get(e.famA));
            refresh();
          };
          row.querySelector(".ucr-no").onclick = () => {
            LF.rejectRelation(e.id);
            // Same "declining has to actually remove the line" fix as the
            // detail panel's own ✗ button -- see its comment.
            if (LF.severRelationEntryLinks) {
              LF.severRelationEntryLinks(e, links);
              refreshAfterLinkChange();
              if (dtNode) openDetail(dtNode);
            }
            refresh();
          };
        }
        list.appendChild(row);
      });
    }

    btn.onclick = () => { refresh(); panel.hidden = !panel.hidden; };
    document.getElementById("unconfirmedrel-close").onclick = () => { panel.hidden = true; };
    // Keep the list accurate if it's left open across a confirm/reject that
    // happens elsewhere (e.g. from a car's own detail panel) -- same
    // onFactsUpdate hook already used to refresh other live surfaces.
    if (LF.onFactsUpdate) LF.onFactsUpdate(() => { if (!panel.hidden) refresh(); });
    refresh();
  }

  // ---------- Add Car: manually add a make/model, then run the normal discovery flow ----------
  // Real user request: "there should also be an option for me to specify to
  // the LLM a specific car make and model to further add to the knowledge
  // graph. If the make doesn't exist, then create a new make. If the model
  // doesn't exist, create a new model, and then have the local LLM attempt
  // to find a wikipedia page associated with it. If it could not find a
  // wikipedia page associated with it, then it should ask the user for a
  // wikipedia link about the information on the car. From that link, it
  // should then do the same as it does with other models: it determines
  // whether it's a nameplate, finds the generations, and also looks for the
  // designers and any cars or platforms related to it." Once a verified
  // Wikipedia title is in hand, this mints the make (if new) and model node,
  // splices them into the live graph, and opens the model's own detail panel
  // with LLM Check armed for it -- the EXACT same checkNode() flow every
  // other car already goes through (see renderLlmCheck's "if (!entry)"
  // branch) does all of "determines whether it's a nameplate, finds the
  // generations, designers, platforms" for free; nothing here needs to
  // duplicate any of that discovery logic itself.
  // "Add Engine": the one place a scan can be started for an engine nothing
  // has mentioned yet. Takes a name or a Wikipedia URL, because engine
  // articles are titled inconsistently enough ("BMW N55", "Mercedes-Benz M256
  // engine") that guessing is worse than asking.
  function initAddEnginePanel() {
    const LFam = window.LlmFamilies;
    const btn = document.getElementById("addenginebtn");
    if (!btn || !LFam) return;
    btn.hidden = !LFam.serverAvailable;   // reading an article needs serve.py, same as every other scan
    btn.onclick = () => {
      const menu = document.getElementById("toolsmenu");
      if (menu) menu.hidden = true;
      const typed = window.prompt(
        "Engine to read — a name or a Wikipedia link.\n\n" +
        "e.g.  Mercedes-Benz M256 engine\n      BMW N55\n" +
        "      https://en.wikipedia.org/wiki/Mercedes-Benz_M256_engine");
      const raw = String(typed || "").trim();
      if (!raw) return;
      const title = (LFam.titleFromWikipediaUrl && /^https?:/i.test(raw))
        ? LFam.titleFromWikipediaUrl(raw) : raw;
      if (!title) { window.alert("That doesn't look like a Wikipedia link."); return; }
      scanEngine(title, null);
    };
  }

  function initAddCarPanel() {
    const LF = window.LlmFamilies;
    const btn = document.getElementById("addcarbtn");
    const panel = document.getElementById("addcar");
    if (!btn || !panel || !LF) return;
    const makeInput = document.getElementById("addcar-make");
    const modelInput = document.getElementById("addcar-model");
    const submitBtn = document.getElementById("addcar-submit");
    const status = document.getElementById("addcar-status");
    const urlSection = document.getElementById("addcar-url-section");
    const urlInput = document.getElementById("addcar-url");
    const useUrlBtn = document.getElementById("addcar-use-url");
    btn.hidden = !LF.serverAvailable; // adding a car is pointless without a local LLM to run the discovery flow

    function setStatus(text, kind) {
      status.textContent = text || "";
      status.classList.toggle("addcar-error", kind === "error");
      status.classList.toggle("addcar-ok", kind === "ok");
    }
    function resetForm() {
      makeInput.value = ""; modelInput.value = "";
      urlInput.value = ""; urlSection.hidden = true;
      setStatus("");
    }
    function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
    function uniqueModelId(makeLabel, modelLabel) {
      const base = "usercar-" + slug(makeLabel) + "-" + slug(modelLabel);
      let id = base, n = 2;
      while (byId.has(id)) id = base + "-" + (n++);
      return id;
    }

    // Splices the new make (if needed) and model into the live graph --
    // same incremental index-rebuild pattern as applyLlmConfirmSilent above,
    // since we're only ever ADDING nodes/links here, never retiring or
    // mutating anything that already exists.
    function mintAndOpen(makeLabel, modelLabel, wpTitle) {
      let makeNode = nodes.find(n => n.type === "make" && n.label.toLowerCase() === makeLabel.toLowerCase());
      const nodesBefore = nodes.length, linksBefore = links.length;
      if (!makeNode) {
        makeNode = { id: "usercar-make-" + slug(makeLabel), type: "make", label: makeLabel, year: null, userAdded: true };
        nodes.push(makeNode);
      }
      const modelNode = {
        id: uniqueModelId(makeLabel, modelLabel), type: "model", label: modelLabel, make: makeNode.label,
        year: null, end: null, wp: wpTitle, userAdded: true,
      };
      nodes.push(modelNode);
      links.push({ source: makeNode.id, target: modelNode.id, type: "made" });
      // Real bug report: this used to only ever live in THIS tab's in-memory
      // nodes/links -- gone without a trace on the next reload, since
      // nothing about a manually-typed car was ever recorded anywhere boot
      // could see it. Persists just enough for llm_families.js's
      // applyUserCars to recreate this exact node (same id) on every future
      // boot, before any confirmed split/relation that might target it.
      LF.registerUserCar(modelNode.id, makeLabel, modelLabel, wpTitle);

      spliceIntoIndexes(nodesBefore, linksBefore);
      refreshYearFilter();
      buildSim();
      refreshCounts();

      panel.hidden = true;
      resetForm();
      // Same "arm, then open the detail panel" sequence a real click on an
      // ordinary already-discovered car goes through -- renderLlmCheck's own
      // "if (!entry)" branch kicks off checkNode() for this brand-new node
      // exactly as if the user had just browsed to it themselves.
      setLlmCheck(true);
      Graph.gotoNode(modelNode);
    }

    async function handleSubmit() {
      const makeLabel = makeInput.value.trim(), modelLabel = modelInput.value.trim();
      if (!makeLabel || !modelLabel) { setStatus("Enter both a make and a model.", "error"); return; }
      const already = nodes.find(n => (n.type === "model" || n.type === "family") &&
        n.make && n.make.toLowerCase() === makeLabel.toLowerCase() && n.label.toLowerCase() === modelLabel.toLowerCase());
      if (already) {
        setStatus(`${makeLabel} ${modelLabel} is already in the graph — opening it instead.`, "ok");
        panel.hidden = true; resetForm();
        Graph.gotoNode(already);
        return;
      }
      submitBtn.disabled = true;
      urlSection.hidden = true;
      setStatus("Searching Wikipedia…");
      try {
        const title = await LF.findWikipediaTitleFor(makeLabel, modelLabel);
        if (title) {
          setStatus(`Found "${title}" — adding and checking…`, "ok");
          mintAndOpen(makeLabel, modelLabel, title);
        } else {
          setStatus("Couldn't find a Wikipedia page on its own — paste a link below.", "error");
          urlSection.hidden = false;
        }
      } finally {
        submitBtn.disabled = false;
      }
    }

    async function handleUseUrl() {
      const makeLabel = makeInput.value.trim(), modelLabel = modelInput.value.trim();
      const url = urlInput.value.trim();
      if (!makeLabel || !modelLabel) { setStatus("Enter both a make and a model above first.", "error"); return; }
      if (!url) return;
      const title = LF.titleFromWikipediaUrl(url);
      if (!title) { setStatus("That doesn't look like a Wikipedia article link.", "error"); return; }
      useUrlBtn.disabled = true;
      setStatus("Checking that link…");
      try {
        const ok = await LF.tryWikipediaTitle(title);
        if (!ok) { setStatus(`Couldn't load "${title}" — check the link and try again.`, "error"); return; }
        setStatus(`Using "${title}" — adding and checking…`, "ok");
        mintAndOpen(makeLabel, modelLabel, title);
      } finally {
        useUrlBtn.disabled = false;
      }
    }

    btn.onclick = () => { resetForm(); panel.hidden = !panel.hidden; };
    document.getElementById("addcar-close").onclick = () => { panel.hidden = true; };
    submitBtn.onclick = () => { handleSubmit(); };
    useUrlBtn.onclick = () => { handleUseUrl(); };
  }

  // ---------- Modify Existing Car ----------
  // Real user request: "in the 'Tools' Section there should also be a
  // 'Modify Existing Car' button which lets the user modify the wikipedia
  // link or ask for a particular request with the LLM, like potentially
  // merging multiple models together into one nameplate if it has not been
  // previously caught."
  //
  // Add Car (above) covers "this car isn't here at all"; every OTHER kind of
  // correction had no entry point whatsoever. Three things live here:
  //
  //  1. Fix the Wikipedia link. Same operation the detail panel's own link
  //     row now offers (renderWpLinkRow), reachable without having to find
  //     the car in the graph first -- and it goes through the identical
  //     setNodeWikiLink({force}) -> re-check path, so the corrected article
  //     is genuinely re-read rather than recorded and ignored.
  //  2. Merge several standalone models into one nameplate. The real gap
  //     this fills: build_family_layer.py only groups generations whose
  //     labels share a pattern AND form an unbroken succession chain, and
  //     the LLM split only fires when ONE article describes them all -- a
  //     nameplate whose generations are filed under genuinely unrelated
  //     labels falls through both with no way to say so by hand.
  //  3. Ask the LLM a free-text question about the car. Deliberately the
  //     weakest of the three: the model can answer in prose and it can
  //     SUGGEST a merge (pre-ticking boxes in 2), but it cannot perform any
  //     structural change on its own -- see llm_families.js's askModifyCar,
  //     which constrains it to returning ids from a list it was given.
  function initModifyCarPanel() {
    const LF = window.LlmFamilies;
    const btn = document.getElementById("modifycarbtn");
    const panel = document.getElementById("modifycar");
    if (!btn || !panel || !LF) return;
    const pick = document.getElementById("modifycar-pick");
    const current = document.getElementById("modifycar-current");
    const wpSection = document.getElementById("modifycar-wp-section");
    const urlInput = document.getElementById("modifycar-url");
    const useUrlBtn = document.getElementById("modifycar-use-url");
    const askSection = document.getElementById("modifycar-ask-section");
    const requestInput = document.getElementById("modifycar-request");
    const askBtn = document.getElementById("modifycar-ask");
    const answer = document.getElementById("modifycar-answer");
    const mergeSection = document.getElementById("modifycar-merge-section");
    const mergeList = document.getElementById("modifycar-merge-list");
    const mergeBtn = document.getElementById("modifycar-merge");
    const unmergeSection = document.getElementById("modifycar-unmerge-section");
    const unmergeNote = document.getElementById("modifycar-unmerge-note");
    const unmergeBtn = document.getElementById("modifycar-unmerge");
    const unmergeConfirm = document.getElementById("modifycar-unmerge-confirm");
    const unmergeCancel = document.getElementById("modifycar-unmerge-cancel");
    const status = document.getElementById("modifycar-status");
    const renameSection = document.getElementById("modifycar-rename-section");
    const nameInput = document.getElementById("modifycar-name");
    const renameBtn = document.getElementById("modifycar-rename");
    const renameNote = document.getElementById("modifycar-rename-note");
    const wpConflict = document.getElementById("modifycar-wpconflict");
    // Renaming needs no LLM at all, so this panel is now useful even with no
    // server reachable -- but a rename that can't be persisted would silently
    // revert on the next reload, so the panel says so rather than pretending.
    btn.hidden = false;

    let target = null;

    function setStatus(text, kind) {
      status.textContent = text || "";
      status.classList.toggle("addcar-error", kind === "error");
      status.classList.toggle("addcar-ok", kind === "ok");
    }
    // Merge candidates are deliberately restricted to plain, ungrouped
    // models of the SAME make. Cross-make "generations" of one nameplate
    // aren't a thing this graph models (a rebadge is a `related` link, not a
    // generation), and re-parenting a car that already belongs to another
    // family would silently tear that family apart.
    // Real bug report: "when I want to try to merge them into one nameplate,
    // for some reason I cannot find the individual generations as one of the
    // options to merge together... I look up 'honda civic', I get all of the
    // generations like 'Honda Civic (seventh generation)', I also get 'Honda
    // Civic' as a model, and I also get 'Honda Civic' as a nameplate."
    //
    // The filter was `!n.familyOf`, which excluded every generation of every
    // nameplate -- and `type === "model"`, which excluded nameplates outright.
    // So for a make whose cars are ALREADY partly grouped (the common case
    // once anything has been split), the list was almost empty and the very
    // entries the user could see in search were the ones missing from it.
    //
    // Now: plain models, OTHER nameplates (absorbed whole -- their
    // generations move across and the husk is retired), and generations
    // belonging to a DIFFERENT nameplate (re-homed). Generations already
    // under the target are shown separately, greyed, so it's obvious they're
    // in rather than mysteriously absent.
    function mergeCandidates() {
      if (!target) return { offer: [], already: [] };
      const sameMake = nodes.filter(n => !n.retired && n.id !== target.id &&
        (n.type === "model" || n.type === "family") && norm(n.make) === norm(target.make));
      const already = sameMake.filter(n => n.familyOf === target.id);
      const offer = sameMake.filter(n => n.familyOf !== target.id &&
        // Never offer a node that would swallow the target itself.
        !(n.type === "family" && (n.generations || []).includes(target.id)));
      const byYear = (a, b) => (a.year || 0) - (b.year || 0) || String(a.label).localeCompare(String(b.label));
      return { offer: offer.sort(byYear), already: already.sort(byYear) };
    }
    function norm(x) { return String(x == null ? "" : x).trim().toLowerCase(); }
    function renderCandidates(preselect) {
      const { offer, already } = mergeCandidates();
      mergeList.innerHTML = "";
      if (!offer.length && !already.length) { mergeSection.hidden = true; return; }
      mergeSection.hidden = false;
      const pre = new Set(preselect || []);
      const kindOf = c => c.type === "family" ? "nameplate" : c.familyOf ? "generation of " + ((byId.get(c.familyOf) || {}).label || "another nameplate") : "model";
      offer.forEach(c => {
        const row = document.createElement("label");
        row.className = "modifycar-cand";
        row.innerHTML = `<input type="checkbox" value="${esc(c.id)}"${pre.has(c.id) ? " checked" : ""}> ${esc(c.label)}` +
          ` <span class="verb">${esc(fmtYearRun(c.year, c.end) || "?")} · ${esc(kindOf(c))}</span>`;
        mergeList.appendChild(row);
      });
      if (already.length) {
        const head = document.createElement("div");
        head.className = "modifycar-already-head";
        head.textContent = `Already part of this nameplate (${already.length}):`;
        mergeList.appendChild(head);
        already.forEach(c => {
          const row = document.createElement("div");
          row.className = "modifycar-cand modifycar-already";
          row.innerHTML = `${esc(c.label)} <span class="verb">${esc(fmtYearRun(c.year, c.end) || "?")}</span>`;
          mergeList.appendChild(row);
        });
      }
    }
    function select(n) {
      target = n;
      pick.value = (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
      const isCar = n.type === "model" || n.type === "family";
      // Real user request: "within 'Modify existing cars', I should also be
      // able to change the name of the make, model, nameplate,
      // engineer/designer, etc..." -- so unlike the car-only sections, the
      // rename row is offered for every node type. A Wikipedia link applies
      // to a make too (see renderWpLinkRow's own note); merging and the
      // free-text car question genuinely only make sense for a car.
      const hasArticle = isCar || n.type === "make";
      renameSection.hidden = false;
      wpSection.hidden = !hasArticle;
      askSection.hidden = !isCar;
      answer.textContent = "";
      setStatus("");
      urlInput.value = "";
      nameInput.value = n.label;
      const kind = n.type === "family" ? `nameplate, ${(n.generations || []).length} generations`
        : n.type === "model" ? (n.familyOf ? "generation" : "plain model")
        : n.type === "make" ? "marque" : personRoleWord(n);
      const shownName = isCar ? `${esc(n.make)} ${esc(n.label)}` : esc(n.label);
      current.innerHTML = `<b>${shownName}</b> — ${esc(kind)}` +
        (hasArticle ? ` · Wikipedia: ${n.wp ? esc(n.wp) : "<i>none on file</i>"}` : "");
      const priorRename = (LF.allRenames() || []).find(r => r.id === n.id);
      renameNote.innerHTML = priorRename
        ? `Renamed from <b>${esc(priorRename.previousLabel)}</b>. <button type="button" class="llm-btn modifycar-revert">Revert</button>`
        : "";
      const revert = renameNote.querySelector(".modifycar-revert");
      if (revert) revert.onclick = () => {
        const res = LF.revertRename(n.id, nodes);
        if (!res.ok) return setStatus(res.error || "Couldn't revert.", "error");
        afterRename(n, "Reverted to " + n.label + ".");
      };
      if (isCar) renderCandidates(); else mergeSection.hidden = true;
      renderUnmerge(n);
      renderWpConflict(n);
    }
    // "If the LLM is unsure which to pick, then it should prompt the user and
    // have the user confirm which information to take." A merge that found two
    // different articles both claiming to BE this nameplate records the
    // conflict rather than guessing (see llm_families.js's applyOneMerge), and
    // this is where the user answers it. Deliberately NOT a modal or a toast:
    // an unanswered conflict is harmless — the nameplate simply has no article
    // of its own, and every generation still has its own correct one — so it
    // waits here until the user next looks at this car.
    function renderWpConflict(n) {
      if (!wpConflict) return;
      const conflict = (LF.pendingMergeWpConflicts ? LF.pendingMergeWpConflicts() : [])
        .find(c => c.primaryId === n.id);
      if (!conflict) { wpConflict.hidden = true; wpConflict.innerHTML = ""; return; }
      wpConflict.hidden = false;
      wpConflict.innerHTML =
        `<div class="modifycar-conflict-head">The merge found ${conflict.candidates.length} articles that each ` +
        `claim to be this nameplate, and didn't guess between them. Which one describes ` +
        `<b>${esc(n.label)}</b>?</div>`;
      conflict.candidates.forEach(wp => {
        const row = document.createElement("div");
        row.className = "modifycar-cand";
        row.innerHTML = `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(wp.replace(/ /g, "_"))}" ` +
          `target="_blank" rel="noopener">${esc(wp)} ↗</a> `;
        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "llm-btn";
        useBtn.textContent = "Use this one";
        useBtn.onclick = async () => {
          useBtn.disabled = true;
          const ok = await LF.resolveMergeWpChoice(n.id, wp, nodes);
          if (!ok) { useBtn.disabled = false; return setStatus("Couldn't record that choice.", "error"); }
          setStatus(`This nameplate now uses "${wp}".`, "ok");
          if (dtNode) openDetail(dtNode);
          select(n);                 // re-renders the header line and hides the prompt
        };
        row.appendChild(useBtn);
        wpConflict.appendChild(row);
      });
    }
    // A rename changes text every derived view reads -- the search index is
    // rebuilt per keystroke so it needs nothing, but labels are baked into
    // the canvas draw order and the open detail panel, and a MAKE rename also
    // rewrites the denormalized `make` string on all of its children.
    function afterRename(n, msg) {
      Graph.touch();
      refreshCounts();
      if (dtNode) openDetail(dtNode);
      select(n);
      setStatus(msg, "ok");
    }
    // Reuses the app's own search index/renderer, exactly like the
    // playground's pickers do.
    const results = pick.parentElement.querySelector(".llmpg-results");
    pick.addEventListener("input", () => {
      renderResults(results, searchAll(pick.value), n => { select(n); results.hidden = true; });
    });
    pick.addEventListener("blur", () => setTimeout(() => { results.hidden = true; }, 150));

    useUrlBtn.onclick = async () => {
      if (!target) return setStatus("Pick a car first.", "error");
      const url = urlInput.value.trim();
      if (!url) return;
      const title = LF.titleFromWikipediaUrl(url);
      if (!title) return setStatus("That doesn't look like a Wikipedia article link.", "error");
      useUrlBtn.disabled = true;
      setStatus("Checking that link…");
      try {
        const ok = await LF.tryWikipediaTitle(title);
        if (!ok) { setStatus(`Couldn't load "${title}" — check the link and try again.`, "error"); return; }
        await LF.setNodeWikiLink(target.id, title, nodes, { force: true });
        setStatus(`Using "${title}" — re-checking this car now.`, "ok");
        panel.hidden = true;
        Graph.gotoNode(target);        // opens the detail panel, which runs the re-check UI
      } finally {
        useUrlBtn.disabled = false;
      }
    };

    askBtn.onclick = async () => {
      if (!target) return setStatus("Pick a car first.", "error");
      const request = requestInput.value.trim();
      if (!request) return;
      askBtn.disabled = true;
      answer.textContent = "";
      setStatus("Asking the local LLM…");
      try {
        const res = await LF.askModifyCar(target, request, nodes);
        setStatus("");
        answer.innerHTML = `<b>LLM:</b> ${esc(res.answer || "(no answer)")}` +
          (res.reason ? `<br><span class="verb">${esc(res.reason)}</span>` : "");
        if (res.mergeIds && res.mergeIds.length) {
          // Suggested, never applied -- the boxes are ticked for you and the
          // Merge button is right there, but a structural change always
          // takes a deliberate click.
          renderCandidates(res.mergeIds);
          setStatus(`It suggests merging ${res.mergeIds.length} car${res.mergeIds.length === 1 ? "" : "s"} in — review the ticked boxes below, then press Merge selected.`, "ok");
        }
      } catch (e) {
        setStatus("The LLM request failed: " + (e.message || e), "error");
      } finally {
        askBtn.disabled = false;
      }
    };

    // Real user request: "I also want an 'unmerge' option just like how there
    // is a 'merge' option in the 'modify existing car' section, if the car
    // that I selected is a nameplate. This would unmerge all of the
    // generations of the car from the existing 'nameplate' of the car."
    // Only offered for a nameplate, and only ever as the exact mirror of the
    // merge above -- it takes the nameplate apart, it doesn't delete anything.
    function renderUnmerge(n) {
      if (!unmergeSection || !LF.unmergeNameplate) return;
      unmergeArm(false);
      const gens = nodes.filter(g => g.familyOf === n.id && !g.retired);
      const isNameplate = n.type === "family" || gens.length > 0;
      unmergeSection.hidden = !isNameplate;
      if (!isNameplate) return;
      const already = LF.isUnmerged && LF.isUnmerged(n.id);
      if (already) {
        unmergeNote.innerHTML = `This nameplate is already unmerged — its cars are standalone models. <button type="button" class="llm-btn modifycar-redo">Put it back together</button>`;
        const redo = unmergeNote.querySelector(".modifycar-redo");
        if (redo) redo.onclick = async () => {
          await LF.redoMerge(n.id);
          setStatus("Re-merged. Reload the page to see the nameplate rebuilt.", "ok");
        };
        if (unmergeBtn) unmergeBtn.hidden = true;
        return;
      }
      if (unmergeBtn) unmergeBtn.hidden = false;
      unmergeNote.textContent = gens.length
        ? `Splits this nameplate back into ${gens.length} standalone car${gens.length === 1 ? "" : "s"}. Each keeps its own years, links, credits and Wikipedia article — nothing is deleted. Generations that only ever existed inside this nameplate are retired.`
        : `This nameplate has no generations left; unmerging just turns it back into a plain model.`;
    }
    function unmergeArm(armed) {
      if (!unmergeBtn) return;
      unmergeBtn.hidden = armed;
      if (unmergeConfirm) unmergeConfirm.hidden = !armed;
      if (unmergeCancel) unmergeCancel.hidden = !armed;
    }
    if (unmergeBtn) unmergeBtn.onclick = () => {
      if (!target) return setStatus("Pick a car first.", "error");
      unmergeArm(true);
    };
    if (unmergeCancel) unmergeCancel.onclick = () => { unmergeArm(false); setStatus(""); };
    if (unmergeConfirm) unmergeConfirm.onclick = () => {
      if (!target) return setStatus("Pick a car first.", "error");
      const linksBefore = links.length;
      const res = LF.unmergeNameplate(target.id, nodes, links);
      unmergeArm(false);
      if (!res.ok) return setStatus(res.error || "Couldn't unmerge that.", "error");
      // No new NODES -- freeing a generation adopts nothing and mints nothing
      // -- but each freed car does gain the "made" link to its marque that it
      // previously reached only through its nameplate, so the link range still
      // has to be wired in (see applyOneUnmerge's own note).
      spliceIntoIndexes(nodes.length, linksBefore);
      backfillGenerationEnds();
      indexMirrorReplacements();
      refreshYearFilter();
      Graph.refreshFocus();
      Graph.touch();
      refreshCounts();
      if (dtNode && dtNode.retired) { dt.hidden = true; dtNode = null; Graph.clearSelection(); }
      else if (dtNode) openDetail(dtNode);
      setStatus(`Unmerged — ${res.generations} car${res.generations === 1 ? "" : "s"} ${res.generations === 1 ? "is" : "are"} standalone again.`, "ok");
      select(target);
    };

    mergeBtn.onclick = () => {
      if (!target) return setStatus("Pick a car first.", "error");
      const ids = [...mergeList.querySelectorAll("input:checked")].map(i => i.value);
      if (!ids.length) return setStatus("Tick at least one car to merge in.", "error");
      const nodesBefore = nodes.length, linksBefore = links.length;
      const res = LF.mergeModelsIntoNameplate(target.id, ids, nodes, links);
      if (!res.ok) return setStatus(res.error || "Couldn't merge those cars.", "error");
      // Same live-splice treatment every other structural mutation gets --
      // the merge adopts existing nodes in place (setting familyOf) and adds
      // generation/gensucc links plus one stand-in node for the primary
      // itself, so both the node and link ranges need wiring in.
      spliceIntoIndexes(nodesBefore, linksBefore);
      backfillGenerationEnds();
      indexMirrorReplacements();
      if (LF.pushSuccessionToGenerations) {
        const before = links.length;
        LF.pushSuccessionToGenerations(nodes, links);
        spliceIntoIndexes(nodes.length, before);
      }
      refreshYearFilter();
      buildSim();
      Graph.refreshFocus();
      Graph.touch();
      refreshCounts();
      setStatus(`Merged — ${target.make} ${target.label} is now a nameplate with ${(target.generations || []).length} generations.`, "ok");
      panel.hidden = true;
      Graph.gotoNode(target);
    };

    renameBtn.onclick = () => {
      if (!target) return setStatus("Pick something first.", "error");
      const res = LF.renameNode(target, nameInput.value, nodes);
      if (!res.ok) return setStatus(res.error || "Couldn't rename that.", "error");
      afterRename(target, `Renamed to "${target.label}".`);
    };

    btn.onclick = () => {
      panel.hidden = !panel.hidden;
      if (panel.hidden) return;
      if (!LF.serverAvailable) setStatus("No local server this session — changes here can't be saved, so they'd revert on reload.", "error");
      // Pre-select whatever the user is already looking at -- the common
      // case is "I'm staring at this thing and its name/link is wrong".
      if (dtNode && !dtNode.retired) select(dtNode);
    };
    document.getElementById("modifycar-close").onclick = () => { panel.hidden = true; };
  }

  // ---------- Delete / Restore ----------
  // Real user request: "I want to also be able to delete makes (and models,
  // nameplates, or generations, or designers/engineers) within the 'tools'
  // tab underneath the 'modify existing cars' button. This should be
  // universally deletable, meaning that even if the data comes directly from
  // dbpedia or my database, it should also be deletable, however should be
  // stored somewhere that 'hard data' (not LLM data) has been deleted, and
  // therefore should also be recoverable."
  //
  // Unlike every other panel here, this one is NOT gated on serverAvailable.
  // Two reasons: hiding a node needs no LLM, and more importantly a deletion
  // that can't be recorded to disk would silently come back on the next
  // reload, which is worse than not offering it. On a static file:// build
  // persist() no-ops, so the panel says so rather than pretending.
  //
  // Live-applies rather than reloading: llm_families.js's applyDeletions sets
  // the same `retired` flag the de-dup and override layers already use, which
  // every view in this file (nodeInLayer, linkInLayer, openDetail, searchAll,
  // refreshCounts, the year filter) already honours -- so a delete takes
  // effect on the very next frame with no index rebuild needed.
  // Real user request: a button that rebuilds data.js from scratch so the
  // snapshot shows today's date. Lives in the Delete/Restore panel, as asked.
  //
  // Deliberately NOT the same thing as the footer's live DBpedia refresh:
  // that patches newly-found cars into the graph in this browser and never
  // touches data.js, which is why its "built <date>" label never moved. This
  // asks serve.py to re-run data_src/rebuild.sh -- a real re-harvest and
  // re-bake, minutes long -- so the file itself is regenerated and re-stamped.
  //
  // Three things that shape the UI here:
  //   1. It rewrites real data files, so it takes a second click to confirm,
  //      the same discipline the delete flow next to it uses.
  //   2. It runs for minutes, so the request only STARTS it; progress comes
  //      from polling, and the script's own "-- step --" banners are what
  //      the progress line shows. Closing the panel doesn't cancel it.
  //   3. When it finishes the page must reload, because data.js is a script
  //      tag -- the running page is still holding the old graph in memory.
  // Set up by initRebuildPanel, used by the reset panel below: "wipe
  // everything and start from scratch" is the overlay reset followed by
  // exactly this rebuild, and two copies of a minutes-long poll loop is two
  // things to keep in step.
  let rebuildRunner = null;
  function initRebuildPanel() {
    const startBtn = document.getElementById("rebuild-start");
    const confirmBtn = document.getElementById("rebuild-confirm");
    const cancelBtn = document.getElementById("rebuild-cancel");
    const skip = document.getElementById("rebuild-skipharvest");
    const status = document.getElementById("rebuild-status");
    const section = document.getElementById("rebuild-section");
    if (!startBtn || !confirmBtn || !cancelBtn || !status || !section) return;

    let polling = null;
    function armed(on) {
      startBtn.hidden = on; confirmBtn.hidden = !on; cancelBtn.hidden = !on;
    }
    function busy(on) {
      startBtn.disabled = on; confirmBtn.disabled = on;
      if (skip) skip.disabled = on;
    }
    function say(msg, cls) {
      status.textContent = msg;
      status.className = "llmdebug-note" + (cls ? " " + cls : "");
    }

    startBtn.onclick = () => {
      armed(true);
      say(skip && skip.checked
        ? "This rewrites data.js using the last downloaded harvest. Continue?"
        : "This re-downloads everything and rewrites data.js. It takes a few minutes and needs internet. Continue?");
    };
    cancelBtn.onclick = () => { armed(false); say(""); };

    confirmBtn.onclick = async () => {
      armed(false); busy(true);
      say("starting…");
      let r;
      try {
        r = await fetch("/api/rebuild", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skipHarvest: !!(skip && skip.checked) }),
        });
      } catch (e) {
        busy(false);
        // The whole feature needs serve.py -- opening index.html straight from
        // disk gives you the graph but no server to run the harvest.
        return say("couldn't reach the local server. This needs `python3 app/serve.py` to be running.", "dp-error");
      }
      if (!r.ok) {
        busy(false);
        let msg = "rebuild couldn't start (HTTP " + r.status + ")";
        try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
        return say(msg, "dp-error");
      }
      poll();
    };

    function poll() { pollWith(say, busy); }
    function pollWith(say, busy) {
      clearInterval(polling);
      polling = setInterval(async () => {
        let d;
        try {
          d = await (await fetch("/api/rebuild")).json();
        } catch (e) {
          return; // a blip mid-rebuild isn't fatal -- keep polling
        }
        if (d.running) {
          const secs = d.elapsed ? " · " + Math.round(d.elapsed) + "s" : "";
          return say("rebuilding: " + (d.step || "working") + secs + " — you can leave this panel open, it keeps going");
        }
        clearInterval(polling); polling = null; busy(false);
        if (d.ok) {
          say("done in " + Math.round(d.elapsed || 0) + "s — reloading so the new data takes effect…");
          setTimeout(() => location.reload(), 1200);
        } else {
          const tail = (d.log || []).slice(-3).join(" / ");
          say("rebuild failed" + (d.returncode != null ? " (exit " + d.returncode + ")" : "") +
              (tail ? " — " + tail : "") + ". Your existing data is untouched.", "dp-error");
        }
      }, 1500);
    }

    rebuildRunner = {
      // Starts it and returns true, or reports why it could not and returns
      // false. `say` and `busy` are the caller's own, so progress lands in
      // whichever panel asked.
      async start(skipHarvest, sayTo, busyTo) {
        busyTo(true);
        sayTo("starting the rebuild…");
        let r;
        try {
          r = await fetch("/api/rebuild", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ skipHarvest: !!skipHarvest }),
          });
        } catch (e) {
          busyTo(false);
          sayTo("couldn't reach the local server. This needs `python3 app/serve.py` to be running.", "dp-error");
          return false;
        }
        if (!r.ok) {
          busyTo(false);
          let msg = "rebuild couldn't start (HTTP " + r.status + ")";
          try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
          sayTo(msg, "dp-error");
          return false;
        }
        pollWith(sayTo, busyTo);
        return true;
      },
    };

    // A rebuild started before this page load (or in another tab) is still
    // running server-side -- pick it up rather than showing an idle panel
    // that invites a second one.
    (async () => {
      try {
        const d = await (await fetch("/api/rebuild")).json();
        if (d && d.running) { busy(true); poll(); }
        else if (d && !d.scriptExists) {
          startBtn.disabled = true;
          say("data_src/rebuild.sh isn't where serve.py expects it, so this can't run.", "dp-error");
        }
      } catch (e) {
        // no server (file:// or serve.py not running) -- leave the button be;
        // clicking it gives the clearer message above.
      }
    })();
  }

  // ---------- start over ----------
  // Real user request: "add two buttons, one that wipes all the LLM stuff
  // (links, nodes, etc everything done by the llm), and a third button which
  // wipes everything and starts from scratch (no LLM stuff done, and the full
  // graph rebuilt from dbpedia)."
  //
  // Both go through serve.py's /api/llm-reset, which copies
  // app/llm_families.json into llm_layer_backups/ before emptying it -- the
  // overlay is the one half of this project that cannot be rebuilt from public
  // sources. The second button is that, then the rebuild above; it reuses that
  // panel's own runner rather than a second copy of a minutes-long poll loop.
  //
  // A reload is not optional afterwards. Both data.js and
  // llm_families_data.js are script tags, and the running page is still
  // holding every node and decision in memory -- worse, its next save would
  // write the old overlay straight back over the reset one.
  function initLlmResetPanel() {
    const status = document.getElementById("llmreset-status");
    if (!status) return;
    const say = (msg, cls) => {
      status.textContent = msg || "";
      status.className = "llmdebug-note" + (cls ? " " + cls : "");
    };
    const all = ["llmreset-start", "llmreset-confirm", "llmreset-cancel",
                 "llmwipe-start", "llmwipe-confirm", "llmwipe-cancel"]
                .map(id => document.getElementById(id));
    if (all.some(b => !b)) return;
    const [rStart, rYes, rNo, wStart, wYes, wNo] = all;
    const busy = on => all.forEach(b => { b.disabled = on; });
    // Only one of the two can be armed at a time: they differ by minutes of
    // work and a whole dataset, and two live "Yes" buttons side by side is
    // how the wrong one gets clicked.
    function arm(which) {
      rStart.hidden = which === "reset"; rYes.hidden = which !== "reset"; rNo.hidden = which !== "reset";
      wStart.hidden = which === "wipe";  wYes.hidden = which !== "wipe";  wNo.hidden = which !== "wipe";
    }
    arm(null);

    async function resetOverlay() {
      let r;
      try {
        r = await fetch("/api/llm-reset", { method: "POST",
              headers: { "Content-Type": "application/json" }, body: "{}" });
      } catch (e) {
        say("couldn't reach the local server. This needs `python3 app/serve.py` to be running.", "dp-error");
        return null;
      }
      if (!r.ok) {
        let msg = "couldn't wipe the LLM layer (HTTP " + r.status + ")";
        try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
        say(msg, "dp-error");
        return null;
      }
      let d = null;
      try { d = await r.json(); } catch (e) { d = { ok: true }; }
      return d;
    }
    const describe = d => {
      const c = (d && d.cleared) || {};
      const n = Object.keys(c).reduce((s, k) => s + c[k], 0);
      const top = Object.keys(c).sort((a, b) => c[b] - c[a]).slice(0, 3)
                        .map(k => c[k] + " " + k);
      return n ? `${n} record(s) cleared` + (top.length ? ` (${top.join(", ")}…)` : "")
               : "there was nothing recorded to clear";
    };

    rStart.onclick = () => {
      arm("reset");
      say("This clears every LLM decision — splits, relationships, engines, renames, merges, " +
          "your accepts and rejects, your deletions and the permanently-cleared list. The graph " +
          "underneath is untouched. A backup is written first. Continue?");
    };
    rNo.onclick = () => { arm(null); say(""); };
    rYes.onclick = async () => {
      arm(null); busy(true);
      say("wiping…");
      const d = await resetOverlay();
      if (!d) { busy(false); return; }
      say(describe(d) + (d.backup ? " · backed up to llm_layer_backups/" : "") +
          " — reloading…");
      setTimeout(() => location.reload(), 1400);
    };

    wStart.onclick = () => {
      arm("wipe");
      say("This clears every LLM decision AND re-harvests the whole graph from DBpedia, " +
          "rebuilding data.js from nothing. Takes a few minutes and needs internet. " +
          "A backup of the LLM layer is written first. Continue?");
    };
    wNo.onclick = () => { arm(null); say(""); };
    wYes.onclick = async () => {
      arm(null); busy(true);
      say("wiping the LLM layer…");
      const d = await resetOverlay();
      if (!d) { busy(false); return; }
      if (!rebuildRunner) {
        busy(false);
        say(describe(d) + ", but the rebuild panel isn't available — run " +
            "`bash data_src/rebuild.sh` yourself to finish.", "dp-error");
        return;
      }
      say(describe(d) + " — now rebuilding the graph from DBpedia…");
      // The rebuild's own poll reports into this panel and reloads when it is
      // done, which is also what the overlay reset needs.
      await rebuildRunner.start(false, say, busy);
    };
  }

  // Real user request: configurable hop count for suggested (transitive)
  // connections, "similar to how there's a setting for picking the number of
  // hops for the LLM to perform for the models".
  //
  // serve.py's TRANSITIVE_MAX_HOPS is the default; this writes an override
  // that's saved with the rest of the LLM data, so it survives a reload and
  // doesn't need a server restart to change. Each extra step multiplies both
  // how many suggestions appear and how far one wrong link can travel, which
  // is what the note under the control is there to say.
  function initTransitiveSetting() {
    const LF = window.LlmFamilies;
    const sel = document.getElementById("transitive-hops");
    const note = document.getElementById("transitive-hops-note");
    if (!sel || !LF || !LF.transitiveMaxHops) return;
    const describe = (n) => {
      if (!n) return "no suggestions will be made";
      const shown = (typeof LF.transitiveProposals === "function")
        ? LF.transitiveProposals(nodes, links).length : null;
      return shown === null ? "" : shown + " suggestion" + (shown === 1 ? "" : "s") + " right now";
    };
    sel.value = String(LF.transitiveMaxHops());
    if (note) note.textContent = describe(LF.transitiveMaxHops());
    sel.onchange = () => {
      const n = LF.setTransitiveMaxHops(parseInt(sel.value, 10));
      sel.value = String(n);   // reflect any clamping back to the control
      if (note) note.textContent = describe(n);
      if (typeof refreshCounts === "function") refreshCounts();
    };
  }

  function initDeletePanel() {
    const LF = window.LlmFamilies;
    const btn = document.getElementById("deletebtn");
    const panel = document.getElementById("deletepanel");
    if (!btn || !panel || !LF || !LF.deleteNode) return;
    const pick = document.getElementById("deletepanel-pick");
    const preview = document.getElementById("deletepanel-preview");
    const confirmSection = document.getElementById("deletepanel-confirm-section");
    const reason = document.getElementById("deletepanel-reason");
    const doDelete = document.getElementById("deletepanel-delete");
    const status = document.getElementById("deletepanel-status");
    const list = document.getElementById("deletepanel-list");
    const results = pick.parentElement.querySelector(".llmpg-results");

    let target = null;

    function setStatus(text, kind) {
      status.textContent = text || "";
      status.classList.toggle("addcar-error", kind === "error");
      status.classList.toggle("addcar-ok", kind === "ok");
    }
    function labelOf(n) {
      if (!n) return "";
      return (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
    }
    // Everything a delete would take with it, shown BEFORE the click rather
    // than discovered afterwards -- deleting a make takes its whole model
    // range with it, and that shouldn't be a surprise.
    function describeCascade(n) {
      // Mirrors llm_families.js's deletionCascadeIds for DISPLAY only -- the
      // authoritative set is computed there, at delete time.
      let extra = 0, what = "";
      if (n.type === "make") {
        const kids = nodes.filter(o => (o.type === "model" || o.type === "family") && !o.retired &&
          o.make && o.make.toLowerCase() === String(n.label).toLowerCase());
        const gens = kids.reduce((s, k) => s + ((k.generations || []).length), 0);
        extra = kids.length + gens;
        what = `${kids.length} car${kids.length === 1 ? "" : "s"}` + (gens ? ` and ${gens} generation${gens === 1 ? "" : "s"}` : "");
      } else if (n.type === "family") {
        const gens = (n.generations || []).length;
        extra = gens;
        what = `${gens} generation${gens === 1 ? "" : "s"}`;
      }
      return extra ? ` — this also removes its ${what}` : "";
    }
    function select(n) {
      target = n;
      pick.value = labelOf(n);
      const hard = LF.isHardData(n);
      const kind = n.type === "family" ? "nameplate" : n.type === "person" ? personRoleWord(n) : n.type;
      preview.innerHTML =
        `<b>${esc(labelOf(n))}</b> <span class="verb">${esc(kind)}</span>${esc(describeCascade(n))}<br>` +
        (hard
          ? `<span class="dp-hard">⚠ Harvested data</span> — this came from the DBpedia build or your Car Database, not from the LLM layer. It'll be recorded below as a hard-data deletion and can be restored at any time.`
          : `Created by the LLM layer.`) +
        `<br><span class="verb">This hides it and can be undone from the list below. ` +
        `Running a check that finds it again brings it back — “Clear for good” down there is what ` +
        `stops that, permanently.</span>`;
      confirmSection.hidden = false;
      setStatus("");
      reason.value = "";
    }
    pick.addEventListener("input", () => {
      // searchAll skips retired nodes, which is exactly right here: something
      // already deleted belongs in the restore list below, not in this picker.
      renderResults(results, searchAll(pick.value), n => { select(n); results.hidden = true; });
    });
    pick.addEventListener("blur", () => setTimeout(() => { results.hidden = true; }, 150));

    function afterStructuralChange() {
      // No index rebuild: a delete/restore only flips `retired`, and nothing
      // about nodes/links membership changed. Everything derived does need
      // recomputing though.
      refreshYearFilter();
      indexMirrorReplacements();
      Graph.refreshFocus();
      Graph.touch();
      refreshCounts();
      if (dtNode && dtNode.retired) { dt.hidden = true; dtNode = null; Graph.clearSelection(); }
      else if (dtNode) openDetail(dtNode);
    }

    doDelete.onclick = () => {
      if (!target) return setStatus("Pick something to delete first.", "error");
      const res = LF.deleteNode(target, nodes, links, reason.value.trim() || null);
      if (!res.ok) return setStatus(res.error || "Couldn't delete that.", "error");
      setStatus(`Deleted ${labelOf(target)}${res.removed > 1 ? ` and ${res.removed - 1} thing${res.removed - 1 === 1 ? "" : "s"} it owned` : ""}. Restorable below.`, "ok");
      afterStructuralChange();
      target = null; pick.value = ""; confirmSection.hidden = true; preview.innerHTML = "";
      refreshNewCars();
      refreshList();
    };

    // ---------- newly added cars ----------
    // Real user request: "there should be a single button to delete all newly
    // created makes and models, like a resetting of the newly added cars
    // memory... (and a dropdown where the user can select a particular make
    // and model)". The dropdown deliberately feeds the SAME confirm/reason
    // flow as the search box above rather than deleting on the spot -- picking
    // one car here is the same action as finding it by name, it's just a way
    // of finding it when you don't know what the LLM invented.
    const ncPick = document.getElementById("newcars-pick");
    const ncOne = document.getElementById("newcars-delete-one");
    const ncAll = document.getElementById("newcars-delete-all");
    const ncConfirm = document.getElementById("newcars-confirm-all");
    const ncCancel = document.getElementById("newcars-cancel-all");
    const ncStatus = document.getElementById("newcars-status");
    function ncSet(text, kind) {
      if (!ncStatus) return;
      ncStatus.textContent = text || "";
      ncStatus.classList.toggle("addcar-error", kind === "error");
      ncStatus.classList.toggle("addcar-ok", kind === "ok");
    }
    function refreshNewCars() {
      if (!ncPick || !LF.newlyAddedNodes) return;
      const list = LF.newlyAddedNodes(nodes);
      ncPick.innerHTML = "";
      if (!list.length) {
        const o = document.createElement("option");
        o.textContent = "— nothing newly added —";
        o.value = "";
        ncPick.appendChild(o);
        ncPick.disabled = true;
        if (ncOne) ncOne.disabled = true;
        if (ncAll) ncAll.disabled = true;
        return;
      }
      ncPick.disabled = false;
      if (ncOne) ncOne.disabled = false;
      if (ncAll) ncAll.disabled = false;
      list.forEach(n => {
        const o = document.createElement("option");
        o.value = n.id;
        const how = n.userAdded ? "added by hand" : "found by the LLM";
        o.textContent = `${labelOf(n)} — ${n.type === "make" ? "make" : "car"}, ${how}`;
        ncPick.appendChild(o);
      });
      if (ncAll) ncAll.textContent = `Delete all ${list.length} newly added car${list.length === 1 ? "" : "s"}…`;
    }
    if (ncOne) ncOne.onclick = () => {
      const id = ncPick && ncPick.value;
      const n = id && nodes.find(x => x.id === id);
      if (!n) return ncSet("Pick a car from the list first.", "error");
      select(n);
      ncSet(`${labelOf(n)} is ready to delete — confirm above.`, "ok");
      if (reason) reason.focus();
    };
    // Two-click confirm, same pattern as the rebuild button: this one clears
    // a whole layer of the graph at once, so it shouldn't be a single stray
    // click away.
    function ncArm(armed) {
      if (!ncAll) return;
      ncAll.hidden = armed;
      if (ncConfirm) ncConfirm.hidden = !armed;
      if (ncCancel) ncCancel.hidden = !armed;
    }
    if (ncAll) ncAll.onclick = () => {
      const list = LF.newlyAddedNodes(nodes);
      if (!list.length) return ncSet("Nothing newly added to delete.", "error");
      ncArm(true);
      ncSet(`This deletes ${list.length} car${list.length === 1 ? "" : "s"} and make${list.length === 1 ? "" : "s"} the LLM or you added, plus anything they own. It's recorded as one entry below and can be restored.`, "error");
    };
    if (ncCancel) ncCancel.onclick = () => { ncArm(false); ncSet(""); };
    if (ncConfirm) ncConfirm.onclick = () => {
      const res = LF.deleteNewCars(nodes, links, null, "reset of newly added cars");
      ncArm(false);
      if (!res.ok) return ncSet(res.error || "Couldn't delete those.", "error");
      ncSet(`Deleted ${res.removed} newly added car${res.removed === 1 ? "" : "s"}${res.total > res.removed ? ` (${res.total} nodes in total)` : ""}. Restorable below.`, "ok");
      afterStructuralChange();
      refreshNewCars();
      refreshList();
    };

    function refreshList() {
      const entries = LF.allDeletions();
      list.innerHTML = "";
      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "ucr-empty";
        empty.textContent = "Nothing deleted.";
        list.appendChild(empty);
        return;
      }
      // Hard-data deletions first and visually flagged -- that's the half the
      // request specifically asked to be "stored somewhere", since losing one
      // loses genuinely harvested data until it's put back.
      entries.sort((a, b) => (b.hard ? 1 : 0) - (a.hard ? 1 : 0) ||
        String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: "base" }));
      entries.forEach(e => {
        const row = document.createElement("div");
        row.className = "ucr-row";
        const bits = [esc(e.kind === "family" ? "nameplate" : e.kind)];
        if (e.hard) bits.push(`<span class="dp-hard">harvested data</span>`);
        if (e.cascadeIds && e.cascadeIds.length > 1) bits.push(`with ${e.cascadeIds.length - 1} owned item${e.cascadeIds.length - 1 === 1 ? "" : "s"}`);
        if (e.reason) bits.push(esc(e.reason));
        if (e.deletedAt) bits.push("deleted " + esc(new Date(e.deletedAt).toLocaleDateString()));
        row.innerHTML = `
          <div class="ucr-pair-btn" style="cursor:default">
            <span class="ucr-pair">${esc(e.label || e.id)}</span>
            <span class="ucr-meta">${bits.join(" — ")}</span>
          </div>
          <div class="ucr-actions">
            <button type="button" class="ucr-yes">↺ Restore</button>
            <button type="button" class="ucr-no dp-clear-btn">✕ Clear</button>
          </div>`;
        row.querySelector(".ucr-yes").onclick = () => {
          const res = LF.restoreNode(e.id, nodes, links);
          if (!res.ok) return setStatus(res.error || "Couldn't restore that.", "error");
          setStatus(`Restored ${e.label || e.id}.`, "ok");
          afterStructuralChange();
          refreshNewCars();
          refreshList();
        };
        // Real user request: "a 'clear' option which lets me remove the cars
        // completely, so they are still deleted but also do not appear in the
        // 'deleted so far'". Unlike everything else in this panel this one is
        // genuinely irreversible, so it asks -- once, in place, by turning
        // itself into the confirmation rather than opening a dialog.
        const clearBtn = row.querySelector(".dp-clear-btn");
        clearBtn.onclick = () => {
          if (clearBtn.dataset.armed !== "1") {
            clearBtn.dataset.armed = "1";
            clearBtn.textContent = "✕ Clear for good?";
            clearBtn.classList.add("dp-delete-btn");
            setStatus(`Clearing ${e.label || e.id} wipes it from the LLM data file and blacklists it: ` +
                      "it can't be restored, and no future check will create it again. " +
                      "Click again to confirm.", "error");
            setTimeout(() => {
              if (clearBtn.dataset.armed !== "1") return;
              clearBtn.dataset.armed = "";
              clearBtn.textContent = "✕ Clear";
              clearBtn.classList.remove("dp-delete-btn");
            }, 6000);
            return;
          }
          const res = LF.purgeDeletion(e.id, nodes, links);
          if (!res.ok) return setStatus(res.error || "Couldn't clear that.", "error");
          setStatus(`Cleared ${e.label || e.id} for good.`, "ok");
          afterStructuralChange();
          refreshNewCars();
          refreshList();
        };
        list.appendChild(row);
      });
    }

    btn.onclick = () => {
      panel.hidden = !panel.hidden;
      if (panel.hidden) return;
      refreshNewCars();
      refreshList();
      setStatus(LF.serverAvailable ? "" : "No local server this session — deletions can't be saved, so they'd come back on reload.", LF.serverAvailable ? "" : "error");
      // Pre-select whatever's open, same convenience as Modify Existing Car.
      if (dtNode && !dtNode.retired) select(dtNode); else { target = null; confirmSection.hidden = true; preview.innerHTML = ""; pick.value = ""; }
    };
    document.getElementById("deletepanel-close").onclick = () => { panel.hidden = true; };
    refreshNewCars();
    refreshList();
  }

  // ---------- consolidated tools dropdown ----------
  // Real user request: "I want all of the tools/debug features to be within
  // one dropdown as opposed to all being separate buttons." Every item keeps
  // its OWN pre-existing hidden/onclick wiring (set above in initLlmDebugPanel,
  // initLlmPlaygroundPanel, and the llmcheck/dbmatchbtn setup in boot()) --
  // this just adds the menu container's own open/close behavior on top,
  // without touching any item's individual click logic.
  // ---------- refresh generation photos (local only) ----------
  // A generation's photo is written once, into llm_families.json, at the
  // moment its family was scanned -- so an improvement to findGenerationImage
  // only reaches families scanned after it, and rebuild.sh (which regenerates
  // cars.json and never touches llm_families.json) changes nothing. This
  // re-reads the source articles and recomputes only that pointer, leaving
  // every code, year, credit and confirmation exactly where it was.
  // ---------- "the model is still working" ----------
  // Real bug report: "I must have been misled into closing the server, since I
  // no longer saw any new operations occur (and my power draw level went down
  // to a normal level, which only happens when the llm stops having something
  // to execute)."
  //
  // Both observations were true and both were misleading. A cascade check is
  // one long LLM call that writes nothing until it finishes, and the partners
  // behind it are queued, not running -- so a page with five cars still to get
  // through looks and draws exactly like a finished one. Stopping serve.py
  // there throws away calls already paid for, and the car that was mid-check
  // is left as a plain model with no record that anything was ever started for
  // it. That is how the Renault Captur ended up with no entry at all.
  //
  // llm_families.js already knows the answer (pendingWork -- what is in
  // flight, what is queued behind it, what is waiting on an article lookup);
  // this just puts it on screen for as long as it is non-empty, and names the
  // cars so the wait is legible rather than a spinner. Polled rather than
  // pushed: the queue advances inside promise chains all over that file, and a
  // second's lag on a minutes-long wait costs nothing next to threading a
  // notification through every one of them.
  let llmBusyTimer = null;
  function initLlmBusy() {
    const box = document.getElementById("llmbusy");
    const text = document.getElementById("llmbusy-text");
    if (!box || !text) return;
    if (llmBusyTimer) clearInterval(llmBusyTimer);
    const LF = window.LlmFamilies;
    if (!LF || !LF.pendingWork) return;   // older build, nothing to report
    function name(id) {
      const n = byId.get(id);
      return n ? ((n.make ? n.make + " " : "") + n.label) : id;
    }
    function tick() {
      let p;
      try { p = LF.pendingWork(); } catch (e) { return; }
      if (!p || !p.total) { box.hidden = true; return; }
      // p.running is the queue's current job where that is not already one of
      // the in-flight checks -- an engine read or a generation research pass
      // makes no checkNode call and so appears in neither `checks` nor
      // `partners`, and used to leave this box blank for its whole duration.
      const running = [...p.checks, ...(p.running || [])].map(name);
      const asked = (p.queued || []).map(name);
      const queued = p.partners.length + p.lookups.length + asked.length;
      // The distinction is the useful part: something IS being worked on right
      // now, and separately there are N more behind it. A bare total reads as
      // a progress bar with no end.
      const head = running.length
        ? "checking " + running.slice(0, 2).join(", ") +
          (running.length > 2 ? ` +${running.length - 2}` : "")
        : "starting the next check";
      text.textContent = head +
        (queued ? ` — ${queued} more queued` : "") +
        (asked.length ? ` (${asked.length} you asked for)` : "");
      box.title = "Still working on: " +
        [...running, ...p.partners.map(name), ...p.lookups.map(name), ...asked].join(", ") +
        ". Don't stop serve.py yet — a check that is cut off is lost.";
      box.hidden = false;
    }
    tick();
    // Fast enough that the label keeps up with a cascade moving from one car
    // to the next, cheap enough to be irrelevant: two array reads and a string
    // compare against a graph that is already in memory.
    llmBusyTimer = setInterval(tick, 400);
  }

  function initGenPhotos() {
    const trigger = document.getElementById("genphotosbtn");
    const panel = document.getElementById("genphotos-panel");
    if (!trigger || !panel) return;
    const closeBtn = document.getElementById("genphotos-close");
    const allEl = document.getElementById("genphotos-all");
    const runBtn = document.getElementById("genphotos-run");
    const statusEl = document.getElementById("genphotos-status");
    const say = (m, cls) => { statusEl.textContent = m || ""; statusEl.className = "lrq-status" + (cls ? " " + cls : ""); };
    // Every item in this menu ships hidden and is revealed by its own init.
    // Writing the result back needs serve.py, so this one follows the same
    // rule as the rest of the menu: local only.
    trigger.hidden = !(window.LlmFamilies && window.LlmFamilies.serverAvailable);
    if (trigger.hidden) return;

    function positionPanel() {
      const r = trigger.getBoundingClientRect();
      panel.style.top = (r.bottom + 6) + "px";
      panel.style.left = "auto";
      panel.style.right = Math.max(0, window.innerWidth - r.right) + "px";
    }
    function open() { positionPanel(); panel.hidden = false; say(""); }
    function close() { panel.hidden = true; }

    // The graph node for a generation, from the family entry it belongs to.
    // Two id spellings exist in the wild -- applyConfirmed strips a trailing
    // hyphen off the slug and applyFamilyOverride does not -- so both are
    // tried before falling back to the minted label, which is always
    // "<family label> <code>".
    function genNodeFor(familyId, code) {
      const slug = String(code).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const n = byId.get("llm-" + familyId + "-" + slug.replace(/-+$/, "")) ||
                byId.get("llm-" + familyId + "-" + slug);
      if (n) return n;
      const want = String(code).toLowerCase().trim();
      return nodes.find(x => x.familyOf === familyId && !x.retired &&
                             String(x.label || "").toLowerCase().endsWith(want)) || null;
    }

    runBtn.onclick = async () => {
      const LF = window.LlmFamilies;
      if (!LF || !LF.serverAvailable) return say("No local server this session — there'd be nothing to save to.", "err");
      runBtn.disabled = true;
      allEl.disabled = true;
      say("Reading articles…");
      let res;
      try {
        res = await LF.refreshGenerationImages({
          all: !!allEl.checked,
          onProgress: ({ title, done, total }) => say(`Reading ${title} (${done + 1} of ${total})…`),
        });
      } catch (e) {
        runBtn.disabled = false; allEl.disabled = false;
        return say("Couldn't finish: " + ((e && e.message) || e), "err");
      }
      runBtn.disabled = false;
      allEl.disabled = false;

      // The stored records are updated; the drawn nodes are not, and
      // genPhotoUrl reads the node. Without this the new photos would only
      // appear after a reload.
      let applied = 0, orphaned = 0;
      (res.updates || []).forEach(u => {
        const n = genNodeFor(u.familyId, u.code);
        if (!n) { orphaned++; return; }
        n.wikiFile = u.wikiFile;
        applied++;
      });
      if (applied) { Graph.touch(); if (dtNode) openDetail(dtNode); }

      const bits = [];
      if (res.filled) bits.push(res.filled + " generation" + (res.filled === 1 ? "" : "s") + " that had no photo now has one");
      if (res.replaced) bits.push(res.replaced + " swapped for a better match");
      if (res.stillNone) bits.push(res.stillNone + " still has none in the article");
      if (res.unchanged) bits.push(res.unchanged + " unchanged");
      let msg = res.scanned
        ? "Read " + res.families + " article" + (res.families === 1 ? "" : "s") + ": " + bits.join(", ") + "."
        : "Nothing to do — every scanned generation already has a photo.";
      if (orphaned) msg += " " + orphaned + " updated record" + (orphaned === 1 ? " has" : "s have") +
                          " no node drawn right now; they'll show on the next reload.";
      if (res.failed && res.failed.length) {
        msg += " " + res.failed.length + " article" + (res.failed.length === 1 ? "" : "s") +
               " couldn't be read (" + res.failed.slice(0, 3).map(f => f.title).join(", ") + ").";
      }
      say(msg, res.failed && res.failed.length ? "err" : "ok");
    };

    trigger.addEventListener("click", e => { e.stopPropagation(); if (panel.hidden) open(); else close(); });
    closeBtn.onclick = close;
    document.addEventListener("click", e => {
      if (e.target !== trigger && !panel.contains(e.target)) close();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) close(); });
    window.addEventListener("resize", () => { if (!panel.hidden) positionPanel(); });
  }

  // ---------- reload when the data changes, and come back to the same place ----
  // Real user request: "if the user scans a specific car and it gets updated
  // with a push, can the webpage refresh and then resume in the exact same
  // focus as it was before the page refresh, to essentially show the newly
  // changed graph?"
  //
  // Two halves. Noticing: the graph ships inside data.js, so a HEAD request
  // for that file and a look at its ETag says whether the deploy underneath
  // this tab has moved on -- no build step, no version file, and a few bytes
  // a minute. Coming back: what is restored is the FOCUS, not a pixel-exact
  // camera. goto() re-frames the same car with the same rules the app already
  // uses, which is what "the same place" means to someone looking at it, and
  // it stays right even though the layout underneath has genuinely changed --
  // which it has, since that is the whole reason for the reload.
  //
  // Hosted only. With serve.py running you are the one changing the data, and
  // a page that reloads itself mid-edit would be a menace.
  const VIEW_STATE_KEY = "carweb_view_state_v1";
  const VIEW_STATE_MAX_AGE_MS = 15 * 60 * 1000;

  function saveViewState() {
    try {
      const st = Graph.state();
      sessionStorage.setItem(VIEW_STATE_KEY, JSON.stringify({
        at: Date.now(),
        view: activeView,
        layer: layer,
        year: [yearLo, yearHi],
        expanded: [...expandedFamilies],
        focus: st.focusRoot ? st.focusRoot.id : null,
        detail: dtNode ? dtNode.id : null,
      }));
    } catch (e) {}   // private mode, full quota -- losing the position is not worth throwing over
  }

  function restoreViewState() {
    let st = null;
    try {
      st = JSON.parse(sessionStorage.getItem(VIEW_STATE_KEY) || "null");
      sessionStorage.removeItem(VIEW_STATE_KEY);   // one use: a later manual reload starts fresh
    } catch (e) { return; }
    if (!st || !st.at || Date.now() - st.at > VIEW_STATE_MAX_AGE_MS) return;

    if (st.layer && st.layer !== layer) setLayer(st.layer);
    if (Array.isArray(st.year) && st.year.length === 2) setYearRange(st.year[0], st.year[1]);
    if (st.view && st.view !== activeView) switchView(st.view);
    // A family that was expanded may not exist any more -- the scan that
    // triggered this reload can have merged or renamed it -- so every id here
    // is checked rather than trusted.
    (st.expanded || []).forEach(id => { if (byId.get(id)) expandFamily(id); });
    const focus = st.focus && byId.get(st.focus);
    const detail = st.detail && byId.get(st.detail);
    if (focus && !focus.retired) Graph.gotoNode(focus);
    else if (detail && !detail.retired) Graph.gotoNode(detail);
    if (detail && !detail.retired) openDetail(detail);
  }

  function initAutoRefresh() {
    if (window.LlmFamilies && window.LlmFamilies.serverAvailable) return;
    let stamp = null, checking = false, lastInput = Date.now();
    const seen = () => { lastInput = Date.now(); };
    ["pointerdown", "keydown", "wheel", "touchstart"].forEach(ev =>
      window.addEventListener(ev, seen, { passive: true }));
    window.addEventListener("beforeunload", saveViewState);

    async function stampOf() {
      try {
        const r = await fetch("data.js", { method: "HEAD", cache: "no-store" });
        return r.headers.get("etag") || r.headers.get("last-modified") || null;
      } catch (e) { return null; }
    }

    async function check() {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const now = await stampOf();
        if (!now) return;
        if (stamp === null) { stamp = now; return; }
        if (now === stamp) return;
        // Don't yank the page out from under someone mid-gesture; the next
        // tick will catch it a minute later.
        if (Date.now() - lastInput < 8000) return;
        saveViewState();
        location.reload();
      } finally { checking = false; }
    }

    check();
    setInterval(check, 60000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
  }

  // ---------- request-a-scan (hosted site only) ----------
  // Real user request: "the user should be able to request a scan after they
  // have focused on a particular model or nameplate in the graph. If the user
  // clicks 'request scan' then the user should be prompted to select a
  // particular car on the graph, or search the name and model of the car."
  //
  // So a request names ONE CAR. It is prefilled from whatever is open or
  // focused, because that is where you are standing when you decide you want
  // something looked at, and the box searches the graph the same way the main
  // search box does when it is not.
  //
  // The button cannot call the machine -- it has no public address and is
  // usually asleep -- so this leaves a job in a Cloudflare Worker and the
  // agent on that machine polls for it. Every state shown here is therefore a
  // record of what the agent last reported, never a live view of it. See
  // src/worker.js and docs/REQUEST-QUEUE.md.
  //
  // Shown only when there is NO local server: with serve.py running you are
  // sitting at the machine and run the pass yourself from the Tools menu.
  const LRQ_POLL_MS = 20000;
  function initLlmRequest() {
    const wrap = document.getElementById("llmrequest-wrap");
    const trigger = document.getElementById("llmrequest-btn");
    const panel = document.getElementById("llmrequest-panel");
    if (!wrap || !trigger || !panel) return;
    if (window.LlmFamilies && window.LlmFamilies.serverAvailable) { wrap.hidden = true; return; }
    wrap.hidden = false;

    const dot = document.getElementById("llmrequest-dot");
    const closeBtn = document.getElementById("llmrequest-close");
    const carEl = document.getElementById("llmrequest-car");
    const resultsEl = document.getElementById("llmrequest-carresults");
    const chosenEl = document.getElementById("llmrequest-chosen");
    const passEl = document.getElementById("llmrequest-pass");
    const sendBtn = document.getElementById("llmrequest-send");
    const statusEl = document.getElementById("llmrequest-status");
    const queueEl = document.getElementById("llmrequest-queue");
    let poll = null, chosen = null;

    const say = (msg, cls) => { statusEl.textContent = msg || ""; statusEl.className = "lrq-status" + (cls ? " " + cls : ""); };
    const ago = iso => {
      const ms = Date.now() - Date.parse(iso);
      if (!isFinite(ms)) return "";
      const m = Math.round(ms / 60000);
      if (m < 1) return "just now";
      if (m < 60) return m + " min ago";
      const h = Math.round(m / 60);
      return h < 48 ? h + "h ago" : Math.round(h / 24) + " days ago";
    };
    const carName = n => (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;

    // Only a nameplate or a model can hide generations -- a make or a person
    // has nothing for this check to read. Mirrors LlmFamilies.isEligible /
    // isEligibleForRecheck without duplicating their finer rules: the Worker
    // takes the id, and the agent re-checks eligibility against the real
    // graph when it runs.
    // Engines included, per "including for engines": the agent knows how to
    // read an engine's article (see scripts/llm_agent.py), and this is now the
    // only way to ask for one from the web.
    const scannable = n => !!n && !n.retired &&
      (n.type === "model" || n.type === "family" || n.type === "engine");
    const kindOf = n => n && n.type === "family" ? "nameplate"
                      : n && n.type === "engine" ? "engine" : "model";

    function setChosen(n) {
      chosen = scannable(n) ? n : null;
      if (chosen) {
        chosenEl.hidden = false;
        chosenEl.innerHTML = `<span class="k">${kindOf(chosen)}</span>` +
          `<span>${esc(carName(chosen))}</span><button title="clear">✕</button>`;
        chosenEl.querySelector("button").onclick = () => { setChosen(null); carEl.focus(); };
        carEl.value = "";
      } else {
        chosenEl.hidden = true;
        chosenEl.innerHTML = "";
      }
      resultsEl.hidden = true;
      refreshSendState();
    }

    function renderCarResults(q) {
      const hits = (CarWeb.searchAll(q) || []).filter(scannable).slice(0, 8);
      if (!hits.length) { resultsEl.hidden = true; resultsEl.innerHTML = ""; return; }
      resultsEl.innerHTML = "";
      hits.forEach(n => {
        const b = document.createElement("button");
        b.className = "lrq-result";
        b.innerHTML = `<span class="t">${kindOf(n)}</span>` +
          `<span>${esc(carName(n))}</span><span class="y">${n.year || ""}</span>`;
        b.onclick = () => setChosen(n);
        resultsEl.appendChild(b);
      });
      resultsEl.hidden = false;
    }

    function refreshSendState() {
      const queued = !!(lastStatus && (lastStatus.queue || []).some(j => j.targetId === (chosen && chosen.id)));
      sendBtn.disabled = !chosen || queued;
      sendBtn.textContent = !chosen ? "Pick a car or engine first"
                          : (queued ? "Already requested" : "Send request");
    }

    let lastStatus = null;
    function render(d) {
      lastStatus = d && d.ok ? d : null;
      if (!d || !d.ok) {
        if (d && d.error === "queue-unconfigured") {
          say("The queue isn't set up on this deploy yet — see docs/REQUEST-QUEUE.md.", "err");
        }
        dot.hidden = true;
        queueEl.innerHTML = "";
        refreshSendState();
        return;
      }
      const q = d.queue || (d.pending ? [d.pending] : []);
      dot.hidden = !q.length;

      if (q.length) {
        queueEl.innerHTML = `<h5>waiting (${q.length})</h5><ol>` + q.map(j =>
          `<li${j.state === "running" ? ' class="run"' : ""}>` +
          `<span>${esc(j.targetLabel || j.targetId)}` +
          `${j.state === "running" ? " — running now" : " — " + ago(j.queuedAt)}</span>` +
          // A request is a suggestion, so it has to be withdrawable. Not on
          // the one being scanned: the agent is mid-pass on it and its own
          // /done is what closes it out.
          (j.state === "running" ? "" :
            `<button class="lrq-drop" data-id="${esc(j.id)}" title="remove this request">✕</button>`) +
          `</li>`).join("") + "</ol>";
        queueEl.querySelectorAll(".lrq-drop").forEach(b => { b.onclick = () => drop(b.dataset.id); });
      } else {
        queueEl.innerHTML = "";
      }

      const last = d.last;
      if (q.some(j => j.state === "running")) {
        say("The machine is working through the queue now.", "ok");
      } else if (q.length) {
        say("Waiting for the machine to wake up.", "ok");
      } else if (last && last.state === "done") {
        say(`Last run (${last.targetLabel || "a car"}) finished ${ago(last.finishedAt)}` +
            (last.summary ? " — " + last.summary : "") + ".");
      } else if (last) {
        say(`Last run (${last.targetLabel || "a car"}) failed ${ago(last.finishedAt)}` +
            (last.summary ? " — " + last.summary : "") + ".", "err");
      } else {
        say("");
      }
      refreshSendState();
    }

    async function refresh() {
      try {
        const r = await fetch("/api/request/status", { cache: "no-store" });
        render(await r.json());
      } catch (e) {
        dot.hidden = true;
      }
    }

    async function drop(id) {
      if (!passEl.value) { say("Enter the passphrase to remove a request.", "err"); passEl.focus(); return; }
      say("Removing…");
      try {
        const r = await fetch("/api/request/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passphrase: passEl.value, id }),
        });
        const d = await r.json();
        if (d && d.error === "bad-passphrase") return say("That passphrase isn't right.", "err");
        if (!r.ok || !d || !d.ok) return say(d && d.message ? d.message : "Couldn't remove that.", "err");
        render(d);
        say("Removed.", "ok");
      } catch (e) {
        say("Couldn't reach the queue.", "err");
      }
    }

    // Same fixed-position trick #toolsmenu uses, and for the same reason:
    // #topbar clips anything that extends below its own box.
    function positionPanel() {
      const r = trigger.getBoundingClientRect();
      panel.style.top = (r.bottom + 6) + "px";
      panel.style.left = "auto";
      panel.style.right = Math.max(0, window.innerWidth - r.right) + "px";
    }

    function openPanel() {
      positionPanel();
      panel.hidden = false;
      trigger.classList.add("open");
      // Prefilled from where the user actually is: the open card first, then
      // whatever the graph is focused on.
      if (!chosen) {
        const focus = graphFocusRoot();
        setChosen(dtNode && scannable(dtNode) ? dtNode : focus);
      }
      refresh();
      if (!poll) poll = setInterval(refresh, LRQ_POLL_MS);
      (chosen ? passEl : carEl).focus();
    }
    function closePanel() {
      panel.hidden = true;
      trigger.classList.remove("open");
      resultsEl.hidden = true;
      if (poll) { clearInterval(poll); poll = null; }
    }

    function graphFocusRoot() {
      const set = Graph.state().focusSet;
      if (!set || !set.size) return null;
      for (const id of set) {
        const n = byId.get(id);
        if (scannable(n)) return n;
      }
      return null;
    }

    sendBtn.onclick = async () => {
      if (!chosen) { say("Pick a car first.", "err"); carEl.focus(); return; }
      if (!passEl.value) { say("Enter the passphrase first.", "err"); passEl.focus(); return; }
      sendBtn.disabled = true;
      say("Sending…");
      try {
        const r = await fetch("/api/request/queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            passphrase: passEl.value,
            targetId: chosen.id,
            targetLabel: carName(chosen),
          }),
        });
        const d = await r.json();
        if (d && d.error === "bad-passphrase") { say("That passphrase isn't right.", "err"); refreshSendState(); return; }
        if (!r.ok || !d || !d.ok) {
          say(d && d.message ? d.message : "The queue didn't accept that (" + r.status + ").", "err");
          refreshSendState();
          return;
        }
        passEl.value = "";
        render(d);
        say(d.already ? `${carName(chosen)} was already in the queue.`
                      : `${carName(chosen)} is queued.`, "ok");
      } catch (e) {
        say("Couldn't reach the queue.", "err");
        refreshSendState();
      }
    };

    carEl.addEventListener("input", () => {
      if (chosen) setChosen(null);
      const q = carEl.value.trim();
      if (q.length < 2) { resultsEl.hidden = true; return; }
      renderCarResults(q);
    });
    carEl.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const first = resultsEl.querySelector(".lrq-result");
        if (first) { e.preventDefault(); first.click(); }
      }
    });

    trigger.onclick = (e) => { e.stopPropagation(); if (panel.hidden) openPanel(); else closePanel(); };
    closeBtn.onclick = closePanel;
    passEl.addEventListener("keydown", e => { if (e.key === "Enter") sendBtn.click(); });
    document.addEventListener("click", e => { if (!wrap.contains(e.target) && !panel.contains(e.target)) closePanel(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) closePanel(); });
    window.addEventListener("resize", () => { if (!panel.hidden) positionPanel(); });
    wrap.closest("#topbar")?.addEventListener("scroll", closePanel);

    // Opening a car while the panel is up retargets the request, so clicking
    // around the graph and then asking for "this one" works without going
    // back to the text box.
    onDetailOpen(n => { if (!panel.hidden && scannable(n)) setChosen(n); });

    // One check at boot so the dot can show something is queued without the
    // panel ever being opened.
    refresh();
  }


  // ---------- the local scan queue panel ----------
  // Real user request: "I want there to also be a queuing system everywhere,
  // including serve.py, for if I want to request several different models to
  // be checked and I want to request to scan them while others are already
  // currently being scanned."
  //
  // The local twin of "Request scan" above. Same shell and the same .lrq-*
  // styles on purpose -- what differs is only where the request goes: the
  // hosted panel leaves a job in a Worker for a machine that is asleep, this
  // one hands it to the queue in llm_families.js, which this page runs itself.
  // No passphrase, because this panel only appears when serve.py is answering
  // and that means you are the one at the keyboard.
  let refreshQueueUi = () => {};
  function initLlmQueuePanel() {
    const trigger = document.getElementById("llmqueuebtn");
    const panel = document.getElementById("llmqueue-panel");
    const LF = window.LlmFamilies;
    if (!trigger || !panel || !LF || !LF.enqueueJob) return;
    // Every item in the Tools menu ships hidden and is revealed by its own
    // init; this one needs the server, like every other write control.
    if (!LF.serverAvailable) return;
    trigger.hidden = false;

    const dot = document.getElementById("llmqueue-dot");
    const closeBtn = document.getElementById("llmqueue-close");
    const carEl = document.getElementById("llmqueue-car");
    const resultsEl = document.getElementById("llmqueue-carresults");
    const chosenEl = document.getElementById("llmqueue-chosen");
    const addBtn = document.getElementById("llmqueue-add");
    const clearBtn = document.getElementById("llmqueue-clear");
    const statusEl = document.getElementById("llmqueue-status");
    const listEl = document.getElementById("llmqueue-list");
    let chosen = null;

    const say = (m, cls) => { statusEl.textContent = m || ""; statusEl.className = "lrq-status" + (cls ? " " + cls : ""); };
    const carName = n => (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
    // Exactly what llmJobSpecFor will accept, asked the same way: a make has
    // no pass of its own and a person has nothing to read.
    const scannable = n => !!n && !n.retired && !!llmJobSpecFor(n);
    const kindOf = n => n && n.type === "family" ? "nameplate"
                      : n && n.type === "engine" ? "engine" : "model";
    const ago = iso => {
      const ms = Date.now() - Date.parse(iso);
      if (!isFinite(ms)) return "";
      const m = Math.round(ms / 60000);
      if (m < 1) return "just now";
      if (m < 60) return m + " min ago";
      const h = Math.round(m / 60);
      return h < 48 ? h + "h ago" : Math.round(h / 24) + " days ago";
    };

    function setChosen(n) {
      chosen = scannable(n) ? n : null;
      if (chosen) {
        chosenEl.hidden = false;
        chosenEl.innerHTML = `<span class="k">${kindOf(chosen)}</span>` +
          `<span>${esc(carName(chosen))}</span><button title="clear">✕</button>`;
        chosenEl.querySelector("button").onclick = () => { setChosen(null); carEl.focus(); };
        carEl.value = "";
      } else {
        chosenEl.hidden = true;
        chosenEl.innerHTML = "";
      }
      resultsEl.hidden = true;
      refreshAddState();
    }
    function renderCarResults(q) {
      const hits = (searchAll(q) || []).filter(scannable).slice(0, 8);
      if (!hits.length) { resultsEl.hidden = true; resultsEl.innerHTML = ""; return; }
      resultsEl.innerHTML = "";
      hits.forEach(n => {
        const b = document.createElement("button");
        b.className = "lrq-result";
        b.innerHTML = `<span class="t">${kindOf(n)}</span>` +
          `<span>${esc(carName(n))}</span><span class="y">${n.year || ""}</span>`;
        b.onclick = () => setChosen(n);
        resultsEl.appendChild(b);
      });
      resultsEl.hidden = false;
    }
    function refreshAddState() {
      const spec = chosen ? llmJobSpecFor(chosen) : null;
      const queued = spec && LF.jobFor(spec.targetId, spec.kind);
      addBtn.disabled = !spec || !!queued;
      addBtn.textContent = !spec ? "Pick one first"
                         : queued ? "Already in the queue" : "Add to the queue";
    }

    // Called on every queue change, whether this panel is open or not: the
    // dot on the Tools menu is how you see there is still work outstanding
    // without opening anything.
    refreshQueueUi = function () {
      const list = LF.jobs();
      const waiting = list.filter(j => j.state !== "running");
      if (dot) dot.hidden = !list.length;
      if (panel.hidden) return;
      if (list.length) {
        listEl.innerHTML = `<h5>in the queue (${list.length})</h5><ol>` + list.map(j =>
          `<li${j.state === "running" ? ' class="run"' : ""}>` +
          `<span>${esc(j.label)} — ${esc(LF.jobDescription(j))}` +
          `${j.state === "running" ? " — running now" : " — added " + ago(j.queuedAt)}</span>` +
          // Not the one being worked on: its pass is mid-flight, and a check
          // that is cut off is lost.
          (j.state === "running" ? "" :
            `<button class="lrq-drop" data-id="${esc(j.id)}" title="remove this request">✕</button>`) +
          `</li>`).join("") + "</ol>";
        listEl.querySelectorAll(".lrq-drop").forEach(b => {
          b.onclick = () => {
            const r = LF.cancelJob(b.dataset.id);
            say(r && r.ok ? "Removed." : "That one is already running.", r && r.ok ? "ok" : "err");
          };
        });
      } else {
        listEl.innerHTML = "";
      }
      clearBtn.disabled = !waiting.length;
      const running = LF.runningJob();
      const last = LF.lastJob ? LF.lastJob() : null;
      if (running) {
        say(`Working on ${running.label} now` + (waiting.length ? ` — ${waiting.length} behind it.` : "."), "ok");
      } else if (waiting.length) {
        say(`${waiting.length} waiting — starting the next one.`, "ok");
      } else if (last) {
        say(`Nothing waiting. Last was ${last.label}, ${ago(last.finishedAt)}` +
            (last.state === "error" ? ` — it failed: ${last.summary}` : "") + ".",
            last.state === "error" ? "err" : "");
      } else {
        say("Nothing in the queue.");
      }
      refreshAddState();
    };

    // Real bug report: "the 'scan queue' button doesn't work on serve.py."
    // It did work -- it opened the panel 800 pixels down the page, off the
    // bottom of the screen, which looks exactly like a button that does
    // nothing. Every other panel here anchors to a button in the top bar;
    // this one anchored to its own trigger, which is an item partway down
    // the Tools dropdown. So it anchors to the Tools BUTTON instead, and is
    // clamped to the viewport either way, because the dropdown can be long
    // enough to put any item near the bottom of a laptop screen.
    function positionPanel() {
      const anchor = document.getElementById("toolsmenu-btn") || trigger;
      const r = anchor.getBoundingClientRect();
      panel.style.left = "auto";
      panel.style.right = Math.max(0, window.innerWidth - r.right) + "px";
      panel.style.top = (r.bottom + 6) + "px";
      // Measured after it is on screen: a hidden element has no height.
      // maxHeight (with overflow-y:auto in the stylesheet) is what keeps a
      // long queue reachable rather than running off the bottom.
      panel.style.maxHeight = Math.max(160, window.innerHeight - (r.bottom + 6) - 12) + "px";
    }
    function openPanel() {
      panel.hidden = false;
      const menu = document.getElementById("toolsmenu");
      if (menu) menu.hidden = true;
      positionPanel();
      if (!chosen) setChosen(dtNode && scannable(dtNode) ? dtNode : null);
      refreshQueueUi();
      (chosen ? addBtn : carEl).focus();
    }
    function closePanel() {
      panel.hidden = true;
      resultsEl.hidden = true;
    }

    addBtn.onclick = () => {
      const spec = chosen ? llmJobSpecFor(chosen) : null;
      if (!spec) { say("Pick a car, nameplate or engine first.", "err"); carEl.focus(); return; }
      const res = LF.enqueueJob(spec);
      if (res && res.error === "queue-full") {
        say(`The queue is full (${res.limit} waiting). Let some of it run first.`, "err");
        return;
      }
      say(res && res.duplicate ? `${carName(chosen)} was already in the queue.`
                               : `${carName(chosen)} added.`, "ok");
      setChosen(null);
      carEl.focus();
    };
    clearBtn.onclick = () => {
      const r = LF.clearWaitingJobs();
      say(r && r.dropped ? `Removed ${r.dropped} waiting request(s).` : "Nothing was waiting.", "ok");
    };
    carEl.addEventListener("input", () => {
      if (chosen) setChosen(null);
      const q = carEl.value.trim();
      if (q.length < 2) { resultsEl.hidden = true; return; }
      renderCarResults(q);
    });
    carEl.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const first = resultsEl.querySelector(".lrq-result");
        if (first) { e.preventDefault(); first.click(); }
      }
    });
    trigger.onclick = (e) => { e.stopPropagation(); if (panel.hidden) openPanel(); else closePanel(); };
    closeBtn.onclick = closePanel;
    // The same outside-click close every other panel here has.
    document.addEventListener("click", e => {
      if (!panel.hidden && e.target !== trigger && !panel.contains(e.target)) closePanel();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) closePanel(); });
    window.addEventListener("resize", () => { if (!panel.hidden) positionPanel(); });
    // Opening a car while the panel is up retargets it, so clicking around
    // the graph and then adding "this one" works without the text box.
    onDetailOpen(n => { if (!panel.hidden && scannable(n)) setChosen(n); });
    refreshQueueUi();
  }

  // ---------- phone layout: the wordmark is the menu ----------
  // Real user request: "the UI for the mobile version is still a bit
  // cluttered... At the top left, there should be the title 'The Car Web'. I
  // want this to also act as a clickable icon, which then presents a dropdown
  // to the user. Within this dropdown, there should be the page selection,
  // followed by the people selection, followed by the shared platforms
  // toggle, followed by the year range selection (it should live here now),
  // followed by the 'Request Scan' button... At the top right, there should be
  // space now for the search bar."
  //
  // The controls are MOVED, not copied. A second year slider or a second set
  // of view tabs would be two things to keep in step, and every one of these
  // already has its handlers wired by the time this runs -- appendChild keeps
  // them, so nothing has to be re-bound and there is still exactly one of
  // each in the page. Their original position is recorded so a window that
  // grows past the breakpoint (a rotated tablet, a resized desktop window)
  // puts them straight back.
  //
  // Driven by the same 720px breakpoint the stylesheet uses, read through
  // matchMedia rather than duplicated as a number here.
  const PHONE_MQ = "(max-width:720px)";
  function initPhoneNav() {
    const trigger = document.getElementById("navmenu-btn");
    const menu = document.getElementById("navmenu");
    const header = document.getElementById("topbar");
    const searchWrap = document.getElementById("searchbar-fixed");
    if (!trigger || !menu || !header) return;
    // In the order asked for.
    const MOVES = ["viewtabs", "layertoggle", "platformsonly", "yearfilter", "llmrequest-wrap"];
    const home = new Map();   // id -> [parent, nextSibling] as the page shipped it
    [...MOVES, "searchbar-fixed"].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.parentElement) home.set(id, [el.parentElement, el.nextSibling]);
    });

    function toPhone() {
      MOVES.forEach(id => { const el = document.getElementById(id); if (el) menu.appendChild(el); });
      // The search goes to the top right of the header, which on a phone is
      // the only thing left in it besides the title.
      if (searchWrap) header.appendChild(searchWrap);
      document.body.classList.add("phone-nav");
    }
    function toWide() {
      closeMenu();
      [...MOVES, "searchbar-fixed"].forEach(id => {
        const el = document.getElementById(id), at = home.get(id);
        if (el && at && at[0]) at[0].insertBefore(el, at[1] && at[1].parentElement === at[0] ? at[1] : null);
      });
      document.body.classList.remove("phone-nav");
    }

    function positionMenu() {
      const r = trigger.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + "px";
      menu.style.left = Math.max(6, r.left) + "px";
    }
    function closeMenu() {
      menu.hidden = true;
      trigger.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
    }
    function openMenu() {
      positionMenu();
      menu.hidden = false;
      trigger.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
    }
    trigger.onclick = (e) => {
      e.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    };
    // Same convention as the Tools dropdown: a click outside both closes it,
    // but a click on a control INSIDE it must not -- picking a year or a
    // people layer is something you do several of in a row.
    document.addEventListener("click", (e) => {
      if (menu.hidden) return;
      if (menu.contains(e.target) || trigger.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
    // Switching view is the one thing in here that replaces what you are
    // looking at, so it closes the menu behind itself.
    menu.addEventListener("click", (e) => {
      if (e.target && e.target.classList && e.target.classList.contains("tab")) closeMenu();
    });
    window.addEventListener("resize", () => { if (!menu.hidden) positionMenu(); });

    const mq = window.matchMedia ? window.matchMedia(PHONE_MQ) : null;
    const sync = () => { if (mq && mq.matches) toPhone(); else toWide(); };
    sync();
    if (mq && mq.addEventListener) mq.addEventListener("change", sync);
  }

  // ---------- phone layout: the legend folds away ----------
  // Open by default so the colours are explained on a first visit, then
  // remembered -- once you know what a dashed line means, reclaiming that
  // strip of canvas on every load is the point of the button.
  function initLegendToggle() {
    const btn = document.getElementById("legendtoggle");
    const legend = document.getElementById("legend");
    if (!btn || !legend) return;
    const KEY = "cw-legend-open";
    let open = true;
    try { if (localStorage.getItem(KEY) === "0") open = false; } catch (e) {}
    function apply() {
      legend.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.classList.toggle("open", open);
      btn.textContent = open ? "key ▴" : "key ▾";
      // The camera measures the legend (legendReserveY), so a fold changes
      // where the middle of the visible area is -- tell it to look again.
      Graph.touch();
    }
    btn.onclick = () => {
      open = !open;
      try { localStorage.setItem(KEY, open ? "1" : "0"); } catch (e) {}
      apply();
    };
    const mq = window.matchMedia ? window.matchMedia(PHONE_MQ) : null;
    const sync = () => {
      const phone = !!(mq && mq.matches);
      btn.hidden = !phone;
      // A wide screen shows the legend as one strip that costs nothing, so it
      // is always open there whatever the remembered phone setting.
      legend.hidden = phone ? !open : false;
      if (phone) apply();
      else Graph.touch();
    };
    sync();
    if (mq && mq.addEventListener) mq.addEventListener("change", sync);
  }

  function initToolsMenu() {
    const wrap = document.getElementById("toolsmenu-wrap");
    const trigger = document.getElementById("toolsmenu-btn");
    const menu = document.getElementById("toolsmenu");
    if (!wrap || !trigger || !menu) return;
    const items = [...menu.querySelectorAll(".toolsmenu-item")];

    // Real user report: "the tools bar is appearing behind the main
    // viewfinder window." #topbar sets overflow-y:hidden so it can scroll
    // horizontally without also gaining a vertical scrollbar (see its own
    // CSS comment) -- but that clips ANY descendant that visually extends
    // below the header's box, including this dropdown, regardless of its
    // z-index. #toolsmenu is now position:fixed in styles.css specifically
    // to escape that clipping (a fixed box's containing block is the
    // viewport, not #topbar), which means its on-screen position has to be
    // computed here in viewport coordinates rather than anchored via plain
    // CSS (which only worked for position:absolute, relative to
    // #toolsmenu-wrap). Recomputed every time it opens, and on resize while
    // it's open, so it always tracks the trigger button correctly.
    function positionMenu() {
      const r = trigger.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + "px";
      menu.style.left = "auto";
      menu.style.right = Math.max(0, window.innerWidth - r.right) + "px";
    }
    function closeMenu() {
      menu.hidden = true;
      trigger.classList.remove("open");
    }
    function openMenu() {
      positionMenu();
      menu.hidden = false;
      trigger.classList.add("open");
    }
    trigger.onclick = (e) => {
      e.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    };
    // Close on any click landing outside both the trigger AND the panel --
    // the standard dropdown convention, and needed since these tools (LLM
    // Debug, Playground, LLM Check's own relation-check boxes) all live on
    // the same page the user keeps clicking around in. #toolsmenu is no
    // longer a DOM descendant of #toolsmenu-wrap (see index.html's comment
    // on why it moved to a top-level sibling), so both have to be checked
    // separately here.
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target) && !menu.contains(e.target)) closeMenu(); });
    // The trigger button can itself move (window resize, or the user
    // scrolling #topbar's own horizontal scrollbar while the menu is open)
    // -- keep a fixed-position menu glued to it, or just close it rather
    // than leaving it floating over the wrong spot.
    window.addEventListener("resize", () => { if (!menu.hidden) positionMenu(); });
    wrap.closest("#topbar")?.addEventListener("scroll", closeMenu);
    // Every item still runs its own pre-existing onclick (toggle a panel,
    // flip a filter, navigate to db_match.html, etc.) -- this just ALSO
    // closes the menu afterward, same as any standard app menu, without
    // replacing or wrapping those handlers.
    items.forEach((it) => it.addEventListener("click", closeMenu));
    // If a server-availability/DB-match condition has hidden every single
    // item (e.g. no llama.cpp server running AND no Car Database folder set
    // up), hide the trigger itself too -- an empty "Tools" dropdown that
    // opens onto nothing is just confusing, not a real affordance.
    function refreshTriggerVisibility() {
      wrap.hidden = items.every((it) => it.hidden);
    }
    refreshTriggerVisibility();
    // Item visibility can still change later (LLM server coming up async,
    // My Database folder detected after boot) -- a lightweight observer
    // keeps the trigger's own visibility in sync without every call site
    // that flips an item's `hidden` needing to remember to also call this.
    items.forEach((it) => {
      new MutationObserver(refreshTriggerVisibility).observe(it, { attributes: true, attributeFilter: ["hidden"] });
    });
  }

  // ---------- search index ----------
  function searchAll(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    const scored = [];
    for (const n of nodes) {
      if (n.retired) continue;  // superseded by a nameplate generation-list override, see nodeInLayer
      if (isPerson(n) && !nodeInLayer(n)) continue;  // respect the designer/engineer layer toggle only
      const hay = ((n.type === "model" || n.type === "family") ? n.make + " " + n.label : n.label).toLowerCase();
      const extra = ((n.type === "model" || n.type === "family")
        ? ((n.designers || []).join(" ") + " " + (n.engineers || []).join(" ")).toLowerCase() : "");
      let s = -1;
      if (hay.startsWith(q)) s = 0;
      else if (hay.includes(q)) s = 1;
      else if (extra.includes(q)) s = 2;
      if (s >= 0) scored.push([s, n.deg, n]);
    }
    scored.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    return scored.slice(0, 12).map(x => x[2]);
  }
  function renderResults(el, items, onpick) {
    el.innerHTML = "";
    if (!items.length) { el.hidden = true; return; }
    items.forEach(n => {
      const d = document.createElement("div");
      d.className = "sr-item";
      const chip = n.type === "person" ? personRoleWord(n).replace(" & ", "+") : (n.type === "family" ? "nameplate" : n.type);
      d.innerHTML = `<span class="sr-type ${n.type}">${chip}</span>
        <span class="sr-label">${(n.type === "model" || n.type === "family") ? n.make + " " + n.label : n.label}</span>
        <span class="sr-sub">${(n.type === "model" || n.type === "family") ? n.year : (n.country || "")}</span>`;
      d.onmousedown = e => { e.preventDefault(); onpick(n); };
      el.appendChild(d);
    });
    el.hidden = false;
  }
  const searchInput = document.getElementById("search");
  const searchResults = document.getElementById("searchresults");
  // Real user request: "once I enter a car or select a car from the search
  // bar, that the keyboard automatically goes away."
  //
  // A phone keyboard stays up for as long as the input has focus, and picking
  // a result does not by itself take focus away -- the result row calls
  // preventDefault on mousedown precisely so the input KEEPS focus long
  // enough for the click to land. So it has to be given up explicitly, and at
  // the one moment it is certainly finished with: a car has been chosen and
  // the camera is flying to it, behind half a screen of keyboard.
  //
  // Unconditional rather than width-gated: on a desktop, blurring an input
  // you have just finished using is invisible, and a media query here would
  // be a second, quietly-drifting definition of "is this a phone".
  function dismissSearch() {
    searchResults.hidden = true;
    if (typeof searchInput.blur === "function") searchInput.blur();
  }
  searchInput.addEventListener("input", () => renderResults(searchResults, searchAll(searchInput.value), n => {
    searchInput.value = (n.type === "model" || n.type === "family") ? `${n.make} ${n.label}` : n.label;
    dismissSearch();
    api.goto(n.id);
  }));
  searchInput.addEventListener("blur", () => setTimeout(() => searchResults.hidden = true, 150));
  searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { const r = searchAll(searchInput.value); if (r.length) { dismissSearch(); api.goto(r[0].id); } }
    if (e.key === "Escape") dismissSearch();
  });

  // ---------- Graph-only year-range filter ----------
  // Scoped to the Graph view specifically (not Timeline, which already has
  // its own complete year-scrubbing UX, and not Six Degrees, which needs
  // full connectivity regardless of era to trace a path). Declutters the
  // default view and speeds up first paint by only drawing what's actually
  // in the selected year range, rather than every one of ~5,100 models at
  // once. A model/family is "in range" if its own [year, end] OVERLAPS the
  // filter's [lo, hi] — a 1980-2000 run stays visible even with lo=1990
  // (it was still being made partway into the range); "end" missing (still
  // in production) counts as extending indefinitely. This applies per-node,
  // not per-nameplate: a collapsed family is checked against its own
  // aggregate span, but once expanded, EACH generation is checked against
  // its own individual span — so an early generation entirely before the
  // lower bound drops out even while a later sibling generation stays.
  const YEAR_NODES = nodes.filter(n => (n.type === "model" || n.type === "family") && n.year != null);
  const DATA_MIN_YEAR = YEAR_NODES.length ? Math.min(...YEAR_NODES.map(n => n.year)) : 1900;
  const DATA_MAX_YEAR = YEAR_NODES.length ? Math.max(...YEAR_NODES.map(n => n.year)) : new Date().getFullYear();
  // Real user request: "for the default year range, it should initially
  // include all years. Make sure this is true for all versions (computer
  // version or mobile version)."
  //
  // It opened at 2000 to keep the first paint light, which meant the graph
  // silently withheld most of itself until you noticed the slider and dragged
  // it -- a filter nobody asked for, presented as the whole dataset.
  //
  // Everything, then, on a first visit; and after that whatever range was last
  // set, so a deliberate choice survives a reload instead of being re-widened
  // every time. Stored per browser, guarded because localStorage throws in
  // private mode, and clamped to the data's own span in case a rebuild moved
  // the bounds under a remembered value.
  const YEAR_RANGE_KEY = "cw-year-range";
  let yearLo = DATA_MIN_YEAR, yearHi = DATA_MAX_YEAR;
  try {
    const saved = (localStorage.getItem(YEAR_RANGE_KEY) || "").split(",").map(Number);
    if (saved.length === 2 && saved.every(Number.isFinite) && saved[0] <= saved[1]) {
      yearLo = Math.max(DATA_MIN_YEAR, Math.min(saved[0], DATA_MAX_YEAR));
      yearHi = Math.min(DATA_MAX_YEAR, Math.max(saved[1], yearLo));
    }
  } catch (e) { /* private mode -- the full range is the right default anyway */ }
  let yearFilterSet = null; // Set of currently-in-range node ids; recomputed on slider change
  const yearFilterListeners = [];

  function modelInYearRange(n) {
    if (n.year == null) return true; // no year data -- don't hide it on a guess
    const end = n.end == null ? Infinity : n.end;
    return n.year <= yearHi && end >= yearLo;
  }
  function computeYearFilterSet() {
    const set = new Set();
    for (const n of nodes) {
      if ((n.type === "model" || n.type === "family") && modelInYearRange(n)) set.add(n.id);
    }
    for (const n of nodes) {
      if (n.type === "make" || n.type === "person") {
        const has = adj.get(n.id).some(({ n: o, l }) =>
          (o.type === "model" || o.type === "family") && set.has(o.id) && linkInLayer(l));
        if (has) set.add(n.id);
      }
    }
    return set;
  }
  function refreshYearFilter() {
    yearFilterSet = computeYearFilterSet();
    yearFilterListeners.forEach(f => f());
  }
  function passesYearFilter(n) {
    if (n.type !== "model" && n.type !== "family" && n.type !== "make" && n.type !== "person") return true;
    return !yearFilterSet || yearFilterSet.has(n.id);
  }
  // Real bug report: "If I place both the start and end date to be at the end
  // (or at the start of time), then I cannot actually move them back again,
  // presumably because one overlaps the other and i cannot access the correct
  // one." Exactly that: two range inputs stacked on one track, both thumbs on
  // the same pixel, and only the one on top can be grabbed -- so the range was
  // stuck at a single year with no way out but clearing the stored setting.
  // Kept a year apart here rather than in the slider's own handlers, so every
  // caller is covered: the handlers, ensureYearVisible, and a value restored
  // from localStorage that was already collapsed before this existed.
  function setYearRange(lo, hi) {
    lo = Math.max(DATA_MIN_YEAR, Math.min(lo, hi));
    hi = Math.min(DATA_MAX_YEAR, Math.max(lo, hi));
    if (hi <= lo && DATA_MAX_YEAR > DATA_MIN_YEAR) {
      // Push the one that has room. At the very end of the range that has to
      // be the low thumb, and at the very start the high one.
      if (hi < DATA_MAX_YEAR) hi = lo + 1; else lo = hi - 1;
    }
    if (lo === yearLo && hi === yearHi) return;
    yearLo = lo; yearHi = hi;
    // Remembered so a deliberate range survives a reload -- see YEAR_RANGE_KEY.
    try { localStorage.setItem(YEAR_RANGE_KEY, yearLo + "," + yearHi); } catch (e) {}
    refreshYearFilter();
  }
  // Explicit navigation (search, a connection link, Six Degrees) shouldn't
  // be silently blocked by whatever the slider happens to be set to right
  // now -- widen the range just enough to include the target instead.
  function ensureYearVisible(n) {
    if (n.type !== "model" && n.type !== "family") return;
    if (n.year == null || modelInYearRange(n)) return;
    const end = n.end == null ? n.year : n.end;
    setYearRange(Math.min(yearLo, n.year), Math.max(yearHi, end));
  }
  refreshYearFilter(); // seed the initial 2000-present set before first paint

  // ---------- layout ----------
  // Positions are precomputed at build time (layout.mjs) and shipped in the data.
  // Nodes added by a live refresh get seeded near their make; the sim only runs
  // short local reheats when focusing, never a full 7k-node layout in the page.
  function seedNewNode(n) {
    if (n.x !== undefined) return;
    const near = (adj.get(n.id) || []).map(a => a.n).filter(m => m.x !== undefined);
    if (near.length) {
      n.x = near.reduce((s, m) => s + m.x, 0) / near.length + (Math.random() - .5) * 90;
      n.y = near.reduce((s, m) => s + m.y, 0) / near.length + (Math.random() - .5) * 90;
    } else { n.x = (Math.random() - .5) * 900; n.y = (Math.random() - .5) * 900; }
  }

  function radius(n) {
    if (n.type === "make") return Math.min(9 + n.deg * 0.18, 26);
    if (n.type === "person") return Math.min(4.5 + n.deg * 0.5, 13);
    // An engine is its layer's hub, the way a make is the main layer's, so it
    // is sized on the same curve -- see the draw branch for the colour.
    if (n.type === "engine") return Math.min(9 + n.deg * 0.18, 26);
    if (n.type === "family") return 4.4 + Math.min(n.deg, 10) * 0.6;
    return 3.6 + Math.min(n.deg, 8) * 0.55;
  }
  nodes.forEach(n => n.r = radius(n));

  let sim;
  // The layout's own parameters, named so a local relax (see the Graph's
  // relaxLocally) settles a patch of the graph by exactly the same rules the
  // whole-graph simulation uses.
  function simLinkDistance(l) {
    return l.type === "made" ? 60 : (l.type === "designed" || l.type === "engineered") ? 110
         : (l.type === "succession" || l.type === "gensucc") ? 34 : 46;
  }
  function simLinkStrength(l) {
    return l.type === "made" ? 0.55 : (l.type === "designed" || l.type === "engineered") ? 0.08
         : (l.type === "succession" || l.type === "gensucc") ? 0.5 : 0.35;
  }
  function simChargeStrength(d) {
    return d.type === "make" ? -900 : d.type === "person" ? -160 : -46;
  }
  function buildSim() {
    // d3's link force resolves every endpoint up front and THROWS on one it
    // cannot find, which unwinds out of here and leaves no usable simulation
    // at all -- one malformed entry anywhere in the array and the canvas is
    // dead, silently, because the render loop catches its own exceptions and
    // just skips the frame. That is how a single bad connection from the old
    // DBpedia live layer froze the whole graph. Drop those instead, and say so.
    const unresolvable = [];
    for (let i = links.length - 1; i >= 0; i--) {
      const l = links[i];
      const s0 = l && (typeof l.source === "string" ? l.source : l.source && l.source.id);
      const t0 = l && (typeof l.target === "string" ? l.target : l.target && l.target.id);
      // A powertrain edge is not this simulation's business and is never
      // handed to it, so it cannot be the malformed entry this guard exists
      // for -- and deleting one would quietly empty the Powertrain view. Its
      // endpoints are also not guaranteed to be in byId at this moment: an
      // engine recorded mid-session is indexed by recordEnginesLive a step
      // later, and being early is not a reason to destroy it.
      if (l && POWERTRAIN_LINKS.has(l.type)) continue;
      if (!l || !byId.get(s0) || !byId.get(t0)) { unresolvable.push(l); links.splice(i, 1); }
    }
    if (unresolvable.length) {
      console.warn(`CarWeb: dropped ${unresolvable.length} link(s) the graph has no endpoint for`,
                   unresolvable.slice(0, 5));
    }
    // The powertrain layer is kept out of the physics as well as out of the
    // drawing. An engine node is invisible either way, but a simulated one
    // still pushes cars around and every fitted edge still pulls two of them
    // together -- which would move the main graph's layout, and "the main
    // graph is untouched" has to mean the positions too, not just what is
    // drawn. Filtered here rather than in the forces, so nothing downstream
    // has to know.
    // In the powertrain layer it is the main graph that sits out instead --
    // same reasoning in reverse, so each layer's positions are its own and
    // neither pushes the other around.
    const simNodes = isPowerMode()
      ? nodes.filter(n => isPowertrain(n) || powerSimCars().has(n.id))
      : nodes.filter(n => !isPowertrain(n));
    // Both endpoints have to be nodes this simulation actually holds. A
    // fitted edge can legitimately name a car that is not in the graph -- the
    // article listed it and nothing minted it -- and the prune above
    // deliberately spares powertrain edges, so they are filtered here
    // instead. d3's link force resolves endpoints up front and a missing one
    // is a hard "node not found" that leaves no usable simulation at all.
    const simIds = new Set(simNodes.map(n => n.id));
    const simLinks = isPowerMode()
      ? links.filter(l => POWERTRAIN_LINKS.has(l.type) &&
          simIds.has(typeof l.source === "string" ? l.source : l.source && l.source.id) &&
          simIds.has(typeof l.target === "string" ? l.target : l.target && l.target.id))
      : links.filter(l => !POWERTRAIN_LINKS.has(l.type));
    // Seeded here rather than over every node: a node the simulation does not
    // hold has no position to seed, and seedNewNode reads its neighbours out
    // of adj, which a powertrain node has no business being in.
    simNodes.forEach(seedNewNode);
    sim = d3.forceSimulation(simNodes)
      .force("link", d3.forceLink(simLinks).id(d => d.id)
        .distance(simLinkDistance).strength(simLinkStrength))
      .force("charge", d3.forceManyBody()
        .strength(simChargeStrength).theta(0.95).distanceMax(1400))
      .force("collide", d3.forceCollide(d => d.r + 2.5).iterations(1))
      .force("x", d3.forceX(0).strength(0.018))
      .force("y", d3.forceY(0).strength(0.026))
      // Keeps an expanded nameplate's bubble empty -- see ringClearanceForce.
      // A no-op (one Set size check) whenever nothing is expanded, which is
      // the overwhelmingly common case.
      .force("ringclear", ringClearanceForce)
      .stop();
    if (DATA.meta.layout !== "precomputed") { for (let i = 0; i < 300; i++) sim.tick(); }
  }

  // ---------- graph view ----------
  const Graph = (function () {
    const canvas = document.getElementById("graphcanvas");
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, DPR = 1;
    let t = d3.zoomIdentity;
    let hoverN = null, selected = null;
    let focusSet = null, focusRoot = null;
    let dirty = true, simActive = 0;

    // ---------- settling one patch of the graph, not all of it ----------
    // Real user report, same overnight graph: every click stuttered. Each
    // focus reheated the WHOLE simulation for 26 frames, each zoom-level
    // change for 40, and one whole-graph step on 12,224 nodes measured about
    // 150 ms -- four to six seconds of a frozen canvas, most of it spent
    // moving nodes nobody could see.
    //
    // A relax now runs a small simulation over the patch that is actually
    // changing -- what is on screen, or the focused set and the area around
    // it -- by the layout's own rules (simLinkDistance and friends). It works
    // on stand-ins and copies positions back, so it never touches the main
    // simulation's own bookkeeping: d3 indexes every node it holds, and a
    // second simulation over the same objects would renumber them under it.
    // Nodes on the patch's outer edge and neighbours just outside it are held
    // still, so the patch settles against its surroundings instead of
    // drifting apart from them. Too big a patch (zoomed right out) and it is
    // skipped: at that scale nobody can see what a relax would change.
    const LOCAL_MAX = 1500;
    let localSim = null, localLeft = 0, localPairs = null, localRefs = null, localBoost = 1;
    let lastRelax = null;   // for the suite
    function relaxLocally(rect, ids, nticks, alpha) {
      if (!sim) return false;
      const pool = sim.nodes();
      const inside = n => rect && n.x >= rect[0] && n.x <= rect[2] && n.y >= rect[1] && n.y <= rect[3];
      const want = new Set();
      for (const n of pool) {
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        if ((ids && ids.has(n.id)) || inside(n)) want.add(n);
      }
      if (!want.size || want.size > LOCAL_MAX) { lastRelax = { skipped: true, size: want.size }; return false; }
      // The outer 15% of the rectangle is the frame: present, pushing and
      // pulling, but not moving.
      let inner = null;
      if (rect) {
        const px = (rect[2] - rect[0]) * 0.15, py = (rect[3] - rect[1]) * 0.15;
        inner = [rect[0] + px, rect[1] + py, rect[2] - px, rect[3] - py];
      }
      const held = n => (n.fx != null || n.fy != null) ||
        (inner && !(ids && ids.has(n.id)) &&
         (n.x < inner[0] || n.x > inner[2] || n.y < inner[1] || n.y > inner[3]));
      const proxy = new Map();
      const mk = (n, fixed) => {
        let p = proxy.get(n);
        if (p) return p;
        p = { id: n.id, type: n.type, r: n.r, x: n.x, y: n.y, vx: 0, vy: 0, ref: n, fixed };
        if (fixed) { p.fx = n.fx != null ? n.fx : n.x; p.fy = n.fy != null ? n.fy : n.y; }
        proxy.set(n, p);
        return p;
      };
      want.forEach(n => mk(n, held(n)));
      const plinks = [];
      const lf = sim.force("link");
      for (const l of (lf ? lf.links() : [])) {
        const a = l.source, b = l.target;
        if (!a || !b || typeof a !== "object" || typeof b !== "object") continue;
        const ina = want.has(a), inb = want.has(b);
        if (!ina && !inb) continue;
        // A neighbour just outside still pulls -- held where it is.
        if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) continue;
        plinks.push({ source: mk(a, !ina || held(a)), target: mk(b, !inb || held(b)), type: l.type });
      }
      const pnodes = [...proxy.values()];
      localSim = d3.forceSimulation(pnodes).stop().alpha(alpha)
        .force("link", d3.forceLink(plinks).distance(simLinkDistance).strength(simLinkStrength))
        .force("charge", d3.forceManyBody().strength(simChargeStrength).theta(0.95).distanceMax(1400))
        .force("collide", d3.forceCollide(d => (d.r + 2.5) * localBoost).iterations(1));
      localPairs = pnodes.filter(p => !p.fixed);
      localRefs = localPairs.map(p => p.ref);
      localLeft = nticks;
      simActive = 0;   // never both at once: they would fight over the same positions
      lastRelax = { skipped: false, size: want.size, moving: localPairs.length, total: pnodes.length };
      dirty = true;
      return true;
    }
    function localTick() {
      localSim.tick();
      for (const p of localPairs) { p.ref.x = p.x; p.ref.y = p.y; }
      // The bubble around an expanded nameplate still has to stay clear; its
      // rule works on the real nodes, so run it there and read back.
      ringClearanceOver(localRefs);
      for (const p of localPairs) { p.x = p.ref.x; p.y = p.ref.y; }
      if (--localLeft <= 0) { localSim = null; localPairs = null; localRefs = null; }
    }

    // Real user report: zooming in is just a camera move, so two nodes that
    // happen to sit nearly on top of each other in the precomputed layout
    // stay just as jammed together at any zoom level -- there's no way to
    // actually separate them by looking closer. Nudge the physics itself:
    // every time the zoom level crosses into a new "band" (roughly each
    // doubling of scale), briefly widen the collision force's radius and
    // let the simulation relax for a couple dozen ticks, so genuinely
    // overlapping nodes push apart from each other as you zoom in -- and
    // relax back down again as you zoom back out. Only fires on an actual
    // scale change (not a plain pan), and is debounced so a fast series of
    // wheel events doesn't trigger a reheat on every single one.
    let spacingBand = 0, spacingTimer = null;
    function spacingBandFor(k) { return Math.max(0, Math.round(Math.log2(Math.max(k, 0.05)) + 2)); }
    function applySpacing(band) {
      spacingBand = band;
      const boost = 1 + Math.min(band, 5) * 0.35;
      localBoost = boost;
      // Kept on the main simulation too, so anything that runs it later
      // respects the same spacing -- set, not run.
      sim.force("collide", d3.forceCollide(d => (d.r + 2.5) * boost).iterations(1));
      relaxLocally(viewRect(0), null, 40, 0.12);
      dirty = true;
    }
    const K_MIN = 0.22, K_MAX = 9; // must match the scaleExtent below
    const zoom = d3.zoom().scaleExtent([K_MIN, K_MAX])
      .filter(e => !e.button)
      .on("zoom", e => {
        t = e.transform; dirty = true;
        const band = spacingBandFor(t.k);
        if (band !== spacingBand) {
          clearTimeout(spacingTimer);
          spacingTimer = setTimeout(() => applySpacing(band), 220);
        }
        syncZoomSlider();
      });

    // Real user request: a visible zoom slider (bottom-right corner),
    // alongside the existing wheel/pinch/double-click zoom gestures.
    // d3.zoom's own transform, however it changed (slider drag, +/-
    // buttons, wheel, fitAll/flyToSet), always flows back through the
    // "zoom" handler above, so syncZoomSlider() there is the one place that
    // keeps the slider's thumb position honest no matter what moved it.
    let zoomSliderEl = null;
    function kToSliderVal(k) { return Math.round(100 * Math.log(k / K_MIN) / Math.log(K_MAX / K_MIN)); }
    function sliderValToK(v) { return K_MIN * Math.pow(K_MAX / K_MIN, v / 100); }
    function syncZoomSlider() {
      if (!zoomSliderEl) return;
      const v = String(kToSliderVal(t.k));
      if (zoomSliderEl.value !== v) zoomSliderEl.value = v;
    }
    function zoomTo(k, animMs) {
      k = Math.max(K_MIN, Math.min(K_MAX, k));
      const sel = d3.select(canvas);
      if (animMs) sel.transition().duration(animMs).call(zoom.scaleTo, k, [W / 2, H / 2]);
      else sel.call(zoom.scaleTo, k, [W / 2, H / 2]);
    }
    function initZoomSlider() {
      zoomSliderEl = document.getElementById("zoomslider");
      const inBtn = document.getElementById("zoomslider-in"), outBtn = document.getElementById("zoomslider-out");
      if (zoomSliderEl) {
        zoomSliderEl.addEventListener("input", () => zoomTo(sliderValToK(+zoomSliderEl.value)));
        syncZoomSlider();
      }
      if (inBtn) inBtn.onclick = () => zoomTo(t.k * 1.5, 200);
      if (outBtn) outBtn.onclick = () => zoomTo(t.k / 1.5, 200);
    }

    function resize() {
      const r = canvas.parentElement.getBoundingClientRect();
      W = r.width; H = r.height; DPR = window.devicePixelRatio || 1;
      canvas.width = W * DPR; canvas.height = H * DPR;
      dirty = true;
    }

    // Real user request: "when focusing on a group of cars that are
    // related, remember that the info card comes up on the right side. I
    // would like that the viewable window is actually represented by the
    // area where the info card isn't... a tiny bit to the left of the left
    // edge of the info card." #detail is 308px wide, sitting 18px from the
    // right edge (styles.css) -- reserve that plus a little breathing room
    // whenever it's actually open, and treat the remaining LEFT region as
    // the whole viewport for both fitAll and flyToSet's own centering math.
    //
    // Second real user report, from a phone: "when I search for a particular
    // car, it zooms into it as it's supposed to but it's not within the view
    // of the available knowledge graph window. Oftentimes it is behind the
    // info card for the car I searched for, out of view." Same principle,
    // wrong axis. Below 720px the detail panel is not a right-anchored card
    // at all -- it is a bottom SHEET spanning the full width (see styles.css)
    // -- so reserving 346px of WIDTH for it both narrowed the camera for no
    // reason and parked the result underneath the sheet every time.
    //
    // Which axis to reserve is decided by measuring the panel, not by
    // matching the breakpoint: a panel as wide as the canvas is a sheet and
    // takes height, anything narrower is a card and takes width. One source
    // of truth, so the CSS and this can never disagree about where the panel
    // is.
    function panelBox() {
      if (!dt || dt.hidden) return null;
      const r = dt.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { r, p: canvas.parentElement.getBoundingClientRect() };
    }
    function panelIsSheet() {
      const b = panelBox();
      return !!b && b.r.width >= b.p.width - 12;
    }
    function panelReserve() {
      const b = panelBox();
      return b && !panelIsSheet() ? 346 : 0;
    }
    function panelReserveY() {
      const b = panelBox();
      if (!b || !panelIsSheet()) return 0;
      // How much of the canvas the sheet actually covers, plus a little
      // breathing room, capped so a nearly full-height sheet still leaves a
      // usable strip instead of collapsing the camera onto a sliver.
      return Math.min(Math.max(0, b.p.bottom - b.r.top) + 12, H * 0.72);
    }
    // What the legend covers at the TOP of the canvas. Real user request, for
    // the collapsible phone legend: "if it is closed, then there is now more
    // screen space for the knowledge graph. This should be considered when
    // determining where the 'center' of the viewable image is, so that when
    // searching for a car or selecting it, the main car being focused is in
    // the correct part of the viewable window."
    //
    // The detail sheet already did this from the bottom (panelReserveY). The
    // legend is the mirror image and had no equivalent, so a car focused with
    // the legend open landed under it. Measured rather than assumed, for the
    // same reason the sheet is: an open legend, a closed one and no legend at
    // all are three different heights, and whichever it is right now is the
    // one the camera has to aim around.
    //
    // Scoped to the phone layout (body.phone-nav, set by initPhoneNav). On a
    // wide screen the legend is a short strip in the top-left corner with the
    // whole canvas around it -- reserving a band across the full width for it
    // would push the camera down for no reason, and nobody asked for the
    // desktop centre to move. The phone legend is a full-width bar that
    // genuinely covers the top of the graph, which is the case this is for.
    function legendReserveY() {
      if (!document.body.classList.contains("phone-nav")) return 0;
      const lg = document.getElementById("legend");
      if (!lg || lg.hidden) return 0;
      const r = lg.getBoundingClientRect();
      if (!r.height) return 0;
      const p = canvas.parentElement.getBoundingClientRect();
      return Math.min(Math.max(0, r.bottom - p.top) + 10, H * 0.5);
    }
    function viewCenterX() { return Math.max(60, (W - panelReserve()) / 2); }
    // Centre of the band actually left visible: the legend eats into the top,
    // the detail sheet into the bottom. Averaging the two edges is what puts
    // the focused car in the middle of what you can SEE rather than the middle
    // of the canvas.
    function viewCenterY() {
      const top = legendReserveY(), bottom = panelReserveY();
      return Math.max(60, top + (H - top - bottom) / 2);
    }
    function fitAll(animate) {
      // Over the nodes actually ON SCREEN, not the whole array. Real user
      // report about the Powertrain tab: "there should be an auto scaling
      // where the camera initially is scaled down to fit all of the engines
      // that it can, rather than start out super zoomed out." The extent was
      // taken over every node in the graph, so switching to a layer holding
      // forty of them still framed the other six thousand -- and in the main
      // layer, an engine left wherever the powertrain simulation had put it
      // stretched that extent for nothing.
      let shown = nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y) && inGraphView(n));
      if (!shown.length) shown = nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y));
      if (!shown.length) return;
      const xs = d3.extent(shown, n => n.x), ys = d3.extent(shown, n => n.y);
      const k = Math.min((W - panelReserve()) / (xs[1] - xs[0] + 200),
                         (H - panelReserveY() - legendReserveY()) / (ys[1] - ys[0] + 200));
      const tf = d3.zoomIdentity.translate(viewCenterX(), viewCenterY()).scale(k)
        .translate(-(xs[0] + xs[1]) / 2, -(ys[0] + ys[1]) / 2);
      const sel = d3.select(canvas);
      if (animate) sel.transition().duration(900).ease(d3.easeCubicInOut).call(zoom.transform, tf);
      else sel.call(zoom.transform, tf);
    }

    function activeSet() { return focusSet || (dbFilterOn ? DB_IDS : null); }

    // ---------- "shared platforms only" filter (formerly the separate
    // Platforms tab) ----------
    // Real user request: "take all of this from the Platforms tab and apply
    // it back to the main Graph tab... add a toggle which enables a 'only
    // shared platform/relations' option... so that now I can also use the
    // rest of the features like the search as well." Rather than a second
    // canvas/subset (the old platforms.js), this is just one more gate
    // folded into the SAME inGraphView()/linkInLayer() choke points every
    // other Graph filter (layer, year range, My Database) already goes
    // through -- so focus, search, hover, and click-to-reveal all keep
    // working on top of it for free.
    let platformsOnly = false;
    let platformsNodeIds = new Set();
    // Real user report: "the overview mode... will only be a connection
    // from nameplate to nameplate. However, when clicking on an individual
    // model that happens to be a nameplate, then that initial connection
    // might vanish and be replaced by the specific generation... if the
    // destination node is also a nameplate, the edge should be connected to
    // the specific generation of the nameplate (if available), otherwise
    // default to the nameplate." The coarse "mirror" link and the real
    // generation-specific link already exist in the data (see
    // indexMirrorReplacements/linkInLayer's own mirror-hide precedence) --
    // expanding a nameplate correctly hides the coarse mirror once its own
    // family is expanded, but the real specific link only draws if BOTH
    // endpoints individually pass nodeInLayer, which requires the OTHER
    // side's nameplate to *also* be separately expanded. Without a fix,
    // clicking just one side loses the connection entirely (mirror hidden,
    // specific link still blocked by the still-collapsed other side) rather
    // than "replacing" it as the mirror precedence intends. platformsRevealedIds
    // is the narrow fix: node ids this filter has decided to quietly reveal
    // (bypassing nodeInLayer's collapse gate for just that one id) because a
    // real, non-mirror platform/related link resolves to them from a
    // nameplate the user actually did expand -- standing in for their own
    // still-collapsed nameplate, without fully expanding it.
    let platformsRevealedIds = new Set();
    // Only these link types ever drew in the old Platforms tab -- succession/
    // gensucc/generation-structural links never did, even if both endpoints
    // happen to individually qualify (e.g. two platform-sharing cars that
    // also happen to be a succession pair). Checked in ADDITION to node
    // membership below, not instead of it.
    function platformsTypeOk(l) {
      // "generation" (the structural family->generation hub link) is
      // allowed through here even though it's never actually an edge the
      // old Platforms tab drew -- the draw() loop below already skips it
      // unconditionally before this check is ever reached (same as it does
      // for every other view), so allowing it here only affects
      // neighborhood()/expandFocus()'s FOCUS-SET traversal: without it, a
      // clicked family's own just-expanded generations (997, in the real
      // Porsche 911 example) fail to join the highlighted focus set at all,
      // even though they're correctly drawn -- the family's own click
      // should highlight its generations, same as ordinary (filter-off)
      // Graph already does.
      return !platformsOnly || l.type === "platform" || l.type === "related" ||
        l.type === "made" || l.type === "designed" || l.type === "engineered" || l.type === "generation";
    }
    // Same closure computation as the old platforms.js's computeSubset(),
    // just producing an id set instead of a whole {nodes,links} object,
    // since Graph already has its own full nodes/links arrays and draw loop
    // to filter against.
    function computePlatformsFilter() {
      const carIds = new Set();
      const revealedIds = new Set();
      for (const l of links) {
        if (l.type !== "platform" && l.type !== "related") continue;
        if (l.retired) continue;
        if (!l.sn || !l.tn) continue;
        if (!linkInLayer(l) || !nodeInLayer(l.sn) || !nodeInLayer(l.tn)) continue;
        carIds.add(l.sn.id); carIds.add(l.tn.id);
      }
      // Pass 2: a real (non-mirror) platform/related link whose ORIGIN end
      // just got expanded, but whose DESTINATION end is a generation of a
      // still-collapsed OTHER nameplate -- pass 1 above rejected this link
      // entirely (nodeInLayer fails on the still-collapsed destination), and
      // the coarse family-level mirror for this same relation is ALSO now
      // hidden (linkInLayer hides a mirror once either side's family is
      // expanded) -- so without this pass the connection would just vanish
      // instead of being replaced by the specific generation, exactly the
      // gap the real user report described. Quietly reveal just that one
      // destination generation (standing in for its own still-collapsed
      // nameplate) rather than fully expanding the other family too.
      if (expandedFamilies.size) {
        const belongsToExpanded = n => !!n && !n.retired &&
          (expandedFamilies.has(n.id) || (n.familyOf && expandedFamilies.has(n.familyOf)));
        for (const l of links) {
          if (l.type !== "platform" && l.type !== "related") continue;
          if (l.retired || l.mirror) continue; // only the real, specific link -- never a coarse mirror
          if (!l.sn || !l.tn) continue;
          if (!linkInLayer(l)) continue;
          const origin = belongsToExpanded(l.sn) ? l.sn : belongsToExpanded(l.tn) ? l.tn : null;
          if (!origin) continue;
          const dest = origin === l.sn ? l.tn : l.sn;
          if (dest.retired) continue;
          if (dest.familyOf && !expandedFamilies.has(dest.familyOf)) {
            carIds.add(origin.id); carIds.add(dest.id);
            revealedIds.add(dest.id);
          }
        }
      }
      platformsRevealedIds = revealedIds;
      // A qualifying GENERATION's own nameplate hub stays included too --
      // Graph always keeps a family's dot visible/anchored regardless of
      // expand state, and that's the node the real "made" link actually
      // lives on for a generation that has no direct make link of its own.
      const carOrFamIds = new Set(carIds);
      carIds.forEach(id => { const car = byId.get(id); if (car && car.familyOf) carOrFamIds.add(car.familyOf); });
      const nodeIds = new Set(carOrFamIds);
      const allMadeLinks = links.filter(l => l.type === "made" && l.sn && l.tn);
      carOrFamIds.forEach(id => {
        const ml = allMadeLinks.find(l => l.sn.id === id || l.tn.id === id);
        if (ml) nodeIds.add(ml.sn.type === "make" ? ml.sn.id : ml.tn.id);
      });
      for (const l of links) {
        if (l.type !== "designed" && l.type !== "engineered") continue;
        if (l.retired) continue;
        if (!l.sn || !l.tn) continue;
        if (!linkInLayer(l) || !nodeInLayer(l.sn) || !nodeInLayer(l.tn)) continue;
        const carEnd = carOrFamIds.has(l.sn.id) ? l.sn.id : carOrFamIds.has(l.tn.id) ? l.tn.id : null;
        if (!carEnd) continue;
        nodeIds.add(l.sn.id); nodeIds.add(l.tn.id);
      }
      platformsNodeIds = nodeIds;
    }
    // Cheap no-op when the filter is off -- safe to call from every place
    // that can change its membership (layer toggle, family expand/collapse,
    // a live LLM-confirmed structural change) without a dedicated "did this
    // actually affect it" check at each call site.
    function refreshPlatformsFilter() { if (platformsOnly) computePlatformsFilter(); }
    function setPlatformsOnly(v) {
      v = !!v;
      if (v === platformsOnly) return;
      platformsOnly = v;
      const btn = document.getElementById("platformsonly");
      if (btn) btn.classList.toggle("active", platformsOnly);
      if (platformsOnly) {
        computePlatformsFilter();
        focusSet = null; focusRoot = null; selected = null;
        document.getElementById("clearfocus").hidden = true;
        switchDetailAway();
        if (platformsNodeIds.size) flyToSet(platformsNodeIds); else fitAll(true);
      } else {
        platformsRevealedIds = new Set();
        fitAll(true);
      }
      dirty = true;
    }
    // The single choke point for "is this node in the Graph view at all"
    // (drawn, clickable, counted as a neighbor) -- nodeInLayer() handles the
    // people-layer toggle and collapsed-family hiding (shared with every
    // view); passesYearFilter() is Graph-only on top of that; the platforms
    // filter (when on) narrows it further to only what the old Platforms
    // tab would have shown. platformsRevealedIds is a narrow, platforms-only
    // exception to nodeInLayer's collapsed-family gate -- see
    // computePlatformsFilter's "pass 2" comment for why.
    function inGraphView(n) {
      // The year slider and the platforms filter are main-layer controls (the
      // slider is hidden on this tab), and an engine has no year at all -- so
      // in the powertrain layer nodeInLayer is the whole answer.
      if (isPowerMode()) return nodeInLayer(n);
      if (nodeInLayer(n)) return passesYearFilter(n) && (!platformsOnly || platformsNodeIds.has(n.id));
      if (platformsOnly && !n.retired && platformsRevealedIds.has(n.id)) return passesYearFilter(n) && platformsNodeIds.has(n.id);
      return false;
    }
    function visible(n) { const s = activeSet(); return inGraphView(n) && (!s || s.has(n.id)); }

    function personStroke(n, r) {
      const d = hasRole(n, "designer"), e = hasRole(n, "engineer");
      ctx.lineWidth = Math.max(2, r * 0.42);
      if (d && e && layer === "both") {
        ctx.beginPath(); ctx.arc(n.x, n.y, r, -Math.PI / 2, Math.PI / 2);
        ctx.strokeStyle = C.designer; ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x, n.y, r, Math.PI / 2, 3 * Math.PI / 2);
        ctx.strokeStyle = C.engineer; ctx.stroke();
      } else {
        const useEng = e && (layer === "engineers" || !d);
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
        ctx.strokeStyle = useEng ? C.engineer : C.designer; ctx.stroke();
      }
    }

    // db-gold-ring / garage-dashed-ring markers, shared by model and family
    // nodes (a family shows these when ANY of its generations carries the flag).
    function drawDbGarageRings(n, r, k) {
      if (n.db) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 2.4 / k, 0, 2 * Math.PI);
        ctx.lineWidth = Math.max(1.4, r * 0.34) / k; ctx.strokeStyle = C.dbGold; ctx.stroke();
      }
      if (n.garage) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 6 / k, 0, 2 * Math.PI);
        ctx.lineWidth = 1.6 / k; ctx.strokeStyle = C.ink;
        ctx.setLineDash([2 / k, 2.2 / k]); ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // Real user report: with nothing focused, EVERY edge in the whole graph
    // (thousands of "made"/"designed"/"engineered"/generic connections) drew
    // at full alpha at once -- a dense rat's-nest at the zoomed-out overview
    // level where you can least afford it. Edges now fade in as you zoom
    // in: a wide establishing view reads as a clean cloud of dots, and
    // detail (which specific cars connect to which) appears progressively
    // as you get closer, exactly when there's screen space to show it
    // without everything overlapping. A focus/filter set (aSet) already has
    // its own much stronger unfocused-dimming below and is deliberately NOT
    // scaled down further here -- this only tames the "nothing is focused,
    // show me everything" case.
    function edgeZoomScale(k) {
      const MIN_K = 0.22; // matches the zoom behavior's own scaleExtent floor
      return Math.max(0.1, Math.min(1, (k - MIN_K) / (0.85 - MIN_K)));
    }

    // ---------- edges around an expanded nameplate's bubble ----------
    // Real user request, two parts of the same picture:
    //
    //   "the lines connecting previous generation to next generation to be
    //    curved as well, so that it somewhat follows the curvature of the
    //    actual generations going 'around' the nameplate"
    //
    //   "try not to have any of the edges go through the center of this
    //    circle as well, for cleanliness, unless absolutely necessary. An
    //    exception to this rule is if the connection edge must come from the
    //    nameplate itself and none of the models"
    //
    // Both are answered by asking one question per edge: does this edge have
    // any business being inside a ring? A succession between two generations
    // of the same nameplate does -- it belongs to the ring, so it is drawn ON
    // it, as a real arc at the generations' own radius. Anything else does
    // not, so it is bowed around the outside. And an edge that starts at the
    // nameplate itself is the stated exception: it begins at the centre, so
    // there is no bending it out, and it is left straight.

    // The succession arc: same centre and radius as the generations, going
    // the short way round, so it lies exactly along the rim they sit on.
    // Rebuilt once per frame (see draw), never per edge: ringOf allocates a
    // Set of generation ids, and doing that ten thousand times a frame is the
    // difference between free and a visible stall.
    let frameRings = [], frameRingById = new Map();
    function refreshFrameRings() {
      frameRings = [];
      frameRingById = new Map();
      if (!expandedFamilies.size) return;
      expandedFamilies.forEach(id => {
        const ring = ringOf(id);
        if (!ring) return;
        frameRings.push(ring);
        frameRingById.set(id, ring);
      });
    }

    function genSuccArc(l) {
      const a = l.sn, b = l.tn;
      if (!a.familyOf || a.familyOf !== b.familyOf) return false;
      const ring = frameRingById.get(a.familyOf);
      if (!ring) return false;
      const ra = Math.hypot(a.x - ring.x, a.y - ring.y);
      const rb = Math.hypot(b.x - ring.x, b.y - ring.y);
      // Only while they really are on the ring. A generation being dragged,
      // or a frame caught mid-relayout, falls back to a straight line rather
      // than drawing an arc through empty space.
      if (Math.abs(ra - rb) > 1 || Math.abs(ra - ring.r) > 1) return false;
      let a1 = Math.atan2(a.y - ring.y, a.x - ring.x);
      let a2 = Math.atan2(b.y - ring.y, b.x - ring.x);
      let delta = a2 - a1;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      ctx.arc(ring.x, ring.y, ring.r, a1, a1 + delta, delta < 0);
      return true;
    }

    // Does the straight segment a->b pass inside this circle? Standard
    // point-to-segment distance against the centre; `t` is where the nearest
    // point falls along the segment, which is also the place to push the
    // curve away from.
    function segmentEntersCircle(a, b, ring) {
      const vx = b.x - a.x, vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      if (len2 < 1e-6) return null;
      let t = ((ring.x - a.x) * vx + (ring.y - a.y) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + vx * t, py = a.y + vy * t;
      const d = Math.hypot(ring.x - px, ring.y - py);
      if (d >= ring.clear) return null;
      return { t, d, px, py };
    }

    // Bow the edge around the ring it would otherwise cut through. The
    // control point goes on the far side of the circle from its centre,
    // pushed out past the rim, so the quadratic passes outside it. Only the
    // WORST offender is corrected: an edge crossing two rings at once is
    // vanishingly rare, and chaining curves for it would bend the line into
    // something less legible than the straight one it replaced.
    function bowAroundRings(l) {
      let worst = null;
      for (const ring of frameRings) {
        // An endpoint sitting on or inside this ring belongs to it -- a
        // generation on the rim, or the nameplate at the centre. Those edges
        // are supposed to touch it.
        if (l.sn === ring.fam || l.tn === ring.fam) continue;
        if (ring.gens.has(l.sn.id) || ring.gens.has(l.tn.id)) continue;
        const hit = segmentEntersCircle(l.sn, l.tn, ring);
        if (hit && (!worst || hit.d < worst.hit.d)) worst = { ring, hit };
      }
      if (!worst) return false;
      const { ring, hit } = worst;
      // Direction from the centre out through the closest point on the
      // segment. A segment aimed straight at the centre has no such
      // direction, so take the perpendicular instead -- either side is as
      // good as the other.
      let ux = hit.px - ring.x, uy = hit.py - ring.y;
      let d = Math.hypot(ux, uy);
      if (d < 0.001) {
        ux = -(l.tn.y - l.sn.y); uy = l.tn.x - l.sn.x;
        d = Math.hypot(ux, uy) || 1;
      }
      // A quadratic sits about halfway to its control point at the midpoint,
      // so aim twice as far out as the curve actually needs to go.
      const want = ring.clear + 10;
      const cx = ring.x + (ux / d) * (want * 2 - hit.d);
      const cy = ring.y + (uy / d) * (want * 2 - hit.d);
      ctx.quadraticCurveTo(cx, cy, l.tn.x, l.tn.y);
      return true;
    }

    function pathForLink(l) {
      ctx.moveTo(l.sn.x, l.sn.y);
      if (frameRings.length) {
        if (l.type === "gensucc" && genSuccArc(l)) return;
        if (bowAroundRings(l)) return;
      }
      ctx.lineTo(l.tn.x, l.tn.y);
    }

    // ---------- drawing, batched ----------
    // Real user report, after an overnight LLM run grew the graph to 12,224
    // nodes and 32,544 links: "a large slowdown in rendering and refreshing
    // and low frame rate". Measured on that graph, one frame issued 19,800
    // separate stroke() calls -- every edge its own path, each with its own
    // setLineDash, colour, width and alpha -- and 10,100 separate fill()s, and
    // did it for every edge and node whether or not it was on screen. Canvas
    // state changes are the expensive part, and that was ~90,000 of them per
    // frame, on every pan, hover and zoom.
    //
    // Now: edges and nodes are grouped by how they look, and each group is
    // one path and one stroke/fill. Anything wholly outside the viewport is
    // skipped. The picture is the same; the order in which two overlapping
    // things of DIFFERENT styles stack can differ, which is invisible at this
    // density -- and a focused set now always draws on top of the faded rest.
    const EDGE_STYLE = {
      platform:   { col: () => C.accent,   a: 0.75, w: 1.9, dash: [5, 4] },
      related:    { col: () => C.accent,   a: 0.3,  w: 1,   dash: [2.5, 4] },
      succession: { col: () => C.ink2,     a: 0.3,  w: 1.2, dash: null },
      fitted:     { col: () => C.ink2,     a: 0.4,  w: 1.1, dash: null },
      enginesucc: { col: () => C.gensucc,  a: 0.8,  w: 1.6, dash: null },
      gensucc:    { col: () => C.gensucc,  a: 0.8,  w: 1.8, dash: null },
      designed:   { col: () => C.designer, a: 0.27, w: 1.1, dash: null },
      engineered: { col: () => C.engineer, a: 0.5,  w: 1.4, dash: null },
      _:          { col: () => C.muted,    a: 0.26, w: 1,   dash: null },
    };
    // Back to front: the quiet structural lines first, the lines that carry
    // meaning (succession, platform) last so they sit on top.
    const EDGE_ORDER = ["_", "designed", "engineered", "related", "fitted", "succession",
                        "platform", "enginesucc", "gensucc"];
    // The world-space rectangle on screen, grown by `margin` world units.
    function viewRect(margin) {
      const k = t.k, m = margin || 0;
      const x0 = -t.x / k, y0 = -t.y / k;
      return [x0 - m, y0 - m, x0 + W / k + m, y0 + H / k + m];
    }
    // Both ends on the same outside side of the rectangle: the segment cannot
    // cross it. Conservative -- an edge cutting a corner diagonally is drawn.
    function edgeOffscreen(a, b, R) {
      return (a.x < R[0] && b.x < R[0]) || (a.x > R[2] && b.x > R[2]) ||
             (a.y < R[1] && b.y < R[1]) || (a.y > R[3] && b.y > R[3]);
    }
    let lastFont = null;
    function setFont(f) { if (f !== lastFont) { ctx.font = f; lastFont = f; } }

    function draw() {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);
      lastFont = null;
      const k = t.k;
      const aSet = activeSet();
      const edgeScale = aSet ? 1 : edgeZoomScale(k);
      refreshFrameRings();
      // An edge bowed around an expanded nameplate's bubble can swing out
      // past its own endpoints, so the cull leaves room for the widest ring.
      let ringPad = 0;
      for (const ring of frameRings) ringPad = Math.max(ringPad, (ring.clear || ring.r || 0) * 2);
      const RE = viewRect(40 / k + ringPad);
      const RN = viewRect(40 / k);

      // ---- edges ----
      const buckets = new Map();   // style key + "|" + on -> links
      for (const l of links) {
        // Structural hub->child links, not drawn: the radial ring is what
        // shows that relationship, for an engine's variants exactly as for a
        // nameplate's generations.
        if (l.type === "generation" || l.type === "enginegen") continue;
        // A link whose endpoints aren't resolved (or aren't laid out) yet --
        // possible for a frame or two right after a live LLM mutation splices
        // new nodes in -- would otherwise reach ctx.moveTo(undefined) and
        // throw, which the render loop catches by skipping the WHOLE frame:
        // one bad link blanks the entire canvas until the next clean frame.
        // Skipping just that link keeps everything else drawing normally.
        if (!l.sn || !l.tn) continue;
        if (!Number.isFinite(l.sn.x) || !Number.isFinite(l.sn.y) ||
            !Number.isFinite(l.tn.x) || !Number.isFinite(l.tn.y)) continue;
        if (edgeOffscreen(l.sn, l.tn, RE)) continue;
        if (!linkInLayer(l) || !platformsTypeOk(l) || !inGraphView(l.sn) || !inGraphView(l.tn)) continue;
        const on = (!aSet || (aSet.has(l.sn.id) && aSet.has(l.tn.id)));
        const key = (EDGE_STYLE[l.type] ? l.type : "_") + (on ? "|1" : "|0");
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push(l);
      }
      for (const pass of ["|0", "|1"]) {
        const on = pass === "|1";
        for (const type of EDGE_ORDER) {
          const arr = buckets.get(type + pass);
          if (!arr || !arr.length) continue;
          const st = EDGE_STYLE[type];
          ctx.strokeStyle = st.col();
          ctx.globalAlpha = (on ? edgeScale : 0.045) * st.a;
          ctx.lineWidth = st.w / k;
          ctx.setLineDash(st.dash ? st.dash.map(v => v / k) : []);
          ctx.beginPath();
          for (const l of arr) pathForLink(l);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);

      // ---- nodes ----
      // Fills grouped by colour and by faded/not; the rings some nodes carry
      // grouped the same way, drawn over the fills.
      const fills = new Map(), rings = new Map(), extras = [];
      const add = (map, key, item) => { let a = map.get(key); if (!a) { a = []; map.set(key, a); } a.push(item); };
      for (const n of nodes) {
        if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue; // see the same guard on edges above
        if (n.x < RN[0] - n.r || n.x > RN[2] + n.r || n.y < RN[1] - n.r || n.y > RN[3] + n.r) continue;
        if (!inGraphView(n)) continue;
        const on = visible(n);
        const r = Math.max(n.r, 2.6 / k) * (n === hoverN ? 1.35 : 1);
        const tag = on ? "|1" : "|0";
        let fill;
        if (n.type === "make") fill = C.ink;
        else if (n.type === "model" || n.type === "family") fill = n.heritage ? C.heritage : C.accent;
        else if (n.type === "engine") fill = C.ink;
        else if (n.type === "enginevar") fill = C.engvar;
        else fill = C.card;
        add(fills, fill + tag, { n, r });
        if (n.type === "family") {
          // thin innermost ring marks a family as expandable/collapsible,
          // nested inside the db-gold-ring and garage-dashed-ring if present.
          add(rings, C.ink + "|" + (1.1 / k) + tag, { x: n.x, y: n.y, r: r + 1.8 / k });
        } else if (n.type === "engine") {
          // Real user request: "it would make more sense for the engines in
          // the powertrain tab to adopt the same coloring as if it were the
          // 'makes' nodes from the Graph tab" -- the hub in ink, and the
          // expandable ring a nameplate gets, in accent so it reads against it.
          add(rings, C.accent + "|" + (1.2 / k) + tag, { x: n.x, y: n.y, r: r + 2 / k });
        } else if (n.type === "person") {
          // Designer / engineer rim, split in two for someone who is both
          // while both layers are on. Widths rounded to a quarter pixel so
          // people of similar degree share a stroke; nobody can see 0.1 px.
          const d = hasRole(n, "designer"), e = hasRole(n, "engineer");
          const w = Math.round(Math.max(2, r * 0.42) * 4) / 4;
          if (d && e && layer === "both") {
            add(rings, C.designer + "|" + w + tag, { x: n.x, y: n.y, r, a1: -Math.PI / 2, a2: Math.PI / 2 });
            add(rings, C.engineer + "|" + w + tag, { x: n.x, y: n.y, r, a1: Math.PI / 2, a2: 3 * Math.PI / 2 });
          } else {
            const useEng = e && (layer === "engineers" || !d);
            add(rings, (useEng ? C.engineer : C.designer) + "|" + w + tag, { x: n.x, y: n.y, r });
          }
        }
        if ((n.type === "model" || n.type === "family") && (n.db || n.garage)) extras.push({ n, r, on });
      }
      for (const pass of ["|0", "|1"]) {
        ctx.globalAlpha = pass === "|1" ? 1 : 0.09;
        for (const [key, arr] of fills) {
          if (!key.endsWith(pass)) continue;
          ctx.fillStyle = key.slice(0, -2);
          ctx.beginPath();
          for (const { n, r } of arr) { ctx.moveTo(n.x + r, n.y); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); }
          ctx.fill();
        }
        for (const [key, arr] of rings) {
          if (!key.endsWith(pass)) continue;
          const parts = key.slice(0, -2).split("|");
          ctx.strokeStyle = parts[0]; ctx.lineWidth = +parts[1];
          ctx.beginPath();
          for (const g of arr) {
            const a1 = g.a1 == null ? 0 : g.a1, a2 = g.a2 == null ? 2 * Math.PI : g.a2;
            ctx.moveTo(g.x + Math.cos(a1) * g.r, g.y + Math.sin(a1) * g.r);
            ctx.arc(g.x, g.y, g.r, a1, a2);
          }
          ctx.stroke();
        }
      }
      // The few nodes with a database or garage mark, one by one: there are
      // a handful, and the garage ring is dashed.
      for (const { n, r, on } of extras) {
        ctx.globalAlpha = on ? 1 : 0.09;
        drawDbGarageRings(n, r, k);
      }
      if (selected && Number.isFinite(selected.x) && inGraphView(selected)) {
        const r = Math.max(selected.r, 2.6 / k) * (selected === hoverN ? 1.35 : 1);
        ctx.globalAlpha = visible(selected) ? 1 : 0.09;
        ctx.beginPath(); ctx.arc(selected.x, selected.y, r + 5 / k, 0, 2 * Math.PI);
        ctx.lineWidth = 1.6 / k; ctx.strokeStyle = C.ink; ctx.stroke();
      }

      // labels — draw makes first (big to small), then designers, then models,
      // skipping any label that would collide in screen space. Whether a label
      // is shown at all is decided BEFORE its font is set: setting the font
      // parses it, and doing that for every one of ten thousand nodes to draw
      // a hundred and fifty labels was a measurable share of each frame.
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const placed = [];
      const collides = (x, y, w, h) => {
        for (const r of placed)
          if (x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]) return true;
        placed.push([x, y, w, h]);
        return false;
      };
      const LR = viewRect(220 / k);
      for (const n of LABEL_ORDER) {
        if (!Number.isFinite(n.x) || n.x < LR[0] || n.x > LR[2] || n.y < LR[1] || n.y > LR[3]) continue;
        const on = visible(n);
        if (!on) continue;
        let show = false;
        if (n.type === "make") show = k > 0.55 || n.deg >= 12;
        else if (n.type === "person") show = k > 1.15 || n.deg >= 14 || !!focusSet || n === hoverN || n === selected;
        else show = k > 1.6 || !!focusSet || n === hoverN || n === selected;
        if (!show) continue;
        let col = C.ink2, fs;
        if (n.type === "make") {
          fs = Math.min(30, (9.5 + Math.min(n.deg, 30) * 0.11) / Math.min(k, 1));
          setFont(`600 ${fs}px Inter, sans-serif`); col = C.ink;
        } else if (n.type === "person") {
          fs = (n.deg >= 9 ? 12.5 : 11.5) / Math.min(k, 1.15);
          setFont(`italic 600 ${fs}px Georgia, serif`);
          col = hasRole(n, "engineer") && (layer === "engineers" || !hasRole(n, "designer")) ? C.engineer : C.designer;
        } else {
          fs = 10.5 / Math.min(k, 1.3);
          setFont(`500 ${fs}px Inter, sans-serif`);
        }
        const label = n.type === "make" ? n.label.toUpperCase() : n.label;
        const y = n.y + Math.max(n.r, 2.6 / k) + 3.5 / k;
        const w = ctx.measureText(label).width;
        const isHot = n === hoverN || n === selected;
        if (!isHot && collides((n.x - w / 2) * k + t.x, y * k + t.y, w * k, fs * 1.25 * k)) continue;
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 3.4 / Math.min(k, 1); ctx.strokeStyle = C.paper; ctx.strokeText(label, n.x, y);
        ctx.fillStyle = col; ctx.fillText(label, n.x, y);
      }
      ctx.globalAlpha = 1;
    }

    // Real bug report: "the whole page becomes unresponsive after accepting
    // an LLM change, I have to refresh." requestAnimationFrame(loop) used to
    // be the LAST statement in this function with no error handling around
    // it -- if ANYTHING inside sim.tick()/draw() threw (e.g. a link whose
    // source/target briefly points at a node not yet fully wired into every
    // index mid-way through a live graph mutation like applyLlmConfirmSilent
    // or applyFamilyOverrideConfirm), the exception unwound straight out of
    // loop() and it never reached its own requestAnimationFrame(loop) call
    // -- silently killing the render loop for good. Nothing else ever
    // restarts it, so the canvas simply stops updating forever: clicks and
    // hovers may still fire, but nothing ever redraws, which looks exactly
    // like the whole page freezing and is only fixable by a full reload.
    // Wrapping the frame body means one bad frame gets logged and skipped
    // instead of permanently ending every future one -- self-healing rather
    // than requiring a manual refresh.
    function loop() {
      try {
        if (localSim) { localTick(); dirty = true; }
        else if (simActive > 0) { sim.tick(); simActive--; dirty = true; }
        if (dirty) { draw(); dirty = false; }
      } catch (e) {
        console.error("Graph render loop error (skipping this frame):", e);
      }
      requestAnimationFrame(loop);
    }

    function pick(mx, my) {
      const [wx, wy] = t.invert([mx, my]);
      let best = null, bd = 14 / t.k + 4;
      for (const n of nodes) {
        if (!inGraphView(n)) continue;
        if (focusSet && !focusSet.has(n.id)) continue;
        const d = Math.hypot(n.x - wx, n.y - wy);
        if (d < n.r + 8 / t.k && d < bd) { bd = d; best = n; }
      }
      return best;
    }

    function neighborhood(id, set) {
      set = set || new Set([id]);
      // `adj.get(id)` can legitimately be undefined for an id that isn't in
      // the index (a retired node's stale reference, or one mid-splice
      // during a live LLM mutation) -- calling .forEach on that throws out
      // of focusOn/refreshFocus and kills whatever click handler or apply
      // pass was running. See spliceIntoIndexes' own comment.
      (adj.get(id) || []).forEach(({ n, l }) => { if (inGraphView(n) && linkInLayer(l) && platformsTypeOk(l)) set.add(n.id); });
      return set;
    }
    // A one-hop neighborhood() from a FAMILY only reaches what's linked
    // directly to the family node itself (its make, its mirrored designer/
    // engineer credits, its own generation hub links) -- it doesn't reach
    // links that live on the individual generations, like a cross-nameplate
    // "related"/"succession"/"platform" connection harvested straight onto
    // one specific generation's own Wikipedia article (e.g. BMW X1 (F48) is
    // directly related to the Zinoro 60H rebadge; that link is on F48, not
    // on the X1 family node). Expanding a nameplate's generations should
    // make those show up as part of the highlighted focus too, not just as
    // near-invisible unfocused background lines (draw() still technically
    // renders them at ~0.01 alpha either way, but that reads as "missing").
    function neighborhoodForFocus(n) {
      const set = neighborhood(n.id);
      if (isHub(n)) {
        childIdsOf(n).forEach(gid => neighborhood(gid, set));
      } else if (n.type === "make") {
        // Real user request: "if i click on the company name (mark) itself,
        // i also want it to show the shared platforms/relations to other
        // cars in different companies, so it should include the edge
        // connection and the model/nameplate that it is related to outside
        // of the mark as well." A cross-company platform/related/succession
        // link lives on the CHILD nameplate/model, never on the make node
        // itself, so the plain one-hop neighborhood(n.id) above never
        // reaches it. Walk one more hop out from each of this make's own
        // direct children, but -- unlike the family branch above -- scoped
        // to just platform/related/succession links whose OTHER endpoint
        // belongs to a genuinely different make. A full second hop
        // (designers, engineers, every sibling nameplate's own connections)
        // would blow the focus set up into something no longer meaningfully
        // "focused" for a make with dozens of nameplates.
        // A child nameplate's cross-company links may live on the FAMILY
        // node (as a build-time mirror) or on one of its individual
        // GENERATIONS (where the link was actually harvested) -- and which
        // of the two is currently visible flips depending on whether that
        // nameplate happens to be expanded, since linkInLayer hides the
        // mirror as soon as the real generation-level link can draw. Now
        // that focusOn's revealRelatedFor expands exactly those far
        // nameplates on purpose, scanning only the family nodes would lose
        // the connection precisely when the fix that expanded them was
        // trying to reveal it. Scanning both levels makes this independent
        // of expansion state entirely.
        const children = [];
        [...set].filter(id => id !== n.id).forEach(id => {
          children.push(id);
          const c = byId.get(id);
          if (c && c.type === "family") (c.generations || []).forEach(g => children.push(g));
        });
        children.forEach(id => {
          (adj.get(id) || []).forEach(({ n: o, l }) => {
            if (l.type !== "platform" && l.type !== "related" && l.type !== "succession") return;
            if (!inGraphView(o) || !linkInLayer(l) || !platformsTypeOk(l)) return;
            const otherMake = (o.type === "family" || o.type === "model") ? o.make : null;
            if (otherMake && otherMake !== n.label) set.add(o.id);
          });
        });
      }
      return set;
    }

    // ---------- clicking something should reveal everything its own card claims ----------
    // Two real bug reports, one root cause each, both fixed here because
    // both are about the gap between what the DETAIL PANEL lists and what
    // the graph actually draws for the same click.
    //
    // 1. "sometimes when I click on a specific make, it does not reveal all
    //    of the models/nameplates associated in the knowledge graph view,
    //    even though this information is present in the card details of the
    //    company itself. It seems to be a visual bug." It isn't a rendering
    //    bug -- it's the year slider. openDetail lists a make's connections
    //    straight off its adjacency with no year filtering at all, while
    //    neighborhoodForFocus/draw both go through inGraphView, which
    //    includes passesYearFilter. With the slider at its 2000-present
    //    default, every pre-2000 nameplate the card cheerfully lists is
    //    filtered out of the graph. ensureYearVisible already encodes the
    //    right principle for a single node ("explicit navigation always wins
    //    over the slider -- the slider is a decluttering default, not a
    //    wall"); this just applies that same principle to the thing actually
    //    being navigated to, which for a make is its whole model range.
    //
    // 2. "some cars that state they are related for a particular model do not
    //    show up in the knowledge graph as being connected, until I click to
    //    reveal them. I want all of the cars that are related to immediately
    //    be revealed as well when I click on a particular model (or make)."
    //    A related car is frequently a GENERATION of some other nameplate,
    //    and a generation is hidden by nodeInLayer while its own family is
    //    collapsed -- so the link had nothing visible to draw to. Expanding
    //    that far family (rather than leaving it to a second click) is what
    //    makes the connection appear at the same time as everything else.
    // Real user report: "It seems that some of the cars that are nameplates
    // are still exposing the generations even when I am not selecting the
    // make of a car company nor when I am selecting a particular nameplate/
    // model... I can see this issue particularly when I select a make and
    // then unselect it. All of the make's nameplates will then remain
    // exposed after the fact."
    //
    // Exactly right, and it's the direct cost of the auto-reveal added for
    // the previous request. clearFocus only ever collapsed ONE family -- the
    // focus root's own, or the one its generation belonged to -- which was
    // complete back when focusing could only ever expand that one. Now a
    // single click can expand many (revealRelatedFor walks every
    // platform/related/succession link, and a make click walks all its
    // children's), and every one of those stayed open forever, permanently
    // cluttering the graph with generations nothing is pointing at any more.
    //
    // Tracked explicitly rather than inferred: only families THIS focus
    // actually expanded are collapsed again, so a nameplate the user opened
    // deliberately beforehand (or one expanded by a live LLM confirmation) is
    // never yanked shut underneath them.
    let autoExpanded = new Set();
    function expandForFocus(famId) {
      if (expandedFamilies.has(famId)) return;   // already open on its own account -- not ours to close
      expandFamily(famId);
      autoExpanded.add(famId);
    }
    function collapseAutoExpanded() {
      autoExpanded.forEach(id => collapseFamily(id));
      autoExpanded = new Set();
    }
    function revealRelatedFor(n) {
      const RELATION_TYPES = ["platform", "related", "succession"];
      // A family's cross-nameplate links usually live on its individual
      // generations, not on the family node, so scan those too -- same
      // reasoning as neighborhoodForFocus' own family branch.
      const roots = [n.id];
      if (n.type === "family") (n.generations || []).forEach(g => roots.push(g));
      if (n.type === "make") (adj.get(n.id) || []).forEach(({ n: o, l }) => {
        if (l.type === "made" && o && !o.retired) {
          roots.push(o.id);
          if (o.type === "family") (o.generations || []).forEach(g => roots.push(g));
        }
      });
      const far = [];
      roots.forEach(id => (adj.get(id) || []).forEach(({ n: o, l }) => {
        if (RELATION_TYPES.indexOf(l.type) < 0 || l.retired || !o || o.retired) return;
        far.push(o);
      }));
      far.forEach(o => {
        ensureYearVisible(o);
        if (o.familyOf) expandForFocus(o.familyOf);
      });
    }
    function ensureMakeRangeVisible(n) {
      if (n.type !== "make") return;
      let lo = null, hi = null;
      (adj.get(n.id) || []).forEach(({ n: o, l }) => {
        if (l.type !== "made" || l.retired || !o || o.retired || o.year == null) return;
        const end = o.end == null ? o.year : o.end;
        lo = lo == null ? o.year : Math.min(lo, o.year);
        hi = hi == null ? end : Math.max(hi, end);
      });
      if (lo == null) return;
      const r = api.yearRange();
      setYearRange(Math.min(r.lo, lo), Math.max(r.hi, hi));
    }
    function focusOn(n, opts = {}) {
      // Release the PREVIOUS focus's auto-expansions before opening this
      // one's. Without this, browsing from car to car accumulates expanded
      // nameplates indefinitely -- the same "still exposing the generations"
      // complaint, just reached by clicking through ten cars instead of by
      // releasing one. Must run before any expanding below.
      collapseAutoExpanded();
      // Focusing a specific generation implies opening its nameplate; done
      // here rather than in gotoNode so it survives the collapse just above
      // regardless of which entry point got us here.
      if (parentIdOf(n)) expandForFocus(parentIdOf(n));
      ensureYearVisible(n); // explicit navigation always wins over the slider
      ensureMakeRangeVisible(n); // ...and for a make, that means its whole model range -- see above
      revealRelatedFor(n);       // ...and every related car, without needing a second click
      // Same principle for the platforms filter -- a search hit or a
      // "connections" link click on a car the filter is currently hiding
      // shouldn't silently no-op; turn the filter off rather than fly the
      // camera to an empty patch of canvas.
      if (platformsOnly && !platformsNodeIds.has(n.id)) setPlatformsOnly(false);
      if (isHub(n)) expandForFocus(n.id);
      // Real bug report, with a screenshot: clicking one of the cars
      // connected to an engine left the Powertrain tab "completely blank".
      // collapseAutoExpanded above had just shut the engine that was making
      // that car visible, so the car vanished at the instant it was clicked
      // and the focus flew to an empty patch of canvas.
      //
      // A car in this layer exists BECAUSE an engine reaches it, so focusing
      // one opens every engine that does. That is also what the user asked
      // for -- "I want a duplicate of the car that exists in the graph tab,
      // but appearing in the powertrain tab. It should be an exact copy of
      // the car being referenced" -- and it is the same node, so it is.
      if (isPowerMode() && !isPowertrain(n)) {
        for (const { n: o, l } of adj.get(n.id) || []) {
          if (l.retired || l.type !== "fitted" || !o) continue;
          if (powerEdgeSuppressed(l)) continue;
          expandForFocus(o.type === "enginevar" ? o.engineOf : o.id);
        }
      }
      focusRoot = n; selected = n;
      focusSet = neighborhoodForFocus(n);
      document.getElementById("clearfocus").hidden = false;
      if (!opts.noPanel) openDetail(n);
      flyToSet(focusSet);
      reheat(26);
      dirty = true;
    }
    function expandFocus() {
      if (!focusSet) return;
      const next = new Set(focusSet);
      focusSet.forEach(id => adj.get(id).forEach(({ n, l }) => { if (inGraphView(n) && linkInLayer(l) && platformsTypeOk(l)) next.add(n.id); }));
      focusSet = next;
      flyToSet(focusSet);
      reheat(30);
      dirty = true;
    }
    function clearFocus() {
      // Collapse every family THIS focus expanded -- the root's own, plus
      // each one revealRelatedFor/the make branch opened to make a related
      // car visible. See expandForFocus's own comment for the "all of the
      // make's nameplates will then remain exposed after the fact" report.
      collapseAutoExpanded();
      focusSet = null; focusRoot = null; selected = null;
      document.getElementById("clearfocus").hidden = true;
      switchDetailAway();
      if (window.LlmFamilies) window.LlmFamilies.setEngaged(null);
      dt.hidden = true; dtNode = null;
      // Real user request: releasing focus (the "release focus" button, or
      // clicking outside the focused set) should just stop dimming/
      // highlighting -- not fly the camera back out to the whole graph.
      // Whatever position/zoom you were looking at stays put; only the
      // dimming (visible()/activeSet()) and the collapsed-family cleanup
      // above change.
      dirty = true;
    }
    // The other half of the "viewfinder freezes and then goes blank" report
    // (see spliceIntoIndexes' own comment for the first half). A focus set is
    // built from node IDS, and a live LLM mutation can leave an id in it that
    // no longer resolves -- a node retired by a de-dup/override, or one
    // minted into `links` a moment before it reached `byId`. `byId.get(id)`
    // then returns undefined, `n => n.x` throws inside d3.extent, and the
    // exception unwinds straight out of focusOn/refreshFocus -- which are
    // called from click handlers and from every apply* function -- aborting
    // whatever else that handler still had to do. Even when nothing throws,
    // a set whose nodes have no laid-out coordinates yet produces NaN
    // extents, and a NaN zoom transform blanks the canvas outright with
    // nothing logged anywhere. Filter to nodes that actually exist and
    // actually have finite coordinates, and bail out (leaving the camera
    // exactly where it is) rather than flying somewhere undefined.
    function flyToSet(set) {
      const arr = [...set].map(id => byId.get(id))
        .filter(n => n && Number.isFinite(n.x) && Number.isFinite(n.y));
      if (!arr.length) return;
      const xs = d3.extent(arr, n => n.x), ys = d3.extent(arr, n => n.y);
      const k = Math.max(0.4, Math.min(3.4,
        Math.min((W - panelReserve()) / (xs[1] - xs[0] + 260),
                 (H - panelReserveY() - legendReserveY()) / (ys[1] - ys[0] + 260))));
      const cx = (xs[0] + xs[1]) / 2, cy = (ys[0] + ys[1]) / 2;
      if (!Number.isFinite(k) || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
      const tf = d3.zoomIdentity.translate(viewCenterX(), viewCenterY()).scale(k).translate(-cx, -cy);
      d3.select(canvas).transition().duration(850).ease(d3.easeCubicInOut).call(zoom.transform, tf);
    }
    // After a focus: the focused set, and the area its bounding box covers,
    // settle -- the rest of the graph stays exactly where it is. A focused
    // set spread too wide for that falls back to the set alone.
    function reheat(nticks) {
      const ids = focusSet || null;
      let rect = null;
      if (ids && ids.size) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        ids.forEach(id => {
          const n = byId.get(id);
          if (!n || !Number.isFinite(n.x)) return;
          x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y);
        });
        if (Number.isFinite(x0)) rect = [x0 - 160, y0 - 160, x1 + 160, y1 + 160];
      } else {
        rect = viewRect(0);
      }
      if (!relaxLocally(rect, ids, nticks, 0.16) && ids) relaxLocally(null, ids, nticks, 0.16);
    }
    // Recomputes the current focus set from scratch — used after a live
    // structural change (e.g. an LLM-confirmed generation split just minted
    // new nodes) so a family that's currently focused immediately includes
    // its brand-new generations in the focus set, without moving the camera
    // or re-opening the detail panel (unlike focusOn/gotoNode).
    function refreshFocus() {
      if (focusRoot) focusSet = neighborhoodForFocus(focusRoot);
      dirty = true;
    }

    function gotoNode(n) {
      // An engine lives in the powertrain layer, so go to that layer first --
      // focusing it in the main one would fly the camera to an empty patch of
      // canvas. After the switch it is focused exactly like anything else,
      // because the two layers are the same graph. The reverse too: clicking
      // a car from an engine's card takes you back to the main layer.
      if (isPowertrain(n) && !isPowerMode()) switchView("power");
      else if (!isPowertrain(n) && isPowerMode() && !nodeInLayer(n)) switchView("graph");
      focusOn(n); // focusOn expands n's own family itself -- see its comment
    }

    // Real user request: clicking an entry in the "Unconfirmed Relationships"
    // browser should "move the window viewfinder to focus on these two cars
    // within the window." An UNCONFIRMED relation (llm_families.js's
    // store.relations, status "provisional") deliberately has NO live graph
    // link yet -- confirming it is what adds one -- so the ordinary
    // single-node focusOn/gotoNode (which flies to a node's EXISTING
    // adjacency) can't be trusted to include the other side. This builds the
    // focus set directly from the two given ids instead of walking links.
    function focusPair(idA, idB) {
      const a = byId.get(idA), b = byId.get(idB);
      if (!a || !b) return;
      collapseAutoExpanded(); // same release-the-previous-focus rule as focusOn
      ensureYearVisible(a); ensureYearVisible(b);
      if (platformsOnly && !(platformsNodeIds.has(a.id) && platformsNodeIds.has(b.id))) setPlatformsOnly(false);
      if (a.type === "family") expandForFocus(a.id);
      if (b.type === "family") expandForFocus(b.id);
      focusRoot = a; selected = a;
      focusSet = new Set([a.id, b.id]);
      document.getElementById("clearfocus").hidden = false;
      openDetail(a);
      flyToSet(focusSet);
      reheat(26);
      dirty = true;
    }

    // events
    let downPt = null, moved = false;
    canvas.addEventListener("pointerdown", e => { downPt = [e.clientX, e.clientY]; moved = false; });
    canvas.addEventListener("pointermove", e => {
      if (downPt && Math.hypot(e.clientX - downPt[0], e.clientY - downPt[1]) > 4) moved = true;
      const r = canvas.getBoundingClientRect();
      const n = pick(e.clientX - r.left, e.clientY - r.top);
      if (n !== hoverN) {
        hoverN = n; dirty = true;
        canvas.style.cursor = n ? "pointer" : "grab";
        if (n) showHover(n, e.clientX, e.clientY); else hideHover();
      } else if (n) positionHover(e.clientX, e.clientY);
    });
    canvas.addEventListener("pointerleave", () => { hoverN = null; hideHover(); dirty = true; });
    let clickTimer = null;
    canvas.addEventListener("click", e => {
      if (moved) return;
      const r = canvas.getBoundingClientRect();
      const n = pick(e.clientX - r.left, e.clientY - r.top);
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        if (n) focusOn(n);
        else if (focusSet) clearFocus();
      }, 240);
    });
    canvas.addEventListener("dblclick", e => {
      clearTimeout(clickTimer);
      const r = canvas.getBoundingClientRect();
      const n = pick(e.clientX - r.left, e.clientY - r.top);
      if (focusSet) expandFocus();
      else if (n) focusOn(n);
    });
    window.addEventListener("keydown", e => { if (e.key === "Escape" && !document.getElementById("view-graph").classList.contains("hidden")) clearFocus(); });
    document.getElementById("clearfocus").onclick = clearFocus;

    function init() {
      resize();
      d3.select(canvas).call(zoom).on("dblclick.zoom", null);
      fitAll(false);
      initZoomSlider();
      loop();
      document.fonts && document.fonts.ready.then(() => dirty = true);
      window.addEventListener("resize", () => { resize(); });
    }

    return {
      init, gotoNode, focusPair, clearFocus, refreshFocus,
      // Re-frame the camera on whatever is on screen now. Needed when the
      // layer changes under it (see switchView): the powertrain layer's forty
      // nodes sit nowhere near the main graph's six thousand.
      refit(anim) { fitAll(!!anim); },
      // Run the forces far enough for the layout to mean something, then
      // frame it. Switching layer hands the simulation a completely different
      // set of nodes, most of them still sitting where they were seeded, so
      // framing immediately frames a cloud that is about to move.
      settleAndFit(ticks) {
        for (let i = 0; i < (ticks || 140); i++) sim.tick();
        fitAll(false);
        dirty = true;
      },
      clearSelection() { selected = null; dirty = true; },
      touch() { dirty = true; resize(); refreshPlatformsFilter(); },
      platformsOnly: () => platformsOnly, setPlatformsOnly,
      state: () => ({ t, focusSet, focusRoot, platformsOnly, platformsNodeIds, platformsRevealedIds }),
      // Where the camera thinks the usable area is, given whatever shape the
      // detail panel currently has. Exposed so the regression test can read
      // it directly: every path that moves the camera goes through a d3
      // transition, which a headless test cannot advance, so the transform
      // itself is not observable there -- but its two inputs are.
      camera: () => ({ reserveX: panelReserve(), reserveY: panelReserveY(),
                       reserveTop: legendReserveY(),
                       centerX: viewCenterX(), centerY: viewCenterY(),
                       isSheet: panelIsSheet(), W, H }),
      // Draw one frame, now, instead of waiting for the render loop's next
      // requestAnimationFrame. Exposed for the regression suite: a headless
      // test has no animation frames at all, so the only way to assert what
      // an edge is actually DRAWN as (an arc along the rim, a curve bowed
      // around it, a straight line) is to ask for a frame and record what the
      // canvas context was told to do.
      drawNow() { draw(); },
      // Advance the simulation by hand. Exposed for the regression suite: a
      // headless test has no animation frames, so the render loop never ticks,
      // and "does this still hold once the layout has been allowed to fight
      // back" is only answerable by running the forces.
      simTick(n) { for (let i = 0; i < (n || 1); i++) sim.tick(); dirty = true; },
      // The last local relax -- how big a patch, how much of it moved -- and
      // a way to run it out by hand, since a headless test has no frames.
      relaxStats: () => lastRelax,
      relaxRun() { while (localSim) localTick(); dirty = true; },
    };
  })();

  // ---------- view switching ----------
  const views = { graph: null, timeline: null, sixdeg: null };
  let activeView = "graph";
  // Both the Graph and the Powertrain tab show the SAME section, canvas and
  // renderer -- they differ only in which layer is on screen. See graphMode.
  const GRAPH_VIEWS = { graph: "main", power: "power" };
  function powertrainCounts() {
    let engines = 0, variants = 0, fitted = 0;
    const cars = new Set();
    for (const n of nodes) {
      if (n.retired) continue;
      if (n.type === "engine") engines++;
      else if (n.type === "enginevar") variants++;
    }
    for (const l of links) {
      if (l.retired || l.type !== "fitted") continue;
      const a = endOf(l, "source"), b = endOf(l, "target");
      if (!a || !b || a.retired || b.retired) continue;
      fitted++;
      cars.add(isPowertrain(a) ? b.id : a.id);
    }
    return { engines, variants, cars: cars.size, fitted };
  }
  // Something in the powertrain layer changed -- an engine read, a mention
  // recorded, a merge. Was CarWebPower.invalidate() back when that layer had
  // its own renderer; now it is the same graph, so it is the same refresh
  // every other live mutation does.
  function powertrainChanged() {
    invalidatePowerVis();
    refreshPowertrainLegend();
    if (isPowerMode()) { buildSim(); Graph.touch(); }
  }
  function refreshPowertrainLegend() {
    const el = document.getElementById("pt-counts");
    if (!el) return;
    const c = powertrainCounts();
    el.textContent = c.engines
      ? `${c.engines} engine${c.engines === 1 ? "" : "s"} · ${c.variants} variant${c.variants === 1 ? "" : "s"} · ` +
        `${c.cars} car${c.cars === 1 ? "" : "s"} · ${c.fitted} fitted`
      : "nothing scanned yet";
  }
  function switchView(name) {
    if (name === activeView) return;
    const prevMode = graphMode;
    activeView = name;
    graphMode = GRAPH_VIEWS[name] || "main";
    // The Graph section is what both graph-layer tabs show; the tab strip
    // still highlights whichever one was asked for.
    const section = GRAPH_VIEWS[name] ? "graph" : name;
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + section));
    const yf = document.getElementById("yearfilter");
    if (yf) yf.style.display = name === "graph" ? "" : "none";
    const mainLegend = document.getElementById("legend");
    const ptLegend = document.getElementById("pt-legend");
    if (mainLegend) mainLegend.hidden = isPowerMode();
    if (ptLegend) ptLegend.hidden = !isPowerMode();
    hideHover();
    switchDetailAway();
    if (window.LlmFamilies) window.LlmFamilies.setEngaged(null);
    dt.hidden = true; dtNode = null;
    if (name === "timeline") CarWebTimeline.activate();
    if (name === "sixdeg") CarWebSix.activate();
    if (isPowerMode()) refreshPowertrainLegend();
    // Changing layer changes which nodes the simulation holds, so it is
    // rebuilt and re-framed -- the same thing a live mutation does.
    if (GRAPH_VIEWS[name] && prevMode !== graphMode) {
      invalidatePowerVis();
      Graph.clearFocus();
      buildSim();
      // Settling only matters going IN to the powertrain layer -- a few dozen
      // nodes, most of them still sitting where they were seeded. Coming back
      // out, the main graph's six thousand are already laid out from before
      // the switch and re-running their forces would cost a visible pause for
      // no change.
      if (isPowerMode()) Graph.settleAndFit();
      else Graph.refit(false);
    }
    if (GRAPH_VIEWS[name]) Graph.touch();
  }
  document.querySelectorAll(".tab").forEach(b => b.onclick = () => switchView(b.dataset.view));

  // ---------- footer counts (live, not baked) ----------
  // Used to print DATA.meta.counts (frozen at build time by build_data.py)
  // plus a raw links.length -- both wrong the moment anything changed at
  // runtime: an LLM-confirmed split mints new generation/person nodes and
  // links, a de-dup retires a standalone (which should no longer count),
  // a generation-list override retires nodes AND links, a live DBpedia
  // splice adds models before boot, and raw links.length also counted
  // structural "generation" hub links and retired links. Recomputed from
  // the live arrays instead, with the same category definitions
  // build_data.py's baked counts use (models = model nodes, nameplates
  // separate, designers/engineers = persons by role), minus anything
  // retired -- a hidden, superseded node isn't part of the visible web and
  // shouldn't be counted as if it were. Called at boot and after every
  // live graph mutation (applyLlmConfirmSilent / applyFamilyOverrideConfirm
  // / applyRelationConfirm / applySharedPlatformLive); page reloads (debug
  // deletes, live-refresh Apply) recount naturally at the next boot.
  function refreshCounts() {
    const el = document.getElementById("counts");
    if (!el) return;
    let models = 0, families = 0, makes = 0, designers = 0, engineers = 0;
    for (const n of nodes) {
      if (n.retired) continue;
      if (n.type === "model") models++;
      else if (n.type === "family") families++;
      else if (n.type === "make") makes++;
      else if (n.type === "person") {
        if (hasRole(n, "designer")) designers++;
        if (hasRole(n, "engineer")) engineers++;
      }
    }
    let conns = 0;
    for (const l of links) {
      if (l.retired || l.type === "generation") continue; // structural hub links aren't a "connection" between two cars
      // The footer describes the main graph, which the powertrain layer is
      // deliberately not part of -- "same nodes, same counts, same layout".
      if (POWERTRAIN_LINKS.has(l.type)) continue;
      const sn = l.sn || byId.get(typeof l.source === "string" ? l.source : (l.source && l.source.id));
      const tn = l.tn || byId.get(typeof l.target === "string" ? l.target : (l.target && l.target.id));
      if (!sn || !tn || sn.retired || tn.retired) continue;
      conns++;
    }
    el.textContent =
      `${models} models` + (families ? ` (${families} nameplates)` : "") +
      ` · ${makes} makes · ${designers} designers · ${engineers} engineers · ${conns} connections`;
  }

  // ---------- public ----------
  const api = {
    C, nodes, links, byId, adj, wiki, searchAll, renderResults,
    showHover, positionHover, hideHover, openDetail, nodeKicker, nodeMeta,
    nodeInLayer, linkInLayer, personRoleWord, hasRole, isPerson,
    // The powertrain layer, which is this same graph with graphMode flipped.
    graphMode: () => graphMode, powertrainCounts, isPowertrain,
    layer: () => layer, setLayer, onLayerChange: f => layerListeners.push(f),
    dbFilterOn: () => dbFilterOn, setDbFilter, onDbFilterChange: f => dbFilterListeners.push(f),
    isFamilyExpanded, expandFamily, collapseFamily, onFamilyChange: f => familyListeners.push(f),
    // The geometry of an expanded nameplate's bubble -- where its generations
    // sit and the circle nothing else may enter. Exposed for the regression
    // suite, which has to be able to check that nothing is inside it.
    ringOf,
    llmCheckOn: () => llmCheckOn, setLlmCheck,
    yearRange: () => ({ lo: yearLo, hi: yearHi, min: DATA_MIN_YEAR, max: DATA_MAX_YEAR }),
    setYearRange, onYearFilterChange: f => yearFilterListeners.push(f), passesYearFilter,
    refreshCounts,
    goto(id) {
      const n = byId.get(id);
      if (!n) return;
      if (activeView === "timeline") { CarWebTimeline.goto(n); }
      else { if (activeView !== "graph") switchView("graph"); Graph.gotoNode(n); }
    },
    // Used by the "Unconfirmed Relationships" browser panel -- unlike goto()
    // above, always lands in the graph view (a relation between two specific
    // cars, one of which may not even be on the timeline/six-degrees view's
    // own terms, is inherently a graph-layer concept).
    gotoPair(idA, idB) {
      if (activeView !== "graph") switchView("graph");
      Graph.focusPair(idA, idB);
    },
    switchView,
    // "Shared platforms only" filter, formerly the separate Platforms tab --
    // exposed here (same pattern as graphFocusSet below) so the jsdom suite
    // and any other outside caller can drive/inspect it without reaching
    // into Graph's own closure.
    platformsOnly: () => Graph.platformsOnly(),
    setPlatformsOnly: v => Graph.setPlatformsOnly(v),
    graphPlatformsNodeIds: () => Graph.state().platformsNodeIds,
    graphPlatformsRevealedIds: () => Graph.state().platformsRevealedIds,
    boot() {
      buildSim();
      Graph.init();
      CarWebTimeline.init();
      CarWebSix.init();
      refreshCounts();
      document.querySelectorAll("#layertoggle button").forEach(b =>
        b.onclick = () => setLayer(b.dataset.layer));
      api.onLayerChange(() => { Graph.touch(); });
      // Real user report: dragging the year slider wider while focused on a
      // nameplate/model didn't bring newly-in-range older generations into
      // the highlighted focus set -- Graph.touch() only marks the canvas
      // dirty (a redraw), it never recomputes WHICH nodes belong in
      // focusSet, so a generation that just became visible via
      // passesYearFilter() stayed excluded from the focus ring until the
      // user unfocused and refocused from scratch. refreshFocus() (already
      // used after live LLM mutations) recomputes focusSet from the current
      // focusRoot and inGraphView() state -- cheap no-op when nothing is
      // focused.
      api.onYearFilterChange(() => { Graph.touch(); Graph.refreshFocus(); });
      // A family expand/collapse can change which cars qualify for the
      // platforms-only filter (a generation-level platform link only
      // "counts" once its nameplate is expanded) -- this fires from every
      // source (Graph's own clicks, Timeline/Six Degrees cross-navigation,
      // a live LLM confirmation), not just Graph-originated ones.
      api.onFamilyChange(() => { if (Graph.platformsOnly()) Graph.touch(); });
      initYearFilterUI();
      const dbBtn = document.getElementById("dbfilter");
      if (dbBtn) {
        dbBtn.hidden = DB_IDS.size === 0;
        dbBtn.onclick = () => setDbFilter(!dbFilterOn);
      }
      // Same visibility condition as the My Database filter above (there's
      // at least one matched car) -- the review page itself still works
      // fine with zero matches (that's exactly what "Needs Review" is for),
      // this is just about not showing a debug-tool link to someone who
      // hasn't set up a Car Database folder at all.
      const dbMatchBtn = document.getElementById("dbmatchbtn");
      if (dbMatchBtn) dbMatchBtn.hidden = DB_IDS.size === 0;
      api.onDbFilterChange(() => { Graph.touch(); });
      // A newly-minted related car or designer/engineer starts at
      // year/born/died: null and gets a background Wikipedia-then-LLM-recall
      // lookup kicked off for it (see llm_families.js's scheduleFactBackfill
      // -- the "very big attempt" fix for e.g. the Puch G landing with no
      // year at all). That lookup finishes well after this node was already
      // drawn once with nulls, so nothing else would ever prompt a redraw on
      // its own. refreshYearFilter() too, since a node moving from
      // year:null to a real year can change both the slider's min/max
      // bounds and whether that node currently passes the filter at all.
      // A related PARTNER that turned out to hide generations (see
      // llm_families.js's schedulePartnerCheck -- the Honda Odyssey / Acura
      // MDX report). That check can only RECORD the split; minting the
      // generations and wiring them into byId/adj/LABEL_ORDER has to happen
      // here. Without this the generations were genuinely discovered and then
      // left sitting in memory with nothing able to apply them, because the
      // one code path that DOES apply a cascade split (the relation panel's
      // own branch) never sees a partner matched exactly by name -- that
      // connection is hard-confirmed at nameplate level the moment it's
      // found, and the panel deliberately skips anything already confirmed.
      //
      // Re-rendering afterwards matters as much as the apply: with the
      // partner now a real nameplate, unresolvedFamilyRelations' ordinary
      // adjacency scan picks the pair up under its NAMEPLATE-level key (which
      // has no entry yet, unlike the generation-level one already confirmed)
      // and runs a fresh disambiguation with both real generation lists —
      // which is the second half of the request, "to then make the links
      // between the generations."
      if (window.LlmFamilies && window.LlmFamilies.onSplitReady) {
        window.LlmFamilies.onSplitReady(partner => {
          try {
            applyLlmConfirmSilent(partner);
          } catch (e) {
            console.error("CarWeb: could not apply a partner's generation split", e);
            return;
          }
          if (dtNode) { renderLlmCheck(dtNode); renderRelationChecks(dtNode); }
        });
      }
      if (window.LlmFamilies && window.LlmFamilies.onFactsUpdate) {
        window.LlmFamilies.onFactsUpdate(() => {
          refreshYearFilter();
          Graph.touch();
          if (dtNode) openDetail(dtNode);
        });
      }
      const platformsBtn = document.getElementById("platformsonly");
      if (platformsBtn) platformsBtn.onclick = () => Graph.setPlatformsOnly(!Graph.platformsOnly());
      const llmBtn = document.getElementById("llmcheck");
      if (llmBtn) {
        llmBtn.hidden = !(window.LlmFamilies && window.LlmFamilies.serverAvailable);
        llmBtn.classList.toggle("active", llmCheckOn);
        llmBtn.onclick = () => setLlmCheck(!llmCheckOn);
      }
      initLlmDebugPanel();
      initLlmPlaygroundPanel();
      initUnconfirmedRelPanel();
      initAddCarPanel();
      initAddEnginePanel();
      initModifyCarPanel();
      initDeletePanel();
      initRebuildPanel();
      initLlmResetPanel();   // after it: reuses its runner, see rebuildRunner
      initTransitiveSetting();

      // Every panel under Tools writes through serve.py's JSON API, so with no
      // server reachable -- a plain file:// open, or a deployed static build --
      // they can only ever report that nothing can be saved. LLM Check and Add
      // Car already gated themselves on serverAvailable; these five did not, so
      // a visitor to the public site was offered a menu of controls that all
      // dead-end. initToolsMenu() below drops the whole Tools button once every
      // item inside it is hidden, so gating them here removes the menu itself.
      if (!(window.LlmFamilies && window.LlmFamilies.serverAvailable)) {
        for (const id of ["llmdebugbtn", "llmplaygroundbtn", "unconfirmedrelbtn",
                          "modifycarbtn", "deletebtn", "genphotosbtn"]) {
          const el = document.getElementById(id);
          if (el) el.hidden = true;
        }
      }

      // The legend listed the "My Database" ring and the "my garage" marker
      // unconditionally, but both are written by build_db_layer.py, which a
      // public build never runs -- so the legend described two colours nothing
      // on screen actually used. Driven by the data rather than hardcoded, so a
      // private build carrying those flags still shows both rows.
      const lgDb = document.getElementById("lg-db");
      const lgGarage = document.getElementById("lg-garage");
      if (lgDb) lgDb.hidden = !nodes.some((n) => n.db);
      if (lgGarage) lgGarage.hidden = !nodes.some((n) => n.garage);

      // Decides the proposals that were already queued when the policy
      // arrived: a year overlap under an exactly-matched nameplate is a real
      // link, a substring name match is not a match at all. See
      // llm_families.js's resolveWeakRelations.
      if (window.LlmFamilies && window.LlmFamilies.resolveWeakRelations) {
        const r = window.LlmFamilies.resolveWeakRelations(byId);
        if (r.confirmed.length) {
          console.info(`[carweb] confirmed ${r.confirmed.length} year-overlap platform link(s):`,
                       r.confirmed.map(d => `${d.a} <-> ${d.b}`));
        }
        if (r.dropped.length) {
          console.info(`[carweb] dropped ${r.dropped.length} substring/cross-company proposal(s):`,
                       r.dropped.map(d => `${d.a} <-> ${d.b}`));
        }
      }
      // Any additive cross-check that was stored but never applied -- a
      // session that ran the check with the panel open and then closed the
      // tab, or one from before this rule existed. Same verdict, same confirm
      // path; idempotent, because applying flips the entry to "applied" and
      // additiveRecheck only ever looks at "provisional" ones.
      if (window.LlmFamilies && window.LlmFamilies.allRecheckEntries) {
        try {
          window.LlmFamilies.allRecheckEntries()
            .filter(e => e.status === "provisional")
            .forEach(e => {
              const fam = byId.get(e.id);
              if (fam && fam.type === "family") autoAcceptAdditiveRecheck(fam);
            });
        } catch (e) { console.warn("CarWeb: could not apply pending cross-checks", e); }
      }
      // Stand-in orphans, cleared automatically. Has to run HERE, after every
      // overlay pass above has minted whatever it mints: "not in the graph"
      // asked any earlier would be true of cars that are merely not created
      // yet, and this deletes what it finds. See llm_families.js's
      // pruneStandInOrphans for which kind is cleared and which is kept.
      if (window.LlmFamilies && window.LlmFamilies.pruneStandInOrphans) {
        try {
          const p = window.LlmFamilies.pruneStandInOrphans(byId);
          if (p.cleared) {
            console.info(`[carweb] cleared ${p.cleared} decision(s) filed under a placeholder ` +
                         "car that no longer exists:",
                         p.entries.map(e => `${e.what} — ${e.id}`));
          }
        } catch (e) { console.warn("CarWeb: could not clear stand-in orphans", e); }
      }
      initGenPhotos();
      initLlmBusy();
      initPhoneNav();
      initLegendToggle();
      initToolsMenu();
      initLlmRequest();
      // The work queue. Runners first (nothing can run without them), then
      // the panel, then resume: anything left over from a previous session --
      // including a job that was mid-pass when the page reloaded or serve.py
      // was stopped -- starts here rather than being lost. See
      // llm_families.js's resumeJobs.
      initLlmJobRunners();
      initLlmQueuePanel();
      if (window.LlmFamilies && window.LlmFamilies.resumeJobs) {
        const q = window.LlmFamilies.resumeJobs();
        if (q && q.waiting) {
          console.info(`[carweb] scan queue: ${q.waiting} request(s) waiting` +
                       (q.recovered ? `, ${q.recovered} recovered from an interrupted run` : ""));
        }
        // ?agent=1 is the agent's own page (scripts/llm_agent.py). It starts
        // the queue itself, after stamping its decisions as "agent" -- a job
        // started during boot would have been filed as a person's decision.
        // Any other page is a person's browser, so it starts now.
        if (!/[?&]agent=1(?:&|$)/.test(location.search) && window.LlmFamilies.startJobs) {
          window.LlmFamilies.startJobs();
        }
      }
      initAutoRefresh();
      restoreViewState();
      setDataStatus();
      dropLiveLayerStorage();
    },
    sim: () => sim,
    // The Graph itself. Exposed for the regression suite, which now drives
    // both layers through it -- there is no second renderer to drive.
    Graph,
    graphFocusSet: () => Graph.state().focusSet,
    graphCamera: () => Graph.camera(),
    graphDrawNow: () => Graph.drawNow(),
    simTick: n => Graph.simTick(n),
    // The same reinitialize-over-the-current-arrays call every live graph
    // mutation already makes (see applyLlmConfirmSilent and friends). Exposed
    // so a test can add a node or a link and have the forces actually see it.
    rebuildSim: () => buildSim(),
    // Wire nodes/links appended since those counts into byId/adj -- the same
    // call every live mutation makes. Exposed so a test that pushes nodes
    // directly (an engine article applied by hand) can put the graph in the
    // state the real code path leaves it in, rather than a half-indexed one.
    spliceIntoIndexes,
    isPowertrain, powertrainLinkTypes: () => POWERTRAIN_LINKS,
    scanEngine, renderPowertrain, recordEnginesLive, mergeEnginePrompt, scanEnginesLive,
    // The work queue, from outside: `scanEngine` and the card's own buttons
    // all go through it, and the agent's settle test sees it through
    // LlmFamilies.pendingWork. requestScan is the one-call "do to this node
    // whatever its own card's check would do", which is what the queue panel
    // and the agent both want.
    llmJobSpecFor,
    requestScan: n => { const spec = llmJobSpecFor(n); return spec ? enqueueLlmJob(spec) : null; },
    scanEngineNow, runManualRecheckNow, runGenerationResearchNow,
    graphTransform: () => Graph.state().t,
  };
  return api;
})();
