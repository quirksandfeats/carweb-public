/* LLM-assisted nameplate generations — reads a car's Wikipedia article
 * through a locally-running llama.cpp model to spot generations that
 * DBpedia never split out (e.g. Mercedes-Benz G-Class: W460/W461/W463/W464
 * all live as sections of ONE article, so the build-time family layer,
 * which only groups nameplates that already have separate per-generation
 * Wikipedia articles, can't see them).
 *
 * Everything this module discovers lives in llm_families.json — a file kept
 * completely separate from cars.json/data.js. Nothing here is trusted until
 * you say so: a proposal sits as "provisional" until you confirm it (Yes),
 * reject it (No), or send it back with a reason for another attempt. Delete
 * llm_families.json (or POST {"families":{}} to /api/llm-families) any time
 * to wipe this layer back to nothing — the DBpedia-built graph is untouched.
 *
 * Requires app/serve.py running (not a plain static file server, and not
 * file://) so the browser has a same-origin /api/llm/chat proxy (itself
 * proxying to a local llama-server -- see serve.py's own module docstring
 * for the full setup) and /api/llm-families read/write endpoint. If those
 * aren't reachable, this module quietly no-ops — the rest of the app works
 * exactly as before.
 */
window.LlmFamilies = (function () {
  "use strict";

  // NOTE: the model name is deliberately NOT configured here. There is
  // exactly ONE obvious place to change/select the model: the
  // LLAMA_MODEL/LLAMA_MODEL_ALIAS constants + comment near the top of
  // serve.py's "llama-server lifecycle" section. askLlamaCpp below sends no
  // "model" field at all; serve.py's do_POST /api/llm/chat handler always
  // stamps every outgoing request with whatever serve.py's
  // LLAMA_MODEL_ALIAS currently is before forwarding it to llama-server.
  // Context-window size (the old OLLAMA_NUM_CTX) has moved server-side too,
  // for the same "one place, not two" reason -- llama.cpp's --ctx-size is a
  // server-startup property (see serve.py's LLAMA_CTX_PER_REQUEST), not
  // something a per-request "options" field can override the way Ollama's
  // could, so there's nothing left to configure about it here at all. See
  // askLlamaCpp's own comment for why every request still gets an
  // "enable_thinking": false hint sent from THIS side too, even though the
  // model is also configured that way at server startup.
  const MAX_ATTEMPTS = 4;

  // In-memory mirror of llm_families.json, seeded synchronously at page load
  // (see the inline bootstrap script in index.html) so it's ready before
  // app.js builds its node/link indexes. Kept as a clean {families:{...}}
  // shape — the exact thing that gets POSTed back to serve.py — separate
  // from the boot-time availability flag.
  const bootData = window.LLM_FAMILIES || {};
  const store = {
    families: bootData.families || {}, relations: bootData.relations || {},
    // Cross-checks of an EXISTING nameplate's generation list against a
    // fresh read of its Wikipedia article -- separate from `families`
    // (which is "does this plain model hide multiple generations at all")
    // since a nameplate being rechecked here may already be a real family,
    // build-time-grouped or LLM-discovered, with no `families` entry of its
    // own at all (build-time families never go through checkNode). See
    // checkFamily/applyFamilyOverride below.
    recheck: bootData.recheck || {},
    // Permanent blacklist of relation keys the user has explicitly deleted
    // via the LLM Debug panel -- see rejectRelation()/resolvePlatformMention
    // below. Real bug report: deleting a "confirmed" relation (e.g. an
    // inaccurate Jeep Commander (XK) <-> Toyota C-HR platform match) only
    // ever removed it from store.relations, but applyConfirmed() re-runs
    // resolvePlatformMention() for every confirmed family on EVERY page
    // boot, and its only guard against recreating a relation is "does
    // store.relations[key] already exist" -- which no longer held once the
    // key was deleted, so the exact same "confirmed" match silently came
    // right back on the next reload, looking exactly like deletion simply
    // didn't work. This list is checked in addition to store.relations so a
    // deleted auto-discovered match stays gone for good.
    rejectedRelations: bootData.rejectedRelations || {},
    // Why a weak proposal was auto-rejected for crossing company lines --
    // see weakProposalRejection. Kept separately from rejectedRelations
    // (a plain key -> true map) because rule 2 counts these.
    crossGroupRejections: bootData.crossGroupRejections || {},
    // Transitive relationships the user has decided on -- confirmed ones
    // become real links, rejected ones must never be re-proposed. Keyed the
    // same unordered way as the proposal itself so a pair can't come back
    // under a reversed key. See inferTransitiveRelations.
    transitive: bootData.transitive || {},
    // App-level settings that belong to the data rather than to a browser --
    // currently just the transitive hop count, which overrides serve.py's
    // TRANSITIVE_MAX_HOPS default.
    settings: bootData.settings || {},
    // Real bug report: "even though I clear the positive (and negative) llm
    // messages, they reappear after a refresh." Dismissing an LLM message
    // (either the individual ✕ close button, or the debug panel's bulk
    // "Clear all positive messages") used to only ever add to app.js's own
    // in-memory dismissedLlm Set -- deliberately session-only by original
    // design ("reopening the panel later... naturally shows a box again
    // since it's a genuinely new result"), but that reasoning only really
    // applies to a dead-end verdict that might change on a fresh check, not
    // to a plain "I've seen this, stop showing it" dismissal the user
    // explicitly asked for. Persisted here now, same pattern as
    // rejectedRelations above -- a plain key -> true map, round-tripped
    // through serve.py's /api/llm-families exactly like everything else in
    // this store, so a dismissal survives a page refresh.
    dismissed: bootData.dismissed || {},
    // Real user request: a brand-new node minted from something the LLM
    // found (a related car with no existing graph entry, or a designer/
    // engineer name with no existing person node) always used to get
    // year/end (or born/died/country) hardcoded to null, permanently --
    // e.g. the Puch G, minted as a Mercedes-Benz G-Class platform-mate,
    // never even attempted to find its actual production year. This is the
    // persistent cache for the "big attempt" fix (see scheduleFactBackfill
    // and its two callers below): a background Wikipedia-then-LLM-recall
    // lookup runs once per newly-minted id, and whatever it finds (a real
    // year, or a confirmed "genuinely couldn't find one") is cached here so
    // mintRelatedNode/resolvePersonNode read it back on every later boot
    // instead of repeating the lookup (or losing the answer) every time the
    // page reloads and re-mints the same node from a confirmed relation.
    // Keyed by node id; a model entry looks like {year, end, source,
    // checkedAt}, a person entry {born, died, country, source, checkedAt}.
    mintedFacts: bootData.mintedFacts || {},
    // Real bug report: a car added by hand via the "Add Car" panel showed up
    // fine in the tab that added it (mintAndOpen splices it straight into
    // the live nodes/links/byId/adj), but was completely gone on the next
    // page load or in any other tab -- clicking its make or searching for it
    // found nothing, because nodes/links get rebuilt from scratch off
    // cars.json/data.js on every boot, and nothing about a manually-typed
    // make/model was ever recorded anywhere that rebuild could see. Keyed by
    // the exact node id mintAndOpen already generated, so applyUserCars
    // below can recreate the identical node on every future boot -- same
    // "store just enough to deterministically replay the mint" pattern
    // mintRelatedNode's callers already rely on for auto-discovered related
    // cars (see the relations key), just for a user-typed one instead.
    userCars: bootData.userCars || {},
    // Real user request: "if the wikipedia page is not available and the
    // program isn't able to find it, then the info box should have a
    // location for the user to be able to put in the wikipedia link with
    // the car associated." A node's `wp` field only ever comes from
    // build-time DBpedia data, an auto-guessed/searched title (Add Car,
    // mintRelatedNode's own background lookup below), or -- now -- this:
    // a manually pasted URL for a car that came up empty on both automatic
    // paths. Keyed by node id -> the resolved title string, exactly like
    // `userCars` is keyed by id -> its own base fields, and replayed the
    // same deterministic way at every boot (see applyWpLinks below) since
    // nothing about the node itself survives a reload except through this
    // store.
    wpLinks: bootData.wpLinks || {},
    // Real user request (the Mercedes-Benz E-Class W211 case): "it would be
    // actually worth checking if there exists a separate wikipedia page for
    // each of these generations, and then use that wikipedia page for the
    // LLM to read through and get a better understanding of all of the
    // relationships. Additionally, the user should also be able to do an LLM
    // search on an individual generation as well." Every other layer in this
    // store is keyed by a NAMEPLATE (or plain model) id; this one is keyed by
    // a GENERATION id, recording the outcome of a research pass run against
    // that generation's own, more specific Wikipedia article. Kept separate
    // from `families` because it answers a completely different question --
    // not "does this hide multiple generations" (a generation by definition
    // doesn't) but "what does this specific generation's own article say
    // about who built it and what it's related to". See researchGeneration.
    genResearch: bootData.genResearch || {},
    // Real user request: "in the 'Tools' Section there should also be a
    // 'Modify Existing Car' button which lets the user... ask for a
    // particular request with the LLM, like potentially merging multiple
    // models together into one nameplate if it has not been previously
    // caught." A merge is structural (it turns N standalone models into one
    // family with N generations), so like every other structural decision in
    // this file it has to be replayable from scratch on every boot -- see
    // applyMerges. Keyed by the id of the model that becomes the family.
    merges: bootData.merges || {},
    // Real user request: "I want to also be able to delete makes (and models,
    // nameplates, or generations, or designers/engineers) within the 'tools'
    // tab... This should be universally deletable, meaning that even if the
    // data comes directly from dbpedia or my database, it should also be
    // deletable, however should be stored somewhere that 'hard data' (not LLM
    // data) has been deleted, and therefore should also be recoverable."
    //
    // Every other layer in this file only ever ADDS to (or reinterprets) the
    // build-time snapshot; this is the first that takes something away from
    // it. That makes the "recoverable" half non-negotiable rather than a nice
    // extra: `cars.json`/`data.js` are never edited, so a deletion is just a
    // record here saying "hide this id", and restoring is deleting that
    // record. `hard: true` marks a node that came from the build-time
    // snapshot (DBpedia harvest, curated core, My Database match) rather than
    // anything this LLM layer invented -- the delete/restore panel surfaces
    // those separately, since losing one loses genuinely harvested data until
    // it's restored, while an LLM-invented node can always be rediscovered by
    // re-running a check. Keyed by node id.
    deletions: bootData.deletions || {},
    // Real user request: "within 'Modify existing cars', I should also be able
    // to change the name of the make, model, nameplate, engineer/designer,
    // etc..." Same replay discipline as everything else here -- the snapshot
    // is never rewritten, the new label is re-stamped onto the node at every
    // boot (see applyRenames). Keyed by node id -> {label, previousLabel}.
    renames: bootData.renames || {},
    // Escape hatch for the automatic duplicate-nameplate merge below (see
    // mergeDuplicateNameplates). That merge is derived deterministically from
    // the data on every boot rather than persisted, so this is the only way
    // to say "no, leave that particular pair alone" and have it stick.
    unmergedDuplicates: bootData.unmergedDuplicates || {},
    // Real user request, on the Honda Civic merge: "If the LLM is unsure which
    // to pick, then it should prompt the user and have the user confirm which
    // information to take." When a merge finds two different articles both
    // claiming to BE the nameplate, it records the conflict instead of
    // guessing and the answer lands here. Keyed by the nameplate's node id ->
    // the chosen article title. See applyOneMerge/resolveMergeWpChoice.
    mergeWpChoices: bootData.mergeWpChoices || {},
    // Real user request: "there is a 'deleted so far' section, which I want
    // to also have a 'clear' option which lets me remove the cars completely,
    // so they are still deleted but also do not appear in the 'deleted so
    // far', since they are completely deleted from the system, including in
    // any file which this information was ever stored."
    //
    // Ordinary deletion in this file is a recorded HIDE, precisely so it can
    // be undone (see deleteNode). This is the other half the request asks
    // for: a purge wipes every trace of a node out of every other key in this
    // store -- the entry that minted it, its cached facts, its relations, its
    // merges, its renames -- and then leaves ONE tombstone here so it can
    // never come back. The tombstone is unavoidable rather than a compromise:
    // `data.js` is rebuilt from the pipeline on every boot and is never
    // edited by this layer, and an LLM-minted car is re-derived from whatever
    // article mentioned it, so without a permanent "never re-create this id"
    // marker a purged car would simply reappear on the next rebuild or the
    // next check. Keyed by node id -> {label, purgedAt}. Nothing in the UI
    // lists these, which is exactly what "no longer appears in Deleted so
    // far" means.
    purged: bootData.purged || {},
    // Real user request: "I also want an 'unmerge' option just like how there
    // is a 'merge' option in the 'modify existing car' section, if the car
    // that I selected is a nameplate. This would unmerge all of the
    // generations of the car from the existing 'nameplate' of the car."
    //
    // The mirror image of `merges`, and deliberately a record of its own
    // rather than "delete the merge record": a nameplate can be a nameplate
    // for four different reasons (baked into the build-time snapshot, split
    // out by the LLM, folded together by the automatic duplicate merge, or
    // merged by hand here), and only the last of those is undone by removing
    // a merge record. One decision, replayed at boot after every layer that
    // could have built a family, undoes all four the same way. Keyed by the
    // nameplate's node id -> {label, unmergedAt}. See applyUnmerges.
    unmerges: bootData.unmerges || {},
    // Engines the local model has read, keyed by engine node id -> {status,
    // checkedAt, sourceTitle, article}. The powertrain layer's equivalent of
    // `families`: the article is stored as read, and the graph is rebuilt
    // from it at boot rather than the nodes being persisted themselves.
    engines: bootData.engines || {},
    // Engines folded into one another, primary id -> {memberIds, mergedAt}.
    // The powertrain twin of `merges`; see applyOneEngineMerge.
    engineMerges: bootData.engineMerges || {},
    // Which cars have had their engines read, node id -> {checkedAt,
    // sourceTitle, engines}. Separate from `genResearch` because that means
    // "the model read this generation's whole article"; this only means "the
    // infobox's engine field was looked at", which costs no model call.
    engineScans: bootData.engineScans || {},
    // What the orphan prune cleared, one line per decision -- see
    // pruneStandInOrphans and clearRenamedOrphans.
    //
    // Loaded back here for a reason worth spelling out: `store` is an explicit
    // literal of known keys, and persist() POSTs the whole of it. A key that
    // is created only when the prune has something to clear therefore exists
    // for exactly one session -- the run that cleared something writes it, and
    // the very next persist() on a later boot, having never created the key,
    // writes a store without it and silently wipes the archive from the file.
    // Caught by reading the real llm_families.json after the first boot in the
    // wild had cleared 78 stand-in entries: they were gone, correctly, and the
    // record of them was gone too.
    prunedDecisions: bootData.prunedDecisions || {},
  };

  // Whether /api/llm-families was actually reachable at boot — if not (e.g.
  // still on file://, or plain http.server without serve.py's routes), every
  // public method below becomes a safe no-op instead of failing repeatedly.
  const serverAvailable = !!bootData.__serverAvailable;

  // ---------- how far one click is allowed to cascade ----------
  // Real user question: "does this code essentially just check the current
  // model selected and its directly related models... [or does it also do]
  // yet another (unintended) additional nameplate which is related to the
  // nameplate that the original model was related to?"
  //
  // It was the latter, without limit. Applying a partner's generation split
  // runs the same related-car discovery over ITS generations, which schedules
  // a check on ITS partners, which when applied does the same again --
  // clicking one car could walk outward across the graph, one LLM call per
  // hop. Measured on a deliberate A->B->C->D->E chain: clicking A alone
  // checked and split all five. The only brakes were incidental ("each car is
  // checked at most once ever", a serial queue), never a depth limit.
  //
  // Depth 0 is a car the user actually selected; its directly-named partners
  // are depth 1. At the default of 1, a second-hop partner is still LINKED in
  // the graph and still fully checkable -- clicking it makes it depth 0 in its
  // own right -- so nothing is lost, the cost of any one click just stays
  // predictable. Configured server-side (serve.py's CASCADE_MAX_DEPTH, sent
  // down on the same GET that seeds this store) so there's one place to
  // change it; falls back to 1 on a static file:// build, which has no
  // server to ask and no LLM to spend anyway.
  // ---------- is background LLM work currently authorised? ----------
  // Real bug report: "Sometimes it seems like the program does an LLM search
  // on a car even though I didn't specify that I wanted to do an LLM search
  // on it. The LLM search toggle isn't turned on, I simply clicked on a car
  // and it did the search anyways" -- with a terminal log showing dozens of
  // calls (Ford C1, Chevrolet HHR, Opel Zafira A, GM platforms...) from one
  // Honda Prelude click.
  //
  // Three background schedulers fired with no reference to the toggle at all:
  // scheduleWpLookupAndCheck (look up a minted car's article, then CHECK it),
  // scheduleFactBackfill (production years / designer bios), and
  // schedulePartnerCheck (gated on engagedId, but never on the toggle). Worse,
  // the first two aren't gated on engagedId either -- and mintRelatedNode runs
  // during applyConfirmed's BOOT replay for every confirmed family, so simply
  // loading the page could kick off a pile of LLM calls nobody asked for.
  //
  // One gate now covers all three, driven by app.js: work is authorised while
  // 🤖 LLM Check is on, and continues for the specific car whose own check is
  // still finishing (app.js disengages the toggle the moment a check starts --
  // see disengageLlmCheckFor -- so gating on the raw toggle alone would cut
  // off the very cascade the user just asked for). Defaults to FALSE, which
  // is what makes a page load silent.
  let backgroundAllowed = false;
  function setBackgroundAllowed(v) { backgroundAllowed = !!v; }

  // A manual "LLM re-check" is a person asking, deliberately, what a fresh
  // read of this one article turns up. The loose-match drop in
  // resolveOnePlatformMention exists to stop an automatic background pass
  // from filing coincidences of letters nobody asked for -- that reasoning
  // doesn't hold when somebody is sitting there waiting for the answer, so
  // it is lifted for the duration of that single pass and whatever the read
  // found is put in front of them as an ordinary proposal instead of being
  // decided on their behalf. Set only by reworkRelationsForFamily, around
  // its own loop, and always cleared in a finally.
  let surfaceLooseMatches = false;

  const CASCADE_MAX_DEPTH_DEFAULT = 1;
  const cascadeMaxDepth = (() => {
    const v = bootData.__config && bootData.__config.cascadeMaxDepth;
    return Number.isFinite(v) && v >= 0 ? v : CASCADE_MAX_DEPTH_DEFAULT;
  })();
  // node id -> how many hops from a user-selected car it was reached in.
  // Deliberately session-only (a Map, not part of `store`): it describes this
  // browsing session's path through the graph, not a fact about the cars.
  const cascadeDepth = new Map();
  function depthOf(id) { return cascadeDepth.has(id) ? cascadeDepth.get(id) : 0; }
  // Would a partner discovered from `originId` be within the limit? Exposed so
  // app.js's own relation-panel cascade honours the same budget rather than
  // keeping a second, separately-drifting rule.
  function cascadeAllowedFrom(originId) { return depthOf(originId) + 1 <= cascadeMaxDepth; }
  // Real user request: "when I hit 'llm re-check', I want it to essentially do
  // a re-check of the entire car that I selected, as well as its cascade max
  // depth length that I would normally do when I check a car using LLM for the
  // first time."
  //
  // It didn't, and the reason is this map. Distances accumulate across a
  // session: a partner reached at depth 1 during an earlier check keeps that
  // distance, so when you later open THAT car and re-check it, its own
  // partners compute to depth 2 and the budget refuses them -- the re-check
  // re-read the article and stopped. Re-checking is an explicit "start again
  // from this car" instruction, so the honest thing is to start the distance
  // bookkeeping again too: forget every recorded distance and re-seed this car
  // at zero, exactly as setEngaged does for a first-time click.
  function resetCascadeFrom(nodeId) {
    cascadeDepth.clear();
    if (nodeId) cascadeDepth.set(nodeId, 0);
  }

  function entryFor(nodeId) { return store.families[nodeId] || null; }

  // Which node the user currently has the detail panel open on, for LLM
  // purposes — app.js keeps this in sync with its own dtNode (open/close/
  // switch). A "provisional" proposal is only ever written to disk once the
  // user decides Yes/No/Retry on it; if they walk away first — close the
  // panel, or switch straight to a different car — without deciding, it's
  // discarded rather than silently recorded in the background. "none" and
  // "error" verdicts are unaffected: there's no pending decision to walk
  // away from, so those still persist as soon as they're known.
  let engagedId = null;
  function setEngaged(nodeId) {
    engagedId = nodeId || null;
    // A car the user actually selected is depth 0 by definition -- including
    // one that was itself reached as a partner earlier. That's what makes the
    // one-hop default lossless: anything the cascade declined to follow is
    // still one click away from being followed fully.
    if (nodeId) cascadeDepth.set(nodeId, 0);
  }
  function discardPending(nodeId) {
    const e = store.families[nodeId];
    if (e && e.status === "provisional") delete store.families[nodeId];
    const r = store.recheck[nodeId];
    if (r && r.status === "provisional") delete store.recheck[nodeId];
  }
  // Avoids kicking off a second concurrent llama.cpp call for the same car if
  // the user closes and reopens it while the first check is still running.
  const inFlight = new Map();

  // Background fact-backfill (year/end for a newly minted model, born/died/
  // country for a newly minted person -- see scheduleFactBackfill below)
  // updates a node's fields well after the synchronous mint/apply pass that
  // created it has already finished and the graph has already been drawn.
  // app.js has no way to know that happened on its own; this is the same
  // "subscribe, get told when something changes in the background" shape as
  // app.js's own onFamilyChange/onDbFilterChange listener lists, just owned
  // here since the change originates here.
  const factsListeners = [];
  function notifyFactsUpdate() { factsListeners.forEach(f => { try { f(); } catch (e) { /* one bad listener shouldn't break the others */ } }); }

  function isEligible(n) {
    // Only plain, ungrouped models are candidates — not makes/people, not
    // anything already split (by the build-time layer OR by this one), not
    // a generation that already belongs to some family, and not a retired
    // node (a standalone superseded by some family's generation via the
    // de-dup layer -- it's permanently hidden, so checking it would burn an
    // llama.cpp call proposing a split nobody can ever see or act on).
    return !!n && n.type === "model" && !n.familyOf && !n.retired;
  }

  function recheckEntryFor(nodeId) { return store.recheck[nodeId] || null; }
  function isEligibleForRecheck(n) {
    // Any nameplate family — build-time-grouped or LLM-discovered. This is
    // deliberately broader than isEligible() above: it exists to catch a
    // family whose GENERATION LIST ITSELF is wrong, most commonly
    // build_family_layer.py's BARE-FOLD pass (see its own comment) folding
    // in an un-suffixed article that isn't really a distinct generation at
    // all — e.g. a bare "BMW X3" article ending up listed as one of the X3
    // family's own "generations" right alongside X3 (G01)/(F25)/... Build-
    // time family nodes don't carry their own `wp` field (only their
    // individual generations do) — app.js resolves a usable article title
    // (a bare-titled sibling generation's own wp, or a plain "make label"
    // guess) before calling checkFamily/retryFamilyCheck, so eligibility
    // here doesn't require `n.wp` to already be set. Nothing here is
    // trusted automatically either way — same provisional-until-confirmed
    // discipline as the rest of this file.
    return !!n && n.type === "family";
  }

  async function persist() {
    if (!serverAvailable) return;
    try {
      await fetch("/api/llm-families", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(store),
      });
    } catch (e) {
      console.warn("LlmFamilies: could not persist llm_families.json", e);
    }
  }

  // Say what the page is doing, in serve.py's terminal. Everything in this
  // file except the model calls goes browser-to-Wikipedia and so left no
  // trace there at all -- which made a single slow model call look like the
  // only thing happening while several other passes ran invisibly beside it.
  // Fire-and-forget on purpose: a note that does not arrive must never delay
  // or fail the work it describes.
  function note(text) {
    if (!serverAvailable || !text) return;
    try {
      fetch("/api/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: String(text) }),
      }).catch(() => {});
    } catch (e) { /* nothing here is worth interrupting for */ }
  }

  // ---------- Wikipedia: fetch wikitext, pull just the infobox + headings ----------
  // Full articles can run 60-80k+ characters (Mercedes G-Class did); feeding
  // that whole thing to a 7B local model is slow and mostly noise. The
  // infobox and section headings are where generation breakdowns usually
  // live, so that's the bulk of what we send — plus a lightweight scan for
  // generation announcements in body prose (see generationCues below), for
  // nameplates that don't say it cleanly in either of those two places.
  // A short-lived cache of article reads. Several passes now want the same
  // wikitext within moments of each other -- the generation check reads a
  // nameplate's article, the engine scan then reads it again to find out where
  // each generation's article is, and findGenerationArticle re-reads it to
  // compare resolved titles. Same bytes, three round trips.
  //
  // Deliberately short. A deliberate re-check minutes later is a person asking
  // what the article says NOW, and must not be served a stale copy; within a
  // minute of the last read it cannot have meaningfully changed.
  const ARTICLE_CACHE_MS = 60 * 1000;
  const ARTICLE_CACHE_MAX = 24;
  const articleCache = new Map();
  function cachedArticle(title) {
    const hit = articleCache.get(title);
    if (!hit) return null;
    if (Date.now() - hit.at > ARTICLE_CACHE_MS) { articleCache.delete(title); return null; }
    return hit.value;
  }
  function cacheArticle(title, value) {
    articleCache.set(title, { at: Date.now(), value });
    while (articleCache.size > ARTICLE_CACHE_MAX) {
      articleCache.delete(articleCache.keys().next().value);
    }
  }

  async function fetchArticleDigest(title) {
    const cached = cachedArticle(title);
    if (cached) return cached;
    const url = "https://en.wikipedia.org/w/api.php?action=parse&format=json&origin=*&prop=wikitext&redirects=1&page=" +
      encodeURIComponent(title);
    const r = await fetch(url);
    if (!r.ok) throw new Error("wikipedia fetch failed: " + r.status);
    const j = await r.json();
    const wikitext = j && j.parse && j.parse.wikitext && j.parse.wikitext["*"];
    if (!wikitext) throw new Error("no wikitext for " + title + " (article may not exist / was redirected oddly)");
    // resolvedTitle is what Wikipedia ACTUALLY served after following
    // redirects, which can differ from what was asked for. Needed by
    // findGenerationArticle below: guessing "Mercedes-Benz E-Class (W211)"
    // and guessing "Toyota 86 (ZN6)" both "succeed" as fetches, but only the
    // first is a genuinely distinct article -- the second just redirects
    // straight back to the nameplate's own page. Comparing resolved titles
    // is the only reliable way to tell those two cases apart.
    const out = { wikitext, digest: extractDigest(wikitext), resolvedTitle: (j.parse && j.parse.title) || title };
    cacheArticle(title, out);
    return out;
  }

  // ---------- public: Wikipedia lookup for a manually-added car ----------
  // Real user request: "Add Car" lets Andy type a make + model by hand
  // rather than discovering it from some OTHER article's own text -- the
  // only way a new car has ever entered the graph before this feature. With
  // no mention text to work from, this tries the most likely article title
  // directly first, then falls back to Wikipedia's own search API. If
  // neither finds a real article, app.js asks the user for the URL
  // themselves rather than guessing further or giving up silently.
  async function tryWikipediaTitle(title) {
    if (!title) return false;
    try { await fetchArticleDigest(title); return true; }
    catch (e) { return false; }
  }
  async function searchWikipediaTitle(query) {
    try {
      const url = "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=3&srsearch=" +
        encodeURIComponent(query);
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      const hits = (j && j.query && j.query.search) || [];
      return hits.length ? hits[0].title : null;
    } catch (e) { return null; }
  }
  async function findWikipediaTitleFor(makeLabel, modelLabel) {
    const guess = `${makeLabel} ${modelLabel}`.trim();
    if (await tryWikipediaTitle(guess)) return guess;
    const searched = await searchWikipediaTitle(guess);
    if (searched && searched !== guess && await tryWikipediaTitle(searched)) return searched;
    return null;
  }
  // A user-supplied Wikipedia URL, used when the automatic guess/search
  // above couldn't find the article on its own -- extracts the article
  // title and verifies it's real (redirects included, same as every other
  // article fetch in this file), rather than trusting the URL's shape alone.
  function titleFromWikipediaUrl(url) {
    try {
      const u = new URL(String(url).trim());
      if (!/(^|\.)wikipedia\.org$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/\/wiki\/(.+)$/);
      if (!m) return null;
      return decodeURIComponent(m[1]).replace(/_/g, " ");
    } catch (e) { return null; }
  }

  function extractDigest(wikitext) {
    const allHeadingMatches = Array.from(wikitext.matchAll(/^={2,4}\s*([^=]+?)\s*={2,4}\s*$/gm));
    const headings = allHeadingMatches.map(m => m[1].trim());

    // ---------- infobox extraction: EVERY infobox in the article, not just the first ----------
    // Real bug report ("the LLM sometimes misses a generation's production
    // date") root-caused against a live article: a merged, single-article
    // nameplate (Mercedes-Benz G-Class is the confirmed case) commonly gives
    // EACH generation its own embedded {{Infobox automobile}} "side card"
    // within that generation's own section — production years, engines,
    // body styles specific to just that era — separate from the one
    // top-level infobox at the very top of the article (which usually only
    // covers the nameplate's overall span or its most recent generation).
    // The old code found only the FIRST "{{Infobox" in the whole document —
    // every one of these per-generation cards was invisible to the model,
    // even though a clean, explicitly-labeled production year range is
    // often the ONLY place a specific generation's dates are stated
    // unambiguously at all (the rest of the article may only describe that
    // generation's years in scattered prose, or not at all).
    const infoboxes = [];
    const INFOBOX_RE = /\{\{\s*Infobox/gi;
    let im;
    while ((im = INFOBOX_RE.exec(wikitext))) {
      const bstart = im.index;
      let depth = 0, i = bstart;
      for (; i < wikitext.length; i++) {
        if (wikitext.startsWith("{{", i)) { depth++; i += 1; }
        else if (wikitext.startsWith("}}", i)) { depth--; i += 1; if (depth <= 0) { i += 2; break; } }
      }
      // Was capped at 8000, then 18000 chars for the single infobox this
      // used to extract -- now that every infobox in the article is kept
      // (not just one), each individual one is capped lower (12000, still
      // comfortably more than any real {{Infobox automobile}} needs) so a
      // handful of generations' worth of side-cards doesn't balloon the
      // total prompt unreasonably; see the combined-budget cap below too.
      const text = wikitext.slice(bstart, Math.min(i, bstart + 12000));
      // Label each infobox with the nearest preceding heading (typically
      // that generation's own chassis code, e.g. "== W460 ==") so both the
      // extraction below and the model itself can attribute its fields to
      // the right generation instead of an unlabeled blob.
      let heading = null;
      for (let hi = allHeadingMatches.length - 1; hi >= 0; hi--) {
        if (allHeadingMatches[hi].index < bstart) { heading = allHeadingMatches[hi][1].trim(); break; }
      }
      infoboxes.push({ start: bstart, text, heading });
      INFOBOX_RE.lastIndex = Math.max(i, INFOBOX_RE.lastIndex); // resume after this infobox, don't re-match inside its own nested templates
      if (infoboxes.length >= 12) break; // sane upper bound -- even the most sprawling nameplate article won't have more real generations than this
    }
    const infobox = infoboxes.length ? infoboxes[0].text : ""; // kept as before: the primary/overall-nameplate infobox, sent in full

    // Context-cue prose scan: some nameplates (the Dacia Logan is the case
    // that prompted this) announce a new generation only in a body-text
    // sentence under a generic heading like "History" — no dedicated
    // "== Second generation ==" heading, no chassis code in the infobox
    // row. And even when a generation IS clearly identified, who designed
    // or engineered it is almost never in the infobox or a heading either —
    // it's stated in a nearby sentence, often not the SAME sentence as the
    // generation announcement itself ("The second generation launched in
    // 2012. It was styled by Jane Doe at Renault's design studio."). Pull
    // whole PARAGRAPHS (not just single sentences) that mention either a
    // generation or a design/engineering credit, so the model has a real
    // chance of matching a person to the generation they actually worked on
    // instead of just the isolated fact that a person's name exists
    // somewhere in the article.
    const GEN_CUE_RE = /\b(?:(?:first|second|third|fourth|fifth|sixth|seventh|1st|2nd|3rd|4th|5th|6th|7th)[\s-]generation|facelift(?:ed)?|Mk\.?\s?\d+|generation\s+[IVX]+\b)/i;
    const PEOPLE_CUE_RE = /\b(?:design(?:ed)?\s+by|styled\s+by|penned\s+by|design\s+director|chief\s+designer|led\s+by|headed\s+by|engineered\s+by|developed\s+by|chief\s+engineer|project\s+lead|lead\s+engineer|under\s+the\s+direction\s+of)\b/i;
    // Production-date cue -- real bug report: "the LLM sometimes misses the
    // production date for a generation." A paragraph can state a clean date
    // range ("produced from 1979 to 1991", "went on sale in ... 1979" / "was
    // replaced ... in 1991") while mentioning nothing that GEN_CUE_RE
    // matches at all -- no ordinal phrasing, no "Mk" number, just a chassis
    // code like "W460" that regex doesn't (and shouldn't; codes are far too
    // varied to pattern-match reliably) recognize on its own. Catching an
    // explicit two-year range directly means a paragraph describing exactly
    // when a generation started and ended still gets pulled in even when no
    // other cue fires on it.
    const YEAR_RANGE_CUE_RE = /\b(19|20)\d{2}\s*(?:[-–—]|to|until|through)\s*(?:(19|20)\d{2}|present)\b/i;
    // Shared-platform/rebadge cues -- the same nameplate-per-generation gap
    // that motivates this whole feature (a merged, single-article nameplate)
    // also tends to bury a badge-engineering/platform-sharing sentence deep
    // in body prose rather than the infobox, e.g. "...was also sold as the
    // rebadged Vauxhall Corsa in some markets." Pulling the whole paragraph
    // in gives the model a real shot at attributing the mention to the
    // correct generation instead of just the nameplate as a whole.
    const PLATFORM_CUE_RE = /\b(?:shares?\s+(?:its|the|a)?\s*platform|platform[\s-]mate|badge[\s-]engineer(?:ed|ing)?|rebadged?|re-?badge|sister\s+model|twin(?:ned)?\s+with|sold\s+as\s+the|marketed\s+as\s+the|captive\s+import|clone\s+of|jointly\s+developed\s+with|co-developed\s+with)\b/i;
    // Real bug report: checking Infiniti Q30 <-> Mercedes-Benz A-Class kept
    // failing to find the A-Class's explicit "(W176)" chassis code, even
    // though it's right there in the Q30 article's own "Related" infobox
    // field on the live page. Root cause: a piped wikilink's TARGET (the
    // actual page title, e.g. "Mercedes-Benz A-Class (W176)") and its
    // DISPLAY text (what a reader sees, e.g. plain "Mercedes-Benz A-Class")
    // can differ -- editors often pipe a chassis-coded article title to a
    // clean display name. The old wikilink replacement always kept the
    // DISPLAY half and threw the target away, so a code that only exists in
    // the target was silently deleted before extractExplicitGenCode ever
    // got a chance to look for it. Now: only when the target carries a
    // parenthetical the display text lacks (the exact "code lives in the
    // target only" shape) is the target kept instead -- every other link
    // (the vast majority, where display and target agree) behaves exactly
    // as before.
    function stripWikiMarkup(s) {
      return s
        .replace(/<ref[^>]*\/?>[\s\S]*?<\/ref>|<ref[^>]*\/>/gi, "")
        .replace(/\{\{[^{}]*\}\}/g, "")
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, targetText, displayText) => {
          if (displayText && /\([^)]*\)/.test(targetText) && !/\([^)]*\)/.test(displayText)) return targetText;
          return displayText || targetText;
        })
        .replace(/'''?/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    // Was capped at 20 cues -- too tight for articles with a long service
    // history (recurring "facelift"/"Mk\d" mentions for EARLY generations
    // can fill all 20 slots before the scan ever reaches a later
    // generation's own paragraph, since this loop walks the article in
    // document order and stops as soon as it hits the cap). With the
    // server's context window (see serve.py's LLAMA_CTX_PER_REQUEST) at its
    // real 128K ceiling there's ample room to raise this substantially
    // instead of silently truncating whichever generations happen to come
    // last in the article. Raised again (60 -> 160 cues, 600 -> 900 chars
    // each) after a real bug report of the model settling for a shallow,
    // years-only read of a nameplate instead of finding the specific
    // generation-to-generation evidence actually present further into the
    // article -- accuracy matters more than prompt size here, and the
    // measured worst-case prompt still leaves enormous headroom under the
    // real 128K ceiling even at these limits.
    //
    // PLATFORM_CUE_RE was defined above but never actually included in this
    // filter -- a real gap: a paragraph that ONLY mentions a shared-
    // platform/rebadge relationship, with no generation or people cue word
    // nearby, was silently never pulled into `cues` at all, even though the
    // system prompt and buildMessages both promise the model a real shot at
    // it. Included now alongside the other two.
    const seenCue = new Set();
    const cues = [];
    for (const raw of wikitext.split(/\n\s*\n/)) {
      if (!GEN_CUE_RE.test(raw) && !PEOPLE_CUE_RE.test(raw) && !PLATFORM_CUE_RE.test(raw) && !YEAR_RANGE_CUE_RE.test(raw)) continue;
      const clean = stripWikiMarkup(raw).slice(0, 900);
      const key = clean.toLowerCase();
      if (clean.length > 20 && !seenCue.has(key)) { seenCue.add(key); cues.push(clean); }
      if (cues.length >= 160) break;
    }

    // {{Infobox automobile}}'s "Body and chassis" group renders a bolded
    // divider above a run of fields (class, body_style, layout, platform,
    // related, doors, ...) -- that divider is template-generated, not a
    // real wikitext heading, so it never shows up in `headings` above, and
    // the "related"/"platform" params it groups can end up buried anywhere
    // inside a huge raw infobox blob alongside dozens of other fields
    // (engine, dimensions, production years...). A small local model
    // reliably missed them there -- reported as "struggles to find the
    // Related section under Body and Chassis" -- and no amount of
    // retrying-with-feedback could fix that, since the field was genuinely
    // never called out in what the model was given to read. Pull key
    // fields out explicitly by name instead of hoping they get noticed in
    // the noise; buildMessages surfaces whatever's found here as its own
    // clearly-labeled line(s). Takes a `text` param (not a closure over the
    // single `infobox` var) so it can run against EVERY infobox found
    // above, not just the first.
    function extractInfoboxField(text, names) {
      for (const name of names) {
        const re = new RegExp("\\|\\s*" + name + "\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*[a-zA-Z_]+\\s*=|\\n\\}\\}|$)", "i");
        const m = text.match(re);
        if (!m) continue;
        const val = stripWikiMarkup(m[1]).trim();
        if (val && !/^(n\/a|none|unknown|-|tbd)$/i.test(val)) return val.slice(0, 400);
      }
      return null;
    }
    const relatedField = extractInfoboxField(infobox, ["related"]);
    const platformField = extractInfoboxField(infobox, ["platform"]);

    // Per-generation infobox summaries -- every infobox found ABOVE the
    // first one (which is already sent in full as `infobox`), each labeled
    // by its nearest heading, with its own production/related/platform
    // fields pulled out explicitly (same reasoning as relatedField/
    // platformField above: a specific generation's clean, unambiguous
    // production year range is exactly the data most likely to be sitting
    // in one of these and nowhere else in the article). The RAW text of
    // each is included too (capped), not just the extracted fields, so the
    // model can also read anything else in that side-card (engine, body
    // style) that might help identify or date that generation.
    const PRODUCTION_FIELD_NAMES = ["production", "model_years", "production_years", "manufacture", "years"];
    let perGenBudget = 40000; // combined cap across all additional infoboxes, well inside num_ctx headroom
    const perGenInfoboxes = infoboxes.slice(1).map(ib => {
      const production = extractInfoboxField(ib.text, PRODUCTION_FIELD_NAMES);
      const related = extractInfoboxField(ib.text, ["related"]);
      const platform = extractInfoboxField(ib.text, ["platform"]);
      const predecessor = extractInfoboxField(ib.text, ["predecessor"]);
      const successor = extractInfoboxField(ib.text, ["successor"]);
      const raw = perGenBudget > 0 ? ib.text.slice(0, Math.min(6000, perGenBudget)) : null;
      if (raw) perGenBudget -= raw.length;
      return { heading: ib.heading, production, related, platform, predecessor, successor, raw };
    });

    // ---------- sub-articles: a section that delegates to its own page ----------
    // Real user request (Kia Pride): "There are some examples where a specific
    // model is being analyzed as a nameplate but not enough information comes
    // back. In some cases, this is because there are links associated on the
    // page which refer to other wikipedia pages... Here we can see that there
    // are actually links within this wikipedia page which describes the
    // details about the specific car generations. I want that the LLM also
    // considers this, and tries to access these links if possible as well in
    // these instances, to be as accurate as possible."
    //
    // Wikipedia's convention for exactly this is a hatnote at the top of a
    // section -- {{Main|Kia Pride (first generation)}}, {{Main article|...}},
    // {{See also|...}} -- meaning "the real detail lives over there, this
    // section is a summary". When a nameplate delegates its generations that
    // way, its own article genuinely doesn't contain the detail, so no amount
    // of re-reading it will help; the sub-articles have to be fetched. Each
    // is recorded with the heading it sat under, so the fetched text can be
    // attributed to the right generation rather than dumped in as one blob.
    const MAIN_HATNOTE_RE = /\{\{\s*(?:Main|Main article|Further|See also)\s*\|([^}]+)\}\}/gi;
    const subArticles = [];
    const seenSub = new Set();
    let hm2;
    while ((hm2 = MAIN_HATNOTE_RE.exec(wikitext))) {
      let heading = null;
      for (let hi = allHeadingMatches.length - 1; hi >= 0; hi--) {
        if (allHeadingMatches[hi].index < hm2.index) { heading = allHeadingMatches[hi][1].trim(); break; }
      }
      // A hatnote can list several targets, pipe-separated; each may itself be
      // a piped link whose display half we don't want.
      hm2[1].split("|").forEach(raw => {
        const title = raw.split("#")[0].trim();
        if (!title || /^l\d?=|^selfref/i.test(title)) return;   // template params, not titles
        const k = title.toLowerCase();
        if (seenSub.has(k)) return;
        seenSub.add(k);
        subArticles.push({ title, heading });
      });
      if (subArticles.length >= 12) break;   // a sane cap; no real nameplate delegates more
    }

    return { infobox, headings: headings.slice(0, 80), cues, relatedField, platformField, perGenInfoboxes, subArticles };
  }

  // ---------- llama.cpp, via the same-origin proxy in serve.py ----------
  // Real user request: switched from Ollama to llama.cpp (llama-server),
  // mainly for llama-server's native multi-request "slots" (see serve.py's
  // own module docstring) and for the live tokens/sec terminal reporting
  // this function's request shape makes possible. serve.py's do_POST
  // /api/llm/chat handler is the one that actually talks to llama-server
  // (over its OpenAI-compatible /v1/chat/completions endpoint) and prints
  // that live progress to its own terminal -- from this function's point of
  // view, /api/llm/chat still looks like one plain request in, one complete
  // JSON response out, the exact same contract the old Ollama-backed proxy
  // had, so nothing else in this file needed to change.
  // ---------- tolerant JSON parsing of the model's own reply ----------
  // Real bug report: "Local LLM relation check failed: JSON Parse error:
  // Unrecognized token '`'". Every request already asks for OpenAI-style
  // JSON mode (`response_format: {"type": "json_object"}`), which normally
  // grammar-constrains the output to valid JSON from the first token -- but
  // that guarantee is only as good as the server honoring it, and in
  // practice a few things break it: a llama-server build/quant where the
  // JSON grammar isn't applied (older builds silently ignore the field), a
  // request that fell back to plain text after a grammar-compile failure,
  // or a chat template that wraps the assistant turn in a markdown code
  // fence itself. When that happens the content comes back as
  // "```json\n{...}\n```" and a bare JSON.parse() dies on the very first
  // backtick -- surfacing as a hard "check failed" error even though a
  // perfectly good JSON object is sitting right there two characters later.
  // Strip a fence if present, then fall back to slicing out the outermost
  // {...} (or [...]) span, before giving up. Deliberately does NOT try to
  // repair genuinely malformed JSON -- a truncated or invented object should
  // still fail loudly rather than be half-guessed at.
  function parseLlmJson(content) {
    const text = String(content == null ? "" : content).trim();
    if (!text) throw new Error("empty response from llama.cpp");
    try { return JSON.parse(text); } catch (e) { /* fall through to the recovery paths below */ }
    // ```json ... ``` / ``` ... ``` (with or without a language tag)
    const fenced = text.match(/^`{3,}[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?\s*`{3,}\s*$/);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch (e) { /* keep going */ }
    }
    // Outermost object/array span anywhere in the reply -- covers a stray
    // preamble ("Here is the JSON:") or trailing prose the fence regex above
    // wouldn't catch.
    const first = text.search(/[{[]/);
    if (first >= 0) {
      const open = text[first], close = open === "{" ? "}" : "]";
      const last = text.lastIndexOf(close);
      if (last > first) {
        try { return JSON.parse(text.slice(first, last + 1)); } catch (e) { /* genuinely malformed -- fall through */ }
      }
    }
    throw new Error("llama.cpp returned something that isn't JSON: " + text.slice(0, 160));
  }

  // `purpose` is a short human-readable label for what this particular call
  // is actually doing ("relation check: Ford Focus <-> VW Jetta", "designers/
  // engineers + generation split: Toyota 86", ...). Real user request: the
  // terminal serve.py runs in should say more than a token count and a rate
  // -- with several checks running concurrently through llama-server's
  // parallel slots, "[req-7] 214 tok in 4.1s" on its own gives no way to
  // tell WHICH car or WHICH kind of check that even is. serve.py pops this
  // field off the body before forwarding to llama-server (it isn't part of
  // the OpenAI chat-completions schema) and prints it alongside the live
  // progress line; omitting it is always safe, it just prints the generic
  // label instead.
  async function askLlamaCpp(messages, purpose) {
    const r = await fetch("/api/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: purpose || undefined,
        // No "model" field here on purpose -- see the comment at the top of
        // this file. serve.py's do_POST /api/llm/chat handler always fills
        // it in (and overrides it if present) from its own
        // LLAMA_MODEL_ALIAS, which is the single, obvious place to change
        // models.
        messages,
        // OpenAI-style JSON-mode request (llama-server's OAI-compatible
        // endpoint supports this the same way Ollama's plain "format":
        // "json" did) -- constrains the model's OUTPUT tokens to valid JSON
        // from the very first token, same purpose as before: every prompt
        // in this file asks for a specific JSON shape and nothing else.
        response_format: { type: "json_object" },
        // This proxy always reads llama-server's response as a stream
        // internally regardless of what's requested here (see serve.py's
        // own comment on why), but this still documents this function's
        // own actual contract with serve.py: one request, one complete
        // response, no client-side stream handling needed.
        stream: false,
        // Real user request: keep Qwen3.5's internal reasoning/thinking
        // pass off, so this file's own carefully hallucination-guarded
        // system prompts (see SYSTEM_PROMPT/DUPLICATE_CHECK_SYSTEM_PROMPT)
        // stay fully in control of the output instead of the model
        // second-guessing them in a hidden reasoning pass. This used to
        // also be stamped per-request here as
        // "chat_template_kwargs": {"enable_thinking": false}, but that's
        // the exact mechanism newer llama-server builds print a deprecation
        // warning for at startup ("Setting 'enable_thinking' via
        // --chat-template-kwargs is deprecated. Use --reasoning on /
        // --reasoning off instead") -- sending it on every single request
        // here would print that warning on every single LLM call. Reasoning
        // is now suppressed entirely server-side, via serve.py's
        // start_llama_server (--reasoning off plus --reasoning-budget 0,
        // the latter a stronger guarantee against a currently-open
        // llama.cpp bug -- github.com/ggml-org/llama.cpp/issues/20182 --
        // where the softer --reasoning off alone doesn't always take effect
        // for Qwen3.5), so every request through this one function --
        // generation extraction, family recheck, relation checks, and the
        // duplicate sanity check -- gets it with nothing needed here.
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.hint || body.error || ("llama.cpp request failed: " + r.status));
    }
    const j = await r.json();
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) throw new Error("empty response from llama.cpp");
    return parseLlmJson(content);
  }

  const SYSTEM_PROMPT = `You extract car production-generation data, who designed/engineered each generation, and every shared-platform/rebadge/sister-model relationship to a DIFFERENT nameplate, from Wikipedia infobox wikitext, section headings, and short paragraph excerpts.
Respond with ONLY JSON, no prose, matching exactly this shape:
{"hasMultipleGenerations": boolean, "generations": [{"code": string, "yearStart": number|null, "yearEnd": number|null, "designers": string[], "engineers": string[], "sharedPlatforms": string[]}]}

Work through this in order, as three separate passes over the same text --
do NOT try to do all three at once. Get the generation list exactly right
FIRST (pass 1); only once that's settled, go back through the same material
again for designers/engineers (pass 2), and then a third time for shared-
platform/related mentions (pass 3). A generation you miss or mis-code in
pass 1 corrupts everything you'd otherwise correctly attribute to it in
passes 2 and 3, so getting the generation list right always comes first and
matters more than either of the other two.

PASS 1 -- the generation list itself (do this pass completely before moving on):
- Only set hasMultipleGenerations: true if the text clearly describes multiple distinct production generations of the SAME nameplate (e.g. different chassis/platform codes, or clearly labeled "first generation"/"second generation" etc with different year ranges). A single generation, or a list of trims/body styles within one generation, is NOT multiple generations — set hasMultipleGenerations: false in that case.
- Even when hasMultipleGenerations is false (this nameplate was never split into distinct generations, or only ever had one), STILL include exactly one entry in "generations" representing the whole nameplate as that single generation — with "code" as the nameplate's own name. (Its sharedPlatforms field gets filled in during pass 3 below, not here.)
- Be EXHAUSTIVE, not just correct. If hasMultipleGenerations is true, your job is to find every distinct generation present anywhere in the supplied text — not just the first few, not just the most recent few, not just whichever ones happen to have the most detail. Before finalizing your answer, re-scan the ENTIRE infobox AND every excerpt (all the way to the end, not just the beginning) for any chassis/platform code, "Mk" number, ordinal ("first"/"second"/"third"... generation), or facelift/restyle that names a distinct era you haven't already listed. A generation mentioned only once, in passing, or without a full year range still counts and must be included (use null for a year you can't find, never omit the generation itself). The single most common mistake is stopping early after finding 2-3 generations near the top of the text when more exist further down — do not do this.
- Not every nameplate gives generations a dedicated "== heading ==" or a chassis code in the infobox — some only ever say it in a body sentence, e.g. "the second-generation Logan was revealed in 2012". The "Excerpts" below exist exactly for that case; treat a clear announcement there as just as valid as an infobox row or a heading.
- "code" should be the specific chassis/platform/generation CODE for this generation, not a generic ordinal description. Actively search the infobox (fields like "platform", "predecessor", "successor", body/model-code rows), the section headings, and the excerpts for a short alphanumeric code Wikipedia uses to identify this exact generation (e.g. "W463", "Mk7", "R107", "ZJ", "XJ40", "E30", "Logan II") -- these almost always exist for a nameplate with named generations, even when a heading also happens to say "First generation" or "Second generation" in prose. Only fall back to a plain ordinal phrase like "first generation" or "second generation" as the "code" if you have genuinely searched the ENTIRE supplied text and no chassis/platform/model code for that specific generation appears anywhere in it -- do not default to the ordinal phrasing just because it is easier to find than the code.
- Multi-generation articles often embed a SEPARATE infobox "side card" for each individual generation, further down in that generation's own section, in addition to the one main infobox at the top. If the user message includes any "Generation infobox #2", "#3", etc. sections, treat each one as belonging ONLY to the generation named in its heading, and check its "production/model years" field first for that generation's yearStart/yearEnd -- this is frequently the ONLY clean, unambiguous source for a specific generation's exact date range, more reliable than prose. Do not mix up which side-card belongs to which generation.
- Do not leave yearStart or yearEnd null for a generation if a production/model-years date range for it is stated anywhere in the supplied material -- the main infobox, a per-generation infobox side card, a heading, or a prose excerpt. Check all of them before giving up and returning null.
- When the text identifies a generation (of THIS nameplate or of a DIFFERENT one mentioned in a relation) using ordinal language like "third-generation X" or "X, now in its second generation" instead of a chassis code, that ordinal refers to that nameplate's OWN chronological position -- e.g. "third-generation" means the 3rd oldest generation of THAT specific nameplate by production year, not whichever generation code happens to look similar or most recent. Do not guess a generation from an ordinal by pattern-matching code names; if you cannot tell the actual chronological position, say so rather than guessing.
- READ THE WHOLE HEADING, not just the code in it. Real failure, on the Mercedes-Benz G-Class: the article has a section headed "W463" AND a later one headed "Second generation W463 (2018-present)". Both were reported as plain "W463" with the same recent years, so the earlier car -- a generation that ran for 28 years -- vanished entirely. A manufacturer occasionally reuses one designation for two completely different vehicles; when a heading qualifies a code with an ordinal, a year range, or a word like "second"/"new"/"facelift", that qualifier is part of which generation you are naming. Report each one separately with ITS OWN year range, and never let two entries that cover different eras come back looking identical.
- Conversely, do NOT invent a second generation out of an alternative spelling of one code. Still on the G-Class: "W463A" is not a Mercedes designation at all, it is a name some sources use for the 2018 car to tell it apart from the older W463. One car, listed once. If two candidate codes cover the SAME years and one is just the other with a letter or two added, they are the same generation -- pick the code the article's own heading uses.
- Check the year range you give against the whole article before answering. A generation's run is bounded by the next generation's start, not by the newest date you happened to read: on the G-Class, W461 began when W460 ended in 1991, not in 1985 (a date that appears in the article for an unrelated reason). If two of your entries overlap in years and are not explicitly concurrent production lines, at least one of the ranges is wrong -- go back and find the real one.
- A generation still in production has no end year. Return null for yearEnd rather than the current year or the date of the most recent thing said about it.
- Distinguish a GENERATION from a variant of one. Trim levels, engine designations, body styles, AMG/tuner versions, armoured or military conversions, anniversary and limited editions, and special one-offs all belong to a generation -- they are not generations themselves. On the G-Class, "G 63 AMG", "G 500 4x4²", "G 63 6x6" and the "Maybach G 650 Landaulet" are all variants of the W463, not five more generations. A concurrently-produced parallel line WITH ITS OWN CHASSIS CODE (the G-Class's W461, built alongside W463 for military and commercial use) IS a separate generation and must be listed.
- Never invent a code or year that does not appear in the supplied text.

PASS 2 -- designers/engineers, generation list from pass 1 now fixed, attribute each credit to the right one:
- Actively look through the Excerpts for phrasing like "designed by", "styled by", "penned by", "chief designer", "design director", "engineered by", "chief engineer", "led by" and attribute that person to whichever generation (from your pass-1 list) the SAME excerpt (or the immediately surrounding sentences) is actually talking about — not to every generation, and not to the nameplate as a whole unless the text genuinely doesn't distinguish. If an excerpt names a person but it's ambiguous which generation they worked on, leave it out rather than guessing.
- Only include a designer or engineer name if it is explicitly stated in the text as having worked on that specific generation. Leave the arrays empty rather than guessing. Never invent a name that does not appear in the supplied text.

PASS 3 -- shared-platform/related mentions, same fixed generation list, attribute each mention to the right one:
- "sharedPlatforms": a LIST of every DIFFERENT nameplate the text states THIS SPECIFIC generation shares its platform with, is a rebadged/badge-engineered version of, is a captive import of, is a sister/twin model to, or is otherwise explicitly named alongside as a related car -- not just the first/most obvious one. Be EXHAUSTIVE here too, the same way you were for generations: a single nameplate is very often related to SEVERAL others at once (e.g. one platform shared across four or five badge-engineered siblings across different regions/brands), and every one of them that the text names must appear in this list, not just one. Check the infobox's "platform"/"related" rows AND every prose excerpt -- a related car is just as often named only in a sentence ("...was later rebadged in Australia as the X and in Japan as the Y...", "the related Z was built on the same platform...") as in the infobox, and both count equally. Give each one exactly as its name appears in the text (e.g. "Toyota GT86", "Vauxhall Corsa"). Every entry must be a genuinely different nameplate, never another generation of THIS SAME nameplate (that's a succession, not a platform share — leave successions out of this list entirely). Empty array if none. Never invent one — only include a nameplate here if the text explicitly names it as related/shared-platform/rebadged for that generation.
- CRITICAL: "sharedPlatforms" holds CARS, never PLATFORMS. A platform/architecture/chassis NAME -- "Ford C1 platform", "GM Delta platform", "General Motors Gamma platform", "Mazda GE platform", "MQB", "GMT001", "CD3" -- is the engineering base that cars are built ON, not a car that exists. Never put one in this list. If the text says a generation is built on the "Ford C1 platform", that tells you which platform it uses; it does NOT name a related car, and you must list only the actual CARS the text says share it (if any). A name containing the word "platform", "architecture" or "chassis", or that is a bare code with no marque and model, is a platform, not a car.
- If a line below labeled "Infobox 'related'/'platform' field" is present, that's Wikipedia's own explicit statement of one or more related/platform-sharing nameplates for this whole article -- it may list SEVERAL names (comma- or semicolon-separated); treat every single one of them as a strong, trustworthy signal to add to sharedPlatforms, not just the first name in the list. Your job is figuring out which generation (from your pass-1 list) each one actually belongs to: usually the most recent one if the infobox only describes one generation's specs overall, or whichever generation the surrounding infobox rows/excerpts tie it to -- never leave any of them out just because the field isn't phrased as a full sentence, and never stop after adding only one when the field names more. A nameplate mentioning a shared platform/rebadge relationship is common even when it only ever had one generation (e.g. a single-generation captive-import model) — never drop that fact just because there's nothing to split; only return an entirely empty "generations" array (all the way back in pass 1) if there's truly no shared-platform/rebadge relationship to report either.
- A car built under licence, or the same car sold under a different marque's badge, is exactly the kind of relationship this list is for, and it is usually stated in ordinary prose rather than the infobox. The G-Class names two in its opening section alone -- it was "sold under the Puch name as Puch G until 2000", and the Peugeot P4 is a "variant made under licence in France with a Peugeot engine" -- and a licensed or rebadged twin is easy to skim past because the sentence reads like history rather than like a specification. Include them.
- Never invent a name that does not appear in the supplied text. Being exhaustive means finding every REAL related nameplate in the text, never inventing ones that aren't there.`;

  function buildMessages(node, digest, priorProposal, feedback) {
    let user = `Car: ${node.make} ${node.label}\n\nInfobox wikitext:\n${digest.infobox || "(no infobox found)"}\n\nSection headings:\n${digest.headings.join("\n")}`;
    if (digest.platformField || digest.relatedField) {
      // Called out separately (and repeated in the system prompt above) since
      // this is exactly the field a small local model was reliably missing
      // when it was just one more line lost inside a huge raw infobox blob --
      // see extractDigest's own comment for the real bug report this fixes.
      user += `\n\nInfobox "related"/"platform" fields (Body and chassis group) -- Wikipedia's own explicit statement about this article:`;
      // The "related" field names CARS and is a strong sharedPlatforms signal.
      // The "platform" field names the engineering PLATFORM, which is not a
      // car at all -- labelling both the same way is what produced minted
      // "cars" called "Ford C1 platform" and "GM Delta platform", each of
      // which then got its own article looked up and checked, dragging in
      // every unrelated marque built on that platform. Kept in the prompt
      // (it's useful context for identifying a generation) but explicitly
      // marked as NOT a related car.
      if (digest.platformField) user += `\n- platform = ${digest.platformField}   <- the PLATFORM this is built on. Context only. NEVER list this in sharedPlatforms; it is not a car.`;
      if (digest.relatedField) user += `\n- related = ${digest.relatedField}   <- these ARE cars; treat every name here as a strong sharedPlatforms signal (it may list more than one).`;
    }
    // Real bug report: "the LLM sometimes misses the production date for a
    // generation." Root cause -- a merged, single-article nameplate
    // commonly gives EACH generation its own embedded infobox "side card"
    // in that generation's own section, separate from the one main infobox
    // above; those used to be invisible to the model entirely (only the
    // FIRST infobox in the article was ever captured). Surfaced here, each
    // clearly labeled by its nearest heading so the model can tell them
    // apart and attribute fields to the right generation -- see
    // extractDigest's own comment for the confirmed example (Mercedes-Benz
    // G-Class: separate W460/W461/W463/W464 side cards).
    if (digest.perGenInfoboxes && digest.perGenInfoboxes.length) {
      user += `\n\nThis article ALSO has ${digest.perGenInfoboxes.length} more infobox(es), one per generation section (separate from the main infobox above) -- check EACH of these for that specific generation's own production year range before falling back to prose:`;
      digest.perGenInfoboxes.forEach((ib, i) => {
        user += `\n\n--- Generation infobox #${i + 2}, near heading "${ib.heading || "(unknown)"}" ---`;
        if (ib.production) user += `\n- production/model years = ${ib.production}`;
        if (ib.predecessor) user += `\n- predecessor = ${ib.predecessor}`;
        if (ib.successor) user += `\n- successor = ${ib.successor}`;
        if (ib.platform) user += `\n- platform = ${ib.platform}`;
        if (ib.related) user += `\n- related = ${ib.related}`;
        if (ib.raw) user += `\nRaw infobox wikitext for this generation:\n${ib.raw}`;
      });
    }
    if (digest.subArticleTexts && digest.subArticleTexts.length) {
      user += `\n\nThis article DELEGATES detail to ${digest.subArticleTexts.length} dedicated sub-article(s) via a "main article" hatnote -- each one is that generation's own full page, fetched below. Treat these as first-class source material, not background: when a nameplate delegates like this, its own article deliberately only summarises, and the real generation detail is here.`;
      digest.subArticleTexts.forEach((sa, i) => {
        user += `\n\n--- Sub-article #${i + 1}: "${sa.title}"${sa.heading ? ` (linked from the "${sa.heading}" section)` : ""} ---`;
        if (sa.infobox) user += `\nIts infobox:\n${sa.infobox.slice(0, 4000)}`;
        if (sa.cues && sa.cues.length) user += `\nExcerpts:\n- ${sa.cues.join("\n- ")}`;
      });
    }
    if (digest.cues && digest.cues.length) {
      user += `\n\nExcerpts mentioning a generation, its production years, and/or who designed/engineered it (paragraph-level, may repeat/overlap; use if headings/infobox don't already cover it):\n- ${digest.cues.join("\n- ")}`;
    }
    if (priorProposal) {
      user += `\n\nA previous attempt produced:\n${JSON.stringify(priorProposal)}\nA human reviewed this and said it was NOT accurate, with this feedback: "${feedback}"\nReconsider the text above and correct your answer accordingly.`;
    }
    // Repeated at the end of the user turn too (not just in the system
    // prompt) since this is the instruction that empirically made the
    // biggest difference to completeness in manual testing/retries.
    user += `\n\nDisplay every generation you can find on this car, not just a couple — make sure every generation actually described in the text above is listed, including ones mentioned only briefly or without a full year range. Also list EVERY related/shared-platform/rebadged nameplate mentioned anywhere in the text (infobox rows AND prose excerpts) in that generation's sharedPlatforms array, not just the first or most obvious one — a nameplate is very often related to several others at once.`;
    return [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }];
  }

  // ---------- hallucination guard: every claimed fact must appear verbatim in the source ----------
  // A merged, single-article nameplate (the whole reason this feature
  // exists) usually still has a separate photo per generation in the
  // article body — just not its own infobox/DBpedia entry to hang it off
  // of. This isn't LLM-claimed data needing the hallucination guard: it's
  // found directly in the source by regex, anchored at wherever the
  // (already-verified) generation code actually appears, so it's at least
  // as trustworthy as the rest of the article text itself.
  // Real user report: "Most of the time it uses the same picture for each
  // generation of a nameplate." Three separate causes, all fixed below.
  //
  // 1. The anchor was `hay.indexOf(code)` -- the FIRST occurrence of that
  //    generation's code anywhere in the article. For most nameplates the
  //    first mention of every code is in the lead paragraph or the top
  //    infobox ("produced 1979-1991 (W460), 1990-present (W463)..."), all
  //    within a few hundred characters of each other and of the article's
  //    lead image -- so a forward scan from each of them found the same
  //    photo. Anchoring on the code's own SECTION HEADING instead points
  //    each generation at its own part of the article, which is where its
  //    own photo actually lives.
  // 2. The forward scan ran a flat 4000 characters regardless of structure,
  //    so a generation whose section has no image of its own happily
  //    borrowed the NEXT generation's photo. Bounded to the end of that
  //    generation's own section now.
  // 3. Nothing stopped two generations resolving to the same file. A
  //    caller-supplied `used` set makes the choice exclusive, so the second
  //    generation to want a shared image falls through to its next-best
  //    candidate instead of duplicating.
  //
  // Non-photographic files (logos, badges, flags, diagrams, drawings) are
  // skipped throughout -- they're common in car infoboxes and make a
  // particularly bad thumbnail.
  const NON_PHOTO_FILE_RE = /(logo|badge|icon|flag|map|emblem|wordmark|montage|animation|diagram|drawing|blueprint|chart|graph|\.svg$)/i;
  const FILE_RE = /\[\[\s*(?:File|Image)\s*:\s*([^|\]\n]+)/gi;
  function filesIn(text) {
    return Array.from(String(text).matchAll(FILE_RE))
      .map(m => m[1].trim())
      .filter(f => f && !NON_PHOTO_FILE_RE.test(f));
  }
  // Where does the section whose heading mentions `code` start and end?
  // Returns null when no heading names this code, which is the honest answer
  // for a nameplate that only ever mentions its generations inline.
  // `occurrence` picks the Nth section whose heading names this code (0-based),
  // for the case an article genuinely has more than one. Real example: the
  // Mercedes-Benz G-Class has "== W463 ==" and, further down, "== Second
  // generation W463 (2018-present) ==" -- two different vehicles under one
  // designation. Without this, both generations resolved to the FIRST section
  // and the later one could never find a photo (or any text) of its own.
  function sectionRangesForCode(wikitext, code) {
    const headings = Array.from(wikitext.matchAll(/^={2,4}\s*([^=\n]+?)\s*={2,4}\s*$/gm));
    if (!headings.length) return [];
    const wanted = String(code || "").toLowerCase();
    if (!wanted) return [];
    // Match on any named part of the code ("ZN6/ZC6" should match a "== ZN6
    // ==" heading), same component-wise logic codeAnchorIn uses.
    const parts = wanted.replace(/\s*\([^)]*\)\s*$/, "").split(/\s*[\/,&]\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i][1].toLowerCase();
      if (!parts.some(p => p.length > 1 && h.includes(p)) && !h.includes(wanted)) continue;
      out.push({
        start: headings[i].index,
        end: i + 1 < headings.length ? headings[i + 1].index : wikitext.length,
        heading: headings[i][1],
      });
    }
    return out;
  }
  function sectionRangeForCode(wikitext, code, occurrence) {
    const all = sectionRangesForCode(wikitext, code);
    return all[occurrence || 0] || all[0] || null;
  }
  // Real user request, with a screenshot of the G-Class's W461 side-card:
  // "Looking at the wikipedia page of the g class there are clearly thumbnails
  // of the specific generations present within the overview description of
  // each of the generations... which the llm could take from the wikipedia
  // page and pass it as the picture of that said generation."
  //
  // Exactly right, and the article structure makes it reliable rather than a
  // guess: a multi-generation nameplate gives each generation its own embedded
  // {{Infobox automobile}} inside that generation's section, and that
  // infobox's own `image =` is a photo Wikipedia editors have explicitly
  // captioned as THAT generation ("Mercedes G-Class G 280 CDI EDITION.30 PUR"
  // under W461). Nothing else in the article carries that guarantee -- a photo
  // merely sitting in a section could be a rival, a detail shot, or a
  // historical aside. extractDigest already locates every infobox in the
  // article for the model's benefit; this reads the same structure for the
  // picture.
  const INFOBOX_IMAGE_RE = /^\s*\|\s*(?:image|image1|photo)\s*=\s*([^|\n<{}\[\]]+)/im;
  function infoboxImageIn(sectionText) {
    // The infobox is normally the first thing in the section; bounding the
    // search to it stops a later template's own image parameter being read as
    // this generation's.
    const start = sectionText.search(/\{\{\s*Infobox/i);
    if (start < 0) return null;
    let depth = 0, i = start;
    for (; i < sectionText.length; i++) {
      if (sectionText.startsWith("{{", i)) { depth++; i += 1; }
      else if (sectionText.startsWith("}}", i)) { depth--; i += 1; if (depth <= 0) { i += 2; break; } }
    }
    const box = sectionText.slice(start, i);
    return boxImage(box);
  }
  // Two spellings in the wild: a bare filename in `image =`, and a full
  // [[File:...]] link. Both mean the same thing.
  function boxImage(box) {
    const bare = box.match(INFOBOX_IMAGE_RE);
    const candidate = bare ? bare[1].trim() : (filesIn(box)[0] || null);
    if (!candidate) return null;
    return NON_PHOTO_FILE_RE.test(candidate) ? null : candidate;
  }

  // Every {{Infobox ...}} in the article, with its character range and its own
  // image. Needed because a nameplate does not have to give its generations
  // HEADINGS: the Mercedes-Benz GLA writes each one as a bold chassis code
  // followed straight away by its own {{Infobox automobile}}, and its only
  // headings are sub-sections INSIDE those generations ("Facelift",
  // "GLA 45 AMG", "Technical details"). sectionRangeForCode finds nothing for
  // "X156" there, so the two heading-based tiers below are both skipped -- and
  // the article contains no [[File:...]] syntax at all (all four photos are
  // infobox `image =` parameters), so the tiers after them had nothing to scan
  // either. Every GLA and CLA generation came back with no picture at all.
  function infoboxBlocks(wikitext) {
    const out = [];
    const re = /\{\{\s*Infobox/gi;
    let m;
    while ((m = re.exec(wikitext))) {
      let depth = 0, i = m.index;
      for (; i < wikitext.length; i++) {
        if (wikitext.startsWith("{{", i)) { depth++; i += 1; }
        else if (wikitext.startsWith("}}", i)) { depth--; i += 1; if (depth <= 0) { i += 2; break; } }
      }
      const body = wikitext.slice(m.index, i);
      out.push({ start: m.index, end: i, image: boxImage(body), body });
      re.lastIndex = Math.max(i, m.index + 1);
    }
    return out;
  }

  // "See if the local LLM can better be pointed to the proper section of the
  // Wikipedia page where that generation is listed, like where the info card
  // of that generation exists in the Wikipedia, is also where the picture for
  // that generation likely lives." -- exactly the rule, applied without
  // needing a heading to find the generation by.
  //
  // Position first: an un-headed generation is written as its code followed
  // immediately by its own infobox, so the box the code sits in, or the next
  // one to open right after it, IS that generation's card. The window keeps a
  // generation with no infobox of its own from claiming a distant one.
  // Naming second: a box whose text names the code, compared with punctuation
  // and spacing removed, because captions write "X 156" for X156.
  function infoboxImageForCode(wikitext, code, anchorIndex, used) {
    const boxes = infoboxBlocks(wikitext);
    if (!boxes.length) return null;
    const free = f => f && !used.has(f.toLowerCase());
    if (anchorIndex >= 0) {
      const WINDOW = 2000;
      const near = boxes.find(b => anchorIndex >= b.start && anchorIndex < b.end) ||
                   boxes.find(b => b.start >= anchorIndex && b.start - anchorIndex <= WINDOW);
      if (near && free(near.image)) return near.image;
    }
    const squash = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
    const parts = String(code == null ? "" : code)
      .replace(/\s*\([^)]*\)\s*$/, "")
      .split(/\s*[\/,&]\s*|\s+and\s+/)
      .map(squash).filter(x => x.length > 2);
    if (!parts.length) return null;
    const named = boxes.find(b => free(b.image) && parts.some(x => squash(b.body).includes(x)));
    return named ? named.image : null;
  }
  function findGenerationImage(wikitext, code, anchorIndex, used, occurrence) {
    used = used || new Set();
    const fresh = list => list.find(f => !used.has(f.toLowerCase()));
    const range = sectionRangeForCode(wikitext, code, occurrence);
    // Tier 0: the photo this generation's OWN infobox names. The strongest
    // signal in the article -- see infoboxImageIn just above.
    if (range) {
      const boxed = infoboxImageIn(wikitext.slice(range.start, range.end));
      if (boxed && !used.has(boxed.toLowerCase())) return boxed;
    }
    // Tier 1: any photo in this generation's own section.
    if (range) {
      const inSection = fresh(filesIn(wikitext.slice(range.start, range.end)));
      if (inSection) return inSection;
    }
    // Tier 2: the generation's own infobox, found by position rather than by
    // heading. Ranked above the nearby-file scan below because an infobox
    // image is captioned as that exact generation, while a file merely lying
    // near the text could be a rival, a detail shot or a historical aside.
    const boxed2 = infoboxImageForCode(wikitext, code, anchorIndex, used);
    if (boxed2) return boxed2;
    // Tier 3: a bounded forward scan from wherever the code was actually
    // verified to appear -- the old behaviour, but exclusive and
    // photo-filtered, and only reached when there's no section to use.
    if (anchorIndex >= 0) {
      const WINDOW = 4000;
      const forward = fresh(filesIn(wikitext.slice(anchorIndex, anchorIndex + WINDOW)));
      if (forward) return forward;
      const backward = filesIn(wikitext.slice(Math.max(0, anchorIndex - WINDOW), anchorIndex));
      const back = fresh(backward.reverse());
      if (back) return back;
    }
    // Real user correction: "the modification you did which simply doesn't
    // have a picture if the correct thumbnail doesn't exist for a generation of
    // a nameplate, then it's okay to fall back on whatever picture does exist,
    // even if it doesn't correspond to the correct picture in this case."
    //
    // So the last resort is a photo from the article rather than nothing --
    // preferring one no other generation has taken, and accepting a repeat only
    // when the article genuinely has fewer photos than it has generations.
    // filesIn only sees [[File:...]] syntax, and a whole class of car articles
    // has none -- every photo is an infobox `image =` parameter. Without the
    // infobox images here, the last resort is empty on exactly the articles
    // that reached it.
    const all = filesIn(wikitext)
      .concat(infoboxBlocks(wikitext).map(b => b.image).filter(Boolean));
    return fresh(all) || all[0] || null;
  }
  // ---------- public: re-derive stored generation photos, no model involved ----
  // Real user question: "so for the thumbnails to be proper, do i need to do a
  // rebuild or what?" No -- rebuild.sh regenerates cars.json from DBpedia and
  // the curated tables and never touches llm_families.json, which is where a
  // generation's photo actually lives. Each generation's `wikiFile` is written
  // once, by validate(), at the moment that family was scanned, so an
  // improvement to findGenerationImage only reaches families scanned AFTER it.
  //
  // Re-running the whole LLM check to pick one up is the wrong tool: the
  // codes, years and credits are already settled and, for a confirmed family,
  // already approved by a human, and a fresh check would throw all of that
  // back into provisional over a picture. This re-reads the article and
  // recomputes ONLY the image pointer, using the identical ordering validate()
  // uses so two generations still cannot end up holding the same photo.
  //
  // It never blanks a photo that already exists: a generation that had one and
  // finds nothing this time keeps what it had. By default it only fills in the
  // ones that have none; pass {all:true} to re-derive every generation, which
  // is what you want after a change like the infobox tier, where a generation
  // may be holding a WORSE photo rather than none at all.
  async function refreshGenerationImages(opts) {
    opts = opts || {};
    const all = !!opts.all;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const entries = Object.entries(store.families).filter(([, e]) =>
      e && e.proposal && Array.isArray(e.proposal.generations) && e.proposal.generations.length);
    const todo = entries.filter(([, e]) =>
      all ? true : e.proposal.generations.some(g => !g.wikiFile));
    const result = { families: todo.length, scanned: 0, filled: 0, replaced: 0,
                     unchanged: 0, stillNone: 0, failed: [], updates: [] };
    let done = 0;
    for (const [nodeId, entry] of todo) {
      const title = entry.sourceTitle || nodeId;
      if (onProgress) onProgress({ title, done, total: todo.length });
      done++;
      let wikitext;
      try {
        wikitext = (await fetchArticleDigest(title)).wikitext;
      } catch (e) {
        result.failed.push({ id: nodeId, title, error: (e && e.message) || String(e) });
        continue;
      }
      const hay = wikitext.toLowerCase();
      const usedFiles = new Set();
      const seenCodes = new Map();
      // Reserve the photos the generations we are NOT touching already hold,
      // or a fill-in could take one of them and produce the duplicate this
      // whole mechanism exists to prevent.
      if (!all) entry.proposal.generations.forEach(g => {
        if (g.wikiFile) usedFiles.add(String(g.wikiFile).toLowerCase());
      });
      entry.proposal.generations.forEach(g => {
        // Walked in full even when only some generations are being refilled:
        // seenCodes is what tells the G-Class's two W463 sections apart, and
        // skipping an entry early would shift every later one's section.
        const lookupCode = g.codeBase || g.code;
        const seenBefore = seenCodes.get(norm(lookupCode)) || 0;
        seenCodes.set(norm(lookupCode), seenBefore + 1);
        if (!all && g.wikiFile) return;
        result.scanned++;
        const before = g.wikiFile || null;
        const found = findGenerationImage(wikitext, lookupCode, codeAnchorIn(hay, g.code), usedFiles, seenBefore);
        if (found) usedFiles.add(found.toLowerCase());
        if (!found) {
          if (before) result.unchanged++; else result.stillNone++;
          return;
        }
        if (found === before) { result.unchanged++; return; }
        g.wikiFile = found;
        if (before) result.replaced++; else result.filled++;
        result.updates.push({ familyId: nodeId, code: g.code, wikiFile: found });
      });
    }
    if (result.filled || result.replaced) await persist();
    return result;
  }

  // Kept as a thin wrapper: several call sites (and the QA suite) still ask
  // the simple "any photo near here" question.
  function findNearbyFile(wikitext, anchorIndex) {
    return findGenerationImage(wikitext, null, anchorIndex, null);
  }

  // A model asked for an exhaustive list of related nameplates will
  // sometimes echo the same one back twice under slightly different
  // casing/whitespace (e.g. "toyota gt86" and "Toyota GT86" both surviving
  // in the same array) -- keeps the first-seen casing, drops the rest.
  function dedupeCaseInsensitive(arr) {
    const seen = new Set(), out = [];
    arr.forEach(s => {
      const k = s.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(s); }
    });
    return out;
  }

  // ---------- who owns whom: the two auto-reject rules for weak proposals ----
  // A shared-platform proposal that rests on nothing but a year overlap or a
  // substring name match is the weakest thing this file produces, and 32 of
  // them had piled up awaiting review. They fall into two groups, and the line
  // between them is corporate ownership:
  //
  //   plausible   Audi TT <-> Audi A3, Škoda Octavia <-> SEAT León,
  //               Karmann Ghia <-> Beetle, TrailBlazer <-> GMC Envoy
  //   nonsense    Audi TT <-> Saturn Ion, Škoda Octavia <-> Daren Mk.3,
  //               Cupra Formentor <-> Hyundai Eon, SEAT Toledo <-> Leapmotor A05
  //
  // Cars do not share a platform across unrelated companies. That is not a
  // heuristic about text, it is how the industry works, and it is the one
  // thing a substring match can never check.
  //
  // Deliberately includes HISTORICAL ownership -- Mazda and Volvo and Jaguar
  // sit under Ford, Volvo also under Geely -- because Ford Escape <-> Mazda
  // Tribute is a real shared platform and rejecting it would be worse than
  // letting a Mercury <-> Mazda oddity through for review. A make absent from
  // this table is UNKNOWN, not foreign: nothing is rejected on ignorance.
  const MAKE_GROUPS = {
    vw: ["Volkswagen", "Audi", "Škoda", "Skoda", "SEAT", "Cupra", "Porsche", "Bentley",
         "Lamborghini", "Bugatti", "MAN", "Scania"],
    gm: ["Chevrolet", "GMC", "Buick", "Cadillac", "Oldsmobile", "Pontiac", "Saturn",
         "Holden", "Hummer", "Daewoo", "Vauxhall", "Opel", "Saab", "Wuling", "Baojun"],
    stellantis: ["Chrysler", "Dodge", "Jeep", "Ram", "Fiat", "Alfa Romeo", "Lancia",
                 "Maserati", "Abarth", "Peugeot", "Citroën", "Citroen", "DS", "Opel",
                 "Vauxhall", "Plymouth", "Imperial", "Eagle", "Talbot", "Simca", "Leapmotor"],
    ford: ["Ford", "Lincoln", "Mercury", "Merkur", "Mazda", "Volvo", "Jaguar",
           "Land Rover", "Aston Martin", "Edsel"],
    toyota: ["Toyota", "Lexus", "Daihatsu", "Scion", "Hino", "Subaru"],
    honda: ["Honda", "Acura"],
    "renault-nissan": ["Nissan", "Infiniti", "Datsun", "Renault", "Dacia", "Mitsubishi",
                       "Venucia", "Samsung", "Alpine"],
    hyundai: ["Hyundai", "Kia", "Genesis"],
    bmw: ["BMW", "Mini", "MINI", "Rolls-Royce", "Alpina"],
    mercedes: ["Mercedes-Benz", "Smart", "Maybach", "Mercedes-AMG", "Mercedes-Maybach"],
    tata: ["Tata", "Jaguar", "Land Rover"],
    geely: ["Geely", "Volvo", "Polestar", "Lotus", "Lynk & Co", "Proton", "Zeekr", "Smart"],
    saic: ["MG", "Roewe", "Maxus", "Wuling", "Baojun", "LDV"],
    suzuki: ["Suzuki", "Maruti Suzuki"],
    isuzu: ["Isuzu"],
    byd: ["BYD", "Denza", "Yangwang"],
    chery: ["Chery", "Exeed", "Jetour", "Omoda"],
    greatwall: ["Great Wall", "Haval", "Wey", "Ora", "Tank"],
    changan: ["Changan", "Deepal", "Avatr"],
    amc: ["AMC", "Rambler", "Nash", "Hudson", "Willys", "Kaiser"],
    bl: ["Austin", "Morris", "Rover", "Triumph", "Riley", "Wolseley", "Austin-Healey", "Leyland"],
    // Marques that were nobody's subsidiary. Listed so they come out as a
    // KNOWN different group rather than as unknown -- a Škoda sharing a
    // platform with a Daren kit car is exactly the kind of thing this is for.
    independent: ["Daren", "Kline", "Veritas", "Reliant", "Bristol", "Marcos", "TVR",
                  "Morgan", "Caterham", "Noble", "Ginetta", "Ascari", "Panoz", "Saleen",
                  "Spyker", "Koenigsegg", "Pagani", "Rimac", "Hennessey", "Gumpert",
                  "Wiesmann", "Artega", "Melkus", "Trabant", "Wartburg", "Tatra",
                  "Zastava", "Yugo", "Lada", "AvtoVAZ", "GAZ", "UAZ", "ZAZ", "Moskvitch"],
  };
  const GROUP_OF = (() => {
    const m = new Map();
    for (const [group, makes] of Object.entries(MAKE_GROUPS)) {
      // A marque can belong to several groups across its life (Volvo: Ford,
      // then Geely), and any shared group is enough to be plausible.
      makes.forEach(mk => {
        const k = mk.toLowerCase();
        if (!m.has(k)) m.set(k, new Set());
        m.get(k).add(group);
      });
    }
    return m;
  })();
  function groupsOfMake(make) { return GROUP_OF.get(String(make || "").trim().toLowerCase()) || null; }

  // "same" | "different" | "unknown"
  function makeRelationship(makeA, makeB) {
    const a = String(makeA || "").trim().toLowerCase(), b = String(makeB || "").trim().toLowerCase();
    if (!a || !b) return "unknown";
    if (a === b) return "same";
    const ga = groupsOfMake(a), gb = groupsOfMake(b);
    if (!ga || !gb) return "unknown";
    for (const g of ga) if (gb.has(g)) return "same";
    return "different";
  }

  // Rule 2. A car that rule 1 has already thrown out twice is not unlucky, it
  // is a bad matcher -- the Saturn Ion turned up in five unrelated proposals,
  // which is a short common name matching as a substring, not a car that
  // shares five platforms. Once it has earned that, its remaining weak
  // proposals go too, including ones inside a single group.
  const REJECTED_MATCH_LIMIT = 2;
  function badMatchers() {
    const count = new Map();
    const bump = id => { if (id) count.set(id, (count.get(id) || 0) + 1); };
    for (const info of Object.values(store.crossGroupRejections || {})) {
      bump(info && info.a); bump(info && info.b);
    }
    const out = new Set();
    count.forEach((n, id) => { if (n >= REJECTED_MATCH_LIMIT) out.add(id); });
    return out;
  }

  // The gate itself. Applies ONLY to a proposal that would otherwise sit in
  // the review queue -- nothing confirmed, and nothing the user has decided,
  // is ever touched by this.
  function weakProposalRejection(nodeA, nodeB) {
    const rel = makeRelationship(nodeA && nodeA.make, nodeB && nodeB.make);
    if (rel === "different") {
      return { why: `${nodeA.make} and ${nodeB.make} are not part of the same company, ` +
                    "so they cannot share a platform -- rejected without review",
               cross: true };
    }
    const bad = badMatchers();
    const idA = nodeA && nodeA.id, idB = nodeB && nodeB.id;
    if (bad.has(idA) || bad.has(idB)) {
      const who = bad.has(idA) ? nodeA : nodeB;
      return { why: `${who.make} ${who.label} has already been rejected against ` +
                    `${REJECTED_MATCH_LIMIT}+ unrelated marques, so it is matching on its ` +
                    "name rather than on a real platform -- rejected without review",
               cross: false };
    }
    return null;
  }

  // Recorded so rule 2 can count, and so the reason survives a reload. Keyed
  // the same way relations are, and never deleted -- like every other decision
  // record in this file.
  function recordWeakRejection(key, nodeA, nodeB, why, cross) {
    store.rejectedRelations[key] = true;
    if (cross) {
      store.crossGroupRejections = store.crossGroupRejections || {};
      store.crossGroupRejections[key] = { a: nodeA && nodeA.id, b: nodeB && nodeB.id, why };
    }
  }

  // The same policy, applied once to proposals that were already sitting in
  // the review queue when it arrived. 32 of them, and they sorted themselves:
  //
  //   16 rested on a year overlap under an exactly-matched nameplate, and
  //      every one is a real platform sibling -- Karmann Ghia <-> Beetle,
  //      TrailBlazer <-> Envoy, Octavia <-> León, SSR <-> TrailBlazer.
  //      Confirmed.
  //   15 rested on a substring name match, and every one is nonsense --
  //      Audi TT <-> Saturn Ion, SEAT Toledo <-> Leapmotor A05, Isuzu Trooper
  //      <-> Kline Kar. Dropped.
  //
  // A stored entry does not record whether its nameplate match was loose, so
  // the company rule stands in for it on the year-overlap side: the single
  // bad one there (Volkswagen Touran <-> Daren Mk.3) is also the single
  // cross-company one. Nothing confirmed is touched, and a drop is the same
  // reversible record a manual "no" writes.
  // The two wordings the OLD code wrote, and nothing else. Every reason
  // string this file writes today is deliberately phrased differently (see
  // resolveOnePlatformMention), so these two patterns match the historical
  // backlog and can never match a proposal made after the policy landed.
  // That matters because this runs on EVERY boot, not once: without the
  // guard it would come back on the next reload and delete a legitimately
  // provisional entry -- a re-check the user asked for, or a sanity-check
  // "low confidence" result -- that is still waiting to be reviewed.
  const LEGACY_YEAR_OVERLAP = "proposed by overlapping production years only (a shared-platform";
  const LEGACY_SUBSTRING = "the matched nameplate name wasn't an exact match, just a substring overlap";

  function resolveWeakRelations(byId) {
    const confirmed = [], dropped = [];
    for (let pass = 0; pass < 4; pass++) {
      let changed = 0;
      for (const [key, e] of Object.entries(store.relations)) {
        if (!e || e.status !== "provisional" || !e.llmDiscovered) continue;
        const reason = e.reason || "";
        const yearsOnly = reason.indexOf(LEGACY_YEAR_OVERLAP) === 0;
        const substring = reason.indexOf(LEGACY_SUBSTRING) !== -1;
        if (!yearsOnly && !substring) continue;
        const a = byId.get(e.genIdA) || byId.get(e.famA);
        const b = byId.get(e.genIdB) || byId.get(e.famB);
        if (!a || !b) continue;
        const name = { a: `${a.make} ${a.label}`, b: `${b.make} ${b.label}` };
        const veto = weakProposalRejection(a, b);
        if (substring || veto) {
          delete store.relations[key];
          recordWeakRejection(key, a, b,
            veto ? veto.why : "matched only as a substring of the mention text -- not a match",
            veto ? veto.cross : false);
          dropped.push(Object.assign({ key }, name));
        } else {
          e.status = "confirmed";
          e.decidedAt = new Date().toISOString();
          e.reason = "matched automatically -- the nameplate was named exactly in the source " +
                     "text, and exactly one of its generations was in production alongside this one";
          confirmed.push(Object.assign({ key }, name));
        }
        changed++;
      }
      if (!changed) break;
    }
    if (confirmed.length || dropped.length) persist();
    return { confirmed, dropped };
  }

  // ---------- decisions whose car is no longer in the graph ----------
  // Real user question, about rebuilding often: "would there be an issue with
  // the cars that were created with the LLM or by hand in this case?"
  //
  // Mostly no -- ids are derived from make and label, so a rebuild reproduces
  // them, and everything in this store is replayed over the new bake. The one
  // way work detaches is when the car's own IDENTITY moves under it: DBpedia
  // renames the article or changes the manufacturer, the id changes with it,
  // and every entry here pointing at the old id is aimed at nothing.
  //
  // Nothing breaks when that happens, which is the problem. A split keyed to
  // a vanished id simply never applies, a relation with a missing endpoint is
  // skipped, a patch is pruned -- so a nameplate you split quietly goes back
  // to being one model and the entry sits in the file doing nothing. This
  // counts them, so a rebuild's drift is a number you can look at instead of
  // something you notice months later.
  //
  // Only the buckets where an orphan means a DECISION has stopped applying.
  // `deletions` and `purged` are deliberately excluded: a deletion whose car
  // is gone has got what it wanted, and reporting it as a problem would bury
  // the real ones. genIdA/genIdB are excluded for the same reason -- those
  // name generations this layer itself mints, which do not exist until the
  // split they belong to is applied.
  //
  // Two quite different things end up orphaned, and lumping them together is
  // what made the report confusing. Real user report: "I figured that if i
  // re-scanned the mercedes GLA nameplate, that the entry would disappear from
  // the list. I guess I am still confused about what these cars actually
  // represent."
  //
  //   "stand-in" -- an llm-related-/llm-make- id. Not a car at all: a
  //     placeholder minted by mintRelatedNode when an article named a car the
  //     graph did not have, so the connection had something to attach to.
  //     Once the real car exists the mention resolves to IT, the placeholder
  //     is never minted again, and everything filed under the placeholder's
  //     id is stranded. Re-checking the real car cannot clear it: the new
  //     entry is filed under the real id and never touches the old one. So
  //     these get pruned automatically -- see pruneStandInOrphans.
  //
  //   "renamed" -- a real car whose id moved, because DBpedia renamed the
  //     article or changed the manufacturer and the next rebuild picked it up
  //     under the new name. THIS is the one worth keeping and looking at: the
  //     car still exists, the work still applies to it, and re-checking it
  //     under its current name redoes the decision.
  const STAND_IN_ID = /^llm-(?:related|make)-/;
  function orphanKind(id) { return STAND_IN_ID.test(String(id || "")) ? "stand-in" : "renamed"; }
  function orphanedEntries(byId) {
    const out = [];
    const nameOf = (id) => {
      const n = byId.get(id);
      return n ? ((n.make ? n.make + " " : "") + n.label) : id;
    };
    const scan = (bucket, what, labelOf) => {
      const store_ = store[bucket] || {};
      Object.keys(store_).forEach(id => {
        if (byId.has(id)) return;
        out.push({ bucket, what, id, kind: orphanKind(id),
                   label: (labelOf && labelOf(store_[id], id)) || id });
      });
    };
    scan("families", "generation split");
    scan("recheck", "generation-list re-check");
    scan("wpLinks", "Wikipedia link you pasted", (v, id) => id + " → " + v);
    scan("genResearch", "generation research");
    scan("merges", "merge into a nameplate", v => (v && v.label) || null);
    scan("renames", "rename", v => v && v.previousLabel && (v.previousLabel + " → " + v.label));
    scan("unmerges", "un-merge");
    // A relation needs BOTH its nameplate-level ends. Reported once, by key.
    Object.keys(store.relations || {}).forEach(key => {
      const e = store.relations[key];
      if (!e) return;
      const missing = [e.famA, e.famB].filter(id => id && !byId.has(id));
      if (!missing.length) return;
      // A connection is only a stand-in case if EVERY end that went missing
      // was a placeholder. One real renamed car in it makes it worth keeping.
      const kind = missing.every(id => orphanKind(id) === "stand-in") ? "stand-in" : "renamed";
      out.push({ bucket: "relations", what: "connection you decided", id: key, kind,
                 label: nameOf(e.famA) + " ↔ " + nameOf(e.famB) +
                        " (" + (e.relType || "?") + ", " + (e.status || "?") + ")" });
    });
    return out;
  }

  // Clear the stand-in orphans. Real user question: "Why doesn't it simply
  // delete the orphans automatically? Is there a good reason for this?" For
  // the renamed kind, yes -- some of those decisions are hand-entered (a
  // pasted link, a rename, a merge), a bad rebuild can make a real car vanish
  // for one boot and come back on the next run, and if the id ever resolves
  // again the work reattaches for free. Deleting on that guess is destructive
  // for no gain, since an inert entry costs nothing but bytes.
  //
  // None of that applies to a stand-in. It is not a car, nothing about it is
  // hand-entered, and no amount of re-checking will ever reach it. So these
  // go, on every boot, without asking.
  //
  // What is left behind is a one-line record per id rather than nothing: the
  // bulky part (a whole generation proposal, a research blob) is what was
  // worth reclaiming, and a stand-in CAN in principle be minted again if the
  // real car later leaves the graph -- in which case the worst case should be
  // "re-scan it", not "wonder what used to be here".
  function pruneStandInOrphans(byId) {
    const dead = orphanedEntries(byId).filter(it => it.kind === "stand-in");
    if (!dead.length) return { cleared: 0, entries: [] };
    store.prunedDecisions = store.prunedDecisions || {};
    const now = new Date().toISOString();
    let n = 0;
    dead.forEach(it => {
      const bucket = store[it.bucket];
      if (!bucket || !(it.id in bucket)) return;
      delete bucket[it.id];
      // Keyed by bucket too: the same id can hold a split AND a pasted link,
      // and those are separate decisions, separately cleared.
      store.prunedDecisions[it.bucket + "|" + it.id] =
        { what: it.what, label: it.label, prunedAt: now };
      n++;
    });
    if (n) persist();
    return { cleared: n, entries: dead };
  }

  // The renamed orphans, cleared on purpose because the user asked -- the
  // panel offers it as one button rather than making them delete 80 rows by
  // hand. Same archive record, for the same reason.
  function clearRenamedOrphans(byId) {
    const dead = orphanedEntries(byId).filter(it => it.kind === "renamed");
    if (!dead.length) return { cleared: 0 };
    store.prunedDecisions = store.prunedDecisions || {};
    const now = new Date().toISOString();
    let n = 0;
    dead.forEach(it => {
      const bucket = store[it.bucket];
      if (!bucket || !(it.id in bucket)) return;
      delete bucket[it.id];
      store.prunedDecisions[it.bucket + "|" + it.id] =
        { what: it.what, label: it.label, prunedAt: now, byHand: true };
      n++;
    });
    if (n) persist();
    return { cleared: n };
  }

  // ---------- hallucination guard, code half: match COMPONENTS, not one composed string ----------
  // Real bug report (Toyota 86): the model returned a perfectly correct,
  // fully-sourced generation list -- {"code": "ZN6/ZC6 (First generation)"},
  // {"code": "ZN8/ZD8 (Second generation)"} -- and the guard dropped BOTH,
  // reporting "local LLM found no multiple generations here" with the real
  // answer sitting right there in the "claimed but dropped" disclosure. The
  // old check was a single `hay.includes(code)`: the article genuinely
  // contains "ZN6", "ZC6" and a "First generation" heading, but nowhere does
  // it contain the exact composed string "ZN6/ZC6 (First generation)" the
  // model helpfully assembled out of them, so the whole entry failed as if
  // it were invented.
  //
  // The fix keeps the guard's actual purpose (nothing reaches the graph that
  // isn't really in the source) while stopping it from punishing the model
  // for formatting: peel off a trailing parenthetical, then require the core
  // -- or, failing that, EVERY slash/comma-separated part of it -- to appear
  // verbatim. A parenthetical that's just a generic ordinal descriptor
  // ("First generation", "facelift") is accepted without needing its own
  // literal match, since it's a label the model added rather than a factual
  // claim; any OTHER parenthetical still has to appear in the source like
  // before. Returns the character offset of the first verified component
  // (used as findNearbyFile's anchor) or -1 for "not backed by the source".
  // A YEAR RANGE counts as generic too. Real bug report: adding the Fiat
  // Topolino produced two perfectly good generations -- "Fiat Topolino
  // (1936-1955)" and "Fiat Topolino (2023)" -- and both were dropped, so the
  // app said "no multiple generations here" while its own output showed two.
  // The parenthetical was a year range, which is a label the model added from
  // the yearStart/yearEnd it also reported, not an independent factual claim:
  // those years are already carried as their own fields and validated there.
  // Demanding the range ALSO appear verbatim fails on the dash alone -- the
  // article writes 1936-1955 with a different dash character than the model
  // does, or gives the two years in separate sentences.
  const GENERIC_CODE_PAREN_RE = /^(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))[\s-]?generation|generation\s+(?:[ivxIVX]+|\d+)|(?:pre-?)?facelift(?:ed)?|current|latest|final|(?:c\.?\s*)?(?:1[89]|20)\d{2}\s*(?:[-\u2010-\u2015\u2212]|to|until|through)?\s*(?:(?:1[89]|20)\d{2}|present|now)?)$/i;
  function codeAnchorIn(hay, rawCode) {
    const raw = String(rawCode == null ? "" : rawCode).trim();
    if (!raw) return -1;
    const direct = hay.indexOf(raw.toLowerCase());
    if (direct >= 0) return direct;
    // A trailing parenthetical is optional. This used to bail out entirely
    // when there wasn't one -- which meant the composite handling further
    // down was unreachable for any code written without brackets, "Astra F /
    // T91" being exactly that shape. That is why every Opel Astra generation
    // was dropped.
    const m = raw.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    const core = (m ? m[1] : raw).trim(), paren = m ? m[2].trim() : "";
    if (!core) return -1;
    // A non-generic parenthetical is a factual claim of its own and still
    // has to be real -- only a plain ordinal/facelift descriptor gets a pass.
    if (paren && !GENERIC_CODE_PAREN_RE.test(paren) && !hay.includes(paren.toLowerCase())) return -1;
    const coreIdx = hay.indexOf(core.toLowerCase());
    if (coreIdx >= 0) return coreIdx;
    // "ZN6/ZC6", "Astra F / T91" -- a composite of several names.
    //
    // Real bug report: a scan of the Opel Astra returned all six generations
    // correctly -- Astra F, G, H, J, K, L, with the right years and designers
    // -- and every single one was dropped, leaving "local LLM found no
    // multiple generations here". The model had written each code as the
    // generation letter joined to a platform code ("Astra F / T91"), and this
    // used to require EVERY part to appear in the article. The letter half is
    // in the article; the platform half often isn't. One unverifiable half
    // discarded a whole verified generation.
    //
    // Requiring all of it was too blunt. The guard exists to keep invented
    // names out of the graph, and it still does: at least one part has to be
    // verbatim in the source, and codeVerifiedIn below stores only the parts
    // that were -- so the unverifiable half never reaches the graph, rather
    // than taking the real half down with it. A code with nothing verifiable
    // in it is still dropped outright.
    const parts = splitCompositeCode(core);
    if (parts.length < 2) return -1;
    let best = -1;
    for (const p of parts) {
      const i = hay.indexOf(p.toLowerCase());
      if (i < 0) continue;
      if (best < 0 || i < best) best = i;
    }
    return best;
  }
  function splitCompositeCode(core) {
    return core.split(/\s*[\/,&]\s*|\s+and\s+/i).map(s => s.trim()).filter(s => s.length > 1);
  }
  // The code as it should be STORED: the original when it's wholly verifiable,
  // otherwise only the parts actually found in the article. Keeps the guard's
  // promise (nothing unverified enters the graph) without throwing away a
  // generation that was correctly identified.
  function codeVerifiedIn(hay, rawCode) {
    const raw = String(rawCode == null ? "" : rawCode).trim();
    if (!raw) return raw;
    if (hay.indexOf(raw.toLowerCase()) >= 0) return raw;
    const m = raw.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    const core = m ? m[1].trim() : raw;
    if (hay.indexOf(core.toLowerCase()) >= 0) return m ? raw : core;
    const parts = splitCompositeCode(core);
    const kept = parts.filter(p => hay.indexOf(p.toLowerCase()) >= 0);
    return kept.length ? kept.join(" / ") : raw;
  }

  // ---------- a platform is not a car ----------
  // Real bug report: a Honda Prelude click ended up checking "Ford C1
  // platform", "General Motors Gamma platform", "GM Delta platform/GMT001"
  // and a string of Chevrolets and Opels built on them. Root cause: the
  // infobox's `platform` field was surfaced to the model as a strong
  // "sharedPlatforms" signal alongside `related`, so the model dutifully
  // returned the platform's NAME as a related car. mintRelatedNode then
  // created a model called "C1 platform" under a make called "Ford",
  // scheduleWpLookupAndCheck found the real "Ford C1 platform" article, and
  // checking THAT article -- which lists every car ever built on it -- pulled
  // in a dozen unrelated nameplates.
  //
  // The prompt now says this outright (see SYSTEM_PROMPT/buildMessages), but
  // a prompt is a request, not a guarantee, and the cost of one slip is a
  // permanent junk node plus a cascade. This is the guarantee: anything that
  // reads as a platform/architecture rather than a car is dropped before it
  // can be matched or minted. Deliberately conservative -- it only rejects
  // names that SAY they're a platform, or bare codes with no marque at all,
  // so a real car is never lost to it.
  const PLATFORM_NAME_RE = /\b(platform|architecture|chassis|underpinnings|modul(ar)?\s+(toolkit|matrix)|body-on-frame)\b/i;
  // A bare engineering code with no manufacturer or model word: "GMT001",
  // "CD3", "PQ35", "MQB", "W203/W204". Real cars essentially always carry a
  // marque or a word.
  const BARE_CODE_RE = /^[A-Z]{1,4}[0-9]{1,4}([/\-][A-Z0-9]{1,6})*$/;
  // The all-letter platform acronyms BARE_CODE_RE can't reach, since it needs
  // a digit to fire. A curated list rather than a "bare 3-4 capitals" rule on
  // purpose: a rule that broad would swallow real badge names (GTO, GTI, RSX,
  // SLR). Every entry here is a manufacturer architecture that no car is
  // named after, so nothing real is at risk. Add to it when one slips
  // through; don't loosen it into a pattern.
  const PLATFORM_ACRONYMS = new Set([
    "MQB", "MLB", "MEB", "MSB", "PPE", "SSP", "PQ24", "PQ25",
    "TNGA", "GA-C", "GA-K", "GA-B", "CMF", "CMP", "EMP2",
    "BMA", "FAAR", "SPA", "CMA", "GEM", "BEV3", "MHP",
  ]);
  function looksLikePlatformNotCar(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (PLATFORM_NAME_RE.test(t)) return true;
    if (BARE_CODE_RE.test(t)) return true;
    if (PLATFORM_ACRONYMS.has(t.toUpperCase())) return true;
    return false;
  }

  function validate(raw, wikitext) {
    const hay = wikitext.toLowerCase();
    // Shared across every generation in this proposal so no two of them can
    // end up with the same photo -- see findGenerationImage's own comment for
    // the "most of the time it uses the same picture for each generation"
    // report this fixes.
    const usedFiles = new Set();
    const gens = (Array.isArray(raw && raw.generations) ? raw.generations : [])
      .map(g => (g && g.code ? { g, anchor: codeAnchorIn(hay, g.code) } : { g, anchor: -1 }))
      .filter(o => o.anchor >= 0)
      .map(({ g, anchor }) => {
        // Only the verifiable part of a composite code is stored -- see
        // codeVerifiedIn for the Opel Astra report this closes.
        const code = codeVerifiedIn(hay, g.code);
        return {
          code, anchor,
          yearStart: Number.isFinite(g.yearStart) ? g.yearStart : null,
          yearEnd: Number.isFinite(g.yearEnd) ? g.yearEnd : null,
          designers: (Array.isArray(g.designers) ? g.designers : []).filter(d => d && hay.includes(String(d).toLowerCase())),
          engineers: (Array.isArray(g.engineers) ? g.engineers : []).filter(d => d && hay.includes(String(d).toLowerCase())),
          wikiFile: null,   // filled in after the list is settled -- see below
          // Same hallucination guard as designers/engineers above: only kept
          // if the claimed other-nameplate name appears verbatim in the
          // source article. This is free text (not a controlled vocabulary),
          // so it's matched against the graph itself later, at apply time —
          // see applyConfirmed's resolvePlatformMention. Real user request:
          // "make sure that the LLM is formatted so that it can capture
          // every related car that is listed" -- a single generation is
          // often related to SEVERAL other nameplates at once (e.g. one
          // platform shared across many badge-engineered siblings), so this
          // is now a de-duped ARRAY, each entry independently hallucination-
          // guarded, rather than one single string that could only ever
          // carry the first match the model happened to report. `sharedPlatform`
          // (singular) is still accepted on the way IN for backward
          // compatibility with an older model response shape, but the
          // validated output is always the array form from here on.
          sharedPlatforms: dedupeCaseInsensitive(
            (Array.isArray(g.sharedPlatforms) ? g.sharedPlatforms : (g.sharedPlatform ? [g.sharedPlatform] : []))
              .map(s => String(s || "").trim())
              // Verbatim in the source AND actually a car -- see
              // looksLikePlatformNotCar for the Honda Prelude -> GM Delta
              // platform cascade this second condition stops.
              .filter(s => s && hay.includes(s.toLowerCase()) && !looksLikePlatformNotCar(s))
          ),
        };
      });
    // Photos are allocated only AFTER the generation list is settled, and that
    // ordering matters. Assigning them during the map above meant a spurious
    // entry -- the G-Class's W463A, which is really just another name for the
    // 2018 car -- claimed a photo on its way past and left the real generation
    // behind it with nothing, even though the entry itself was merged away
    // moments later. Photos belong to generations that actually exist.
    const settled = reconcileRepeatedCodes(gens);
    const seenCodes = new Map();
    settled.forEach(g => {
      // Which section this generation is: when an article names one code in
      // two headings (the G-Class's two W463 sections), the first entry for
      // that code takes the first section, the second takes the second.
      // Without this both look up the same section, and the later generation
      // can never find text or a photo of its own.
      const lookupCode = g.codeBase || g.code;
      const seenBefore = seenCodes.get(norm(lookupCode)) || 0;
      seenCodes.set(norm(lookupCode), seenBefore + 1);
      const wikiFile = findGenerationImage(wikitext, lookupCode, g.anchor, usedFiles, seenBefore);
      if (wikiFile) usedFiles.add(wikiFile.toLowerCase());
      g.wikiFile = wikiFile;
      delete g.anchor;
    });
    return { hasMultipleGenerations: settled.length > 1, generations: settled };
  }

  // ---------- two entries claiming the same code ----------
  // Real bug report, on the Mercedes-Benz G-Class: the proposal came back with
  // W463 twice (1990-2018 and 2018-2024) plus a W463A (2018-2022), and the
  // graph ended up showing "G-Class W463 2018-2024" twice with the real
  // 1990-2018 generation nowhere, one of the two sitting outside the nameplate
  // as a disconnected node. "the LLM found two entries of the W463, but didn't
  // read the full label."
  //
  // Two genuinely different things were tangled together there, and they need
  // opposite treatment:
  //
  //   * W463 vs W463A over the SAME years is one car listed twice. Wikipedia
  //     says so outright -- Mercedes never renamed anything, and "some sources
  //     unofficially designate the updated model as W463A". Collapsing it is
  //     right.
  //   * W463 (1990-2018) vs W463 (2018-) is genuinely two different vehicle
  //     generations that really do share one factory designation -- the
  //     article calls this out as unusual and unexplained. BOTH have to
  //     survive, and they have to be told apart, or the later one silently
  //     overwrites the earlier (which is exactly what happened: identical
  //     codes produced identical node ids).
  //
  // So: same code AND overlapping years means one car said twice -- merge.
  // Same code and DISJOINT years means two real generations -- keep both, and
  // stamp the start year into the code so everything downstream (node ids,
  // labels, section lookups, relation matching) can tell them apart.
  // Strict on purpose. One generation ending in the same year the next begins
  // is the NORMAL handover pattern, not an overlap -- the G-Class's W463 ran
  // 1990-2018 and its replacement starts in 2018. Treating that shared
  // boundary year as an overlap is what would collapse two real generations
  // into one, which is the very bug this whole area exists to fix.
  function spansOverlap(a, b) {
    const aStart = a.yearStart, bStart = b.yearStart;
    if (aStart == null || bStart == null) return true;   // unknown years: assume the same thing said twice
    const aEnd = a.yearEnd != null ? a.yearEnd : 9999;
    const bEnd = b.yearEnd != null ? b.yearEnd : 9999;
    if (aStart === bStart) return true;                  // same start year is the same car, however it ends
    return aStart < bEnd && bStart < aEnd;
  }
  // "W463" and "W463A" -- an official code and the same code with a short
  // suffix someone added to distinguish a facelift. Only treated as the same
  // family of code when the extra part is 1-2 characters; "W463" and "W4630"
  // would be a different code, not a variant spelling.
  function codeVariantOf(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const [shortC, longC] = x.length <= y.length ? [x, y] : [y, x];
    return longC.startsWith(shortC) && longC.length - shortC.length <= 2;
  }
  function mergeGenerationEntries(keep, extra) {
    // The base designation wins over a longer variant of it: "W463A" is not a
    // Mercedes code, it is "W463" with a letter added by someone needing to
    // tell two cars apart, so the article's own name for the car is the one to
    // keep. The dropped spelling is recorded in alsoCoded below, not lost.
    if (norm(extra.code).length < norm(keep.code).length) {
      const swapCode = keep.code; keep.code = extra.code; extra.code = swapCode;
      // The anchor goes with the code -- it is where THAT spelling was found in
      // the article, and the photo lookup below uses it.
      const swapAnchor = keep.anchor; keep.anchor = extra.anchor; extra.anchor = swapAnchor;
    }
    if (keep.yearStart == null || (extra.yearStart != null && extra.yearStart < keep.yearStart)) {
      keep.yearStart = extra.yearStart;
    }
    // An absent end year means "still in production", which is later than any
    // stated year -- so it wins rather than being treated as missing data.
    if (keep.yearEnd != null) {
      keep.yearEnd = extra.yearEnd == null ? null : Math.max(keep.yearEnd, extra.yearEnd);
    }
    if (!keep.wikiFile) keep.wikiFile = extra.wikiFile;
    keep.designers = dedupeCaseInsensitive([...(keep.designers || []), ...(extra.designers || [])]);
    keep.engineers = dedupeCaseInsensitive([...(keep.engineers || []), ...(extra.engineers || [])]);
    keep.sharedPlatforms = dedupeCaseInsensitive([...(keep.sharedPlatforms || []), ...(extra.sharedPlatforms || [])]);
    // Kept so the card can say "also written W463A" rather than silently
    // dropping a name the article really does use.
    if (norm(extra.code) !== norm(keep.code)) {
      keep.alsoCoded = dedupeCaseInsensitive([...(keep.alsoCoded || []), extra.code]);
    }
    return keep;
  }
  function reconcileRepeatedCodes(gens) {
    const out = [];
    gens.forEach(g => {
      const twin = out.find(o => codeVariantOf(o.code, g.code) && spansOverlap(o, g));
      if (twin) { mergeGenerationEntries(twin, g); return; }
      out.push(g);
    });
    // Anything still sharing an exact code after the merge above is the real
    // two-eras-one-designation case. Disambiguate by start year -- the only
    // thing that actually distinguishes them, and what a reader would use.
    const byCode = new Map();
    out.forEach(g => {
      const k = norm(g.code);
      if (!byCode.has(k)) byCode.set(k, []);
      byCode.get(k).push(g);
    });
    byCode.forEach(list => {
      if (list.length < 2) return;
      list.forEach(g => {
        if (g.yearStart == null) return;
        g.codeBase = g.code;
        g.code = `${g.code} (${g.yearStart})`;
        g.repeatedCode = true;
      });
    });
    return out;
  }

  // Wikipedia/Commons file title -> a directly-usable image URL, no extra
  // API round trip needed: Special:FilePath redirects straight to the file,
  // so it works as a plain <img src> or CSS background-image.
  function filePathUrl(file, width) {
    return "https://en.wikipedia.org/wiki/Special:FilePath/" +
      encodeURIComponent(String(file).replace(/ /g, "_")) + "?width=" + (width || 480);
  }

  // Split out of runCheck below so the playground (see "manual LLM
  // testing" section near the end of this file) can build and display the
  // EXACT prompt a real check would send -- without actually calling
  // llama.cpp -- for a person to paste into their own local model and bring
  // the raw response back.
  // How many delegated sub-articles are worth pulling in. Each is one extra
  // Wikipedia fetch (no LLM call), and they only exist for nameplates that
  // genuinely delegate, so this is rare rather than routine.
  const MAX_SUB_ARTICLES = 6;
  async function buildCheckMaterial(node, priorProposal, feedback) {
    const wp = node.wp || node.label;
    let { wikitext, digest } = await fetchArticleDigest(wp);
    // ---------- follow {{Main|...}} sub-articles (the Kia Pride case) ----------
    // Only when the main article delegates AND doesn't already describe the
    // generations itself: if the headings/cues already carry the detail,
    // fetching more is wasted work. See extractDigest's subArticles comment.
    const subs = (digest.subArticles || []).slice(0, MAX_SUB_ARTICLES);
    if (subs.length) {
      const fetched = await Promise.all(subs.map(sa =>
        fetchArticleDigest(sa.title)
          .then(r => ({ sa, wikitext: r.wikitext, digest: r.digest }))
          .catch(() => null)));
      const good = fetched.filter(Boolean);
      if (good.length) {
        // The hallucination guard checks every claimed code/name against
        // `wikitext`, so the sub-articles' text has to become part of that
        // haystack -- otherwise everything found in them would be validated
        // away as "not in the source", which is exactly the failure the
        // guard is meant to prevent for INVENTED facts, not real ones read
        // from a page the article itself points at.
        wikitext = wikitext + "\n\n" + good.map(g => g.wikitext).join("\n\n");
        // Surfaced to the model as clearly-labelled extra material, attributed
        // to the heading each link sat under.
        digest = Object.assign({}, digest, {
          subArticleTexts: good.map(g => ({
            title: g.sa.title, heading: g.sa.heading,
            infobox: g.digest.infobox || "",
            cues: (g.digest.cues || []).slice(0, 12),
          })),
        });
      }
    }
    const messages = buildMessages(node, digest, priorProposal, feedback);
    return { wp, wikitext, digest, messages };
  }
  // `manualRaw`, when supplied, skips the real askLlamaCpp() call entirely
  // and validates/applies THAT response instead -- the other half of the
  // playground, letting a hand-supplied (or previously-saved) response run
  // through the exact same hallucination guard and result shape a live
  // call would produce.
  // `nodes`, when supplied, is the live graph node array -- purely
  // read-only here, used to run the extra LLM "sanity check" duplicate pass
  // (annotateSharedPlatformMatches, see its own comment) over every
  // shared-platform/rebadge mention THIS proposal found, before it's ever
  // handed back to be applied to the graph. Optional and always backward
  // compatible: every existing caller (and every existing test) that
  // doesn't pass it just gets the old deterministic-only behavior, same as
  // before this feature existed -- including the playground's own preview
  // path, which deliberately never runs a real network call at all.
  async function runCheck(node, priorProposal, feedback, manualRaw, nodes) {
    const { wp, wikitext, messages } = await buildCheckMaterial(node, priorProposal, feedback);
    const raw = manualRaw !== undefined ? manualRaw
      : await askLlamaCpp(messages, `${node.make || ""} ${node.label}`.trim() + " · split");
    const clean = validate(raw, wikitext);
    if (nodes) await annotateSharedPlatformMatches(nodes, node.id, clean);
    // Kept alongside the (possibly much shorter, hallucination-filtered)
    // clean result purely for debugging "why didn't it find anything" cases
    // like the Dacia Logan — lets you see what the model actually said,
    // and separately, anything it said that got dropped for not appearing
    // verbatim in the source (a genuine miss vs. the guard being overly strict).
    const dropped = (Array.isArray(raw && raw.generations) ? raw.generations : [])
      .filter(g => !clean.generations.some(c => c.code === String(g && g.code)));
    // The engines this car's own article names, noted while the wikitext is
    // already in hand. Costs one regex over a string that was fetched anyway,
    // and is the whole of "after a car is searched, the information about the
    // engine also gets revealed" -- nothing here follows an engine article.
    return { wp, wikitext, clean, raw, dropped, messages };
  }

  // ---------- public: check a node for the first time ----------
  // `nodes`, when supplied by the caller (app.js passes its own live graph
  // array), enables the extra LLM sanity-check duplicate pass -- see
  // runCheck's own comment. Optional; omitting it just skips that pass.
  function checkNode(node, nodes, opts) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    const existing = entryFor(node.id);
    if (existing) return Promise.resolve(existing); // already checked — never re-run automatically
    if (inFlight.has(node.id)) return inFlight.get(node.id);
    if (!node.wp) {
      const entry = { status: "no-wiki-link", checkedAt: new Date().toISOString() };
      store.families[node.id] = entry; persist();
      return Promise.resolve(entry);
    }
    const p = (async () => {
      try {
        const { wp, wikitext, clean, raw, dropped } = await runCheck(node, null, null, undefined, nodes);
        // What this car ran, noted but not followed. See recordEngineMentions.
        const engineHits = engineMentions(wikitext);
        const entry = {
          status: clean.generations.length > 1 ? "provisional" : "none",
          checkedAt: new Date().toISOString(),
          sourceTitle: wp,
          proposal: clean,
          attempts: 1,
          feedback: [],
          engines: engineHits,
          debug: { raw, dropped },
        };
        if (entry.status === "provisional") {
          // Real bug report: an explicit LLM search on the Opel Astra ran
          // twice, ~100 seconds each, produced a full generation proposal
          // both times, and the car stayed a plain model. Nothing was wrong
          // with the answer -- it was thrown away. Twice.
          //
          // The rule below is right for idle browsing: clicking through one
          // car after another shouldn't quietly pile up proposals nobody
          // asked for, so a result that arrives after you've moved on is
          // dropped. But a check takes a minute or more, and anything that
          // disturbs the page in that window -- a reload, opening another
          // car, the panel re-rendering -- silently discarded a minute of
          // work with no message at all.
          //
          // When the user ASKED for this specific car to be checked, that
          // reasoning doesn't apply: the result is wanted whether or not
          // they are still staring at the panel, and it survives a reload.
          if (opts && opts.explicit) {
            store.families[node.id] = entry;
            await persist();
            return entry;
          }
          if (engagedId === node.id) store.families[node.id] = entry;
          return entry;
        }
        store.families[node.id] = entry; await persist();
        return entry;
      } catch (e) {
        const entry = { status: "error", checkedAt: new Date().toISOString(), error: String(e.message || e), attempts: 1 };
        if (engagedId !== node.id) return entry; // walked away mid-check -- don't persist a transient error
        store.families[node.id] = entry; await persist();
        return entry;
      } finally {
        inFlight.delete(node.id);
      }
    })();
    inFlight.set(node.id, p);
    return p;
  }

  // ---------- public: cascading check, triggered by a related car's own relation-check ----------
  // checkNode() above deliberately DISCARDS a "provisional" verdict unless
  // the user is still looking at that exact car's detail panel when the
  // check comes back -- that's right for idle browsing (opening one car
  // after another shouldn't quietly pile up unread proposals), but wrong
  // for THIS trigger: app.js's relation-check UI calls this when a family
  // the user IS actively looking at has a coarse platform/related/
  // succession connection to some OTHER, still-plain model that's never
  // been checked at all -- e.g. the BMW X3 nameplate turns out to relate to
  // a "BMW X4" that's still just one ungrouped model. The user is
  // deliberately engaged with that relationship, just not with the X4
  // node's own detail panel specifically, so discarding the result the
  // instant they're not is exactly backwards here. Always keeps a
  // "provisional" verdict in memory (still never written to DISK until a
  // real Yes/No decision, same discipline as everywhere else in this file)
  // and shares checkNode's own inFlight map, so a car that's independently
  // opened directly around the same time doesn't trigger two llama.cpp calls.
  function checkNodeCascade(node, nodes) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    const existing = entryFor(node.id);
    if (existing) return Promise.resolve(existing);
    if (inFlight.has(node.id)) return inFlight.get(node.id);
    if (!node.wp) {
      const entry = { status: "no-wiki-link", checkedAt: new Date().toISOString() };
      store.families[node.id] = entry; persist();
      return Promise.resolve(entry);
    }
    const p = (async () => {
      try {
        const { wp, clean, raw, dropped } = await runCheck(node, null, null, undefined, nodes);
        const entry = {
          status: clean.generations.length > 1 ? "provisional" : "none",
          checkedAt: new Date().toISOString(),
          sourceTitle: wp,
          proposal: clean,
          attempts: 1,
          feedback: [],
          debug: { raw, dropped },
          cascadeDiscovered: true,
        };
        store.families[node.id] = entry;
        if (entry.status !== "provisional") await persist();
        return entry;
      } catch (e) {
        const entry = { status: "error", checkedAt: new Date().toISOString(), error: String(e.message || e), attempts: 1 };
        store.families[node.id] = entry; await persist();
        return entry;
      } finally {
        inFlight.delete(node.id);
      }
    })();
    inFlight.set(node.id, p);
    return p;
  }

  // ---------- public: retry with human feedback ----------
  function retryNode(node, reason, nodes) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    const existing = entryFor(node.id) || {};
    if ((existing.attempts || 0) >= MAX_ATTEMPTS) {
      return Promise.resolve(Object.assign({}, existing, { status: "max-attempts" }));
    }
    if (inFlight.has(node.id)) return inFlight.get(node.id);
    const wp = existing.sourceTitle || node.wp || node.label;
    const p = (async () => {
      try {
        const { clean, raw, dropped } = await runCheck(node, existing.proposal || null, reason, undefined, nodes);
        const entry = {
          status: clean.generations.length > 1 ? "provisional" : "none",
          checkedAt: new Date().toISOString(),
          sourceTitle: wp,
          proposal: clean,
          attempts: (existing.attempts || 0) + 1,
          feedback: [...(existing.feedback || []), reason],
          debug: { raw, dropped },
        };
        if (entry.status === "provisional") {
          if (engagedId === node.id) store.families[node.id] = entry;
          return entry;
        }
        store.families[node.id] = entry; await persist();
        return entry;
      } catch (e) {
        const entry = Object.assign({}, existing, {
          status: "error", checkedAt: new Date().toISOString(), error: String(e.message || e),
          attempts: (existing.attempts || 0) + 1,
        });
        if (engagedId !== node.id) return entry;
        store.families[node.id] = entry; await persist();
        return entry;
      } finally {
        inFlight.delete(node.id);
      }
    })();
    inFlight.set(node.id, p);
    return p;
  }

  // Who is driving this session: a person at the keyboard, or
  // scripts/llm_agent.py working through a queued scan request.
  //
  // It matters because a plain model found to hide several generations is
  // confirmed and applied WITHOUT being asked -- a deliberate decision ("if a
  // car is creating a nameplate for the first time... you do not need my
  // approval"), made when the only way to trigger a check was to click a car
  // and watch what happened. An unattended run applies a dozen of those that
  // nobody looked at, and afterwards they were indistinguishable from the
  // ones a human approved. Stamping the decision is what makes a bad run
  // reviewable instead of archaeology.
  //
  // Session-only and deliberately not persisted anywhere itself: it describes
  // the current driver, so a reload is correctly back to "user".
  let decisionSource = "user";
  function setDecisionSource(src) {
    decisionSource = src === "agent" ? "agent" : "user";
  }

  function confirmNode(nodeId) {
    const e = entryFor(nodeId); if (!e) return;
    e.decidedBy = decisionSource;
    // First time this entry is ever written to disk -- a provisional
    // proposal is kept in memory only (see checkNode/retryNode) right up
    // until this moment.
    e.status = "confirmed"; e.decidedAt = new Date().toISOString();
    // Recorded here (separately from proposal.generations) so the names the
    // LLM found survive even if this nameplate later gets deleted via the
    // debug panel -- deleteEntry() keeps just this pair as a tombstone, and
    // applyConfirmed's "deleted" branch below uses it to credit the plain
    // model node directly instead of losing the attribution entirely.
    const gens = (e.proposal && e.proposal.generations) || [];
    const ds = new Set(), es = new Set();
    gens.forEach(g => {
      (g.designers || []).forEach(d => ds.add(d));
      (g.engineers || []).forEach(d => es.add(d));
    });
    e.allDesigners = [...ds];
    e.allEngineers = [...es];
    persist();
  }
  // "No, inaccurate" doesn't record a rejection anymore -- it forgets the
  // check ever happened (nothing was persisted yet, so this is just an
  // in-memory delete) so the car is checkable again later exactly as if
  // for the first time. app.js also turns LLM Check mode off when this is
  // called, since clicking No is a signal to stop probing more cars right
  // now, not just this one.
  function rejectNode(nodeId) {
    delete store.families[nodeId];
  }

  // ---------- name -> person-node matching (mirrors data_src/build_data.py's slug()/norm()) ----------
  const COMBINING_MARKS_RE = new RegExp("[\\u0300-\\u036f]", "g");
  function norm(s) {
    return String(s).normalize("NFKD").replace(COMBINING_MARKS_RE, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  function slugify(s) {
    let t = String(s).normalize("NFKD").replace(COMBINING_MARKS_RE, "").toLowerCase().replace(/ß/g, "ss");
    t = t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return t || "x";
  }

  // Shared, less-optimized sibling of applyConfirmed's own local
  // resolvePerson() closure -- used by the much rarer applyFamilyOverride
  // path (feature: nameplate generation cross-check) below, kept separate
  // so that well-exercised code path is never touched by this one.
  function resolvePersonNode(nodes, byId, name, role) {
    const key = norm(name);
    if (!key) return null;
    let p = null;
    for (const n of nodes) { if (n.type === "person" && norm(n.label) === key) { p = n; break; } }
    if (!p) {
      let id = "p-" + slugify(name);
      if (byId.has(id)) id = id + "-" + Math.random().toString(36).slice(2, 6);
      // See scheduleFactBackfill's own comment (defined further down, but
      // hoisted -- ordinary function declarations, not const arrow fns) for
      // the "very big attempt" this reuses a prior boot's cached answer, or
      // kicks off a fresh Wikipedia-then-recall lookup, for born/died/
      // country instead of leaving a newly-minted designer/engineer stuck at
      // null forever.
      const cached = store.mintedFacts[id];
      p = { id, type: "person", kind: "person", label: name, roles: [role],
            born: cached && cached.born != null ? cached.born : null,
            died: cached && cached.died != null ? cached.died : null,
            country: cached && cached.country != null ? cached.country : null,
            wp: null, llmGenerated: true };
      if (cached && cached.source) p.factsSource = cached.source;
      nodes.push(p); byId.set(id, p);
      if (!cached) scheduleFactBackfill("person", id, p, () => bigPersonAttempt(name));
    } else if (!p.roles.includes(role)) {
      p.roles = [...p.roles, role];
    }
    return p;
  }

  function relKey(a, b, relType) { return [a, b].sort().join("|") + "|" + relType; }

  // ---------- de-duplication: does this LLM-proposed generation code already exist as its own node somewhere else? ----------
  // Used by applyFamilyOverride and applyConfirmed (see their own comments,
  // right where this is called) when a freshly-proposed generation has no
  // match among the family's OWN existing generations -- checks whether the
  // exact same car already sits elsewhere in the graph, in one of two ways:
  //
  //   1. as an independent, never-grouped standalone model
  //      (build_family_layer.py's automatic (make, base-name) grouping only
  //      catches nameplates whose generations share a common label pattern;
  //      a differently-labeled generation, like the Mercedes-Benz SL-Class's
  //      R107, is invisible to it and stays permanently standalone until
  //      something like this catches it).
  //   2. as a generation already grouped under a DIFFERENT, pre-existing
  //      family -- real bug report: build-time grouping had already filed
  //      the SL-Class's R129/R230/R231 under one family (from a "SL-Class
  //      (<code>)" label pattern), but a LATER, more thorough LLM read of
  //      the plain "SL-Class" overview article found ALL FOUR generations
  //      (R107 included) and, since tier 1 above explicitly skips anything
  //      with a `familyOf` already set, minted a second, fully duplicate
  //      family with its own R129/R230/R231 nodes instead of recognizing
  //      the build-time ones as the same cars. Searched the same way tier 1
  //      is, just without excluding nodes that already belong to some OTHER
  //      family (excluding only the family currently being built, `famId`
  //      itself, which could never be a meaningful "duplicate" of its own
  //      generation).
  //
  // Real bug report, second half: even tier 1's exact-label match doesn't
  // fire when DBpedia filed more than one designation under a single
  // COMBINED article/resource, e.g. "Mercedes-Benz R107 and C107" -- the
  // LLM's own extracted code is just "R107", which normalizes to something
  // different than the combined label as a whole ("r107" vs "r107andc107")
  // and so never matched, silently leaving the old combined node behind
  // forever. Tier 2 below (checked only once tier 1 finds nothing at all)
  // handles this: splits a label on common combining words/punctuation
  // (", ", " and ", "/", "&") into its distinct named parts and requires an
  // EXACT match against one of THOSE -- still never a substring/contains
  // guess (the loose-match false-positive this codebase is deliberately
  // careful about elsewhere, e.g. the Toyota C-HR bug), just tolerant of a
  // label that names more than one thing at once.
  function labelParts(label) {
    return String(label || "").split(/\s*(?:,|\/|&|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
  }
  // A generation ALREADY grouped under some other pre-existing family (tier
  // 3 below's whole reason for existing) is never labeled with just its
  // bare code -- this app's own convention (both build_family_layer.py at
  // build time and this file's own generation-minting above) is always
  // "<nameplate name> (<code>)" or "<nameplate name> <code>", e.g.
  // "SL-Class (R129)" or "SL-Class R129", never "R129" alone. Tier 1's
  // whole-label exact match can therefore never fire for this case no
  // matter how the search pool is widened -- it needs the CODE isolated
  // from the nameplate name first. Returns { base, code } (or null) so the
  // caller can verify the BASE portion too, not just the code -- see tier
  // 3's own comment for why that check is essential, not optional. Prefers
  // a trailing "(...)" group (the more common, build-time-generated
  // format); falls back to splitting off the last whitespace-separated
  // token (this file's own `${label} ${code}` format) when there are no
  // parens at all.
  function trailingCode(label) {
    const s = String(label || "").trim();
    const paren = s.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (paren) return { base: paren[1].trim(), code: paren[2].trim() };
    const parts = s.split(/\s+/);
    return parts.length > 1 ? { base: parts.slice(0, -1).join(" "), code: parts[parts.length - 1] } : null;
  }
  // `make` scopes the search to the SAME manufacturer as the nameplate
  // being processed -- a bare chassis/generation code like "R107" is short
  // enough that, once the search pool widens (as it now does, tiers 2/3
  // below, to every OTHER family's generations too, not just ungrouped
  // standalone models), an accidental same-code collision from a completely
  // different manufacturer becomes a real risk, not just a theoretical one.
  // Required, not optional -- a duplicate match across manufacturers is
  // never correct.
  //
  // `nameplateLabel` (the nameplate CURRENTLY being processed's own label,
  // e.g. "SL-Class") is required for the SAME reason, one level narrower:
  // even within the same manufacturer, a short generation code is not
  // globally unique across DIFFERENT nameplates -- real example found while
  // testing this exact fix: BMW's own G01 is the X3, but G02 is a
  // completely different, unrelated nameplate (the X4). Tier 3's
  // trailing-code match, before this check existed, matched an X4 "G01"
  // proposal straight onto the X3's own "X3 (G01)" generation purely
  // because the bare codes happened to collide -- two different cars,
  // wrongly treated as the same one. Tiers 1/2 don't need this because
  // matching the candidate's ENTIRE label (or a full named part of it) is
  // already specific enough to make an accidental collision vanishingly
  // unlikely; tier 3 only ever compares the short trailing code, so it
  // additionally requires the candidate's own BASE name (everything before
  // that code) to match the nameplate actually being processed.
  function findDuplicateGeneration(nodes, code, famId, make, nameplateLabel) {
    const key = norm(code);
    const makeKey = norm(make);
    const nameKey = norm(nameplateLabel);
    if (!key || !makeKey) return null;
    const eligible = n => n.type === "model" && !n.retired && n.id !== famId && n.familyOf !== famId && norm(n.make) === makeKey;
    // Tier 1: the node's own whole label is an exact match -- a genuinely
    // standalone car whose label IS just the bare code (or happens to equal
    // it exactly), the highest-confidence case.
    for (const n of nodes) { if (eligible(n) && norm(n.label) === key) return n; }
    // Tier 2: a combined-designation label ("R107 and C107") names this
    // code as one of its distinct parts -- see this function's own comment
    // above for the real bug report this fixes.
    for (const n of nodes) {
      if (!eligible(n)) continue;
      const parts = labelParts(n.label);
      if (parts.length > 1 && parts.some(p => norm(p) === key)) return n;
    }
    // Tier 3: an already-grouped generation labeled "<nameplate> (<code>)"
    // or "<nameplate> <code>" -- see trailingCode's own comment for why
    // this is its own tier, not folded into tier 1, and this function's own
    // comment above for why the base-name check here is essential.
    if (nameKey) {
      for (const n of nodes) {
        if (!eligible(n)) continue;
        const tc = trailingCode(n.label);
        if (tc && norm(tc.code) === key && norm(tc.base) === nameKey) return n;
      }
    }
    return null;
  }
  // Companion to findDuplicateGeneration above: once a generation that
  // belonged to some OTHER pre-existing family gets superseded, that old
  // family can end up an empty husk -- every one of its generations now
  // retired, but the family node itself still sitting in the graph as a
  // visible, expandable-but-empty dot. Same "never delete, just make
  // invisible" discipline as everywhere else here: if NONE of a family's
  // generations are still live, retire the family node too, pointed at its
  // replacement so anything holding the old family's id (a persisted
  // relation entry, an old bookmark/search) still resolves via
  // followSuperseded instead of hitting a dead end. Left alone (not
  // retired) if even one of its generations is still live -- a partial
  // supersession is common and totally fine, the family just keeps showing
  // whatever's left.
  function retireOrphanedFamily(byIdLocal, oldFamId, replacementId, replacementLabel) {
    const oldFam = byIdLocal.get(oldFamId);
    if (!oldFam || oldFam.type !== "family" || oldFam.retired) return;
    const gens = (oldFam.generations || []).map(id => byIdLocal.get(id)).filter(Boolean);
    if (!gens.length || gens.some(g => !g.retired)) return;
    oldFam.retired = true;
    oldFam.retiredAt = new Date().toISOString();
    oldFam.retiredReason = "every one of its generations was superseded by the LLM-confirmed generation list for " + replacementLabel;
    oldFam.supersededBy = replacementId;
  }

  // Everything a standalone duplicate KNOWS must survive its retirement --
  // retiring the node alone isn't enough. The old standalone (e.g. the
  // SL-Class's R107, which lived independently in the graph for years) can
  // carry real, hard-won connections and data of its own: platform/related/
  // succession links to OTHER cars, direct designed/engineered links to
  // person nodes, a My Database match (gold ring, specs, photo, overview
  // page), a garage/heritage flag, its own dedicated Wikipedia article, and
  // production years the LLM's fresh read may not have found. Simply
  // hiding the node would silently sever every one of those -- links to a
  // hidden node never draw, so e.g. "R107 related to Porsche 928" would
  // just vanish from the graph the moment the de-dup kicked in. This
  // transplants all of it onto the replacement generation node:
  //   - flags/fields (db/garage/heritage/dbspecs/dbphoto/dbPage/wp/year/
  //     end/designers/engineers) fill gaps on `gn`, never overwrite
  //     anything the LLM's own proposal already supplied;
  //   - every platform/related/succession/designed/engineered link touching
  //     the dup gets an equivalent link minted to `gn` (deduped, tagged
  //     `rebound` + `reboundFrom`), the original left in place untouched --
  //     invisible while its endpoint is retired, and instantly valid again
  //     if the LLM entry is ever deleted (fresh boot: nothing retires the
  //     standalone, nothing mints the rebound copies, original state back
  //     with zero unwinding, same guarantee as everywhere else here);
  //   - `supersededBy` records where the dup went, so anything holding its
  //     id (a persisted store.relations entry, see applyResolvedRelations/
  //     applySharedPlatformForSingleGen) can transparently follow the
  //     redirect instead of wiring new links to a permanently-hidden node.
  const REBOUND_LINK_TYPES = ["platform", "related", "succession", "designed", "engineered"];
  function supersedeStandalone(nodes, links, dup, gn, famId, famLabel) {
    dup.retired = true;
    dup.retiredFrom = famId;
    dup.retiredAt = new Date().toISOString();
    dup.retiredReason = "superseded by the LLM-confirmed generation list for " + famLabel;
    dup.supersededBy = gn.id;
    if (gn.year == null && dup.year != null) gn.year = dup.year;
    if (gn.end == null && dup.end != null) gn.end = dup.end;
    if (!gn.wp && dup.wp) gn.wp = dup.wp;
    if (dup.db) {
      gn.db = true;
      if (dup.dbspecs && !gn.dbspecs) gn.dbspecs = dup.dbspecs;
      if (dup.dbphoto && !gn.dbphoto) gn.dbphoto = dup.dbphoto;
      if (dup.dbPage && !gn.dbPage) gn.dbPage = dup.dbPage;
    }
    if (dup.garage) gn.garage = true;
    if (dup.heritage) gn.heritage = true;
    const dset = new Set(gn.designers || []);
    (dup.designers || []).forEach(d => dset.add(d));
    gn.designers = [...dset];
    const eset = new Set(gn.engineers || []);
    (dup.engineers || []).forEach(d => eset.add(d));
    gn.engineers = [...eset];
    const dupId = dup.id;
    const n0 = links.length; // snapshot -- don't re-scan links this loop just pushed
    for (let i = 0; i < n0; i++) {
      const l = links[i];
      if (REBOUND_LINK_TYPES.indexOf(l.type) < 0) continue;
      const s = idOf(l.source), t = idOf(l.target);
      if (s !== dupId && t !== dupId) continue;
      const otherId = s === dupId ? t : s;
      if (otherId === gn.id || otherId === famId || otherId === dupId) continue;
      const ns = s === dupId ? gn.id : s, nt = t === dupId ? gn.id : t;
      const exists = links.some(l2 => l2.type === l.type &&
        ((idOf(l2.source) === ns && idOf(l2.target) === nt) || (idOf(l2.source) === nt && idOf(l2.target) === ns)));
      if (exists) continue;
      const nl = { source: ns, target: nt, type: l.type, rebound: true, reboundFrom: dupId };
      if (l.note) nl.note = l.note;
      // A repointed credit is still the same credit, so it keeps whatever
      // provenance the original had -- see app.js's creditIsLlmSourced for
      // why a person credit's source has to stay distinguishable.
      if (l.llmDiscovered) nl.llmDiscovered = true;
      if (l.llmResolved) { nl.llmResolved = true; if (l.llmResolvedKey) nl.llmResolvedKey = l.llmResolvedKey; }
      links.push(nl);
    }
  }

  // ---------- shared-platform/rebadge discovery -> matched against the graph itself ----------
  // The LLM's generation-extraction call (see SYSTEM_PROMPT) also looks for
  // a generation-level "this shares a platform with / is a rebadge of a
  // DIFFERENT nameplate" mention. That's just a free-text name pulled out of
  // the article, hallucination-guarded to appear verbatim in the source
  // (see validate()) -- it still has to be resolved against something real.
  // "Search for the model" (per the feature request) means searching the
  // graph itself: this app already has every known nameplate/model loaded
  // client-side, so that's the actual, complete universe to match against,
  // consistent with how every other name-matching in this codebase works
  // (resolvePerson above, build_db_layer.py's Car Database matcher, etc).
  // Returns { node, loose } (or null) rather than just the node -- `loose`
  // tells the caller (resolvePlatformMention) whether this came from the
  // exact-match branch or the substring fallback below, since those two
  // carry very different confidence: an exact "Toyota GT86" == "Toyota
  // GT86" match is about as trustworthy as text-matching gets, but a loose
  // substring hit can coincidentally fire on an unrelated node whose short
  // label just happens to appear inside a longer mention -- real bug
  // report: a Jeep Commander (XK) ended up auto-linked to a completely
  // unrelated Toyota C-HR this way. resolvePlatformMention only auto-
  // applies an exact match; a loose one always goes through the ordinary
  // provisional Yes/No review instead.
  function findMatchingNameplate(nodes, text, excludeFamId) {
    if (!text) return null;
    const key = norm(text);
    if (!key) return null;
    const eligible = n => (n.type === "model" || n.type === "family") &&
      n.id !== excludeFamId && n.familyOf !== excludeFamId;
    for (const n of nodes) {
      if (!eligible(n)) continue;
      if (norm(`${n.make} ${n.label}`) === key || norm(n.label) === key) return { node: n, loose: false };
    }
    // Loose fallback: the mentioned text contains (or is contained by) a
    // node's bare label, e.g. "the Toyota GT86 (badged as the Scion FR-S in
    // some markets)" containing "GT86" -- only accepted when exactly one
    // node matches this way, never on a guess between several.
    let loose = nodes.filter(n => eligible(n) && norm(n.label).length > 2 &&
      (key.includes(norm(n.label)) || norm(n.label).includes(key)));
    // Real bug report: a mention like "Toyota Corolla (E140/E150)" loosely
    // matched BOTH the specific generation node "Corolla (E140)" (already
    // in the graph) AND its own parent family node "Corolla" (whose bare
    // label is always a substring of anything one of its generations
    // matches) -- pushing loose.length to 2 and falling through to
    // mintRelatedNode, which created a brand-new duplicate "Toyota Corolla
    // (E140/E150)" node with no year/link instead of reusing the real
    // Corolla (E140) entry. When a family and one of its own generations
    // both loosely match, the generation is always the more specific/
    // correct answer, so drop the family from the candidate set here.
    if (loose.length > 1) {
      const looseIds = new Set(loose.map(n => n.id));
      loose = loose.filter(n => !(n.type === "family" && (n.generations || []).some(gid => looseIds.has(gid))));
    }
    return loose.length === 1 ? { node: loose[0], loose: true } : null;
  }

  // ---------- mint a brand-new node for a related car that isn't in the graph at all yet ----------
  // Real user request: "If the program looks through the wikipedia page of a
  // specific nameplate I clicked on, then it should also populate new cars
  // into the knowledge graph if it is mentioned as 'related', and should
  // then populate that model/nameplate as well (if the model/nameplate does
  // not yet exist, or if the relationship does not yet exist)." Before this,
  // findMatchingNameplate returning null (no existing node anywhere matches
  // the hallucination-guarded mention) meant the fact was just dropped --
  // correct when there's nothing to anchor a guess to, but it meant a real
  // related car that simply isn't in this dataset yet could never surface,
  // no matter how many articles mentioned it. Mints a genuinely new model
  // node instead (and a new make node too, if even the make isn't already
  // known), wired straight into the family the mention was found on.
  //
  // Splitting "Make Model" free text into its two parts: try every EXISTING
  // make label in the graph as a prefix first (longest match wins, so
  // "Mercedes-Benz X-Class" matches the real "Mercedes-Benz" make rather
  // than some shorter false positive) -- this covers the large majority of
  // real cases, since the related car's manufacturer is almost always
  // already a make somewhere in a dataset this size. Only when NO existing
  // make matches does this fall back to "the first word is the make", which
  // correctly handles the common case of a single-word manufacturer name
  // (Toyota, Honda, Mazda, ...) but is a known rough edge for a genuinely
  // NEW, space-separated multi-word make (rare, since most real multi-word
  // makes -- Mercedes-Benz, Aston Martin, Alfa Romeo, Land Rover -- would
  // already have matched the loop above).
  function findExistingMake(nodes, text) {
    const lower = String(text).toLowerCase();
    let best = null;
    for (const n of nodes) {
      if (n.type !== "make") continue;
      const label = String(n.label || "");
      const lLower = label.toLowerCase();
      if (!lLower) continue;
      if (lower === lLower || lower.startsWith(lLower + " ")) {
        if (!best || label.length > best.label.length) best = n;
      }
    }
    return best;
  }
  function uniqueId(nodes, id) {
    if (!nodes.some(n => n.id === id)) return id;
    return id + "-" + Math.random().toString(36).slice(2, 6); // exceedingly rare collision
  }
  // ---------- background fact-backfill: find a real year for a newly minted car, or a real birth/death/country for a newly minted person ----------
  // Real user request: "there should be a very big attempt at finding the
  // years for any new models (or designers, engineers, etc) that are added"
  // -- the Puch G (minted as a Mercedes-Benz G-Class platform-mate) was the
  // reported case, stuck at year: null forever with nothing ever trying to
  // fill it in. Two-tier attempt, cheapest/most-reliable first: (1) fetch
  // the new node's OWN Wikipedia article (same fetchArticleDigest() used for
  // the main generation-check feature) and ask the LLM to extract the fact
  // from that real text -- grounded, hallucination-guarded, same discipline
  // as everywhere else in this file; (2) only if that finds nothing (no
  // article, or the article genuinely doesn't state it), fall back to asking
  // the LLM to recall the fact from its own general training knowledge, with
  // an explicit high/low confidence self-rating and only a HIGH-confidence
  // answer trusted -- an honest null is always preferred over a plausible-
  // sounding guess. Runs as a background task AFTER the node is already in
  // the graph (see mintRelatedNode/resolvePersonNode below) rather than
  // blocking the synchronous mint -- everything else in this module mints
  // nodes synchronously mid-apply, and threading a network round-trip
  // through every one of those call sites would be a much bigger, riskier
  // change than updating a couple of fields once the answer is known.
  const YEAR_FACTS_SYSTEM_PROMPT = `You extract a car nameplate's OVERALL production year range from Wikipedia infobox/paragraph excerpts.
Respond with ONLY JSON, no prose, matching exactly this shape:
{"yearStart": number|null, "yearEnd": number|null}
Rules:
- yearStart is the year production/sales began; yearEnd is the year it ended, or null if it's still in production/on sale, or the text doesn't give an end date.
- Only use a year that is actually stated in the supplied text for THIS car -- never invent, estimate, or infer one from unrelated context.
- If the supplied text doesn't clearly state this car's own production years, return {"yearStart": null, "yearEnd": null} -- do not guess.`;
  const YEAR_KNOWLEDGE_SYSTEM_PROMPT = `Recall, from your own general knowledge (no source text is supplied here), the production year range of a specific car.
Respond with ONLY JSON, no prose, matching exactly this shape:
{"yearStart": number|null, "yearEnd": number|null, "confidence": "high"|"low"}
Rules:
- Only set confidence "high" if you have genuine, specific knowledge of THIS car's production years -- if you don't recognize it, or are unsure, return {"yearStart": null, "yearEnd": null, "confidence": "low"}.
- Never invent a plausible-sounding year just to avoid returning null -- a wrong year is worse than an honest null.`;
  const PERSON_FACTS_SYSTEM_PROMPT = `You extract a person's birth year, death year, and nationality/home country from Wikipedia infobox/intro-paragraph excerpts.
Respond with ONLY JSON, no prose, matching exactly this shape:
{"born": number|null, "died": number|null, "country": string|null}
Rules:
- born/died are years only, not full dates. died is null if the person is, as far as the supplied text indicates, still alive, or the text simply doesn't mention their death.
- country is the person's nationality/home country as a plain name (e.g. "Italy", "United States"), or null if not stated.
- Only use facts actually present in the supplied text about THIS specific person -- a common name can pull up an unrelated Wikipedia article; if the text doesn't clearly seem to be about the same person (a car designer/engineer), return all null rather than guessing.`;
  const PERSON_KNOWLEDGE_SYSTEM_PROMPT = `Recall, from your own general knowledge (no source text is supplied here), basic biographical facts about a specific car designer or engineer.
Respond with ONLY JSON, no prose, matching exactly this shape:
{"born": number|null, "died": number|null, "country": string|null, "confidence": "high"|"low"}
Rules:
- Only set confidence "high" if you have genuine, specific knowledge of THIS person -- if you don't recognize them, or are unsure, return nulls and "confidence": "low".
- Never invent a plausible-sounding fact just to avoid returning null.`;

  // Compact text blob from fetchArticleDigest()'s output -- infobox first
  // (where a clean "production ="/"years =" field usually lives), then a
  // handful of cue paragraphs, capped well under the context window since
  // this is a small, single-purpose extraction, not the full multi-
  // generation prompt SYSTEM_PROMPT builds.
  function factsSourceText(digest) {
    const bits = [];
    if (digest.infobox) bits.push("Infobox:\n" + digest.infobox.slice(0, 4000));
    if (Array.isArray(digest.cues) && digest.cues.length) bits.push("Excerpts:\n" + digest.cues.slice(0, 6).join("\n\n"));
    return bits.join("\n\n").slice(0, 8000);
  }
  async function fetchYearFactsGrounded(title) {
    let digest;
    try { ({ digest } = await fetchArticleDigest(title)); }
    catch (e) { return null; } // no article by this title, or the fetch itself failed -- not an error, just nothing to ground on
    const text = factsSourceText(digest);
    if (!text.trim()) return null;
    let raw;
    try {
      raw = await askLlamaCpp([
        { role: "system", content: YEAR_FACTS_SYSTEM_PROMPT },
        { role: "user", content: `Car: "${title}"\n\n${text}` },
      ], `${title} · years`);
    } catch (e) { return null; }
    const yearStart = Number.isFinite(raw && raw.yearStart) ? raw.yearStart : null;
    const yearEnd = Number.isFinite(raw && raw.yearEnd) ? raw.yearEnd : null;
    if (yearStart == null && yearEnd == null) return null;
    return { year: yearStart, end: yearEnd, source: "wikipedia" };
  }
  async function fetchYearFactsFromKnowledge(makeLabel, modelLabel) {
    let raw;
    try {
      raw = await askLlamaCpp([
        { role: "system", content: YEAR_KNOWLEDGE_SYSTEM_PROMPT },
        { role: "user", content: `Car: "${makeLabel} ${modelLabel}"` },
      ], `${makeLabel} ${modelLabel} · years (recall)`);
    } catch (e) { return null; }
    if (!raw || raw.confidence !== "high") return null;
    const yearStart = Number.isFinite(raw.yearStart) ? raw.yearStart : null;
    const yearEnd = Number.isFinite(raw.yearEnd) ? raw.yearEnd : null;
    if (yearStart == null && yearEnd == null) return null;
    return { year: yearStart, end: yearEnd, source: "llm-recall" };
  }
  // Tries "Make Model" first (the common case), then the bare model label
  // alone (some related nameplates -- badge-engineered variants especially,
  // the Puch G being exactly this case -- have their OWN short Wikipedia
  // title with no make prefix, or their title redirects straight to the
  // parent nameplate's article, which still carries a usable overall
  // production range).
  async function bigYearAttempt(makeLabel, modelLabel) {
    return (await fetchYearFactsGrounded(`${makeLabel} ${modelLabel}`.trim()))
      || (await fetchYearFactsGrounded(modelLabel))
      || (await fetchYearFactsFromKnowledge(makeLabel, modelLabel));
  }
  async function fetchPersonFactsGrounded(name) {
    let digest;
    try { ({ digest } = await fetchArticleDigest(name)); }
    catch (e) { return null; }
    const text = factsSourceText(digest);
    if (!text.trim()) return null;
    let raw;
    try {
      raw = await askLlamaCpp([
        { role: "system", content: PERSON_FACTS_SYSTEM_PROMPT },
        { role: "user", content: `Person: "${name}"\n\n${text}` },
      ], `${name} · bio`);
    } catch (e) { return null; }
    const born = Number.isFinite(raw && raw.born) ? raw.born : null;
    const died = Number.isFinite(raw && raw.died) ? raw.died : null;
    const country = raw && typeof raw.country === "string" && raw.country.trim() ? raw.country.trim() : null;
    if (born == null && died == null && country == null) return null;
    return { born, died, country, source: "wikipedia" };
  }
  async function fetchPersonFactsFromKnowledge(name) {
    let raw;
    try {
      raw = await askLlamaCpp([
        { role: "system", content: PERSON_KNOWLEDGE_SYSTEM_PROMPT },
        { role: "user", content: `Person: "${name}" (a car designer or engineer)` },
      ], `${name} · bio (recall)`);
    } catch (e) { return null; }
    if (!raw || raw.confidence !== "high") return null;
    const born = Number.isFinite(raw.born) ? raw.born : null;
    const died = Number.isFinite(raw.died) ? raw.died : null;
    const country = typeof raw.country === "string" && raw.country.trim() ? raw.country.trim() : null;
    if (born == null && died == null && country == null) return null;
    return { born, died, country, source: "llm-recall" };
  }
  async function bigPersonAttempt(name) {
    return (await fetchPersonFactsGrounded(name)) || (await fetchPersonFactsFromKnowledge(name));
  }

  // One in-flight/one-per-session guard per id, same reasoning as `inFlight`
  // above -- a node can be re-minted-and-found-already-cached many times in
  // one apply pass (every confirmed relation touching it re-runs
  // mintRelatedNode/resolvePersonNode) without ever double-scheduling this.
  const factsScheduled = new Set();
  // kind: "model" | "person". target: the live node object already pushed
  // into `nodes` -- updated in place if it's still unresolved by the time
  // the background lookup finishes (it may have been superseded, retired,
  // or the user may have already navigated elsewhere; either way, updating
  // the object in memory is harmless and the persisted cache below is what
  // actually matters for next boot).
  // "Useful" means it actually filled something in. An all-null record is a
  // failed lookup, not an answer, and must not be mistaken for one.
  function factsRecordIsUseful(r) {
    if (!r) return false;
    return r.year != null || r.end != null || r.born != null || r.died != null || r.country != null;
  }
  function scheduleFactBackfill(kind, id, target, attempt) {
    if (!serverAvailable) return; // no llama.cpp/serve.py reachable -- nothing this can do
    if (!backgroundAllowed) return; // and never unprompted -- see setBackgroundAllowed
    if (factsScheduled.has(id)) return;
    // Real bug report: "the year dates were still listed as null. It seems to
    // be the case for many new cars added to the knowledge graph."
    //
    // A lookup that came back empty was recorded exactly like a successful
    // one, and any record at all blocked every future attempt. So one failure
    // -- a slow model, a car whose article was fetched before its Wikipedia
    // link was set, a transient error -- made the gap permanent. In this
    // install that is 70 of 136 cars sitting on null years with nothing that
    // would ever try again.
    //
    // An empty result now allows another go on a later visit, up to a small
    // cap so a car whose years genuinely aren't recoverable doesn't get asked
    // about forever. A record that actually found something still blocks, as
    // before -- there is nothing to retry.
    const prior = store.mintedFacts[id];
    if (prior && factsRecordIsUseful(prior)) return;
    if (prior && (prior.tries || 1) >= 3) return;
    factsScheduled.add(id);
    attempt().then(facts => {
      const record = Object.assign({ checkedAt: new Date().toISOString() },
        facts || (kind === "model" ? { year: null, end: null } : { born: null, died: null, country: null }));
      if (!factsRecordIsUseful(record)) record.tries = ((prior && prior.tries) || 0) + 1;
      store.mintedFacts[id] = record;
      if (facts && target) {
        if (kind === "model") {
          if (target.year == null && facts.year != null) target.year = facts.year;
          if (target.end == null && facts.end != null) target.end = facts.end;
        } else {
          if (target.born == null && facts.born != null) target.born = facts.born;
          if (target.died == null && facts.died != null) target.died = facts.died;
          if (target.country == null && facts.country != null) target.country = facts.country;
        }
        target.factsSource = facts.source;
      }
      return persist();
    }).catch(e => {
      console.warn("LlmFamilies: fact backfill failed for " + id, e);
      // Still cache a "checked, found nothing" record -- see mintedFacts'
      // own comment on why this matters (avoids repeating the same doomed
      // lookup on every future boot for a genuinely undocumented car/person).
      store.mintedFacts[id] = { checkedAt: new Date().toISOString() };
      return persist();
    }).finally(() => {
      factsScheduled.delete(id);
      notifyFactsUpdate();
    });
  }

  // `makeVariant` (optional) is the LLM name-variant verdict for this
  // mention, cached earlier by annotateSharedPlatformMatches -- see
  // verifyMakeVariant's own comment for the real user request ("before
  // creating a new make or model, check if there are any variants of the name
  // already existing but maybe written slightly differently"). When present
  // and confident, it says "the marque named here IS this existing make, just
  // spelled differently", so the model is filed under the real marque instead
  // of a brand-new duplicate one being minted beside it.
  function mintRelatedNode(nodes, links, text, makeVariant, originId) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    // Also checked here, not just in validate(), because an ALREADY-PERSISTED
    // proposal from before that filter existed replays through this path on
    // every boot -- without this, the junk nodes would keep coming back.
    if (looksLikePlatformNotCar(trimmed)) return null;
    let makeNode = findExistingMake(nodes, trimmed);
    let modelLabel;
    if (!makeNode && makeVariant && makeVariant.matchId) {
      const resolved = nodes.find(n => n.id === makeVariant.matchId && n.type === "make" && !n.retired);
      if (resolved) {
        // The verdict also told us how many leading words were the marque,
        // so the rest is the model label -- "VW Passat" under a matched
        // "Volkswagen" make must become the model "Passat", not "VW Passat".
        const rest = trimmed.split(/\s+/).slice(makeVariant.makeGuessWords || 1).join(" ").trim();
        if (rest) {
          makeNode = resolved;
          modelLabel = rest;
        }
      }
    }
    if (makeNode && modelLabel === undefined) {
      modelLabel = trimmed.slice(makeNode.label.length).trim();
      if (!modelLabel) return null; // mention WAS just a bare make name, nothing to mint
    }
    if (!makeNode) {
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) return null; // can't even guess a make/model split from one bare word
      const makeLabel = parts[0];
      modelLabel = parts.slice(1).join(" ");
      makeNode = nodes.find(n => n.type === "make" && norm(n.label) === norm(makeLabel));
      if (!makeNode) {
        const newMakeId = uniqueId(nodes, "llm-make-" + slugify(makeLabel));
        if (store.purged && store.purged[newMakeId]) return null;   // marque purged too -- see purgeDeletion
        makeNode = { id: newMakeId, type: "make", label: makeLabel, year: null, llmGenerated: true };
        nodes.push(makeNode);
      }
    }
    const modelId = "llm-related-" + slugify(makeNode.label) + "-" + slugify(modelLabel);
    // Two different generations (or two different nameplates) can both
    // mention the same not-yet-known related car -- mint it once, reuse the
    // same node for every subsequent mention rather than creating
    // duplicates.
    const already = nodes.find(n => n.id === modelId);
    if (already) return already;
    // Purged for good (see purgeDeletion): the article that mentions this car
    // is still on Wikipedia and still says what it says, so without this the
    // very next check would mint the exact same id straight back and the
    // "completely deleted" half of the request would be cosmetic only.
    if (store.purged && store.purged[modelId]) return null;
    // A prior session's background lookup (see scheduleFactBackfill above)
    // may have already found this car's real production years -- reuse that
    // cached answer immediately instead of defaulting to null and kicking
    // off ANOTHER round-trip on every single boot forever. cached.year/end
    // are already null if the earlier attempt genuinely found nothing.
    const cached = store.mintedFacts[modelId];
    const modelNode = {
      id: modelId, type: "model", label: modelLabel, make: makeNode.label,
      year: cached ? (cached.year != null ? cached.year : null) : null,
      end: cached ? (cached.end != null ? cached.end : null) : null,
      llmGenerated: true, llmCreatedNode: true,
    };
    if (cached && cached.source) modelNode.factsSource = cached.source;
    nodes.push(modelNode);
    links.push({ source: makeNode.id, target: modelNode.id, type: "made" });
    // "A very big attempt at finding the years for any new models... that
    // are added" -- see scheduleFactBackfill's own comment for the two-tier
    // Wikipedia-then-recall strategy. Only actually kicks off a lookup the
    // FIRST time this id is ever minted with no cache entry yet; every
    // later boot (or later mention in this same apply pass) just reuses
    // `cached` above.
    if (!cached) scheduleFactBackfill("model", modelId, modelNode, () => bigYearAttempt(makeNode.label, modelLabel));
    // Real user request: "if the program makes new models/nameplates, then
    // these should also be able to be 'LLM-searchable', and should be
    // requested for an LLM check... if it hasn't been checked already,
    // which it should be." Before this, a related car minted here had no
    // `wp` at all (mintRelatedNode never attempted a lookup of its own --
    // only the article that MENTIONED it was ever fetched) and, with no
    // link, checkNode always dead-ended at "no-wiki-link" the moment
    // someone finally opened its detail panel, with no automatic check
    // ever having been attempted and no way for the graph to correct
    // itself. This runs the exact same title-guess-then-search lookup
    // Add Car already uses (findWikipediaTitleFor), and if it finds a real
    // article, immediately requests the ordinary LLM generation/platform
    // check too -- via checkNodeCascade rather than plain checkNode, since
    // nobody is necessarily looking at THIS node's own detail panel right
    // now (it was just discovered as a side effect of checking some OTHER
    // car) -- checkNodeCascade is the one variant that still keeps a
    // "provisional" verdict in memory for later review instead of
    // silently discarding it the instant engagedId doesn't match, which is
    // exactly this situation. If no article is found either way, this
    // leaves `wp` unset -- app.js's "no-wiki-link" UI (see renderLlmCheck)
    // then gives the user a place to paste a link by hand instead.
    scheduleWpLookupAndCheck(modelNode, nodes, originId);
    return modelNode;
  }
  // One-per-session guard, same shape/reasoning as factsScheduled above --
  // a related car can be independently re-minted-and-found-already-cached
  // many times in one apply pass without this ever double-scheduling.
  const wpLookupScheduled = new Set();
  function scheduleWpLookupAndCheck(node, nodes, originId) {
    if (!serverAvailable) return;
    if (!backgroundAllowed) return;   // see setBackgroundAllowed -- never on a bare page load
    if (wpLookupScheduled.has(node.id) || node.wp || store.wpLinks[node.id]) return;
    // Real bug report: one click on the Mercedes G-Class, with the depth limit
    // set to 1, walked off into the Chevrolet Cobalt, Opel Astra, Golf GTI and
    // KSU Gazal-1 -- none of which the G-Class article mentions at all -- and
    // would not stop.
    //
    // schedulePartnerCheck's own budget was working. The hole was here. A car
    // MINTED during a check (a related nameplate the article named that wasn't
    // in the graph yet) went straight into a full check without ever being
    // given a depth. depthOf() then answered 0 for it -- the same as the car
    // the user actually clicked -- so its own partners came out at depth 1,
    // passed the budget, minted more cars at depth 0 again, and the walk
    // renewed its own allowance at every hop. Unbounded, from a limit of 1.
    //
    // A minted car is one hop from THE CAR WHOSE CHECK FOUND IT -- not from
    // whatever the user last clicked. That distinction is the whole fix: an
    // earlier version measured from the clicked car, so a car discovered while
    // checking a partner still came out at depth 1 and was checked, which is
    // one hop further than asked for.
    //
    // What depth 1 means, concretely: check the clicked car, expand it into
    // generations, then do the same for every car directly related to it and
    // match their generations up. Nothing beyond that. A car found while
    // checking one of those partners is two hops out and is left alone --
    // still one click away from being followed properly, if wanted.
    // A car that already has a depth (schedulePartnerCheck assigns one before
    // routing here for a partner with no article link yet) keeps it -- only a
    // genuinely new car needs one derived.
    const mintedDepth = cascadeDepth.has(node.id)
      ? cascadeDepth.get(node.id)
      : depthOf(originId || engagedId) + 1;
    if (mintedDepth > cascadeMaxDepth) return;
    cascadeDepth.set(node.id, mintedDepth);
    wpLookupScheduled.add(node.id);
    findWikipediaTitleFor(node.make, node.label).then(title => {
      if (!title) return; // nothing found automatically -- leave it for a manual paste later
      // A manual paste (setNodeWikiLink, see below) or an independent mint
      // of the same node elsewhere may have already resolved this by the
      // time the network round trip finishes -- never clobber either.
      if (node.wp || store.wpLinks[node.id]) return;
      node.wp = title;
      store.wpLinks[node.id] = title;
      return persist().then(() => checkNodeCascade(node, nodes));
    }).catch(e => {
      console.warn("LlmFamilies: background Wikipedia lookup failed for " + node.id, e);
    }).finally(() => {
      wpLookupScheduled.delete(node.id);
      notifyFactsUpdate(); // reuse the same "something about this node changed in the background" signal app.js already listens for
    });
  }
  // ---------- cascade: a car we just MATCHED against also deserves its own generation check ----------
  // Real bug report: "I was checking the Lexus ES with the LLM, and saw that
  // it was checking if the Toyota Crown is also a nameplate (since the Crown
  // and the ES are related). Later, I also checked the Toyota Avalon with
  // the LLM, and it also mentioned that it was checking if the Toyota Crown
  // is also a nameplate (which it should have already determined was true
  // from an earlier match). This makes me think that the Toyota Crown never
  // actually had its generations created and laid out (or saved in memory)."
  //
  // Exactly right, and the cause was structural: mintRelatedNode already
  // kicks off a wp-lookup-then-check for a BRAND NEW car it invents, but a
  // mention that resolved onto a car ALREADY in the graph (the Crown, which
  // has existed as a plain ungrouped model all along) got wired up as a
  // relation and then dropped -- nothing ever asked whether that partner was
  // itself hiding generations. app.js's relation-panel cascade
  // (needsCascadeCheck/checkNodeCascade) does ask, but only for the one
  // relation whose review box happens to be on screen, and only while the
  // user is sitting on that panel; a match resolved in the background never
  // reached it. So the Crown got re-interrogated from scratch by every new
  // nameplate that happened to name it, forever, and never gained
  // generations of its own from any of them.
  //
  // This schedules that check once, at the moment of the match, from
  // whichever car found it -- persisting the result the same way any other
  // cascade check does, so the SECOND nameplate to mention the Crown finds
  // an existing entry and skips straight past it.
  //
  // Two deliberate guards. It runs one at a time through a small serial
  // queue rather than firing every match at once: a nameplate can name five
  // or six platform siblings, and llama-server's parallel slots are better
  // spent on the check the user is actually waiting on. And it only runs
  // while a detail panel is actually open (`engagedId`) -- resolvePlatformMention
  // is also called from applyConfirmed's boot-time replay for EVERY
  // previously-confirmed family, and turning a page load into dozens of
  // background LLM calls would be its own, much worse bug.
  // ---------- "this partner turned out to be a nameplate -- go apply it" ----------
  // A cascade check can only ever RECORD that a partner hides generations;
  // actually minting them means splicing into app.js's own byId/adj/label
  // indexes, which this file has no access to. The relation panel's own
  // cascade branch is one caller that does that splicing -- but it only ever
  // sees a pair that reaches the panel, and a partner matched exactly by name
  // never does: resolveOnePlatformMention hard-confirms that connection at
  // nameplate level immediately, and unresolvedFamilyRelations deliberately
  // skips anything already confirmed. So the MDX's generations were found,
  // stored, and then sat there with nothing left to apply them. Same listener
  // shape as onFactsUpdate; app.js subscribes once at boot.
  const splitListeners = [];
  function notifySplitReady(node) {
    splitListeners.forEach(f => { try { f(node); } catch (e) { /* one bad listener shouldn't break the others */ } });
  }
  const partnerCheckScheduled = new Set();
  let partnerQueue = Promise.resolve();
  function schedulePartnerCheck(node, nodes, originId) {
    if (!serverAvailable || !node) return;
    if (!backgroundAllowed) return;               // the user hasn't asked for any LLM work
    if (!engagedId) return;                       // boot-time replay -- see the comment above
    if (node.type !== "model" || node.familyOf || node.retired) return;
    if (entryFor(node.id)) return;                // already checked at some point -- never re-run automatically
    if (partnerCheckScheduled.has(node.id) || inFlight.has(node.id)) return;
    // The depth budget (see cascadeMaxDepth's own comment). Without this,
    // applying a partner's split re-enters this same function for ITS
    // partners, and one click walks the graph indefinitely.
    const depth = depthOf(originId) + 1;
    if (depth > cascadeMaxDepth) return;
    cascadeDepth.set(node.id, depth);
    partnerCheckScheduled.add(node.id);
    partnerQueue = partnerQueue
      .then(() => {
        if (entryFor(node.id)) return null;       // decided while this was queued behind something else
        if (!node.wp) { scheduleWpLookupAndCheck(node, nodes); return null; }
        return checkNodeCascade(node, nodes);
      })
      .then(entry => {
        // A partner that turns out to hide generations becomes a real
        // nameplate for the FIRST time here -- which is exactly the case the
        // standing rule covers ("if a car is creating a nameplate for the
        // first time... you do not need my approval. Simply do so without my
        // request"), and exactly what the relation panel's own cascade branch
        // already does when it gets the chance. Confirm it and hand it to
        // whoever can actually splice it into the live graph.
        if (!entry || entry.status !== "provisional") return;
        confirmNode(node.id);
        notifySplitReady(node);
      })
      .catch(e => { console.warn("LlmFamilies: partner generation check failed for " + node.id, e); })
      .then(() => { partnerCheckScheduled.delete(node.id); notifyFactsUpdate(); });
  }

  // ---------- "is there still LLM work outstanding?" ----------
  // Real bug report, the Dacia Duster: its article named the Renault Captur,
  // the match was made and stored, and the Captur was left a plain model --
  // no generations, no entry, nothing. The cascade had not refused it. It was
  // queued, it was running, and the agent shut the browser and llama-server
  // down underneath it.
  //
  // The agent decided a cascade was "finished" by watching the number of
  // stored entries stop changing for a minute. But ONE check writes nothing
  // at all for its entire duration, and a long article on a local model runs
  // for minutes -- which is why the per-car timeout is 600s. A minute of no
  // writes is therefore the normal middle of a single check, not the end of
  // the work, and every partner still queued behind it died with the page.
  //
  // Counting is not a good enough signal, so this reports the truth directly:
  // the checks actually in flight, the partners queued behind them, and the
  // article lookups a minted car is waiting on. Nothing is "quiet" while any
  // of these is non-zero. Ids rather than a bare count so the terminal can
  // name what it is waiting for.
  function pendingWork() {
    const checks = [...inFlight.keys()];
    const partners = [...partnerCheckScheduled].filter(id => !inFlight.has(id));
    const lookups = [...wpLookupScheduled];
    return { checks, partners, lookups, total: checks.length + partners.length + lookups.length };
  }

  // ---------- public: replay every manually-pasted Wikipedia link ----------
  // Companion to applyUserCars' own replay pattern (see its comment) --
  // wpLinks only ever records the resolved title string, never a whole
  // node, since the node itself (whether build-time, LLM-minted, or
  // hand-added) already exists and is rebuilt from its own source on every
  // boot; this just needs to re-stamp `wp` back onto it before anything
  // else runs. Must run before checkNode/checkFamily could plausibly fire
  // for any of these nodes -- called from app.js's boot sequence
  // immediately after applyUserCars, for the same reason.
  function applyWpLinks(nodes) {
    if (!store.wpLinks || !Object.keys(store.wpLinks).length) return;
    const byId = new Map(nodes.map(n => [n.id, n]));
    Object.keys(store.wpLinks).forEach(id => {
      const n = byId.get(id);
      if (n && !n.wp) n.wp = store.wpLinks[id];
    });
  }
  // ---------- public: manually attach a Wikipedia link to an existing node ----------
  // Real user request: "the info box should have a location for the user
  // to be able to put in the wikipedia link with the car associated" --
  // the generalized, any-node version of Add Car's own "paste a link"
  // fallback (see app.js's initAddCarPanel), for a car that's already IN
  // the graph but has no `wp` and neither findWikipediaTitleFor (above) nor
  // build-time DBpedia harvesting ever found one. `title` must already be
  // resolved/verified by the caller (app.js runs it through
  // titleFromWikipediaUrl + tryWikipediaTitle first, same discipline Add
  // Car's own handleUseUrl already follows) -- this function just records
  // and applies it, it doesn't validate.
  // `opts.force` (real user request: "the user should have the option to
  // change the wikipedia link in case it's inaccurate. Then, if the user
  // presses 'recheck with llm' then it should recheck it with the new
  // wikipedia link provided") additionally forgets whatever verdict this
  // node already has, so the very next check genuinely re-reads the NEW
  // article instead of short-circuiting on the stale answer derived from the
  // old one. Off by default, since the original callers (a first-time paste
  // onto a node that had no link at all) have nothing to invalidate.
  function setNodeWikiLink(nodeId, title, nodes, opts) {
    if (!title) return;
    store.wpLinks[nodeId] = title;
    const n = (nodes || []).find(x => x.id === nodeId);
    if (n) n.wp = title;
    if (opts && opts.force) return clearNodeEntry(nodeId);
    // checkNode/checkFamily both short-circuit on ANY existing entry,
    // including a stale "no-wiki-link" dead-end recorded back when this
    // node genuinely had nothing to check against -- that's no longer true
    // the moment a real link is on file, so clear it here rather than
    // leaving the freshly-linked node stuck reporting the same dead end
    // forever. A real, non-"no-wiki-link" verdict (this node was checked
    // successfully once already, unrelated to this link) is left alone.
    if (store.families[nodeId] && store.families[nodeId].status === "no-wiki-link") delete store.families[nodeId];
    if (store.recheck[nodeId] && store.recheck[nodeId].status === "no-wiki-link") delete store.recheck[nodeId];
    return persist();
  }

  // ---------- public: replay every manually-added "Add Car" base node ----------
  // Real bug report: "the added new car doesn't seem to appear on the
  // knowledge graph, neither when I click on the manufacturer nor when I
  // search up the car that I entered." app.js's mintAndOpen (Add Car panel)
  // used to only ever splice its make/model node into the CURRENT tab's live
  // nodes/links/byId/adj -- it worked immediately, which is exactly why this
  // was easy to miss, but nodes/links get rebuilt from scratch off
  // cars.json/data.js on every single page boot, and nothing about a
  // manually-typed make/model was ever recorded anywhere that rebuild could
  // see. So it was gone the moment the tab was reloaded, or opened fresh
  // elsewhere -- looking exactly like it never got added at all. Mirrors how
  // mintRelatedNode above already survives a reload: not by storing the
  // finished node object, but by storing just enough (make/model text, the
  // Wikipedia title app.js already resolved) to deterministically recreate
  // the identical node, with the identical id, on every boot -- called first
  // in app.js's boot sequence, before applyConfirmed/applyResolvedRelations,
  // since a confirmed split or resolved relation targeting this car needs
  // its base node to already exist to attach to.
  function applyUserCars(nodes, links) {
    const entries = Object.entries(store.userCars);
    if (!entries.length) return;
    const existingIds = new Set(nodes.map(n => n.id));
    entries.forEach(([id, rec]) => {
      if (existingIds.has(id)) return; // already present (shouldn't normally happen, but never duplicate)
      if (store.purged && store.purged[id]) return;   // purged for good -- see purgeDeletion
      let makeNode = nodes.find(n => n.type === "make" && norm(n.label) === norm(rec.makeLabel));
      if (!makeNode) {
        makeNode = { id: "usercar-make-" + slugify(rec.makeLabel), type: "make", label: rec.makeLabel, year: null, userAdded: true };
        nodes.push(makeNode);
        existingIds.add(makeNode.id);
      }
      const modelNode = {
        id, type: "model", label: rec.modelLabel, make: makeNode.label,
        year: null, end: null, wp: rec.wpTitle || null, userAdded: true,
      };
      nodes.push(modelNode);
      existingIds.add(id);
      links.push({ source: makeNode.id, target: id, type: "made" });
    });
  }
  // Called from app.js's mintAndOpen the moment a car is actually added (not
  // just checked) -- persists exactly what applyUserCars above needs to
  // recreate this same node on every future boot.
  function registerUserCar(id, makeLabel, modelLabel, wpTitle) {
    store.userCars[id] = { makeLabel, modelLabel, wpTitle: wpTitle || null, addedAt: new Date().toISOString() };
    persist();
  }

  // ---------- LLM sanity check: does a shared-platform mention actually refer to an EXISTING node? ----------
  // Real user request: findMatchingNameplate's exact/loose matching is
  // plain string comparison (normalize, then equality or substring overlap)
  // -- reliable for the common case, but genuinely blind to two different
  // TEXTS that both refer to the SAME real car: different chassis/
  // generation code notation, a translated or regional model name, an
  // abbreviation Wikipedia uses that the graph's own curated label doesn't.
  // A miss there either silently drops a real relationship (ambiguous, more
  // than one loose candidate) or, worse, mints a brand-new duplicate node
  // for a car that already exists (the exact Toyota Auris/Corolla E140/E150
  // bug this whole area of code was reworked for). Rather than trust a
  // regex-shaped guess -- or the ABSENCE of one -- as the final word, this
  // asks the local LLM to double-check: given the mention text and every
  // node in the graph that's remotely plausible (same make, or already a
  // loose substring hit), is this actually one of them? It's a genuine
  // extra reasoning step, not a wider regex: the model is shown real
  // candidate names/years and has to make a judgment call the same way a
  // person skimming the list would.
  //
  // Deliberately never used to auto-apply anything on its own: like every
  // other LLM judgment call in this file (see resolveOnePlatformMention's
  // own comment on loose matches), its verdict only ever produces a
  // "provisional" entry a human still has to confirm -- this is an extra
  // layer of CONFIDENCE in what gets proposed, not a shortcut past review.
  const DUPLICATE_CHECK_SYSTEM_PROMPT = `You check whether a mentioned car already exists in a short list of candidate cars from a database, accounting for the fact that a Wikipedia article's wording and a database's stored label can differ (different chassis/generation code notation, abbreviations, translated or regional names, minor punctuation or formatting differences) while still referring to the exact same real car.
Respond with ONLY JSON, no prose, matching exactly this shape:
{"matchId": string|null, "confidence": "high"|"low", "reason": string}
Rules:
- matchId must be exactly one of the candidate ids given to you, or null if none of them is truly the same car as the mention.
- Only return a candidate's id if you are confident it is the SAME physical car/generation as the mention -- not merely a related, similar, or platform-sharing DIFFERENT model. Two different nameplates that happen to share a platform are NOT a match for this purpose.
- If you are unsure, prefer null over a low-confidence guess -- a missed match just gets reviewed normally; a wrong match creates a false connection.
- The same real car cannot have been in production in two disjoint eras under two names. If the candidate's production years do not overlap the years the mention comes from, it is a DIFFERENT car -- answer null, no matter how similar the names or how plausible the story.
- Do not invent a justification. If you cannot say concretely WHY they are the same car (the licensing deal, the market it was renamed for, the shared chassis code), you do not know that they are -- answer null.
- Sharing a marque is not evidence of anything. Two cars from the same manufacturer with different model names are different cars unless one is a documented rename or export badge of the other.
- Never invent an id that was not in the candidate list.`;
  function buildDuplicateCheckMessages(mentionText, candidates) {
    const list = candidates.map(c => {
      const years = c.year ? ` (${c.year}${c.end ? "–" + c.end : "–present"})` : "";
      return `- id: ${c.id} | ${c.make || ""} ${c.label}${years}`;
    }).join("\n");
    return [
      { role: "system", content: DUPLICATE_CHECK_SYSTEM_PROMPT },
      { role: "user", content: `Mentioned car: "${mentionText}"\n\nCandidates already in the database:\n${list}` },
    ];
  }
  // Bounded to keep the prompt focused and the round-trip fast -- loose
  // substring hits (the highest-signal candidates, since they already share
  // SOME text overlap) always make the cut; same-make nodes fill the rest.
  const DUPLICATE_CHECK_MAX_CANDIDATES = 80;
  function buildDuplicateCandidates(nodes, text, excludeFamId) {
    const eligible = n => (n.type === "model" || n.type === "family") &&
      n.id !== excludeFamId && n.familyOf !== excludeFamId;
    const key = norm(text);
    const looseHits = nodes.filter(n => eligible(n) && norm(n.label).length > 2 &&
      (key.includes(norm(n.label)) || norm(n.label).includes(key)));
    const out = new Map(looseHits.map(n => [n.id, n]));
    const makeNode = findExistingMake(nodes, text);
    if (makeNode) {
      for (const n of nodes) {
        if (out.size >= DUPLICATE_CHECK_MAX_CANDIDATES) break;
        if (eligible(n) && n.make === makeNode.label) out.set(n.id, n);
      }
    }
    return [...out.values()].slice(0, DUPLICATE_CHECK_MAX_CANDIDATES);
  }
  // Real bug report, visible in one run's terminal output: "Chevrolet Astra"
  // was asked about four separate times, "Saturn Astra" three, "Opel Zafira B"
  // three -- the same question, the same answer, ten seconds each. The same
  // related car gets named by several generations of one nameplate, and every
  // mention asked again from scratch.
  //
  // Cached per session, keyed on the mention AND on the candidates offered:
  // if the graph has gained a car since, the question genuinely changed and
  // gets asked again. Never persisted -- this is a within-run saving, not a
  // stored answer.
  const duplicateCheckCache = new Map();
  async function askDuplicateCheck(mentionText, candidates) {
    const cacheKey = norm(mentionText) + "|" + candidates.map(c => c.id).sort().join(",");
    if (duplicateCheckCache.has(cacheKey)) return duplicateCheckCache.get(cacheKey);
    const p = askDuplicateCheckUncached(mentionText, candidates);
    duplicateCheckCache.set(cacheKey, p);
    // A failure shouldn't be cached as the permanent answer for the session.
    p.catch(() => duplicateCheckCache.delete(cacheKey));
    return p;
  }
  async function askDuplicateCheckUncached(mentionText, candidates) {
    const raw = await askLlamaCpp(buildDuplicateCheckMessages(mentionText, candidates),
      `"${mentionText}" · dup?`);
    const matchId = raw && typeof raw.matchId === "string" ? raw.matchId : null;
    // Hallucination guard, same principle as everywhere else in this file:
    // only trust a returned id if it's actually one of the candidates that
    // were offered -- never let a made-up id reach the graph.
    const valid = matchId && candidates.some(c => c.id === matchId);
    return { matchId: valid ? matchId : null, confidence: (raw && raw.confidence) || "low", reason: (raw && raw.reason) || null };
  }
  // Skips the LLM call entirely when there's genuinely nothing plausible to
  // compare against (no same-make node anywhere, no loose text overlap
  // either) -- that's a real "definitely new" case worth minting straight
  // away without spending a round-trip confirming the obvious. Any network/
  // parse failure is swallowed and treated the same as "didn't run" so a
  // flaky llama.cpp call never blocks the ordinary deterministic fallback.
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  // Real bug report (the Acura/Honda Legend case). Asked whether the mention
  // "Daewoo Arcadia" -- named as a platform-mate on the Legend's 1990-1995
  // generation -- was already in the graph, the model answered
  // m-daewoo-magnus with confidence "high" and this reasoning: "Daewoo Arcadia
  // is the export name for the Daewoo Magnus... They are the exact same
  // vehicle (Opel Vectra C platform)." Every word of that is invented. The
  // Arcadia is a licensed second-generation Honda Legend built 1994-1999; the
  // Magnus is Daewoo's own V200, 2000-2006, with no Honda content at all. The
  // only thing the two share is the marque -- which is precisely why the
  // Magnus was in the candidate list in the first place (buildDuplicateCandidates
  // offers every same-make car when the mention names a known marque).
  //
  // The existing hallucination guard only checks that the returned id was one
  // of the ones offered, which this was; it has nothing to say about a
  // confident, fluent, false identity claim.
  //
  // The guard below is deliberately narrow, and the reason is a correction
  // Andy made to a first, broader version of it: "Production doesn't
  // necessarily have to overlap, since it might be that one car has stopped
  // production, but then a new car a few years later uses the same platform as
  // that previously discontinued car." Exactly right, and it separates two
  // different questions this one function gets asked:
  //
  //   1. NAME RESOLUTION -- "the article says 'Rover 800-series'; which node is
  //      that?" The answer is the Rover 800 whatever the eras involved. A 2005
  //      car can perfectly well reuse a platform from a car discontinued in
  //      1999, and the mention still names that car. Years are irrelevant here
  //      and must not be consulted.
  //   2. AN ALIAS CLAIM -- "the article says 'Arcadia'; no node is called that,
  //      but this candidate is the same car under a different name." Nothing in
  //      the text supports that; the model's story is the only thing holding it
  //      up. And a rename, rebadge, export badge or licensed clone is the same
  //      physical car, so it is contemporaneous by definition.
  //
  // So the year test applies to case 2 ONLY -- when the mention and the
  // candidate share no meaningful name token, meaning the match rests entirely
  // on the model's assertion. That still rejects Arcadia -> Magnus (nothing in
  // common but the marque, eras five years apart), still accepts the
  // Auris -> Corolla E140 renames this sanity pass exists for (no shared name,
  // but concurrent), and never touches case 1 at all.
  //
  // Even within case 2 it stays generous: a licensed clone often starts a few
  // years into the donor's run and can outlive it, so this fires only on a
  // clear miss. Skipped entirely when either side's years are unknown, since an
  // absent year is not evidence of anything.
  const IDENTITY_YEAR_SLACK = 3;
  // Words that carry no identifying force on their own, so sharing one is not
  // evidence that two names refer to the same car.
  const GENERIC_NAME_TOKENS = new Set(["the", "car", "series", "sedan", "coupe", "saloon", "estate",
    "wagon", "hatchback", "mk", "gen", "generation", "first", "second", "third", "fourth", "fifth",
    "new", "old", "class", "type", "model"]);
  function nameTokens(text, makeLabel) {
    const makeKey = makeLabel ? norm(makeLabel) : "";
    return new Set(String(text || "")
      .split(/[^A-Za-z0-9]+/)
      .map(w => norm(w))
      .filter(w => w && w.length >= 2 && !GENERIC_NAME_TOKENS.has(w) && w !== makeKey));
  }
  // Does anything in the mention's own wording point at this candidate, or is
  // the model's assertion the only thing connecting them?
  function nameSupportsMatch(mentionText, cand) {
    const a = nameTokens(mentionText, cand.make);
    const b = nameTokens(cand.label, cand.make);
    if (!a.size || !b.size) return true;   // nothing to judge on -- don't second-guess
    for (const w of a) {
      if (b.has(w)) return true;
      // A code written slightly differently on each side ("KA7/8" vs "KA7")
      // still points at the same car -- containment counts, but only for
      // tokens long enough that the overlap means something.
      for (const v of b) {
        if (w.length >= 3 && v.length >= 3 && (w.includes(v) || v.includes(w))) return true;
      }
    }
    return false;
  }
  function yearsPlausiblyTheSameCar(mentionYears, cand) {
    if (!mentionYears || mentionYears.start == null || cand.year == null) return true;
    const aStart = mentionYears.start, aEnd = mentionYears.end != null ? mentionYears.end : aStart + 10;
    const bStart = cand.year, bEnd = cand.end != null ? cand.end : bStart + 10;
    return bStart <= aEnd + IDENTITY_YEAR_SLACK && aStart <= bEnd + IDENTITY_YEAR_SLACK;
  }
  async function verifySharedPlatformMention(nodes, text, excludeFamId, mentionYears) {
    const candidates = buildDuplicateCandidates(nodes, text, excludeFamId);
    if (!candidates.length) return null;
    // Real bug report: llama-server can briefly be overloaded when several
    // checks land on it at once and all its --parallel slots are busy, or
    // (on a first run) still mid-download/mid-load -- see serve.py's own
    // _wait_until_ready comment -- producing a transient 502 ("could not
    // reach llama-server") that has nothing to do with whether this mention
    // is really a duplicate. One retry after a short pause covers exactly
    // that -- a genuinely dead/misconfigured llama-server will just fail
    // again and fall back to the deterministic path below, same as before
    // this retry existed.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const verdict = await askDuplicateCheck(text, candidates);
        if (verdict && verdict.matchId) {
          const cand = candidates.find(c => c.id === verdict.matchId);
          // Only an ALIAS claim is year-tested -- see the comment above for why
          // a match the mention's own wording already supports is left alone
          // however far apart the two eras are.
          if (cand && !nameSupportsMatch(text, cand) && !yearsPlausiblyTheSameCar(mentionYears, cand)) {
            // Kept as a rejection rather than dropped silently, so "see what
            // it said" shows the claim AND why it wasn't believed.
            return {
              matchId: null, confidence: "low",
              reason: `rejected: the local model claimed "${text}" is another name for ` +
                `${cand.make || ""} ${cand.label}`.trim() +
                ` (${cand.year}${cand.end ? "–" + cand.end : "–"}) — but the two names have nothing in common beyond the marque, ` +
                `and that car's production doesn't overlap the ${mentionYears.start}${mentionYears.end ? "–" + mentionYears.end : "–"} ` +
                `generation this mention came from, so they can't be the same vehicle under two names. ` +
                `(A car reusing an older car's platform is a different claim, and isn't affected by this check.) ` +
                `Its stated reasoning was: ${verdict.reason || "(none given)"}`,
              rejectedMatchId: verdict.matchId,
            };
          }
        }
        return verdict;
      } catch (e) {
        if (attempt === 0) await sleep(500);
      }
    }
    return null;
  }
  // Called once per checkNode/checkFamily proposal (see runCheck's own
  // comment for exactly where), right after validate() produces the
  // hallucination-guarded sharedPlatforms list -- this is the "final
  // manager pass" the user asked for: for every shared-platform/rebadge
  // mention on every generation, if the plain deterministic matcher didn't
  // already find a clean EXACT match, ask the LLM to double check it
  // against the real graph before this proposal is ever used to create or
  // link a node. Skips entirely (and costs nothing) when `nodes` wasn't
  // supplied by the caller -- see runCheck's own comment on why that's
  // optional and always backward compatible.
  // ---------- is this "new" MAKE really a variant spelling of an existing one? ----------
  // Real user request: "before creating a new make or model, check if there
  // are any variants of the name already existing but maybe written slightly
  // differently (do this with the LLM)."
  //
  // The model half of that has existed for a while (askDuplicateCheck, above,
  // is exactly this question asked about a car). The MAKE half had nothing at
  // all: mintRelatedNode's `findExistingMake` is plain prefix matching, so a
  // mention naming a marque Wikipedia spells even slightly differently from
  // the graph's own label -- "VW" vs "Volkswagen", "Mercedes Benz" vs
  // "Mercedes-Benz", "Citroen" vs "Citroën", "Alfa" vs "Alfa Romeo", a
  // regional or historical trading name -- silently minted a brand-new,
  // permanently-duplicate make node beside the real one. That's worse than a
  // duplicate model, because every car minted under it inherits the wrong
  // marque.
  //
  // Same shape and same guard rails as the duplicate-car check: the model is
  // shown real candidates and can only return one of their ids, its verdict
  // never auto-applies anything on its own (it only redirects a mint that was
  // going to happen anyway), and a miss just means the mint proceeds exactly
  // as it did before this existed.
  const MAKE_VARIANT_SYSTEM_PROMPT = `You check whether a car manufacturer named in a Wikipedia sentence is the same company as one already in a database, accounting for the fact that the same marque is often written differently (abbreviations like "VW" for "Volkswagen", punctuation and accent differences like "Mercedes Benz" or "Citroen", a parent-company or sub-brand name, a regional or historical trading name, a partial name like "Alfa" for "Alfa Romeo").
Respond with ONLY JSON, no prose, matching exactly this shape:
{"matchId": string|null, "confidence": "high"|"low", "reason": string}
Rules:
- matchId must be exactly one of the candidate ids given to you, or null if the mentioned manufacturer genuinely isn't any of them.
- Only return a candidate if it is the SAME manufacturer, just written differently. Two different manufacturers that are related — a parent company and its separate marque (Volkswagen and Audi, Toyota and Lexus), a joint venture, a coachbuilder and the company it built for — are NOT the same manufacturer and must return null.
- If you are unsure, prefer null over a low-confidence guess: a missed match creates one duplicate marque, a wrong match files cars under the wrong company entirely.
- Never invent an id that was not in the candidate list.`;
  const MAKE_VARIANT_MAX_CANDIDATES = 60;
  // The leading words of a mention are the plausible marque; compare them
  // against every existing make, cheapest-signal-first, and only ask the LLM
  // when plain matching found nothing.
  function buildMakeVariantCandidates(nodes, makeGuess) {
    const key = norm(makeGuess);
    if (!key) return [];
    const scored = [];
    for (const n of nodes) {
      if (n.type !== "make" || n.retired) continue;
      const k = norm(n.label);
      if (!k) continue;
      // Any shared prefix, containment either way, or a shared first token --
      // deliberately generous, since this is only building a shortlist for
      // the model to judge, not deciding anything itself.
      let score = -1;
      if (k === key) score = 0;
      else if (k.startsWith(key) || key.startsWith(k)) score = 1;
      else if (k.includes(key) || key.includes(k)) score = 2;
      else if (k[0] === key[0]) score = 3;
      if (score >= 0) scored.push([score, n]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].label.length - b[1].label.length);
    return scored.slice(0, MAKE_VARIANT_MAX_CANDIDATES).map(x => x[1]);
  }
  async function askMakeVariantCheck(mentionText, makeGuess, candidates) {
    const list = candidates.map(c => `- id: ${c.id} | ${c.label}${c.country ? " (" + c.country + ")" : ""}`).join("\n");
    let raw;
    try {
      raw = await askLlamaCpp([
        { role: "system", content: MAKE_VARIANT_SYSTEM_PROMPT },
        { role: "user", content: `Full mention from the article: "${mentionText}"\nThe manufacturer part appears to be: "${makeGuess}"\n\nManufacturers already in the database:\n${list}` },
      ], `"${makeGuess}" · make?`);
    } catch (e) { return null; }
    const matchId = raw && typeof raw.matchId === "string" ? raw.matchId : null;
    const valid = matchId && candidates.some(c => c.id === matchId);
    return { matchId: valid ? matchId : null, confidence: (raw && raw.confidence) || "low", reason: (raw && raw.reason) || null };
  }
  // Only asked when a mint is genuinely about to happen with a make this
  // graph doesn't already know: no existing make matched by prefix, and the
  // mention has enough words to name one.
  async function verifyMakeVariant(nodes, mentionText) {
    const trimmed = String(mentionText || "").trim();
    if (!trimmed) return null;
    if (findExistingMake(nodes, trimmed)) return null;   // plain matching already found it -- nothing to ask
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return null;                    // one bare word: nothing to split into make + model
    // Try the first one and two words as the marque -- "Alfa Romeo Giulia"
    // needs two, "Toyota Crown" needs one.
    for (const n of [2, 1]) {
      if (parts.length <= n) continue;
      const guess = parts.slice(0, n).join(" ");
      const cands = buildMakeVariantCandidates(nodes, guess);
      if (!cands.length) continue;
      const verdict = await askMakeVariantCheck(trimmed, guess, cands);
      if (verdict && verdict.matchId && verdict.confidence === "high") {
        return { matchId: verdict.matchId, makeGuessWords: n, reason: verdict.reason };
      }
    }
    return null;
  }
  async function annotateSharedPlatformMatches(nodes, famId, clean) {
    for (const g of clean.generations) {
      const texts = Array.isArray(g.sharedPlatforms) ? g.sharedPlatforms : [];
      if (!texts.length) continue;
      const matches = {}, makeMatches = {};
      for (const text of texts) {
        const det = findMatchingNameplate(nodes, text, famId);
        if (det && !det.loose) continue; // exact deterministic match is already trustworthy -- nothing to double-check
        const verified = await verifySharedPlatformMention(nodes, text, famId,
          { start: g.yearStart, end: g.yearEnd });
        if (verified) matches[text] = verified;
        // Only worth asking about the marque when this mention is actually
        // heading for a mint -- i.e. neither the deterministic matcher nor
        // the duplicate sanity check found an existing car for it.
        if (!det && !(verified && verified.matchId)) {
          const makeVerdict = await verifyMakeVariant(nodes, text);
          if (makeVerdict) makeMatches[text] = makeVerdict;
        }
      }
      if (Object.keys(matches).length) g.sharedPlatformMatches = matches;
      if (Object.keys(makeMatches).length) g.makeVariantMatches = makeMatches;
    }
  }

  // Real bug report: checking Mercedes-Benz A-Class against Infiniti QX30
  // failed to identify WHICH A-Class generation the QX30 shares a platform
  // with, even though the Infiniti article's own infobox said so outright:
  // "Related: Infiniti Q30, Mercedes-Benz A-Class (W176), Mercedes-Benz GLA
  // (X156)" -- a parenthetical chassis code sitting right next to the
  // nameplate name in the SAME mention that findMatchingNameplate already
  // uses to find the nameplate itself. That code was being read (it's what
  // proves the match) but then thrown away, leaving the actual generation
  // pick to the much weaker year-overlap guess below. This recovers it: once
  // `match` (the nameplate) is known, look for a "(CODE)" immediately after
  // its own mention in the text -- bounded to a short window and stopped at
  // the next comma/semicolon -- so a code belonging to a DIFFERENT nameplate
  // later in the same list (like GLA's "(X156)" in the example above) is
  // never misattributed to this one.
  // Real bug report: checking Mercedes-Benz CLA against the B-Class kept
  // reporting nothing, even though the CLA's own article says outright
  // "...based on the platform of the W176 A-Class and Mercedes-Benz
  // B-Class#Second generation (W246; 2011) compact cars" -- the code IS
  // right there. Two compounding bugs in the window-truncation logic below:
  // 1. The old stop-at-next-comma-or-semicolon scan didn't know about
  //    parens -- "(W246; 2011)" has its OWN semicolon inside it (separating
  //    the code from a production-start year), so the scan stopped there,
  //    slicing the window off before it ever reached the closing ")" at
  //    all, and the code regex below (which requires a closing paren) never
  //    even got a chance to match.
  // 2. Even with the window intact, the old code regex required the ENTIRE
  //    parenthetical to be nothing but code characters -- "W246; 2011"
  //    itself doesn't match a bare-code character class, since it has a
  //    semicolon and more text in it.
  // findUnnestedStop only stops at a comma/semicolon that's OUTSIDE any
  // open paren, so "(W246; 2011)" survives intact into the window; the code
  // regex now also accepts (and discards) a trailing ";..."/",..." clause
  // inside the same parens, so "(W246; 2011)" still yields just "W246".
  function findUnnestedStop(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if ((c === "," || c === ";") && depth === 0) return i;
    }
    return -1;
  }
  function extractExplicitGenCode(text, match) {
    if (!text || !match || !match.label) return null;
    const lowText = text.toLowerCase();
    const bareLabel = String(match.label).toLowerCase();
    const fullLabel = match.make ? `${match.make} ${match.label}`.toLowerCase() : null;
    let idx = fullLabel ? lowText.indexOf(fullLabel) : -1;
    let matchedLen = fullLabel ? fullLabel.length : 0;
    if (idx === -1) { idx = lowText.indexOf(bareLabel); matchedLen = bareLabel.length; }
    if (idx === -1) return null;
    const after = text.slice(idx + matchedLen, idx + matchedLen + 60);
    const stopAt = findUnnestedStop(after);
    const window = stopAt === -1 ? after : after.slice(0, stopAt);
    const m = window.match(/\(([A-Za-z0-9][A-Za-z0-9\-\/. ]{0,15}?)(?:[;,][^)]*)?\)/);
    return m ? m[1].trim() : null;
  }

  // Is a LOOSE match actually the explicit-code case wearing a loose label?
  //
  // findMatchingNameplate calls a match loose whenever the mention text isn't
  // character-for-character a node's name -- which is also true of the single
  // most informative shape a mention can take: the nameplate named in full
  // with one of its own generation codes in parentheses right after it,
  // "TestFordMg Qelvorash (ZG2xq)". That mention can never equal the bare
  // label "ZG2xq", so the substring fallback is what finds it, and it comes
  // back flagged loose even though the article stated the generation outright.
  //
  // This tells those apart from a real coincidence of letters (the Jeep
  // Commander that matched a Toyota C-HR): the matched node has to be a
  // generation of some family, the mention has to name THAT family, and the
  // code sitting in parentheses after the name has to resolve back to this
  // very generation. Three independent things lining up at once, not one
  // short string turning up inside a longer one.
  function looseMentionNamesThisGeneration(nodes, text, node) {
    if (!node || !node.familyOf) return false;
    const parent = nodes.find(n => n.id === node.familyOf);
    if (!parent) return false;
    const code = extractExplicitGenCode(text, parent);
    if (!code) return false;
    const hit = findGenByCode([{ id: node.id, code: node.label }], code);
    return !!(hit && hit.id === node.id);
  }

  // Given a newly-minted generation `gn` whose source text mentioned sharing
  // a platform with / being a rebadge of another nameplate, find that
  // nameplate in the graph and wire in the most specific connection the
  // available information supports:
  //   - matched node is itself a real nameplate (2+ generations): try a
  //     deterministic, unambiguous match by production-year overlap first
  //     (cheap, no extra LLM call -- mirrors reconcileDbGenerations' own
  //     year-hint approach below). Genuinely ambiguous overlap (zero or
  //     several candidates) is left as a plain nameplate<->nameplate fact,
  //     same trust level a build-time harvested platform link already gets,
  //     for the existing generation-disambiguation flow (checkRelation, see
  //     app.js's unresolvedFamilyRelations) to resolve properly once a
  //     detail panel is opened on either side.
  //   - matched node is a plain model, or already a specific generation of
  //     some OTHER family -- already as specific as it can get on that side,
  //     so it's wired in immediately: "connect the generation from one to
  //     the model from the other."
  //   - no match anywhere in the graph -- nothing to link to; skip silently
  //     rather than inventing a node for a car this dataset doesn't have.
  // Either way, the resolution is recorded into store.relations.
  // Two different bugs, two different fixes here:
  //
  // 1. Picking WHICH generation on the matched side by production-year
  //    overlap alone (the cands.length === 1 branch below) is never
  //    trustworthy enough to skip review on its own -- real bug report: a
  //    Jeep Commander (XK) generation ended up "confirmed" as platform-
  //    related to a specific Jeep Grand Cherokee generation on nothing more
  //    than "their years happen to overlap." That branch always writes
  //    status "provisional" now, surfacing as an ordinary Yes/No proposal
  //    (app.js's unresolvedFamilyRelations) instead of applying itself
  //    with no human ever reviewing it. See buildRelationMessages' own
  //    comment for the matching fix on the interactive disambiguation path.
  //
  // 2. Identifying WHICH NAMEPLATE was mentioned at all (findMatchingNameplate
  //    above) is a hallucination-guarded text match, but its loose substring
  //    fallback can coincidentally fire on a completely unrelated node --
  //    the other half of that same Jeep Commander (XK) bug report describes
  //    exactly this: a totally unrelated Toyota C-HR got matched this way.
  //    An EXACT match (make+label or bare label matches the mentioned text
  //    exactly) is trustworthy enough to apply immediately, same as before
  //    -- this is what makes "if it appears in at least one article, it
  //    should make the connection for both" (the Infiniti QX30 / Mercedes
  //    A-Class case) keep working with zero clicks. A LOOSE match never
  //    auto-applies -- it always goes to "provisional" for review instead,
  //    regardless of which branch below it falls into.
  //
  // Guarded against store.rejectedRelations throughout, so a proposal the
  // user has already deleted via the LLM Debug panel stays gone instead of
  // reappearing next boot.
  // Real user request: "make sure that the LLM is formatted so that it can
  // capture every related car that is listed" -- a generation is very often
  // related to SEVERAL other nameplates at once (see validate()'s own
  // comment on sharedPlatforms), so this now resolves EVERY mention on `gn`
  // independently, not just one. gn.sharedPlatformTexts is the array form;
  // gn.sharedPlatformText (singular) is still honored as a one-item
  // fallback for any caller that hasn't been updated to the array shape.
  function resolvePlatformMention(nodes, links, famId, gn) {
    const texts = Array.isArray(gn.sharedPlatformTexts) ? gn.sharedPlatformTexts
      : (gn.sharedPlatformText ? [gn.sharedPlatformText] : []);
    texts.forEach(text => resolveOnePlatformMention(nodes, links, famId, gn, text));
  }
  function resolveOnePlatformMention(nodes, links, famId, gn, mentionText) {
    if (!mentionText) return;
    let found = findMatchingNameplate(nodes, mentionText, famId);
    // Real user request: findMatchingNameplate's exact/loose STRING matching
    // (norm() substring overlap) still misses genuine duplicates whenever
    // Wikipedia's wording differs enough from the graph's own label --
    // different chassis-code notation, a translated/regional name, "Mk3"
    // vs. a bare generation code, etc. annotateSharedPlatformMatches (run
    // earlier, during the async checkNode/checkFamily proposal validation
    // that produced this `gn`) already asked the local LLM to sanity-check
    // exactly this mention against every plausible existing candidate (same
    // make, or already a loose substring hit) and cached its verdict right
    // here on gn.sharedPlatformMatches. When that ran, its verdict is the
    // final word -- overriding the plain deterministic guess entirely, the
    // same way a human manager's final read-through would override a
    // first-pass regex match. Never upgrades trust beyond "provisional"
    // though (see below): an LLM judgment call, however confident, still
    // isn't the same tier of evidence as a literal exact-string match or an
    // explicit chassis code found in the source text, so it still always
    // goes through ordinary Yes/No review, same as any other loose match.
    const sanity = gn.sharedPlatformMatches && gn.sharedPlatformMatches[mentionText];
    if (sanity && sanity.matchId) {
      // The LLM found a specific existing node -- trust it over the plain
      // deterministic guess (which may have found nothing, or found the
      // wrong/coarser thing), since this is exactly the case a formatting
      // mismatch would otherwise fall through on.
      const node = nodes.find(n => n.id === sanity.matchId);
      if (node) found = { node, loose: true, llmVerified: true, verifyReason: sanity.reason, verifyConfidence: sanity.confidence };
      // else: matched id no longer resolves to a real node -- stay safe,
      // keep whatever the deterministic matcher already found (or null).
    }
    // Deliberately NOT doing the symmetric thing when sanity.matchId is
    // null: that only means "the LLM didn't independently find anything
    // EXTRA" -- it must never erase a deterministic match findMatchingNameplate
    // already made on its own (a loose substring hit is still real
    // evidence). Overriding a legitimate deterministic candidate down to
    // "nothing" on the LLM's say-so would silently convert what should be a
    // reviewable "provisional" match into an auto-confirmed brand-new mint
    // instead -- swapping a human-reviewed guess for an unreviewed one is
    // exactly backwards for a feature whose whole point is MORE confidence,
    // not less. `found` is only ever left as `null` here when the
    // deterministic matcher already found nothing on its own.
    if (!found) {
      // Real user request: a related car named in the article that doesn't
      // match ANY existing node (not even loosely) shouldn't just be
      // dropped -- mint it as a brand-new node so it actually appears in
      // the graph, then wire the very same "confirmed" relation a normal
      // exact-name match would get. Same trust tier: the hallucination
      // guard already required this exact text to appear verbatim in the
      // source wikitext (see validate()), so there's nothing further to
      // verify here -- it's a genuinely new fact, not an ambiguous match.
      // (If an LLM sanity check ran above, "genuinely new" here means it
      // ALREADY checked this against every plausible existing candidate and
      // came back empty -- a stronger guarantee than the old deterministic-
      // only path ever had.)
      // gn.makeVariantMatches carries the LLM's "is this marque already here
      // under a different spelling?" verdict for this exact mention (see
      // verifyMakeVariant) -- without it, "VW Passat" would mint a brand-new
      // "VW" make beside the real "Volkswagen" one, permanently.
      const makeVariant = gn.makeVariantMatches && gn.makeVariantMatches[mentionText];
      const minted = mintRelatedNode(nodes, links, mentionText, makeVariant, famId);
      if (!minted) return;
      // Real user request: two DIFFERENT generations of the same nameplate
      // (e.g. Mazda Familia's 3rd and 4th generations) can each separately
      // mention their own, genuinely different platform partner -- keying
      // this by famId alone (the whole nameplate) meant the SECOND
      // generation's mention silently collided with and was dropped by the
      // first's entry, since both would compute the exact same key. Keying
      // by THIS generation's own id (gn.id) instead of the nameplate's makes
      // every generation's mention independently storable/confirmable, with
      // no cap on how many distinct pairs a single nameplate pair can have.
      const key = relKey(gn.id, minted.id, "platform");
      if (store.relations[key] || store.rejectedRelations[key]) return;
      store.relations[key] = {
        status: "confirmed", checkedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
        famA: famId, famB: minted.id, relType: "platform",
        codeA: gn.label, codeB: minted.label, genIdA: gn.id, genIdB: minted.id,
        reason: `matched automatically -- "${mentionText}" was named as a related car but didn't exist anywhere in the graph yet, so it was newly created from this mention` +
          (sanity && !sanity.matchId ? ` (double-checked by the local LLM sanity pass against every plausible existing car -- none matched)` : ""),
        llmDiscovered: true,
      };
      return;
    }
    const match = found.node, loose = found.loose;
    if (match.id === gn.id) return;
    // The Toyota Crown fix -- see schedulePartnerCheck's own comment. A
    // matched partner that's still a plain, never-checked model gets its own
    // generation/designer/platform discovery scheduled right here, once,
    // instead of being re-interrogated from scratch by every future
    // nameplate that happens to name it. No-op for a partner that's already
    // a family, already checked, or already a generation of something else.
    schedulePartnerCheck(match, nodes, famId);
    if (match.type === "family" && match.generations && match.generations.length >= 2) {
      const byIdLocal = new Map(nodes.map(n => [n.id, n]));
      // Try the strong signal first: an explicit chassis/generation code
      // named right alongside this nameplate's mention in the source text
      // (see extractExplicitGenCode's own comment for the exact bug report
      // this fixes). Matched the same lenient way checkRelation's own
      // findGenByCode already does against a generation's full label. This
      // is evidence Wikipedia stated outright, not a year-overlap guess, so
      // it's trustworthy enough to auto-confirm with no review step -- same
      // tier as an exact nameplate-name match gets below.
      //
      // Deliberately checked regardless of `loose` (unlike the exact-vs-loose
      // gating everywhere else in this function): in practice the LLM almost
      // always copies the code along with the name it's attached to (e.g.
      // "Mercedes-Benz A-Class (W176)"), which makes `key` include that
      // trailing code and therefore fail the STRICT equality the exact-match
      // branch requires -- meaning this exact real-world case would
      // otherwise always be "loose" and never benefit from this shortcut.
      // That's fine: this isn't relying on the substring match alone the way
      // the Toyota C-HR bug did. It requires the label to be followed
      // immediately by a code that ALSO resolves against one of THIS
      // specific family's own real, already-known generations via
      // findGenByCode -- a coincidental hit on both of those at once is
      // vanishingly unlikely, unlike a bare unbounded substring appearing
      // anywhere in a longer sentence.
      const explicitCode = extractExplicitGenCode(mentionText, match);
      const genInfo = match.generations.map(id => byIdLocal.get(id)).filter(Boolean)
        .map(g2 => ({ id: g2.id, code: g2.label }));
      const explicitGen = explicitCode ? findGenByCode(genInfo, explicitCode) : null;
      if (explicitGen) {
        // Real user request: two DIFFERENT generations of the SAME
        // nameplate pair (e.g. Mazda Familia's 3rd gen corresponding to
        // Ford Escort's 2nd gen, and separately Familia's 4th gen to
        // Escort's 3rd) must each be their own independently confirmable
        // edge, not collapsed into one slot -- keying by the two SPECIFIC
        // generation ids involved (rather than the two nameplates as a
        // whole) means every distinct pair naturally gets its own storage
        // key, with no artificial cap on how many pairs one nameplate pair
        // can have.
        const key = relKey(gn.id, explicitGen.id, "platform");
        if (store.relations[key] || store.rejectedRelations[key]) return;
        store.relations[key] = {
          status: "confirmed", checkedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
          famA: famId, famB: match.id, relType: "platform",
          codeA: gn.label, codeB: explicitGen.code, genIdA: gn.id, genIdB: explicitGen.id,
          reason: `matched automatically -- the source text explicitly named this specific generation ("${explicitCode}") alongside the shared-platform mention, not just a year-overlap guess`,
          llmDiscovered: true,
        };
        return;
      }
      const cands = match.generations.map(id => byIdLocal.get(id)).filter(Boolean)
        .filter(g2 => gn.year != null && g2.year != null &&
          g2.year <= (gn.end || gn.year) && (g2.end || 9999) >= gn.year);
      if (cands.length === 1) {
        // Same per-pair keying as the explicitGen branch above, and for the
        // exact same reason -- this is still a specific (if lower-confidence)
        // generation pair, just one generation away from a hard-coded match.
        const key = relKey(gn.id, cands[0].id, "platform");
        if (store.relations[key] || store.rejectedRelations[key]) return;
        // Real user call: "year-overlap guess is actually fine." It holds up
        // when the NAMEPLATE was matched exactly: the pair of cars is not in
        // doubt, only which generation of it, and exactly one of them was in
        // production alongside this one. A wrong generation is a much smaller
        // error than a wrong car, and where no generation fits, the branch
        // below falls back to the plain nameplate-level link instead.
        //
        // Deliberately NOT passed through weakProposalRejection here. That
        // rule is about not trusting a match between unrelated companies, and
        // an exactly-named car came out of the article's own platform list:
        // Toyota Supra and BMW Z4 really do share a platform, and rejecting
        // that pair for crossing company lines would be the rule firing on
        // the one case it has no business judging.
        //
        // Reached from a SUBSTRING nameplate match it is a different animal:
        // the guess sits on top of a match that was already a coincidence of
        // letters, which is how a Volkswagen Touran came to be proposed
        // against a Daren Mk.3 kit car. Those stay in review, and the company
        // rule -- which is safe to apply here, because the pair itself is in
        // doubt -- throws out the impossible ones first.
        if (loose) {
          const veto = weakProposalRejection(gn, cands[0]);
          if (veto) { recordWeakRejection(key, gn, cands[0], veto.why, veto.cross); return; }
        }
        store.relations[key] = {
          status: loose ? "provisional" : "confirmed",
          checkedAt: new Date().toISOString(),
          decidedAt: loose ? undefined : new Date().toISOString(),
          famA: famId, famB: match.id, relType: "platform",
          codeA: gn.label, codeB: cands[0].label, genIdA: gn.id, genIdB: cands[0].id,
          reason: loose
            ? "proposed by overlapping production years only, on top of a nameplate name that only matched as a substring -- please verify this is really the right car before accepting"
            : "matched automatically -- the nameplate was named exactly in the source text, and exactly one of its generations was in production alongside this one, so that is the generation it refers to",
          llmDiscovered: true,
        };
      } else if (!loose || found.llmVerified) {
        // Ambiguous which of the target's generations -- wire in just the
        // plain nameplate<->nameplate fact (same trust level a build-time
        // harvested platform link already gets) and leave it there for the
        // normal checkRelation flow to resolve down to a specific pair once
        // a detail panel is opened on either side (app.js's
        // unresolvedFamilyRelations already picks up any ordinary platform/
        // related/succession link between two families, no special-casing
        // needed here). Only for an EXACT nameplate match -- a loose one is
        // uncertain on BOTH axes (which nameplate, and which generation) at
        // once, which is exactly the combination that produced the Toyota
        // C-HR false positive, so it's skipped entirely rather than adding
        // even the coarse link. The one exception: `found.llmVerified` --
        // the sanity-check LLM already actively confirmed this IS the same
        // nameplate (not a coincidental substring), which is a fundamentally
        // different, stronger kind of confidence than "the text happened to
        // overlap" -- it just couldn't ALSO pin down which specific
        // generation, so the coarse link is still worth surfacing here for
        // review rather than silently dropping a real, LLM-verified
        // connection on the floor.
        //
        // Uses idOf (defined below, hoisted) rather than plain === since
        // l.source/l.target may already be node OBJECT references rather
        // than plain id strings by the time this runs at live runtime --
        // see applyResolvedRelations' own comment for the full story on
        // this gotcha. A plain === here silently never matched an
        // already-mutated pre-existing link, letting a duplicate "platform"
        // link between the same two nameplates get pushed on every
        // subsequent boot.
        //
        // Real bug report (Ford Focus <-> VW Jetta): "When I try to delete
        // that connection... I deleted it but it still appeared and didn't
        // seem to actually get deleted." This is the branch that produced
        // that link, and it was the ONE branch in this whole function with no
        // store.rejectedRelations guard of its own -- every other branch
        // checks it before writing, but this one only ever deduped against
        // links already in the array. Since nodes/links are rebuilt from
        // scratch off cars.json/data.js on every boot and applyConfirmed
        // re-runs this function for every confirmed family, a coarse link the
        // user deleted was faithfully recreated on the very next reload,
        // every time, with nothing anywhere recording that they'd said no.
        // Keyed at the NAMEPLATE level (famId <-> match.id) because that's
        // exactly the granularity of the link being created here -- see
        // rejectRelation, which now records this same coarse key alongside
        // whatever specific generation-pair key was deleted, so declining
        // either one keeps this coarse fallback from quietly reappearing.
        const coarseKey = relKey(famId, match.id, "platform");
        if (store.rejectedRelations[coarseKey]) return;
        const already = links.some(l => l.type === "platform" &&
          ((idOf(l.source) === famId && idOf(l.target) === match.id) || (idOf(l.source) === match.id && idOf(l.target) === famId)));
        // note carries the original mention text forward onto the coarse
        // link -- app.js's unresolvedFamilyRelations reads it straight back
        // off as the interactive disambiguation flow's "note" (see its own
        // comment), so a future manual "check relation" click actually has
        // the real source text to work with instead of nothing. Previously
        // dropped here entirely, which is the other half of the real bug
        // report this whole function was reworked for: even when no
        // explicit code is recognized above (extractExplicitGenCode found
        // nothing, or this is a build-time link that never went through
        // resolvePlatformMention's LLM-driven mention at all), the text is
        // still worth preserving for a human -- or a later LLM pass -- to
        // read directly rather than re-deriving from scratch.
        if (!already) links.push({
          source: famId, target: match.id, type: "platform", llmDiscovered: true, note: mentionText,
          llmVerifiedDuplicate: found.llmVerified || undefined,
        });
      }
    } else {
      // Already as specific as it can get on the matched side (a plain
      // model, or a generation of some OTHER family standing in for
      // itself) -- an EXACT nameplate-name match here is trustworthy enough
      // to wire in immediately with no review step, same as before this
      // fix (this is what makes "if it appears in at least one article, it
      // should make the connection for both" keep working with zero
      // clicks). A LOOSE match is not -- see this function's own top
      // comment for the exact bug (Toyota C-HR) this distinction fixes.
      const targetFamId = match.familyOf || match.id; // a plain model IS its own "family" here
      // Keyed by the two SPECIFIC nodes actually involved (gn.id and
      // match.id -- match is already as granular as this side gets, same as
      // gn is on ours) rather than the coarser nameplate-level targetFamId,
      // for the same multi-pair reason as the branches above: a different
      // generation of this same nameplate mentioning this same (or a
      // different) already-specific target must get its own entry, not
      // collide with one already stored here.
      const key = relKey(gn.id, match.id, "platform");
      if (store.relations[key] || store.rejectedRelations[key]) return;
      // Real user request: "feel free to automatically approve the sanity
      // checks in the background if the LLM can safely determine that a
      // match can be made. No need to report the approval stage to the user
      // unless the LLM is genuinely not sure." A loose match the sanity-
      // check LLM actively verified (askDuplicateCheck, above) at HIGH
      // confidence is auto-confirmed here -- same tier as an exact
      // deterministic match, applied straight away by applyResolvedRelations
      // with no Yes/No box ever shown (unresolvedFamilyRelations only
      // surfaces "provisional" entries). Only a genuinely uncertain result --
      // no sanity check ran at all, or it ran and came back "low" confidence
      // -- still goes through ordinary review, exactly as before.
      const sanityConfident = loose && found.llmVerified && found.verifyConfidence === "high";
      const confirmed = !loose || sanityConfident;
      // Real user call: "for a string that only matches a substring, that's
      // correct that it's too much of a stretch and to not try to do a
      // match." A substring hit is a short label happening to appear inside a
      // longer mention -- the Jeep Commander (XK) that came out linked to a
      // Toyota C-HR -- and putting that in a review queue only moves the work
      // onto a person instead of deciding it. Dropped outright, and recorded
      // so it is not proposed again on the next boot.
      //
      // Scoped to a substring match with NOTHING ELSE behind it. Where the
      // local LLM sanity pass has actually looked at the mention and every
      // plausible car, its verdict is a second opinion, not a coincidence of
      // letters: "high" still auto-confirms, and "low"/"medium" is the real
      // uncertain middle that a review queue exists for. Those still go to
      // review, exactly as before.
      const explicitlyNamed = loose && looseMentionNamesThisGeneration(nodes, mentionText, match);
      if (!confirmed && !found.llmVerified && !explicitlyNamed && !surfaceLooseMatches) {
        store.rejectedRelations[key] = true;
        return;
      }
      // Anything still here is an exact nameplate match, or a substring one
      // the sanity pass has an opinion about. The unvouched substring case
      // returned above.
      store.relations[key] = {
        status: confirmed ? "confirmed" : "provisional",
        checkedAt: new Date().toISOString(),
        decidedAt: confirmed ? new Date().toISOString() : undefined,
        famA: famId, famB: targetFamId, relType: "platform",
        codeA: gn.label, codeB: match.label, genIdA: gn.id, genIdB: match.id,
        reason: !loose
          ? (match.familyOf
              ? "matched automatically (shared-platform mention found alongside this generation's own text, and the mentioned nameplate name matched exactly)"
              : "matched automatically to a plain (non-nameplate) model (shared-platform mention found alongside this generation's own text, and the mentioned nameplate name matched exactly)")
          : sanityConfident
            ? `auto-approved in the background -- the local LLM sanity check confidently identified this as the same car as "${mentionText}" (confidence: high) -- ${found.verifyReason || "no further explanation given"}`
            : found.llmVerified
              ? `flagged by the local LLM sanity check as the same car as "${mentionText}" (confidence: ${found.verifyConfidence || "unspecified"}) -- ${found.verifyReason || "no further explanation given"} -- please verify this is really the right car before accepting`
              : explicitlyNamed
                ? `proposed from a shared-platform/rebadge mention that named this nameplate together with this generation's own code ("${mentionText}") -- please verify this is really the right car before accepting`
                : `proposed from a loosely-matched shared-platform/rebadge mention ("${mentionText}" only overlapped this car's name as a substring) -- surfaced because you asked for this re-check rather than dropped, but please verify this is really the right car before accepting`,
        llmDiscovered: true,
        llmVerifiedDuplicate: found.llmVerified || undefined,
      };
    }
  }

  // ---------- shared-platform discovery for nameplates that DON'T split ----------
  // resolvePlatformMention above only ever gets called from applyConfirmed's
  // and applyFamilyOverride's own generation-minting loops -- i.e. only for
  // a nameplate that turned out to hide 2+ generations. But a shared-
  // platform/rebadge relationship is often stated even on a nameplate with
  // just ONE generation (real bug report: the Infiniti QX30's own article
  // says it shares Mercedes-Benz's MFA platform, even though QX30 was never
  // split -- checking the QX30 finds it, but checking the Mercedes A-Class
  // side alone never would, since the A-Class's OWN article doesn't mention
  // the QX30 back. "If it appears in at least one [article], it should make
  // the connection for both" -- this is what makes that true regardless of
  // which of the two nameplates you happen to check first). SYSTEM_PROMPT
  // now asks the model to report a single generation entry (with its own
  // sharedPlatform) even when hasMultipleGenerations is false, so a plain
  // "none" verdict can still carry a real platform mention worth acting on.
  function applySharedPlatformForSingleGen(nodes, links) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    Object.keys(store.families).forEach(nodeId => {
      const entry = store.families[nodeId];
      if (entry.status !== "none") return;
      const gens = (entry.proposal && entry.proposal.generations) || [];
      if (gens.length !== 1) return;
      // Array form going forward; `sharedPlatform` (singular) still read as
      // a one-item fallback for an older, already-persisted entry from
      // before this was a list.
      const texts = Array.isArray(gens[0].sharedPlatforms) ? gens[0].sharedPlatforms
        : (gens[0].sharedPlatform ? [gens[0].sharedPlatform] : []);
      if (!texts.length) return;
      // The checked node may since have been retired as a standalone
      // duplicate of some family's generation (see supersedeStandalone) --
      // its platform mention is still a real fact, it just belongs to the
      // replacement generation now. Follow the redirect rather than wiring
      // a link to a permanently-hidden node.
      const orig = followSuperseded(byId, byId.get(nodeId));
      if (!orig || (orig.type !== "model" && orig.type !== "family") || orig.retired) return;
      const gn = {
        id: orig.id, year: orig.year, end: orig.end, label: orig.label, sharedPlatformTexts: texts,
        // Carries the LLM sanity-check verdicts (if the check ran -- see
        // annotateSharedPlatformMatches) forward from the persisted
        // proposal onto this runtime gn object, keyed by mention text --
        // resolveOnePlatformMention reads it back off gn.sharedPlatformMatches.
        sharedPlatformMatches: gens[0].sharedPlatformMatches || {},
        // Carried the same way as sharedPlatformMatches -- see verifyMakeVariant.
        makeVariantMatches: gens[0].makeVariantMatches || {},
      };
      // If the redirect landed on a generation inside a family, the
      // relation's family-side id is that family (so the whole nameplate's
      // own generations are excluded from matching, and the stored entry
      // hangs off the family the way every other relation entry does) --
      // gn.id stays the specific generation, which is what genIdA records.
      resolvePlatformMention(nodes, links, orig.familyOf || orig.id, gn);
    });
  }

  // ---------- the same, for the PEOPLE a single-generation check found ----------
  // Real bug report, on the Audi Nuvolari: the check returned
  // `"designers": ["Massimo Frascella"]` and the Designers layer showed
  // nothing for the car. Not a rendering bug -- the credit genuinely never
  // reached the graph. `applyConfirmed` is the only thing that mints person
  // nodes and pushes designed/engineered links out of a check result, and it
  // starts with `if (entry.status !== "confirmed") return; ... if
  // (gens.length < 2) return;`. A car that turns out to have exactly ONE
  // generation is recorded as status "none" (there's no split to confirm and
  // nothing to ask the user about), so it fell through both guards and every
  // designer and engineer found on it was silently discarded.
  //
  // That's the same shape of hole `applySharedPlatformForSingleGen` above was
  // written to close for the platform half of a "none" verdict; this is its
  // twin for the people half. Andy's request: "whenever I do an LLM search, I
  // want that the information about the designers and engineers also be added
  // to the database."
  //
  // Runs at boot from the same replay sequence as everything else, and is
  // idempotent (every link is checked for before it's pushed, names go into a
  // Set), so re-running it mid-session after a live check can't double-credit
  // anyone.
  function applyPeopleForSingleGen(nodes, links) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    Object.keys(store.families).forEach(nodeId => {
      const entry = store.families[nodeId];
      if (!entry || entry.status !== "none") return;
      const gens = (entry.proposal && entry.proposal.generations) || [];
      if (gens.length !== 1) return;
      const g = gens[0];
      const designers = Array.isArray(g.designers) ? g.designers : [];
      const engineers = Array.isArray(g.engineers) ? g.engineers : [];
      if (!designers.length && !engineers.length) return;
      // Same followSuperseded reasoning as applySharedPlatformForSingleGen:
      // the checked node may since have been retired as a duplicate, and the
      // credit belongs to whatever replaced it.
      const orig = followSuperseded(byId, byId.get(nodeId));
      if (!orig || (orig.type !== "model" && orig.type !== "family") || orig.retired) return;
      [["designer", "designed", designers], ["engineer", "engineered", engineers]]
        .forEach(([role, linkType, names]) => {
          const set = new Set(orig[role + "s"] || []);
          names.forEach(name => {
            const p = resolvePersonNode(nodes, byId, name, role);
            if (!p) return;
            set.add(name);
            const already = links.some(l => l.type === linkType &&
              idOf(l.source) === orig.id && idOf(l.target) === p.id);
            if (!already) links.push({ source: orig.id, target: p.id, type: linkType, llmDiscovered: true });
          });
          orig[role + "s"] = [...set];
        });
    });
  }

  // ---------- runtime rewiring: apply every "confirmed" entry into the live graph ----------
  // Mirrors what data_src/build_family_layer.py does at build time, except
  // there are no pre-existing per-generation nodes to group here — the LLM
  // invented the split, so this mints new synthetic generation nodes and
  // turns the ORIGINAL model node into the family (same id, so every
  // existing link into it — made/designed/engineered/succession/related —
  // keeps working with zero rewiring).
  function applyConfirmed(nodes, links) {
    // Deliberately NOT gated on serverAvailable — a plain double-clicked
    // index.html (file://, no serve.py) still has confirmed generations
    // available via the static llm_families_data.js mirror (see index.html's
    // boot script) and should render them identically to the live session
    // that confirmed them. serverAvailable only gates the *interactive*
    // parts (checking a new car, writing a new decision) below.
    if (!Object.keys(store.families).length) return;
    const byId = new Map(nodes.map(n => [n.id, n]));

    // name -> existing person node, by normalized label (diacritic/case
    // insensitive) -- so "Balázs Filczer" reuses the same person node
    // wherever else they're already credited in the graph, rather than
    // minting a duplicate. Rebuilt fresh each call since `nodes` can have
    // grown since the last one.
    const personByNorm = new Map();
    for (const n of nodes) if (n.type === "person") personByNorm.set(norm(n.label), n);

    function resolvePerson(name, role) {
      const key = norm(name);
      if (!key) return null;
      let p = personByNorm.get(key);
      if (!p) {
        let id = "p-" + slugify(name);
        if (byId.has(id)) id = id + "-" + Math.random().toString(36).slice(2, 6); // exceedingly rare collision
        // Same "very big attempt" cache/backfill as resolvePersonNode's own
        // twin implementation above -- see scheduleFactBackfill's comment.
        const cached = store.mintedFacts[id];
        p = { id, type: "person", kind: "person", label: name, roles: [role],
              born: cached && cached.born != null ? cached.born : null,
              died: cached && cached.died != null ? cached.died : null,
              country: cached && cached.country != null ? cached.country : null,
              wp: null, llmGenerated: true };
        if (cached && cached.source) p.factsSource = cached.source;
        nodes.push(p);
        byId.set(id, p);
        personByNorm.set(key, p);
        if (!cached) scheduleFactBackfill("person", id, p, () => bigPersonAttempt(name));
      } else if (!p.roles.includes(role)) {
        p.roles = [...p.roles, role]; // e.g. already a "designer" elsewhere, now also credited as "engineer" here
      }
      return p;
    }

    Object.keys(store.families).forEach(nodeId => {
      const entry = store.families[nodeId];
      // A tombstone left behind by deleteEntry(): this nameplate got
      // undone, but the designers/engineers the LLM found on it shouldn't
      // vanish -- credit them directly on the still-plain model node
      // instead, same shape as any other model-level designed/engineered
      // credit (see build_data.py). Guarded by llmDeletedFallbackApplied so
      // re-running applyConfirmed mid-session (e.g. after a live-apply
      // elsewhere) never double-links these.
      if (entry.status === "deleted") {
        const orig = byId.get(nodeId);
        if (!orig || orig.type !== "model" || orig.llmDeletedFallbackApplied) return;
        const roleNames = { designer: entry.allDesigners || [], engineer: entry.allEngineers || [] };
        Object.keys(roleNames).forEach(role => {
          const linkType = role === "designer" ? "designed" : "engineered";
          roleNames[role].forEach(name => {
            const p = resolvePerson(name, role);
            if (!p) return;
            const already = links.some(l => l.source === nodeId && l.target === p.id && l.type === linkType);
            if (!already) links.push({ source: nodeId, target: p.id, type: linkType, llmDiscovered: true });
          });
        });
        const dset = new Set(orig.designers || []);
        (entry.allDesigners || []).forEach(d => dset.add(d));
        orig.designers = [...dset];
        const eset = new Set(orig.engineers || []);
        (entry.allEngineers || []).forEach(d => eset.add(d));
        orig.engineers = [...eset];
        orig.llmDeletedFallbackApplied = true;
        return;
      }
      if (entry.status !== "confirmed") return;
      const orig = byId.get(nodeId);
      if (!orig || orig.type !== "model") return; // already applied earlier, or node no longer exists
      const gens = (entry.proposal && entry.proposal.generations) || [];
      if (gens.length < 2) return;

      const genIds = [];
      const years = [], ends = [];
      const allDesigners = new Set(orig.designers || []);
      const allEngineers = new Set(orig.engineers || []);
      // Mirrors build_family_layer.py's own dedup: every unique (type,
      // personId) credited on ANY generation also gets a single link up to
      // the family/nameplate node itself, so "G-Class -> Balázs Filczer"
      // exists even when you're looking at the collapsed parent, not just
      // the expanded W463 generation.
      const famPersonLinks = new Map(); // key `${type}|${personId}` -> {type, personId}
      const orphanedOldFamIds = new Set(); // old families a duplicate generation was pulled out of -- see retireOrphanedFamily below
      let prevGid = null;
      // Real bug report (the Mercedes-Benz G-Class): the id is derived purely
      // from the code, so two generations sharing one factory designation --
      // W463 for both the 1990-2018 car and the 2018- car, which Wikipedia
      // itself flags as unexplained -- produced the SAME id twice. Both nodes
      // got pushed, the id map kept whichever came last, and the result was
      // the reported symptom exactly: the same generation listed twice with
      // the later one's years, the earlier one missing, and a stray node
      // "outside the generation link... not connected to the existing graph".
      //
      // reconcileRepeatedCodes above is the real fix (it stamps the start year
      // into a repeated code, so the ids differ naturally). This is the
      // backstop for anything that slips past it -- a duplicate id is never
      // recoverable once it is in the graph, so it is worth refusing outright
      // rather than trusting the layer above to be exhaustive.
      const usedGids = new Set();
      gens.forEach(g => {
        let gid = "llm-" + nodeId + "-" + String(g.code).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
        if (usedGids.has(gid)) {
          const suffix = g.yearStart != null ? String(g.yearStart) : String(usedGids.size + 1);
          gid = gid + "-" + suffix;
          while (usedGids.has(gid)) gid += "x";
        }
        usedGids.add(gid);
        // De-duplication: this generation may already exist elsewhere in the
        // graph, either as its own independent, never-grouped standalone
        // model, or as a generation already grouped under a DIFFERENT,
        // pre-existing family (same reasoning as applyFamilyOverride's own
        // de-dup, see findDuplicateGeneration's own comment -- the
        // Mercedes-Benz SL-Class's R107/R129/R230/R231 is the real case that
        // prompted this). Retire it in favor of the freshly-minted
        // generation node rather than leaving two nodes for one car; never
        // deleted, so it comes back automatically if this confirmed split is
        // ever undone via the LLM Debug panel. Everything the duplicate
        // knew -- its own relation links, person links, My Database data,
        // Wikipedia article, production years -- carries over onto the
        // replacement generation via supersedeStandalone (called just after
        // gn is minted below); its designer/engineer names are additionally
        // folded up to the family level here, same as applyFamilyOverride
        // does for its own orphaned generations.
        const dup = findDuplicateGeneration(nodes, g.code, nodeId, orig.make, orig.label);
        if (dup && dup.familyOf) orphanedOldFamIds.add(dup.familyOf);
        if (dup) {
          (dup.designers || []).forEach(name => {
            allDesigners.add(name);
            const p = resolvePerson(name, "designer");
            if (p && !links.some(l => l.type === "designed" && l.source === nodeId && l.target === p.id)) {
              links.push({ source: nodeId, target: p.id, type: "designed", llmDiscovered: true });
            }
          });
          (dup.engineers || []).forEach(name => {
            allEngineers.add(name);
            const p = resolvePerson(name, "engineer");
            if (p && !links.some(l => l.type === "engineered" && l.source === nodeId && l.target === p.id)) {
              links.push({ source: nodeId, target: p.id, type: "engineered", llmDiscovered: true });
            }
          });
        }
        const gn = {
          id: gid, type: "model", label: `${orig.label} ${g.code}`, make: orig.make,
          // Prefer the LLM's own extracted years, then the standalone
          // duplicate's real, harvested years (the R107 case: DBpedia knew
          // 1971-1989 even if the umbrella-article read didn't), then the
          // parent's year as the last resort.
          year: g.yearStart || (dup && dup.year) || orig.year,
          end: g.yearEnd != null ? g.yearEnd : ((dup && dup.end) || null),
          designers: g.designers || [], engineers: g.engineers || [],
          // The standalone's own dedicated article (when one exists) beats
          // the shared umbrella article for this generation's link/thumbnail.
          familyOf: nodeId, wp: (dup && dup.wp) || orig.wp, llmGenerated: true,
          // Found next to this generation's own text in the source article
          // (see findNearbyFile in validate()) -- lets each generation show
          // its own photo instead of every one of them falling back to the
          // shared parent-article thumbnail. Null just means none was found
          // nearby; the app falls back to the normal per-article thumbnail.
          wikiFile: g.wikiFile || null,
          // Free-text names of every DIFFERENT nameplate this generation's
          // own article text says it shares a platform with / is a rebadge
          // of (hallucination-guarded to appear verbatim in the source by
          // validate() already) -- resolved against the graph itself just
          // below, via resolvePlatformMention. Array form going forward;
          // `sharedPlatform` (singular) still read as a one-item fallback
          // for an older, already-persisted entry from before this was a
          // list.
          sharedPlatformTexts: Array.isArray(g.sharedPlatforms) ? g.sharedPlatforms
            : (g.sharedPlatform ? [g.sharedPlatform] : []),
          // LLM sanity-check verdicts (if the check ran), carried forward
          // the same way -- see the other two sharedPlatformMatches
          // assignments in this file for the full comment.
          sharedPlatformMatches: g.sharedPlatformMatches || {},
          makeVariantMatches: g.makeVariantMatches || {},
        };
        nodes.push(gn);
        if (dup) {
          // Retires the standalone AND transplants everything it knew onto
          // gn -- flags, fields, and equivalent copies of every relation/
          // person link it carried. See supersedeStandalone's own comment.
          supersedeStandalone(nodes, links, dup, gn, nodeId, orig.make + " " + orig.label);
          // Same family-level inheritance build_family_layer.py applies: a
          // documented ("My Database") or garage generation keeps showing
          // its ring on the collapsed nameplate dot too.
          if (gn.db && !orig.db) {
            orig.db = true;
            orig.dbGenerations = [...(orig.dbGenerations || []), gn.id];
          }
          if (gn.garage) orig.garage = true;
        }
        genIds.push(gid);
        if (gn.year) years.push(gn.year);
        ends.push(gn.end);
        links.push({ source: nodeId, target: gid, type: "generation" });
        // Sequential chain between consecutive generations (gen[i] -> gen[i+1],
        // in the LLM's own chronological order) -- a visible line distinct from
        // the structural, undrawn family->generation hub link above. Mirrors
        // what build_family_layer.py does for build-time-detected families.
        if (prevGid) links.push({ source: prevGid, target: gid, type: "gensucc" });
        prevGid = gid;
        resolvePlatformMention(nodes, links, nodeId, gn);
        (g.designers || []).forEach(d => allDesigners.add(d));
        (g.engineers || []).forEach(d => allEngineers.add(d));

        // Wire this generation directly to its designer(s)/engineer(s) --
        // reusing an existing person node by name if one already exists
        // anywhere in the graph, minting a new one otherwise. A direct
        // "W463 -> Balázs Filczer" line, not just text in the node's data.
        // Also guarded by links.some, not just seenOnThisGen: a superseded
        // standalone duplicate's rebound links (see supersedeStandalone
        // above) may already connect this same generation to this same
        // person, when the standalone knew the credit AND the LLM found it
        // independently in the umbrella article.
        const seenOnThisGen = new Set(); // a name showing up in both lists shouldn't double-link
        (g.designers || []).forEach(name => {
          const p = resolvePerson(name, "designer");
          if (!p || seenOnThisGen.has("designed|" + p.id)) return;
          seenOnThisGen.add("designed|" + p.id);
          if (!links.some(l => l.type === "designed" && idOf(l.source) === gid && idOf(l.target) === p.id)) {
            links.push({ source: gid, target: p.id, type: "designed", llmDiscovered: true });
          }
          famPersonLinks.set("designed|" + p.id, { type: "designed", personId: p.id });
        });
        (g.engineers || []).forEach(name => {
          const p = resolvePerson(name, "engineer");
          if (!p || seenOnThisGen.has("engineered|" + p.id)) return;
          seenOnThisGen.add("engineered|" + p.id);
          if (!links.some(l => l.type === "engineered" && idOf(l.source) === gid && idOf(l.target) === p.id)) {
            links.push({ source: gid, target: p.id, type: "engineered", llmDiscovered: true });
          }
          famPersonLinks.set("engineered|" + p.id, { type: "engineered", personId: p.id });
        });
      });

      // Mirror the deduped set of generation-level designer/engineer links
      // up to the family node too (e.g. G-Class -> Balázs Filczer), same as
      // the build-time family layer already does for build-time families.
      famPersonLinks.forEach(({ type, personId }) => {
        links.push({ source: nodeId, target: personId, type, llmDiscovered: true });
      });

      orig.type = "family";
      orig.generations = genIds;
      orig.designers = [...allDesigners];
      orig.engineers = [...allEngineers];
      orig.llmGenerated = true;
      if (years.length) orig.year = Math.min(...years);
      orig.end = ends.some(e => e == null) ? null : Math.max(...ends);
      orphanedOldFamIds.forEach(oldFamId => retireOrphanedFamily(byId, oldFamId, nodeId, orig.make + " " + orig.label));

      // Seed the SEPARATE nameplate generation cross-check (checkFamily,
      // isEligibleForRecheck) as already-satisfied. Without this, the very
      // next render sees a brand-new "family" node with no store.recheck
      // entry, decides it's eligible, and immediately re-fetches this same
      // Wikipedia article for a second, independent llama.cpp call asking the
      // LLM to re-derive the exact generation list it just derived seconds
      // ago (real bug report -- the "cross-checking this nameplate's
      // generations against Wikipedia..." message firing right after
      // confirming a fresh split, e.g. Mercedes-Benz G-Class). There's no
      // question left to answer: `entry.proposal` (from the check that just
      // got confirmed) already IS the freshly-extracted generation list for
      // this exact article, so comparing it against itself can only ever
      // come back clean -- and worse, a second independent LLM pass over the
      // same text isn't perfectly deterministic, so it could occasionally
      // disagree with itself and throw a spurious discrepancy banner right
      // after the user just confirmed the split. Shaped to match exactly
      // what checkFamily itself writes on a clean "no discrepancy" result
      // (see its own "none" entry) so nothing downstream needs to know this
      // one was seeded rather than actually re-checked.
      store.recheck[nodeId] = {
        status: "none",
        checkedAt: new Date().toISOString(),
        sourceTitle: entry.sourceTitle || orig.wp || null,
        proposal: entry.proposal || null,
        discrepancy: null,
        attempts: 1,
        feedback: [],
      };
    });
  }

  // ---------- My Database: prefer a specific generation over the bare nameplate, once one exists ----------
  // build_db_layer.py already does this at BUILD time -- a My Database car
  // whose specs.md gives a model year gets matched directly onto whichever
  // generation's production span covers it, not the bare nameplate (see
  // match_folder()'s year-hint generation preference). But a car that was
  // matched onto a plain, not-yet-split model at build time (the only thing
  // that existed then) only becomes a real nameplate later, once an LLM
  // generation split gets confirmed HERE, in the browser -- so the same
  // "does exactly one generation's span cover this car's model year" check
  // has to run again client-side once that split exists. Never removes the
  // db flag from the family/bare node itself (that stays the permanent
  // fallback) -- only ADDS it to the resolved generation too, so if this
  // LLM nameplate later gets deleted (see deleteEntry()'s tombstone), the
  // family reverts to a plain model and the untouched fallback is exactly
  // what's left, with zero extra unwinding needed.
  function reconcileDbGenerations(nodes) {
    const YEAR_RE = /(19|20)\d{2}/;
    const byId = new Map(nodes.map(n => [n.id, n]));
    nodes.forEach(orig => {
      if (!orig.db || orig.type !== "family" || !orig.generations || !orig.generations.length) return;
      if (orig.dbGenerations && orig.dbGenerations.length) return; // already resolved (build-time family, or earlier this session)
      if (!orig.dbspecs && !orig.dbphoto) return; // this family's db flag came from a generation already, nothing of its own to hand down
      const raw = orig.dbspecs && orig.dbspecs.modelYear;
      const m = raw && String(raw).match(YEAR_RE);
      if (!m) return;
      const yearHint = parseInt(m[0], 10);
      const gens = orig.generations.map(id => byId.get(id)).filter(Boolean);
      const covering = gens.filter(g => (g.year || 0) <= yearHint && yearHint <= (g.end || 9999));
      if (covering.length !== 1) return; // no year data, or ambiguous between multiple -- leave the fallback as-is
      const g = covering[0];
      g.db = true;
      if (orig.dbspecs) g.dbspecs = orig.dbspecs;
      if (orig.dbphoto) g.dbphoto = orig.dbphoto;
      if (orig.dbPage) g.dbPage = orig.dbPage;
      if (orig.garage) g.garage = true;
      orig.dbGenerations = [g.id];
    });
  }

  // ---------- generation-level relation disambiguation (platform/related/succession) ----------
  // A platform/related/succession link between two nameplates is often only
  // known at the collapsed, nameplate-wide level (build_family_layer.py's
  // mirror_relation_links makes sure that's at least visible -- e.g. Porsche
  // 911 <-> Boxster/Cayman -- but a bare "these two are related" fact
  // doesn't say which SPECIFIC generation of each is the one actually
  // sharing a platform). When both connected nameplates already have real
  // generations (build-time or LLM-discovered), this asks the local LLM
  // which specific pair the relationship is really about -- using just the
  // generation code/year lists already in the graph, no Wikipedia refetch
  // needed. Same provisional-until-confirmed discipline as the rest of this
  // file: nothing gets wired into the live graph until confirmRelation().
  const relationInFlight = new Map();
  function relationEntryFor(key) { return (store.relations && store.relations[key]) || null; }

  function fmtGenList(info) {
    return info.generations.map(g => `${g.code} (${g.year != null ? g.year : "?"}${g.end ? "–" + g.end : g.year != null ? "–" : ""})`).join(", ");
  }
  function relationWord(relType) {
    return relType === "platform" ? "share a platform"
      : relType === "succession" ? "are a predecessor/successor pair"
      : "are related (e.g. a rebadge or sister/sibling model)";
  }
  // Real bug report: this prompt used to let the model resolve a pair
  // purely off "overlapping/adjacent production years" -- which is how a
  // Jeep Grand Cherokee generation and a completely unrelated Jeep Commander
  // (XK) ended up "resolved" as a predecessor/successor pair with a reason
  // that amounted to nothing more than "their years happen to overlap."
  // Two nameplates simply existing at overlapping times is true of huge
  // numbers of unrelated car pairs and is never, by itself, evidence that
  // THIS pair is the specific one Wikipedia's platform/related/succession
  // link was actually describing. Year adjacency is now only usable to
  // choose BETWEEN two textually-plausible candidates on the same side, not
  // as the sole basis for resolving one from nothing -- resolved:true now
  // requires the `note` (the actual sentence/field from the source article
  // that stated this relationship) to itself point at a specific
  // generation, e.g. naming a chassis code, an explicit "the W463 was
  // replaced by the W464" kind of statement, or an unambiguous one-of-a-kind
  // model name -- not just silence plus overlapping years.
  // Real user request: a growing pile of the bugs found in this file were
  // really the same shape -- a regex written for one Wikipedia formatting
  // convention (comma-separated codes, a bare "(CODE)" right after a name)
  // broke on another (a semicolon INSIDE the code's own parens, a code that
  // only lives in a piped wikilink's target, a generation whose own `code`
  // field is formatted differently from its siblings...). Hard-coding a new
  // regex for every new formatting quirk anyone ever finds is a losing
  // game; reading past inconsistent punctuation and matching it to the
  // right item in a list is exactly what a language model is good at and a
  // regex isn't. `evidenceQuote` lets the model do that job directly: it
  // reads the (already-widened, see excerptAround above) raw article
  // excerpt itself, figures out the actual code despite whatever
  // formatting the source text happens to use, and copies out the literal
  // phrase that proves it -- which is then checked against the real
  // article text below (quoteVerifies/quoteBacksCode) before it's trusted
  // as strongly as the deterministic extraction. An unverifiable or
  // fabricated quote is worth nothing here, same as any other hallucination
  // guard in this file -- the point isn't to trust the model MORE, it's to
  // let it do the formatting-normalization work a regex can't generalize,
  // while still checking its work against the source.
  function buildRelationMessages(infoA, infoB, relType, note) {
    const word = relationWord(relType);
    const system = `You are given the production-generation lists of two car nameplates that Wikipedia states ${word}. Identify which SPECIFIC generation(s) the relationship actually applies to, based on real evidence -- textual or well-established factual knowledge -- not on year overlap alone.
Respond with ONLY JSON, no prose, matching exactly this shape:
{"resolved": boolean, "codeA": string|null, "codeB": string|null, "evidenceQuote": string|null, "reason": string}
Rules:
- "codeA" and "codeB" must be copied from the code lists given below, exactly as written there (including any nameplate-name prefix, and WITHOUT appending the year range shown beside them) -- never invent a code that isn't in the given lists.
- That is a rule about what you WRITE, not about what counts as knowing the answer. The generation you have identified does NOT have to be named in the list in the same words you know it by. Your job is to MAP what the evidence names onto the best-corresponding list entry: the entry whose year range covers it, or the one at that chronological position. Real failure this rule exists for: a note said the Mazda CX-5 "shares the platform used by the third-generation Mazda3 and the Mazda6 (GJ)", the model correctly worked out that GJ IS the third generation, and then answered resolved:false because the literal string "Mazda6 (GJ)" was absent from a list offering "Mazda6 (third generation)". It had already done the identification; the only thing missing was writing down the list's spelling of it. That is resolved:true with codeB "Mazda6 (third generation)".
- A chassis/platform designation you recognise as equivalent to a listed generation IS a match -- "GJ" and "third generation" naming the same car is exactly the formatting noise the next rule tells you to read past, not a reason to refuse.
- Wikipedia's own text formats things inconsistently -- a code buried inside a longer label like "B-Class (W246)", codes separated by semicolons instead of commas, a code sitting inside a piped wikilink, a code followed immediately by a start year in the SAME parentheses like "(W246; 2011)", an ordinal ("second generation") standing in for a code, and other variations you'll see. Reading past formatting noise like this to find the real code being named is your job, not something you should give up on just because the punctuation looks unfamiliar -- match whatever you find to the closest entry in the given code list.
- When the note names a generation by ordinal ("third-generation X", "X's second generation") instead of a code, that ordinal is that nameplate's OWN chronological position -- count from the OLDEST generation in the code list given below (they're listed with their year ranges) as 1st, and pick the code at that exact position. Do NOT guess a code by how new/similar its name looks -- "third generation" means the 3rd-oldest by year, full stop, even if a different code would seem like a more natural guess. This applies even when the ordinals for the two sides are given separately (e.g. Car A's note says "first generation" and Car B's says "four generations produced") rather than cross-referencing each other by name -- you can still align them by working out which specific generation each ordinal/count actually points to.
- "evidenceQuote" is the literal proof when your answer comes from the note's own text: copy the exact phrase or sentence, character-for-character, with no paraphrasing, summarizing, or fixing up its formatting. This gets checked against the actual source text -- an invented, reworded, or approximate quote is rejected as if it were never given, so only fill it in when you can copy real text verbatim, and leave it null otherwise.
- A confident answer does NOT always require a literal quote. If you have specific, well-established real-world knowledge of exactly which generation of Car A shares a platform/chassis/relationship with exactly which generation of Car B -- not a vague sense that the two brands are "similar" or "in the same segment", but a concrete, nameable fact you're confident is true (e.g. you know the actual shared platform code, or that this specific generation pairing is the well-documented one) -- you may set resolved:true on that basis alone, with evidenceQuote left null. State the concrete fact plainly in "reason" (name the platform/chassis code or the specific fact itself) so it's clear this came from general knowledge rather than the note -- a vague reason like "these seem related" or "this feels right" does not meet this bar and should get resolved:false instead. This still is not backed by a verifiable quote, so it will be held for your review rather than applied automatically -- getting it in front of a human beats leaving it unresolved.
- You do not have to resolve BOTH sides. If you can confidently identify ONE specific generation but the other car's side is genuinely ambiguous between several of its own generations, set resolved:true and fill in just the side you're confident about, leaving the other one null.
- Overlapping or adjacent production years ALONE are still NEVER sufficient evidence and must never be the sole reason for resolved:true, under any of the rules above -- two nameplates merely existing at the same time does not mean they are the specific pair a platform/related/succession fact is about, no matter how the reasoning is phrased. Years may only be used to break a tie between two candidates you've ALREADY narrowed it down to some other way.
- Concretely: "the note doesn't name a generation of Car A, but Car A's production years happen to line up with Car B's" is NEVER a valid reason for resolved:true -- that is exactly the year-overlap guess this rule forbids, even if it feels obviously right. If that is the best justification you can give, the correct answer is resolved:false.
- If there is no note, no ordinal/count you can align, and no specific factual knowledge you're genuinely confident about, return resolved:false and leave both null and say why in "reason" -- do not guess from years alone, and do not guess from vague similarity.
- Do NOT return resolved:false merely because a generation you ARE confident about is awkward to name from the code list. Real failure this rule exists for: a model correctly wrote "it is a well-established fact that the Ford Fusion (First Gen) and Mazda6 (First Gen) share the CD3 platform", then answered resolved:false because the list offered "Mazda6 (2002-2025)" and "Mazda6 (third generation)" with no distinct entry reading "first generation". That is a formatting problem in the list, not doubt about the car. When you know which generation you mean, pick the code that best corresponds to it -- the entry whose year range covers it, or the one at that chronological position -- and set resolved:true, naming the concrete fact (the shared platform/chassis code) in "reason". Only leave a side null when you genuinely do not know which generation it is.
- If you find yourself writing that you know the answer but the rules or the code list are stopping you from giving it, that is a signal to answer resolved:true with your best code match, not resolved:false.
- SHARING A PLATFORM IS ITSELF THE EVIDENCE. If the note (or your own confident knowledge) establishes that a specific generation of Car A and a specific generation of Car B are built on the SAME, EXACTLY-NAMED platform, that IS the relationship -- resolve it. You do not additionally need the text to say the two cars are "related" to each other, or to name one in the other's article. Real failure this rule exists for: a model wrote that the Cupra Terramar "uses the Volkswagen Group MQB Evo platform, which is also the platform for the current-generation Tiguan (Tiguan AD1/AX1)" and then answered resolved:false because the note "does not explicitly state that the Tiguan AD1/AX1 is the specific generation related to the Terramar". It had already stated the match. That should have been resolved:true with codeB "Tiguan AD1/AX1".
- MATCH PLATFORM NAMES EXACTLY, INCLUDING ANY QUALIFIER. "MQB" and "MQB Evo" are DIFFERENT platforms and are NOT a match for each other; so are "MLB" and "MLB Evo", "PQ35" and "PQ46", "MQB" and "MQB A0". A car on MQB does not share a platform with a car on MQB Evo. When you use a shared platform as your evidence, name the platform in full in "reason" (write "MQB Evo", never just "MQB") and only treat two cars as sharing it when the full names are identical.
- Do NOT state the answer and then refuse it. If your "reason" is going to say that you know, or that real-world knowledge confirms, that a particular generation is the one -- for example "real-world knowledge confirms the 2006 Concept A was the design precursor to the first-generation Tiguan (5N)" -- then that IS your answer: set resolved:true and put that generation's code in codeA/codeB. A reason that names the correct generation while the verdict says "unresolved" is self-contradictory and is treated as a resolved:true answer anyway, so write it as one.`;
    const user = `Car A -- ${infoA.make} ${infoA.label}: ${fmtGenList(infoA)}\n` +
      `Car B -- ${infoB.make} ${infoB.label}: ${fmtGenList(infoB)}\n` +
      `Relationship: these two nameplates ${word}.` + (note ? `\nNote: ${note}` : "\nNote: (none given -- no source text was available describing this relationship beyond the bare fact that it exists.)");
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  // A small local model was reliably asked to "copy the code exactly" and
  // reliably didn't -- given offered codes like "X1 U11/U12" (the
  // nameplate's own label prefixed on, see app.js's familyGenInfo), it very
  // often echoed back just "U11/U12", dropping the prefix. That's not
  // actually ambiguous -- it never matched anything ELSE in the list -- so
  // treating it as a hard non-match threw away a confident, correct answer
  // and reported "couldn't confidently match" even when the raw response
  // (visible in the debug disclosure) clearly had resolved it. Try an exact
  // match first, then fall back to a prefix-agnostic one before giving up.
  function normCode(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }
  // Real bug report: a relation check whose raw response clearly resolved the
  // pair -- codeA "CX-5 KF (2016-2025)", codeB "Mazda6 (third generation)
  // (2012-2024)", with a real evidence quote -- still surfaced as "couldn't
  // confidently match". Root cause: the codes offered to the model come from
  // app.js's familyGenInfo as `code: g.label` ("CX-5 KF"), while the YEARS
  // are a separate field the prompt renders alongside them. The model,
  // reasonably, echoed back what it saw on screen: the label with the year
  // range appended. None of the match tiers below strip that, so a correct
  // answer failed every one of them and was thrown away.
  //
  // Strip a TRAILING parenthetical that is purely a year range (all four
  // dash characters Wikipedia uses, plus "present"/"-" open-ended forms).
  // Deliberately narrow: a parenthetical carrying anything else -- "(W176)",
  // "(third generation)", "(GJ)" -- is a real part of the code and must
  // survive, since the tiers below match on exactly those.
  function stripYearSuffix(s) {
    return String(s || "").replace(
      /\s*\((?:c\.?\s*)?(?:1[89]|20)\d{2}\s*(?:[-\u2010-\u2015\u2212]|to|until|through)?\s*(?:(?:1[89]|20)\d{2}|present|now|\u2026|\.\.\.)?\s*\)\s*$/i, "")
      .trim();
  }
  function findGenByCode(generations, rawCode) {
    if (!rawCode) return null;
    // Try the code as given first; if nothing matches, try it again with a
    // trailing year range stripped off (see stripYearSuffix). Retrying the
    // WHOLE tier ladder rather than adding a single extra tier means the
    // year-suffixed form gets the same prefix/suffix/parenthetical handling
    // every other shape already gets -- "Mazda6 (third generation)
    // (2012-2024)" has to fall through to the parenthetical tier, which it
    // can only reach once the year half is gone.
    return findGenByCodeExact(generations, rawCode)
        || findGenByCodeExact(generations, stripYearSuffix(rawCode));
  }
  function findGenByCodeExact(generations, rawCode) {
    if (!rawCode) return null;
    const r = normCode(rawCode);
    if (!r) return null;
    let g = generations.find(g => normCode(g.code) === r);
    if (g) return g;
    g = generations.find(g => {
      const o = normCode(g.code);
      return o.length > r.length && o.endsWith(r) && o[o.length - r.length - 1] === " ";
    });
    if (g) return g;
    g = generations.find(g => {
      const o = normCode(g.code);
      return r.length > o.length && r.endsWith(o) && r[r.length - o.length - 1] === " ";
    });
    if (g) return g;
    // Real bug report: Mercedes-Benz CLA <-> B-Class never resolved even
    // once the evidence text correctly yielded "W246" -- because THIS
    // particular generation's own `code` field is "B-Class (W246)" (kept
    // in its original, un-normalized form from wherever it was harvested),
    // not the bare "W246" its two siblings ("B W245"/"B W247") use. A code
    // extracted from article text is naturally bare, so it never matched
    // this one nameplate's own inconsistent formatting under any of the
    // exact/prefix/suffix tiers above. If a candidate's own code carries a
    // "(...)" of its own, treat whatever's inside it as an alternate code
    // to compare against.
    g = generations.find(g => {
      const m = String(g.code || "").match(/\(([^)]+)\)/);
      return m && normCode(m[1]) === r;
    });
    if (g) return g;
    // Same problem from the other direction: a stored generation label can
    // itself carry a year range ("Mazda6 (third generation) (2012-2024)" as
    // a single harvested label), while the model answers with the clean
    // "Mazda6 (third generation)". Compare both sides year-stripped.
    g = generations.find(g => normCode(stripYearSuffix(g.code)) === normCode(stripYearSuffix(rawCode)));
    if (g) return g;
    // Real failure, on Honda Legend <-> Acura RL: the graph stores the second
    // generation as "KA7/8 (Second generation)" while the model answered
    // "KA7/KA8" -- Wikipedia writes a two-chassis generation both ways and
    // they mean the identical car. Nothing above could match them (different
    // strings, neither a prefix/suffix/parenthetical of the other), so a
    // correctly-identified generation pair fell back to a vaguer
    // nameplate-level match. Compare the two forms with the shared letter
    // prefix expanded onto every bare number after a slash, so "KA7/8" and
    // "KA7/KA8" normalise to the same thing.
    const expandSlashCodes = raw => normCode(stripYearSuffix(raw))
      .replace(/\b([a-z]+)([0-9]+)((?:\s*\/\s*[a-z]*[0-9]+)+)/g, (whole, letters, first, rest) =>
        letters + first + rest.replace(/([a-z]*)([0-9]+)/g, (m, l, n) => "/" + (l || letters) + n).replace(/\s*\/\s*/g, "/").replace(/^\/+/, "/"))
      .replace(/\s+/g, " ");
    // A stored code often carries a descriptive tail the model's answer never
    // has ("KA7/8 (Second generation)" vs "KA7/KA8"), so the comparison drops
    // a trailing parenthetical too. Deliberately only in THIS tier and only
    // for codes that actually contain a slash: everything above has already
    // failed, and requiring a slash keeps it from loosening plain codes, where
    // a parenthetical is often the only thing telling two entries apart.
    const bareSlash = raw => expandSlashCodes(String(raw || "").replace(/\s*\([^)]*\)\s*$/, ""));
    const want = bareSlash(rawCode);
    if (want && /\//.test(want)) {
      const hits = generations.filter(gg => bareSlash(gg.code) === want);
      if (hits.length === 1) return hits[0];   // never guess between two
    }
    return g || null;
  }

  // Real bug report: the INTERACTIVE relation-check flow below (unlike
  // resolvePlatformMention's automatic generation-check-time discovery
  // above) never actually looked at either nameplate's own Wikipedia
  // article -- it only ever had whatever `note` text the caller happened to
  // already have (frequently null/empty for a build-time-harvested, or
  // otherwise mention-less, "related"/"platform" fact), so the model was
  // asked to pick a specific generation pair from nothing but two bare code
  // lists and correctly said it couldn't. Real case: checking Mercedes-Benz
  // A-Class against Infiniti Q30 always came back "couldn't confidently
  // match" even though the Infiniti article's own infobox states outright
  // "Related: Infiniti Q30, Mercedes-Benz A-Class (W176), Mercedes-Benz GLA
  // (X156)" -- nothing here had ever gone and read it.
  //
  // Fetches both sides' own digest right when a human clicks "check"
  // (best-effort -- a renamed/offline article just means this contributes
  // nothing, it never blocks or fails the check itself), then:
  //   1. tries the exact same deterministic "nameplate mention immediately
  //      followed by its own real chassis code" match resolvePlatformMention
  //      already uses (see extractExplicitGenCode's own comment) in BOTH
  //      directions -- does A's article name a generation of B, or does B's
  //      article name a generation of A -- since a shared-platform/rebadge
  //      fact is very often only documented on ONE of the two articles.
  //   2. folds whatever real "related"/"platform" field text or cue
  //      paragraph actually mentions the OTHER nameplate's name into a
  //      richer note than whatever was passed in, so even when no explicit
  //      code is found this way, the LLM call right after this still has
  //      real material to reason from instead of nothing.
  function evidenceHaystack(dig) {
    if (!dig) return "";
    return [dig.relatedField, dig.platformField, ...(dig.cues || [])].filter(Boolean).join(" \n ");
  }
  function mentionsNameplate(hay, other) {
    if (!hay) return false;
    const h = hay.toLowerCase();
    return h.includes(String(other.label).toLowerCase()) ||
      (other.make && h.includes(String(other.make).toLowerCase()));
  }
  // Real gap: the note handed to the LLM used to always be the first 500
  // characters of the whole evidence haystack (relatedField + platformField
  // + every cue paragraph joined together), regardless of WHERE in that
  // blob the other nameplate was actually mentioned. On a nameplate with
  // several cue paragraphs (production dates, designer credits, etc.) ahead
  // of the one that actually names the other car, the real mention could
  // sit well past character 500 and never reach the model at all -- no
  // amount of "handle messy formatting yourself" instruction helps if the
  // text in question was never shown to it in the first place. Centers the
  // excerpt on the actual mention instead, so the model always sees the
  // sentence that matters, with real context on both sides of it.
  function excerptAround(hay, other, radius) {
    if (!hay) return null;
    const h = hay.toLowerCase();
    let idx = h.indexOf(String(other.label).toLowerCase());
    if (idx === -1 && other.make) idx = h.indexOf(String(other.make).toLowerCase());
    if (idx === -1) return hay.slice(0, radius * 2);
    const start = Math.max(0, idx - radius);
    const end = Math.min(hay.length, idx + radius);
    return (start > 0 ? "…" : "") + hay.slice(start, end) + (end < hay.length ? "…" : "");
  }
  // Real bug report: checking a relation whose evidence read "It will be
  // built alongside the closely related third-generation Audi Q3" resolved
  // to "Q3 F3" (the SECOND generation, offered codes were 8U/F3/FJ) instead
  // of "Q3 FJ" (the actual THIRD by production year) -- the model treated
  // "third-generation" as a vague hint and pattern-matched a plausible-
  // looking code rather than actually counting to the third position.
  // Ordinal-generation phrasing like this is common enough (and
  // unambiguous enough, given the nameplate's own year-ordered generation
  // list) to resolve deterministically, the same way extractExplicitGenCode
  // already removes the guesswork for an explicit chassis code: find an
  // "Nth generation" phrase, confirm it's actually naming THIS nameplate
  // (not some other one mentioned nearby), then count to the Nth-oldest of
  // its real generations by production year.
  const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  function parseOrdinal(word) {
    const w = String(word).toLowerCase();
    if (ORDINAL_WORDS[w] != null) return ORDINAL_WORDS[w];
    const m = w.match(/^(\d+)(?:st|nd|rd|th)$/);
    return m ? parseInt(m[1], 10) : null;
  }
  const ORDINAL_GEN_RE = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))[\s-]generation\b/gi;
  function findOrdinalGeneration(text, match) {
    if (!text || !match || !match.label) return null;
    const bareLabel = String(match.label).toLowerCase();
    const fullLabel = match.make ? `${match.make} ${match.label}`.toLowerCase() : null;
    const WINDOW = 45; // chars of slop between the ordinal phrase and the nameplate's own name
    let m;
    ORDINAL_GEN_RE.lastIndex = 0;
    while ((m = ORDINAL_GEN_RE.exec(text))) {
      const n = parseOrdinal(m[1]);
      if (!n) continue;
      const nearby = (text.slice(Math.max(0, m.index - WINDOW), m.index) + " " +
        text.slice(m.index + m[0].length, m.index + m[0].length + WINDOW)).toLowerCase();
      if ((fullLabel && nearby.includes(fullLabel)) || nearby.includes(bareLabel)) return n;
    }
    return null;
  }
  // Nth-oldest generation by production year -- null (rather than a guess)
  // if the count can't resolve cleanly: fewer generations than N, or any
  // missing year that would make the chronological order ambiguous.
  function generationByOrdinal(generations, n) {
    if (!n || !generations || generations.length < n) return null;
    if (generations.some(g => g.year == null)) return null;
    const sorted = [...generations].sort((a, b) => a.year - b.year);
    return sorted[n - 1] || null;
  }

  // ---------- is a nameplate's generation list actually current? ----------
  // Real user request: "if the program is checking the relation to another
  // car model which is also a nameplate, it should first verify with the
  // wikipedia of that nameplate to make sure that the generations are in
  // order. Only after the generations are fixed ... then the matches should
  // be continued between Car A and Car B."
  //
  // The failure this prevents is quiet and was visible in the Mazda report:
  // the model is handed a code list, correctly identifies a generation that
  // ISN'T in it, and the whole check dead-ends -- not because the model was
  // wrong, but because the database's idea of that nameplate's generations
  // was out of date. Asking it to pick from a stale list and then blaming the
  // answer is backwards; the list should be brought up to date first.
  //
  // Deterministic on purpose -- no LLM call. It only decides WHETHER the
  // nameplate is worth re-checking; the actual generation discovery is the
  // existing checkNode flow, which app.js runs before it asks for the match.
  const GEN_HEADING_RE = /^(?:[A-Z]{1,3}[0-9]{2,4}[A-Z0-9]*|Mk\.?\s?[0-9IVX]+|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)[\s-]generation)\b/i;
  function generationCodesFromDigest(digest) {
    if (!digest) return [];
    const out = [];
    const push = (raw) => {
      if (!raw) return;
      // A trailing parenthetical is usually decoration ("(1990-2018)") but
      // frequently carries the chassis code too ("(GJ; 2012)", "(W246; 2011)").
      // Strip only the year half; anything left is the part that identifies
      // the generation and must survive.
      let code = String(raw).trim().replace(/\s*\(([^()]*)\)\s*$/, (m, inner) => {
        const kept = inner.replace(/\b(?:c\.?\s*)?(?:1[89]|20)\d{2}\b/g, "")
                          .replace(/present|now/gi, "")
                          .replace(/[;,\u2013\u2014\u2015-]+/g, " ")
                          .replace(/\s+/g, " ").trim();
        return kept ? " (" + kept + ")" : "";
      }).trim();
      if (code && code.length <= 40 && !out.some(c => normCode(c) === normCode(code))) out.push(code);
    };
    for (const h of digest.headings || []) if (GEN_HEADING_RE.test(h.trim())) push(h);
    for (const g of digest.perGenInfoboxes || []) if (g && g.heading) push(g.heading);
    return out;
  }
  // How a Wikipedia heading and a stored generation label say the same thing:
  //   heading  "Third generation (GJ; 2012)"
  //   stored   "Mazda6 (third generation)"   or   "GJ"   or   "Mazda6 GJ"
  // findGenByCode is deliberately strict -- it decides what a MATCH resolves
  // to, where a wrong answer writes a wrong link. Deciding whether the list
  // merely looks stale is a much lower-stakes question, and being strict
  // there produces false alarms that would send perfectly current nameplates
  // off for an unnecessary re-check. So this compares identity tokens: a
  // chassis-style code, or a generation ORDINAL with Mk-numbers and ordinal
  // words folded onto the same scale.
  const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth",
                    "seventh", "eighth", "ninth", "tenth"];
  function generationKeys(s) {
    const raw = stripYearSuffix(s);
    const keys = new Set();
    // A parenthetical is where a bare chassis code most often lives --
    // "Third generation (GJ)", "G-Class (W463)". Read it before flattening,
    // because once punctuation is gone "gg" is indistinguishable from the
    // tail of a word.
    for (const m of String(raw).matchAll(/\(([^()]+)\)/g)) {
      const inner = normCode(m[1]).replace(/[^a-z0-9]/g, "");
      if (/^[a-z]{1,3}\d{2,4}[a-z0-9]*$/.test(inner) || /^[a-z]{2,4}$/.test(inner)) keys.add(inner);
    }
    // Flatten for everything else: normCode keeps single spaces, so an
    // ordinal test against "first generation" has to ignore them.
    const n = normCode(raw).replace(/[^a-z0-9]/g, "");
    ORDINALS.forEach((w, i) => { if (n.includes(w + "generation")) keys.add("ord" + (i + 1)); });
    const mk = n.match(/mk(\d+)/);
    if (mk) keys.add("ord" + parseInt(mk[1], 10));
    const gen = n.match(/generation(\d+)/);
    if (gen) keys.add("ord" + parseInt(gen[1], 10));
    for (const m of n.matchAll(/[a-z]{1,3}\d{2,4}[a-z0-9]*/g)) keys.add(m[0]);
    if (/^[a-z]{2,4}$/.test(n)) keys.add(n);
    return keys;
  }
  function generationCovered(wikiCode, gens) {
    if (findGenByCode(gens, wikiCode)) return true;
    const wk = generationKeys(wikiCode);
    if (!wk.size) return false;
    return (gens || []).some(g => {
      for (const k of generationKeys(g.code)) if (wk.has(k)) return true;
      return false;
    });
  }
  // Returns null when there's nothing to say, or {wikiCodes, missing, ...}.
  // `missing` is what Wikipedia names that our stored generation list has no
  // match for -- run through the same findGenByCode the match itself uses, so
  // a formatting-only difference never counts as a gap.
  async function generationGapFor(info, digestMaybe) {
    if (!info || !info.wp) return null;
    const gens = info.generations || [];
    let digest = digestMaybe;
    if (!digest) {
      const r = await fetchArticleDigest(info.wp).catch(() => null);
      digest = r && r.digest;
    }
    if (!digest) return null;
    const wikiCodes = generationCodesFromDigest(digest);
    if (!wikiCodes.length) return null;
    const missing = wikiCodes.filter(c => !generationCovered(c, gens));
    if (!missing.length) return null;
    return {
      nodeId: info.id, label: (info.make ? info.make + " " : "") + info.label,
      wikiCodes, missing, wikiCount: wikiCodes.length, heldCount: gens.length,
    };
  }

  // ================= transitive relationships =================
  // Real user request: "if car A and car B are related, and car B and car C
  // are related, then car A and C are also related. However, the generations
  // MUST be kept in mind when doing this relationship check with a nameplate
  // of a car."
  //
  // The generation rule falls out of the graph rather than needing its own
  // logic, and it is worth being explicit about why. A waypoint here is a
  // NODE, and a nameplate and each of its generations are different nodes. So
  // "A is related to the Mazda6 nameplate" and "the Mazda6 GJ is related to
  // C" do not chain: they touch two different nodes, and the walk below never
  // steps between them because it only ever follows related/platform edges,
  // never the family->generation edges that would flatten that distinction.
  // Only "A -> Mazda6 GJ" and "Mazda6 GJ -> C" chain, which is exactly the
  // constraint asked for.
  //
  // succession is deliberately NOT transitive. A was replaced by B and B was
  // replaced by C is a chronology, not a statement that A and C are related;
  // treating it as one would link every generation of a long-running
  // nameplate to every other.
  const TRANSITIVE_TYPES = new Set(["related", "platform"]);
  // Server default (serve.py's TRANSITIVE_MAX_HOPS, delivered in __config),
  // overridable from the app's own setting and persisted with everything else
  // in llm_families.json so it survives a reload. Same two-layer shape the
  // cascade depth already uses, plus the override the user asked for.
  let transitiveMaxHopsDefault = (() => {
    const v = bootData.__config && bootData.__config.transitiveMaxHops;
    return Number.isFinite(v) && v >= 0 ? v : 1;
  })();
  function transitiveMaxHops() {
    const v = store.settings && store.settings.transitiveMaxHops;
    return (v === 0 || v) ? v : transitiveMaxHopsDefault;
  }
  function setTransitiveMaxHops(n) {
    n = Math.max(0, Math.min(4, n | 0));
    if (!store.settings) store.settings = {};
    if (store.settings.transitiveMaxHops === n) return n;
    store.settings.transitiveMaxHops = n;
    persist();
    return n;
  }
  const TRANSITIVE_MAX_PROPOSALS = 300;   // a runaway guard, not a design limit

  // Pure function over the graph so it can be reasoned about and tested on
  // its own: no store access, no fetches, no LLM.
  //
  // maxHops is the number of INTERMEDIATE cars allowed. 1 = A-B-C (the
  // default and the only shape most platform families need), 2 = A-B-C-D.
  // 0 turns the whole thing off.
  function inferTransitiveRelations(nodes, links, opts) {
    const maxHops = Math.max(0, Math.min(4, (opts && opts.maxHops) | 0));
    if (!maxHops) return [];
    const cap = (opts && opts.cap) || TRANSITIVE_MAX_PROPOSALS;
    const skip = (opts && opts.skip) || (() => false);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const live = id => { const n = byId.get(id); return n && !n.retired; };

    const adj = new Map();      // id -> [{to, type}]
    const direct = new Set();   // unordered "a|b" for pairs already connected
    for (const l of links) {
      const src = typeof l.source === "object" ? l.source.id : l.source;
      const tgt = typeof l.target === "object" ? l.target.id : l.target;
      if (!live(src) || !live(tgt) || src === tgt) continue;
      // ANY existing edge between two cars means there is nothing to infer --
      // including a succession or generation edge. Proposing "related" for a
      // pair the graph already connects some other way is noise.
      direct.add(src < tgt ? src + "|" + tgt : tgt + "|" + src);
      if (!TRANSITIVE_TYPES.has(l.type)) continue;
      if (!adj.has(src)) adj.set(src, []);
      if (!adj.has(tgt)) adj.set(tgt, []);
      adj.get(src).push({ to: tgt, type: l.type });
      adj.get(tgt).push({ to: src, type: l.type });
    }

    const out = [];
    const seen = new Set();
    for (const startId of adj.keys()) {
      if (out.length >= cap) break;
      // Breadth-first so the SHORTEST chain to any given car is the one
      // reported -- a two-hop explanation for something already reachable in
      // one hop is strictly worse evidence for the same claim.
      let frontier = [{ id: startId, path: [startId], types: [] }];
      const reached = new Set([startId]);
      // maxHops counts INTERMEDIATE cars, so reaching them takes one more
      // edge than that: 1 hop = A-B-C = two edges walked. The waypoints
      // themselves surface at the earlier levels and get filtered out below
      // as already-directly-linked.
      for (let edges = 0; edges < maxHops + 1 && frontier.length; edges++) {
        const next = [];
        for (const cur of frontier) {
          for (const edge of (adj.get(cur.id) || [])) {
            if (reached.has(edge.to)) continue;
            reached.add(edge.to);
            next.push({ id: edge.to, path: cur.path.concat(edge.to), types: cur.types.concat(edge.type) });
          }
        }
        frontier = next;
        for (const cand of frontier) {
          const a = startId, c = cand.id;
          if (a === c) continue;
          const pairKey = a < c ? a + "|" + c : c + "|" + a;
          if (direct.has(pairKey) || seen.has(pairKey)) continue;
          if (skip(a, c)) continue;
          seen.add(pairKey);
          out.push({
            key: "transitive:" + pairKey,
            aId: a, cId: c,
            via: cand.path.slice(1, -1),
            path: cand.path,
            // A chain of shared-platform links is a stronger claim than a
            // chain of loose "related" ones, and the review UI says so.
            relType: cand.types.every(t => t === "platform") ? "platform" : "related",
            linkTypes: cand.types,
            hops: cand.path.length - 2,
          });
          if (out.length >= cap) break;
        }
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  // ---------- proposals, held for review ----------
  // Never applied automatically. An inferred link is a claim the graph's own
  // shape suggests, not something any source actually said -- the same bar
  // every other unquoted answer in this file has to clear, so it goes in
  // front of a human the same way.
  function transitiveEntryFor(key) { return (store.transitive || {})[key] || null; }

  // Real user request: "when ... a car match is asking to be confirmed between
  // two specific cars, where the LLM doesn't quite have enough information to
  // confirm itself and would otherwise ask me to confirm myself. It should
  // also check the transitive relationships and see if it can answer this
  // matching question itself first, before asking me for approval."
  //
  // The question a stuck match is asking is "WHICH generation of A goes with
  // WHICH generation of B". If the graph already connects one specific
  // generation of A to one specific generation of B through a single car in
  // between, that answers it -- and it answers it from links that are already
  // in the graph, not from a fresh guess.
  //
  // Only used when the model could not resolve the pair itself, and only when
  // the answer is UNAMBIGUOUS: exactly one generation of A and one of B are
  // reachable that way. Two candidate pairings means the chain doesn't
  // actually settle the question, so it falls through to asking the user,
  // which is what would have happened anyway.
  function transitiveAnswerFor(infoA, infoB, nodes, links) {
    if (!nodes || !links) return null;
    const gensA = (infoA.generations || []).map(g => g.id);
    const gensB = new Map((infoB.generations || []).map(g => [g.id, g]));
    if (!gensA.length || !gensB.size) return null;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const alive = id => { const n = byId.get(id); return n && !n.retired; };
    const adj = new Map();
    for (const l of links) {
      if (l.retired || !TRANSITIVE_TYPES.has(l.type)) continue;
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      if (!alive(s) || !alive(t)) continue;
      if (!adj.has(s)) adj.set(s, []); if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push(t); adj.get(t).push(s);
    }
    const found = [];
    for (const a of gensA) {
      for (const mid of (adj.get(a) || [])) {
        if (gensB.has(mid)) continue;          // that's a direct link, not a chain
        for (const end of (adj.get(mid) || [])) {
          if (!gensB.has(end)) continue;
          const g = (infoA.generations || []).find(x => x.id === a);
          found.push({ genIdA: a, codeA: g && g.code, genIdB: end,
                       codeB: gensB.get(end).code, viaId: mid,
                       viaLabel: (byId.get(mid) || {}).label || mid });
        }
      }
    }
    if (found.length !== 1) return null;       // ambiguous, or nothing -- ask the user
    return found[0];
  }
  function transitiveProposals(nodes, links) {
    const decided = store.transitive || {};
    const out = inferTransitiveRelations(nodes, links, {
      maxHops: transitiveMaxHops(),
      // A pair the user already said no to must not come back on the next
      // pass, and one already confirmed is a real link now, not a proposal.
      skip: (a, c) => {
        const k = "transitive:" + (a < c ? a + "|" + c : c + "|" + a);
        return !!decided[k];
      },
    });
    return out.map(p => Object.assign({}, p, { status: "provisional" }));
  }
  function confirmTransitive(key, extra) {
    if (!store.transitive) store.transitive = {};
    store.transitive[key] = Object.assign({ status: "confirmed", decidedAt: new Date().toISOString() }, extra || {});
    persist();
    return store.transitive[key];
  }
  function rejectTransitive(key, extra) {
    if (!store.transitive) store.transitive = {};
    store.transitive[key] = Object.assign({ status: "rejected", decidedAt: new Date().toISOString() }, extra || {});
    persist();
    return store.transitive[key];
  }
  function allTransitiveDecisions() { return Object.assign({}, store.transitive || {}); }
  function confirmedTransitive() {
    const out = [];
    for (const k in (store.transitive || {})) {
      const e = store.transitive[k];
      if (e && e.status === "confirmed") out.push(Object.assign({ key: k }, e));
    }
    return out;
  }

  async function gatherRelationEvidence(infoA, infoB) {
    const out = { codeForA: null, codeForB: null, richNote: null, digestA: null, digestB: null };
    const [digA, digB] = await Promise.all([
      infoA.wp ? fetchArticleDigest(infoA.wp).then(r => r.digest).catch(() => null) : Promise.resolve(null),
      infoB.wp ? fetchArticleDigest(infoB.wp).then(r => r.digest).catch(() => null) : Promise.resolve(null),
    ]);
    out.digestA = digA; out.digestB = digB;
    // Reuse the digests just fetched rather than fetching either article a
    // second time -- this is the same check app.js runs BEFORE asking for a
    // match; recording it here is what lets the entry explain itself when a
    // stale list is why nothing resolved.
    const [gapA, gapB] = await Promise.all([
      generationGapFor(infoA, digA).catch(() => null),
      generationGapFor(infoB, digB).catch(() => null),
    ]);
    out.genGapA = gapA; out.genGapB = gapB;
    const hayA = evidenceHaystack(digA), hayB = evidenceHaystack(digB);
    // Does B's own article name a specific generation of A? (and vice versa)
    if (hayB) out.codeForA = extractExplicitGenCode(hayB, { label: infoA.label, make: infoA.make });
    if (hayA) out.codeForB = extractExplicitGenCode(hayA, { label: infoB.label, make: infoB.make });
    // Fallback to ordinal-generation phrasing when no bare chassis code was
    // found alongside the mention -- see findOrdinalGeneration's own
    // comment for the exact bug (Audi Q3 F3 vs FJ / Terramar) this fixes.
    if (!out.codeForA && hayB) {
      const n = findOrdinalGeneration(hayB, { label: infoA.label, make: infoA.make });
      const g = n ? generationByOrdinal(infoA.generations, n) : null;
      if (g) out.codeForA = g.code;
    }
    if (!out.codeForB && hayA) {
      const n = findOrdinalGeneration(hayA, { label: infoB.label, make: infoB.make });
      const g = n ? generationByOrdinal(infoB.generations, n) : null;
      if (g) out.codeForB = g.code;
    }
    const bits = [];
    if (mentionsNameplate(hayA, infoB)) bits.push(`${infoA.make} ${infoA.label}'s own article says: "${excerptAround(hayA, infoB, 500)}"`);
    if (mentionsNameplate(hayB, infoA)) bits.push(`${infoB.make} ${infoB.label}'s own article says: "${excerptAround(hayB, infoA, 500)}"`);
    out.richNote = bits.length ? bits.join(" / ") : null;
    return out;
  }

  // Split out of checkRelation below so the playground (see "manual LLM
  // testing" section near the end of this file) can build and display the
  // EXACT prompt (evidence-enriched note included) a real relation check
  // would send, without calling llama.cpp itself.
  async function buildRelationMaterial(infoA, infoB, relType, note) {
    const evidence = await gatherRelationEvidence(infoA, infoB)
      .catch(() => ({ codeForA: null, codeForB: null, richNote: null }));
    const effectiveNote = evidence.richNote ? (note ? `${note} / ${evidence.richNote}` : evidence.richNote) : note;
    const messages = buildRelationMessages(infoA, infoB, relType, effectiveNote);
    return { evidence, effectiveNote, messages };
  }
  // Real bug report: the system prompt already tells the model "overlapping
  // or adjacent production years alone are NOT sufficient evidence", but a
  // small local model doesn't reliably follow that -- it can still say
  // resolved:true while its OWN stated reason is nothing but "the years
  // line up", never actually citing anything the article explicitly said.
  // When there's no deterministic article evidence to fall back on either,
  // that verdict is exactly the untrustworthy guess the rule exists to
  // block. This is a coarse text sniff, not proof -- it only downgrades
  // (never auto-rejects a genuinely correct match), and any match still has
  // to clear a human's own Yes/No either way -- but it stops a
  // date-alignment-only guess from even being OFFERED as "resolved" in the
  // first place.
  function reasonLooksDateOnly(reason) {
    if (!reason) return false;
    const r = String(reason).toLowerCase();
    const dateHint = /(production year|model year|years?\s+(align|overlap|match|correspond)|same\s+(time\s?frame|period|era)|timeframe)/.test(r);
    if (!dateHint) return false;
    // A reason can say "does NOT explicitly name a generation" -- that
    // literally contains the word "explicitly", but it's disclaiming
    // evidence, not citing it. Treat any such negation right next to a date
    // hint as date-only regardless of what other words appear nearby.
    const negatedExplicit = /(does\s?n[o']?t|do\s?n[o']?t|no\s+explicit|not\s+explicit|isn'?t\s+explicit|without\s+(an?\s+)?explicit|no\s+specific\s+generation)/.test(r);
    if (negatedExplicit) return true;
    // Real gap found once the system prompt was loosened to allow
    // resolved:true from well-established real-world knowledge, not just
    // literal article text (see buildRelationMessages' own comment): a
    // genuinely good knowledge-based reason can still happen to mention
    // "year"/"timeframe" words -- even a model correctly REASSURING the
    // reader it ISN'T a date-overlap guess ("...not merely because their
    // production years overlap, but because this is a well-established
    // platform pairing...") still trips dateHint above on that trailing
    // phrase. Rather than try to regex-parse negation around the date
    // vocabulary itself (fragile), a positive "this is real, named
    // knowledge" signal is treated as enough to override the coarse
    // date-only suspicion on its own, the same way explicitHint already
    // does for a literal quote/infobox-field citation.
    const explicitHint = /(explicitly\s+(names?|states?|mentions?|says?|identifies)|infobox|related field|platform field|chassis code|generation code|states? (that|outright)|clearly (named|states?)|well[- ]established|well[- ]known|widely (known|documented|reported)|documented (fact|pairing|relationship)|shares? (the |its )?(same )?(platform|chassis))/.test(r);
    return !explicitHint;
  }
  // The other half of "let the LLM handle Wikipedia's formatting instead of
  // hard-coding a regex for every new quirk": evidenceQuote is only trusted
  // once it's checked against reality. quoteVerifies confirms the quote is
  // REAL text (not an invented or reworded paraphrase) by requiring it to
  // appear, whitespace-normalized, in the actual note the model was given.
  // quoteBacksCode goes one step further and confirms the quote actually
  // CONTAINS the specific code being claimed -- otherwise a model could
  // quote real-but-irrelevant text ("a subcompact executive car") and claim
  // an unrelated code, technically passing the first check while proving
  // nothing about the code itself.
  function quoteVerifies(quote, note) {
    if (!quote || !note) return false;
    const norm = s => String(s).toLowerCase().replace(/\s+/g, " ").trim();
    const q = norm(quote);
    return q.length > 0 && norm(note).includes(q);
  }
  function quoteBacksCode(quote, code) {
    if (!quote || !code) return false;
    const q = String(quote).toLowerCase();
    // Codes are alphanumeric runs (chassis codes, generation numbers) that
    // can appear in the quote wrapped in different punctuation than the
    // code list itself uses (parens, a trailing word, ...) -- strip
    // anything that isn't alphanumeric off the ends of the claimed code
    // before checking, rather than requiring an exact substring match of
    // the whole (possibly nameplate-prefixed) code string.
    const c = String(code).toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    return c.length > 0 && q.includes(c);
  }
  // Pure -- no fetch, no persistence -- so both the live checkRelation flow
  // below and the playground's preview/apply can share the exact same
  // resolution logic with zero risk of the two drifting apart.
  // ---------- deterministic ordinal resolution against the NOTE, not just each article ----------
  // gatherRelationEvidence already runs findOrdinalGeneration over each
  // side's own article haystack -- but the note the model actually reasons
  // from (effectiveNote) is a merged, excerpted view of BOTH sides, plus
  // whatever the caller passed in, and an ordinal can easily live only
  // there. Real bug report (Scion FR-S <-> Subaru BRZ): the note said
  // outright that the two were "jointly developed" and that "the
  // first-generation model" is the one marketed as the Scion FR-S; the model
  // read that correctly, said resolved:true, named FR-S ZN6/ZC6 and BRZ
  // ZN6/ZC6, and explained exactly why -- and it STILL landed in the review
  // queue, because it gave no literal evidenceQuote, so `llmVerified` was
  // false and `resolvedByEvidence` had nothing from either article's own
  // extraction pass. "In this case, it's obvious that the LLM should have
  // already validated this without telling me."
  //
  // This closes that gap without loosening the evidence bar: an "Nth
  // generation" phrase sitting next to a nameplate's own name in the real
  // note text, counted against that nameplate's real year-ordered generation
  // list, is exactly as deterministic as the chassis-code extraction already
  // treated as proof -- it's read out of source text by code, not asserted
  // by the model. A note with no ordinal, or an ordinal that doesn't resolve
  // cleanly (missing years, fewer generations than N), still yields nothing
  // and the entry falls through to ordinary provisional review as before.
  function ordinalCodeFromNote(note, info) {
    if (!note || !info || info.generations.length < 2) return null;
    const n = findOrdinalGeneration(note, { label: info.label, make: info.make });
    if (!n) return null;
    const g = generationByOrdinal(info.generations, n);
    return g ? g.code : null;
  }
  // ---------- salvaging a refusal that states its own answer ----------
  // Two real reports, same shape. The model returned resolved:false, codeA:
  // null, codeB: null -- and then explained the answer in its own reason:
  //
  //   "...confirms it uses the Volkswagen Group MQB Evo platform, which is
  //    also the platform for the current-generation Tiguan (Tiguan AD1/AX1).
  //    However, the note does not explicitly state that..."
  //
  //   "While real-world knowledge confirms the 2006 Concept A was the design
  //    precursor to the first-generation Tiguan (5N), the input constraints
  //    require that..."
  //
  // Andy: "if it's confident about sharing a platform... it doesn't need to
  // make this request to the user", and "since it says 'real-world knowledge
  // confirms...', that should be enough information to automatically confirm
  // this relationship on the spot."
  //
  // The existing knowledgeBacked tier can't help: it requires raw.resolved,
  // and these are refusals. So this reads the answer back out of the refusal.
  // Two safety properties make that sound rather than reckless:
  //
  //   1. It can only ever pick a code that is ALREADY IN the generation list
  //      we handed the model. It cannot invent one, and it cannot pick a
  //      generation of some third car.
  //   2. It ignores any mention sitting in a NEGATED clause. This matters
  //      enormously and is not theoretical -- the first reason above names
  //      "Tiguan AD1/AX1" twice, once as the answer and once inside "the note
  //      does not explicitly state that the Tiguan AD1/AX1 is...", and names
  //      5N and CT1 only inside "nor does it mention...". A naive substring
  //      scan would resolve to whichever it hit first.
  // Real user request, on an Acura Legend <-> Acura RL KA9 succession verdict
  // that was queued for approval instead of applied: "The RL KA9 article
  // explicitly states that the first-generation RL replaced the
  // second-generation Acura Legend... the relationship applies to the Second
  // generation of the Legend, which corresponds to the code 'Acura Legend
  // Second generation (1991) (1990-1995)'. The RL KA9 code matches the
  // specific generation named in the text as the successor." -- "In this case,
  // this should be sufficient information for the program to automatically
  // approve this relationship. I shouldn't have to approve it myself."
  //
  // That reason cleared none of the existing auto-confirm tiers, and each miss
  // was legitimate on its own terms: there was no chassis code in either
  // article for the deterministic extractor to find (the RL article says
  // "second-generation Acura Legend" in prose, not "KA7"), the model supplied
  // no literal evidenceQuote for llmVerified to check, and its wording cites
  // the ARTICLE rather than world knowledge so KNOWLEDGE_LANGUAGE_RE didn't
  // fire either. What it does have is the thing all three tiers are really
  // proxies for: it attributes the claim to one of the two source articles,
  // and it names a generation that genuinely exists in the code list it was
  // given. This regex is the first half of that test.
  const SOURCE_ATTRIBUTION_RE = /\b(?:the\s+)?(?:\w+\s+){0,3}(?:article|page|passage|source text|wikipedia|infobox)\b[^.;]{0,80}?\b(?:explicitly\s+|directly\s+|specifically\s+)?(?:states?|said|says?|notes?|mentions?|describes?|confirms?|indicates?|identifies|lists?|names?|refers? to)\b|\b(?:explicitly|directly|specifically)\s+(?:states?|says?|names?|mentions?|identifies|lists?)\b|\b(?:as|which is)\s+(?:stated|named|listed|described|mentioned)\s+in\b|\baccording to the\b|\bnamed in the text\b/i;
  const KNOWLEDGE_LANGUAGE_RE = /\b(real[- ]world knowledge|automotive knowledge|well[- ]established|well[- ]documented|well[- ]known|widely (?:known|documented|reported)|documented (?:fact|pairing|relationship)|knowledge (?:confirms|links|establishes)|it is (?:a )?(?:known|documented) fact)\b/i;
  // A clause is disqualified if it disclaims rather than asserts. Checked
  // against the text between the previous clause boundary and the mention.
  const CLAUSE_NEGATION_RE = /\b(no|nor|not|n't|never|without|lacks?|lacking|fails?|failing|unable|cannot|can't|insufficient|does\s?n[o']?t|do\s?n[o']?t|is\s?n[o']?t|are\s?n[o']?t|rather than|instead of)\b/i;
  // Everything that can end one clause and begin another. Commas included
  // deliberately: "…the current-generation Tiguan (Tiguan AD1/AX1). However,
  // the note does not explicitly state that the Tiguan AD1/AX1…" only
  // separates cleanly if a comma counts as a boundary.
  const CLAUSE_BOUNDARY_RE = /[.;:,]|\b(?:however|but|although|though|while|whereas|since|because)\b/gi;
  function clauseBefore(text, index) {
    let start = 0;
    CLAUSE_BOUNDARY_RE.lastIndex = 0;
    let m;
    while ((m = CLAUSE_BOUNDARY_RE.exec(text))) {
      if (m.index >= index) break;
      start = m.index + m[0].length;
    }
    return text.slice(start, index);
  }
  // Returns the code of a generation of `info` that the reason ASSERTS, or
  // null. Longest match wins, so "Tiguan AD1/AX1" is preferred over a bare
  // "AD1" that happens to also be a listed code.
  function assertedCodeInReason(reason, info) {
    if (!reason || !info || !Array.isArray(info.generations)) return null;
    const hay = String(reason);
    const low = hay.toLowerCase();
    // Prose doesn't quote a code list verbatim. A generation stored as
    // "Tiguan 5N" gets written "the first-generation Tiguan (5N)", so the bare
    // distinctive part has to be searchable too -- exactly the same tolerance
    // findGenByCode already applies to the model's own codeA/codeB. Guarded so
    // a short generic fragment can't match random prose: a bare suffix only
    // counts if it carries a digit, or is at least three characters.
    const needlesFor = code => {
      const out = [code];
      const label = String(info.label || "");
      if (label && code.toLowerCase().startsWith(label.toLowerCase() + " ")) {
        const bare = code.slice(label.length + 1).trim();
        if (bare.length >= 2 && (/[0-9]/.test(bare) || bare.length >= 3)) out.push(bare);
      }
      return out;
    };
    const cands = info.generations
      .map(g => ({ g, code: String(g.code || "") }))
      .filter(c => c.code.length >= 2)
      // Longest first, so "Tiguan AD1/AX1" is preferred over a bare "AD1".
      .sort((a, b) => b.code.length - a.code.length);
    for (const c of cands) {
      for (const needleRaw of needlesFor(c.code)) {
        const needle = needleRaw.toLowerCase();
        let from = 0, at;
        while ((at = low.indexOf(needle, from)) >= 0) {
          from = at + needle.length;
          // Must be a whole token, not a fragment of a longer word/code.
          const before = at > 0 ? hay[at - 1] : " ";
          const after = at + needle.length < hay.length ? hay[at + needle.length] : " ";
          if (/[a-z0-9]/i.test(before) || /[a-z0-9]/i.test(after)) continue;
          if (CLAUSE_NEGATION_RE.test(clauseBefore(hay, at))) continue;   // disclaimed, not asserted
          return c.code;
        }
      }
    }
    return null;
  }
  function computeRelationEntry(infoA, infoB, relType, effectiveNote, evidence, raw) {
    // Used ONLY to corroborate an answer, never to produce one -- see
    // `ordinalBacked` below for exactly why that distinction is load-bearing.
    const ordA = ordinalCodeFromNote(effectiveNote, infoA);
    const ordB = ordinalCodeFromNote(effectiveNote, infoB);
    // When one side has only a single possible "generation" -- a plain,
    // not-yet-split model, or an already-specific generation of some
    // OTHER family, standing in for itself (see app.js's
    // relationGenInfo) -- there's nothing to disambiguate on that side;
    // accept it outright rather than requiring a small local model to
    // pick from a list of one. An explicit code found directly in
    // either article (evidence.codeForA/B) is checked BEFORE the LLM's
    // own answer -- it's Wikipedia's own stated text, not a guess, so
    // it takes priority the same way an exact match already does in
    // resolvePlatformMention above.
    // See assertedCodeInReason's comment: when the model refused but its own
    // reason states the answer in knowledge terms, read the answer back out.
    // Only consulted as a last resort, after real article evidence and after
    // the model's own explicit codeA/codeB.
    const reasonRaw = String((raw && raw.reason) || "");
    const knowledgeLanguage = KNOWLEDGE_LANGUAGE_RE.test(reasonRaw);
    const salvagedA = knowledgeLanguage ? assertedCodeInReason(reasonRaw, infoA) : null;
    const salvagedB = knowledgeLanguage ? assertedCodeInReason(reasonRaw, infoB) : null;
    const genA = infoA.generations.length === 1 ? infoA.generations[0]
      : findGenByCode(infoA.generations, evidence.codeForA) || (raw ? findGenByCode(infoA.generations, raw.codeA) : null)
        || findGenByCode(infoA.generations, salvagedA);
    const genB = infoB.generations.length === 1 ? infoB.generations[0]
      : findGenByCode(infoB.generations, evidence.codeForB) || (raw ? findGenByCode(infoB.generations, raw.codeB) : null)
        || findGenByCode(infoB.generations, salvagedB);
    // True only when the salvage is what actually produced an answer -- i.e.
    // the model itself resolved nothing. Used below to let a stated-but-
    // refused answer resolve and auto-confirm on its own.
    //
    // ...unless the reasoning conflates a platform with its own variant. Real
    // user instruction, in capitals: "THERE IS A DIFFERENCE BETWEEN MQB AND
    // MQB EVO PLATFORMS, so make sure to be explicit about the platform names
    // when doing the matching." A reason that names BOTH a base platform and
    // a qualified version of that same base ("MQB" and "MQB Evo") is either
    // treating them as interchangeable -- which is the error Andy is warning
    // about -- or drawing a distinction subtle enough to be worth a human
    // glance. Either way it doesn't get to skip review. Two genuinely
    // DIFFERENT platforms in one reason ("MQB Evo" and "PQ35") are fine and
    // common, so this deliberately only fires on the base/variant pair.
    const conflatesPlatformVariants = (() => {
      const names = new Set();
      const re = /\b([A-Z][A-Z0-9]{1,7})(?:[ -](Evo|EVO|Plus|PLUS|A0|[A-Z][0-9]{1,2}|II|III))?\s*platform\b/g;
      let m;
      while ((m = re.exec(reasonRaw))) names.add(m[1].toUpperCase() + (m[2] ? " " + m[2].toUpperCase() : ""));
      for (const a of names) for (const b of names) {
        if (a !== b && (b.startsWith(a + " ") || a.startsWith(b + " "))) return true;
      }
      return false;
    })();
    const knowledgeSalvaged = !(raw && raw.resolved) && !!(salvagedA || salvagedB) &&
      !conflatesPlatformVariants;
    // ---------- the model cited the article, and named a real generation ----------
    // Second half of the SOURCE_ATTRIBUTION_RE test above. Held to exactly the
    // same standard as the knowledge salvage directly above it, and for the
    // same reason -- the danger with any "trust the prose" tier is a model
    // that waves at evidence it doesn't have, so the code it points to has to
    // come out of the list we handed it, in a clause it ASSERTS rather than
    // disclaims (that's assertedCodeInReason's whole job), and a bare
    // year-overlap guess is still vetoed however it's dressed up. The one
    // difference from the salvage is which verdict it applies to: the salvage
    // rescues a resolved:false that stated the answer anyway, this one
    // promotes a resolved:true whose justification is a real citation.
    const sourceAttributed = SOURCE_ATTRIBUTION_RE.test(reasonRaw);
    const citedA = sourceAttributed ? assertedCodeInReason(reasonRaw, infoA) : null;
    const citedB = sourceAttributed ? assertedCodeInReason(reasonRaw, infoB) : null;
    // Three-tier fallback, matching how confidently the relationship
    // could actually be pinned down: generation<->generation is best;
    // failing that, pin down whichever ONE side resolved and connect it
    // straight to the OTHER nameplate as a whole (still strictly more
    // specific than nothing); if NEITHER side resolved, there's nothing
    // new to add -- the existing nameplate<->nameplate connection (see
    // app.js's indexMirrorReplacements) is left exactly as informative
    // as it already was, nothing changes. `resolvedByEvidence` lets a
    // deterministic article-text match count as "resolved" on its own,
    // independent of whatever the LLM itself concluded -- a small local
    // model saying resolved:false doesn't get to overrule Wikipedia's
    // own explicit text.
    const resolvedByEvidence = !!(evidence.codeForA || evidence.codeForB);
    // ---------- ordinal corroboration (the Scion FR-S <-> Subaru BRZ case) ----------
    // An "Nth generation" phrase sitting next to a nameplate's own name in
    // the source text, counted against that nameplate's real year-ordered
    // generation list, is read out of the text deterministically -- exactly
    // as trustworthy as the chassis-code extraction gatherRelationEvidence
    // already treats as proof. What it is NOT is a way to pick an answer on
    // its own, and the difference matters: `effectiveNote` is a merged
    // excerpt of BOTH articles, and a nameplate's own article naturally
    // describes all of its own generations in ordinal terms ("the second
    // generation was introduced in..."). Letting that pick a generation
    // outright would mean an article's own internal prose could override the
    // actual cross-referenced evidence about the RELATIONSHIP -- an early
    // version of this did exactly that and silently re-pointed a
    // correctly-resolved Mercedes CLA match at the wrong generation.
    //
    // So it's only ever used to AGREE. When the ordinal resolves to the same
    // generation the answer already landed on, that's independent textual
    // corroboration and earns the same auto-confirm an explicit code would;
    // when it disagrees, or resolves nothing, it changes nothing at all.
    // That's what fixes the reported case -- "it's obvious that the LLM
    // should have already validated this without telling me" for a match
    // whose note said outright that the first-generation model is the one
    // marketed as the Scion FR-S -- without giving ordinals any power to
    // decide anything by themselves.
    // "Let the LLM handle Wikipedia's formatting itself" -- see
    // buildRelationMessages' own comment on evidenceQuote. A resolved:true
    // verdict backed by a quote that's (a) genuinely real text copied from
    // the note and (b) actually contains the specific code it's claiming is
    // doing the same "find the real code despite messy formatting" job the
    // regex-based extraction does, just handling variety a fixed pattern
    // can't -- and it's checked against reality the same way, so it earns
    // the same trust level. Checked against whichever side(s) a code was
    // actually claimed for.
    const quoteReal = !!(raw && raw.evidenceQuote && quoteVerifies(raw.evidenceQuote, effectiveNote));
    const llmVerified = !!(raw && raw.resolved) && quoteReal &&
      ((raw.codeA && quoteBacksCode(raw.evidenceQuote, raw.codeA)) || (raw.codeB && quoteBacksCode(raw.evidenceQuote, raw.codeB)));
    // Only distrust the LLM's own "resolved:true" when there's NO
    // deterministic evidence AND no verified quote to fall back on, AND its
    // own stated reason reads like a bare date-overlap guess -- see
    // reasonLooksDateOnly's own comment above. When resolvedByEvidence or
    // llmVerified is already true, this never matters (genuine evidence
    // already won).
    const ordinalBacked = !!((ordA && genA && normCode(ordA) === normCode(genA.code)) ||
                             (ordB && genB && normCode(ordB) === normCode(genB.code)));
    // Everywhere "the source text itself backs this up" is asked below,
    // deterministic article-code extraction and ordinal corroboration count
    // equally -- both are read out of real text by code, neither is the
    // model's own assertion.
    const textBacked = resolvedByEvidence || ordinalBacked;
    const llmResolved = !!(raw && raw.resolved) && !(!textBacked && !llmVerified && reasonLooksDateOnly(raw.reason));
    // ---------- confident, concretely-named real-world knowledge ----------
    // Real user request, on a Ford Fusion / Mazda6 verdict: the model wrote
    // "While it is a well-established fact that the Ford Fusion (First Gen)
    // and Mazda6 (First Gen) share the CD3 platform..." and still returned
    // resolved:false, because the code list had no distinct "first
    // generation" entry to point at. "This means that it should automatically
    // accept this information if it knows it to be true. This example (and
    // others similar) should also be passing as automatic approval."
    //
    // The prompt now tells it not to refuse on those grounds (see
    // buildRelationMessages). This is the trust half: a reason that NAMES a
    // concrete fact -- a specific platform/chassis code, or explicit
    // well-established/well-documented language about this exact pairing --
    // counts as evidence in its own right, so the match auto-confirms rather
    // than queueing for review. Deliberately narrow: a named code or an
    // explicit "well-established"-class phrase is required, so a vague "these
    // seem related" still doesn't qualify, and reasonLooksDateOnly still
    // vetoes a bare year-overlap guess however confidently it's phrased.
    //
    // A platform name can carry a qualifier, and the qualifier is part of the
    // name: real user instruction, "THERE IS A DIFFERENCE BETWEEN MQB AND MQB
    // EVO PLATFORMS, so make sure to be explicit about the platform names when
    // doing the matching." So the capture deliberately extends over a trailing
    // qualifier ("MQB Evo", "MLB Evo", "MQB A0", "PQ35 Plus") rather than
    // stopping at the all-caps token -- otherwise "MQB Evo platform" wouldn't
    // even be recognised as naming a platform, which is what let the Cupra
    // Terramar verdict fall through.
    const NAMED_PLATFORM_RE = /\b([A-Z][A-Z0-9]{1,7}(?:[ -](?:Evo|EVO|Plus|PLUS|[A-Z][0-9]{1,2}|II|III|2|3))?)\s+platform\b|\bplatform\s+(?:code\s+)?["']?([A-Z][A-Z0-9]{1,7})["']?/;
    const reasonText = String((raw && raw.reason) || "");
    const knowledgeBacked = !!(raw && raw.resolved) &&
      !reasonLooksDateOnly(reasonText) &&
      (NAMED_PLATFORM_RE.test(reasonText) || KNOWLEDGE_LANGUAGE_RE.test(reasonText));
    // knowledgeSalvaged joins resolvedByEvidence/llmResolved as a third way an
    // answer can exist at all. Deliberately NOT gated on reasonLooksDateOnly:
    // that heuristic reads the reason as a whole, and a salvaged reason is by
    // definition a refusal, so it is full of the disclaiming language the
    // heuristic keys on ("does not explicitly state", "guessing from years
    // alone... is forbidden"). The salvage does its own, sharper safety check
    // per mention -- see assertedCodeInReason's clause-negation rule.
    const answerExists = resolvedByEvidence || llmResolved || knowledgeSalvaged;
    let mode = "none", finalGenA = null, finalGenB = null;
    if (answerExists && genA && genB) {
      mode = "generation"; finalGenA = genA; finalGenB = genB;
    } else if (answerExists && genA) {
      mode = "nameplate"; finalGenA = genA; finalGenB = { id: infoB.id, code: infoB.label };
    } else if (answerExists && genB) {
      mode = "nameplate"; finalGenA = { id: infoA.id, code: infoA.label }; finalGenB = genB;
    }
    const resolved = mode !== "none";
    // Real user request: once a match is grounded in an explicit chassis/
    // generation code actually found in one of the two articles' own text
    // (not a guess), asking for a Yes/No click on top of that is just
    // friction -- the same trust level resolvePlatformMention's own
    // automatic exact-match tier already gets (see its own comment: "an
    // EXACT match... is trustworthy enough to apply immediately"). Skips
    // straight to "confirmed" -- app.js wires the real link in immediately,
    // no click needed -- while an LLM-only resolution (no deterministic
    // evidence backing it) still goes through "provisional" review as
    // before, since that one really is just a guess worth double-checking.
    // Real user request: once a match is grounded in an explicit chassis/
    // generation code actually found in one of the two articles' own text
    // (not a guess), asking for a Yes/No click on top of that is just
    // friction -- the same trust level resolvePlatformMention's own
    // automatic exact-match tier already gets (see its own comment: "an
    // EXACT match... is trustworthy enough to apply immediately"). A
    // verified LLM quote earns the exact same trust, for the exact same
    // reason (it's real, checked source text, not a guess) -- skips
    // straight to "confirmed" either way, app.js wires the real link in
    // immediately with no click needed. An LLM-only resolution with no
    // verifiable quote behind it still goes through "provisional" review as
    // before, since that one really is just a guess worth double-checking.
    // knowledgeBacked joins the two existing auto-confirm tiers -- see its own
    // comment for the Ford Fusion / Mazda6 CD3 case it exists for.
    // knowledgeSalvaged auto-confirms for the same reason knowledgeBacked
    // does, and with a stricter provenance: the code it resolved to came out
    // of the list we supplied, in a clause the model asserted rather than
    // disclaimed. "It doesn't need to make this request to the user."
    // Only counts when the cited code is one the match actually landed on --
    // a reason that cites the article about some OTHER generation than the one
    // being confirmed is not evidence for this pairing.
    // ...and never from a model that has already been caught inventing evidence
    // in this same answer. If it supplied an evidenceQuote and that quote does
    // not appear in the real article, its prose attribution ("the article
    // explicitly names...") is exactly as trustworthy as the quote was --
    // which is to say, not. A fabricated quote is positive evidence against
    // the citation, not merely the absence of evidence for it.
    const quoteFabricated = !!(raw && raw.evidenceQuote) && !quoteReal;
    const citationBacked = !!(raw && raw.resolved) && sourceAttributed && !conflatesPlatformVariants &&
      !quoteFabricated && !reasonLooksDateOnly(reasonText) &&
      ((citedA && finalGenA && normCode(citedA) === normCode(finalGenA.code)) ||
       (citedB && finalGenB && normCode(citedB) === normCode(finalGenB.code)));
    const autoConfirmed = resolved && (textBacked || llmVerified || knowledgeBacked || knowledgeSalvaged || citationBacked);
    return {
      status: resolved ? (autoConfirmed ? "confirmed" : "provisional") : "none",
      checkedAt: new Date().toISOString(),
      decidedAt: autoConfirmed ? new Date().toISOString() : undefined,
      autoConfirmed: autoConfirmed || undefined,
      famA: infoA.id, famB: infoB.id, relType, note: effectiveNote || null,
      matchLevel: resolved ? mode : null,
      codeA: resolved ? finalGenA.code : null, codeB: resolved ? finalGenB.code : null,
      genIdA: resolved ? finalGenA.id : null, genIdB: resolved ? finalGenB.id : null,
      // Real user report: when the deterministic evidence path already won,
      // still appending the LLM's own separate (and sometimes flatly wrong
      // -- e.g. a date-overlap guess the system prompt explicitly forbids)
      // reasoning verbatim as "(LLM separately said: ...)" reads as if that
      // reasoning is what decided the match, even though it's just along
      // for the ride and was never used for anything. Now only shown when
      // it doesn't contradict the real reason, so it can't undermine
      // confidence in a match that was actually correct. A verified quote
      // gets its own distinct credit -- it's the actual basis for the
      // match, not just color commentary.
      reason: textBacked
        ? (resolvedByEvidence
            ? `matched from an explicit chassis/generation code found directly in one of the two Wikipedia articles' own text`
            : `matched from an explicit "Nth generation" statement in the source text, counted against the nameplate's own year-ordered generation list, which independently agrees with the LLM's own answer`) +
          ((raw && raw.resolved && raw.reason && !reasonLooksDateOnly(raw.reason)) ? ` (the LLM separately agreed: ${raw.reason})` : "")
        : llmVerified
        ? `matched by the LLM from a quoted passage it found in the article text, verified against the real source: "${raw.evidenceQuote}"`
        : citationBacked
        ? `auto-approved: the model attributed this to one of the two Wikipedia articles and named ` +
          [citedA && `${infoA.make} ${infoA.label} → ${citedA}`,
           citedB && `${infoB.make} ${infoB.label} → ${citedB}`].filter(Boolean).join(" and ") +
          `, which is a generation from that car's own real code list, in an asserted (not disclaimed) clause: ${reasonText}`
        : knowledgeBacked
        ? `auto-approved from concretely-named, well-established knowledge -- no literal quote, but a specific fact is named rather than a vague similarity: ${reasonText}`
        : knowledgeSalvaged
        // Spelled out because this is the one path where the record disagrees
        // with the model's own verdict field, and anyone reading it later
        // deserves to see exactly why rather than wondering how a
        // resolved:false became a confirmed match.
        ? `auto-approved from stated real-world knowledge: the model answered "unresolved" but named ` +
          [salvagedA && `${infoA.make} ${infoA.label} → ${salvagedA}`,
           salvagedB && `${infoB.make} ${infoB.label} → ${salvagedB}`].filter(Boolean).join(" and ") +
          ` as fact in its own reasoning, in an asserted (not disclaimed) clause, and the code is one of the generations it was given: ${reasonText}`
        : (raw && raw.reason) || null,
      // What the model actually said, the article evidence gathered
      // just above (or why none was found), plus the exact code lists
      // it had to choose from -- lets "see what it said" show WHY a
      // "none" happened instead of just the bare verdict.
      debug: {
        raw, evidenceCodeForA: evidence.codeForA, evidenceCodeForB: evidence.codeForB,
        ordinalFromNoteA: ordA || null, ordinalFromNoteB: ordB || null, ordinalBacked,
        evidenceQuote: raw && raw.evidenceQuote, quoteVerified: quoteReal, llmVerified, knowledgeBacked,
        sourceAttributed, citedA, citedB, citationBacked, quoteFabricated,
        fetchedArticleA: !!evidence.digestA, fetchedArticleB: !!evidence.digestB,
        availableCodesA: infoA.generations.map(g => g.code), availableCodesB: infoB.generations.map(g => g.code),
      },
    };
  }
  // infoA/infoB shape: {id, make, label, wp, generations: [{id, code, year, end}, ...]}
  function checkRelation(key, infoA, infoB, relType, note, graph) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    const existing = relationEntryFor(key);
    if (existing) return Promise.resolve(existing);
    if (relationInFlight.has(key)) return relationInFlight.get(key);
    const p = (async () => {
      try {
        const { evidence, effectiveNote, messages } = await buildRelationMaterial(infoA, infoB, relType, note);
        // ---------- don't spend a call on a pair with literally nothing to reason from ----------
        // Real bug report (Pontiac G5 <-> Marcos TSO): the model was asked to
        // resolve a specific generation pair with no note, no shared article
        // text, and no explicit code found in either article -- and correctly
        // answered "No source text note was provided... Relying solely on the
        // overlapping production years is explicitly forbidden." That verdict
        // was never in doubt: buildRelationMessages' own last rule already
        // says "if there is no note, no ordinal/count you can align, and no
        // specific factual knowledge, return resolved:false", and
        // computeRelationEntry can't reach anything but "none" from a
        // resolved:false with no evidence codes either. Sending it anyway
        // burns a full llama.cpp round trip (and a slot other checks are
        // queueing for) to be told what's already known. Short-circuit
        // straight to the same "none" entry the call would have produced.
        // Deliberately checks effectiveNote (the evidence-enriched note),
        // not the caller's raw `note` -- a user's own retry feedback, or a
        // real mention found in either article, both land there and both
        // keep the check running exactly as before.
        if (!effectiveNote && !evidence.codeForA && !evidence.codeForB) {
          const skipped = {
            status: "none", checkedAt: new Date().toISOString(),
            famA: infoA.id, famB: infoB.id, relType, note: null,
            matchLevel: null, codeA: null, codeB: null, genIdA: null, genIdB: null,
            reason: "skipped without asking the LLM -- neither article mentions the other car, no chassis/generation code was found in either one, and no note was supplied, so there is nothing to resolve a specific generation pair from (production-year overlap alone is never sufficient evidence). Retry with a hint if you know which generations this is really about.",
            noEvidence: true,
            debug: {
              raw: null, evidenceCodeForA: null, evidenceCodeForB: null,
              skippedForLackOfEvidence: true,
              fetchedArticleA: !!evidence.digestA, fetchedArticleB: !!evidence.digestB,
              availableCodesA: infoA.generations.map(g => g.code), availableCodesB: infoB.generations.map(g => g.code),
            },
          };
          if (!store.relations) store.relations = {};
          store.relations[key] = skipped;
          await persist();
          return skipped;
        }
        const raw = await askLlamaCpp(messages,
          `${infoA.make} ${infoA.label} ↔ ${infoB.make} ${infoB.label} · ${relType}`);
        let entry = computeRelationEntry(infoA, infoB, relType, effectiveNote, evidence, raw);
        // The model couldn't pin the pair down and this would land in front of
        // the user. Before it does, see whether the graph already answers it.
        if (entry && !entry.matchLevel && graph) {
          const t = transitiveAnswerFor(infoA, infoB, graph.nodes, graph.links);
          if (t) {
            entry = Object.assign({}, entry, {
              status: "provisional", matchLevel: "transitive",
              codeA: t.codeA, codeB: t.codeB, genIdA: t.genIdA, genIdB: t.genIdB,
              reason: `Answered from connections already in the graph: ${t.codeA} is connected to ` +
                      `${t.viaLabel}, which is connected to ${t.codeB}. That is the only such pairing ` +
                      `between these two, so it settles which generations this is about. ` +
                      `(The model itself could not tell: ${entry.reason || "no reason given"})`,
              transitiveVia: t.viaId,
            });
          }
        }
        if (!store.relations) store.relations = {};
        store.relations[key] = entry;
        await persist();
        return entry;
      } catch (e) {
        const entry = { status: "error", checkedAt: new Date().toISOString(), error: String(e.message || e) };
        if (!store.relations) store.relations = {};
        store.relations[key] = entry;
        return entry;
      } finally {
        relationInFlight.delete(key);
      }
    })();
    relationInFlight.set(key, p);
    return p;
  }
  function confirmRelation(key) {
    const e = relationEntryFor(key); if (!e || e.status !== "provisional") return;
    e.status = "confirmed"; e.decidedAt = new Date().toISOString();
    persist();
  }
  // ---------- dismissed LLM messages (persisted -- see store.dismissed's own comment) ----------
  function isDismissed(key) { return !!store.dismissed[key]; }
  function dismiss(key) {
    if (store.dismissed[key]) return; // already recorded, no need to re-persist
    store.dismissed[key] = true;
    persist();
  }
  // Bulk variant for the debug panel's "Clear all positive messages" button
  // -- sets every key and fires exactly ONE persist() call for the whole
  // batch, rather than one POST per message (which is what a plain forEach
  // over dismiss() would do).
  function dismissMany(keys) {
    let changed = false;
    keys.forEach(k => { if (!store.dismissed[k]) { store.dismissed[k] = true; changed = true; } });
    if (changed) persist();
  }
  function allDismissed() { return Object.keys(store.dismissed); }
  // Same "forget it happened, re-checkable later" semantics as rejectNode --
  // saying No here isn't a permanent verdict for the INTERACTIVE
  // checkRelation flow, just "not that one" (reopening the detail panel
  // re-runs checkRelation fresh, since that path never consults
  // rejectedRelations below). But this same function is also what the LLM
  // Debug panel's delete button calls for ANY relation entry -- including
  // one resolvePlatformMention discovered and auto-proposed with no human
  // ever asking for it. Deleting only from store.relations wasn't enough
  // for that case: applyConfirmed() re-runs resolvePlatformMention on
  // every boot for every confirmed family, and its only guard against
  // recreating a relation was "does this key already exist" -- gone the
  // instant it's deleted, so the exact same proposal (or, before the fix
  // above, an already-"confirmed" match) silently came right back on the
  // very next reload. Recording the key here too makes deletion permanent
  // for that path while leaving checkRelation's own re-checkable semantics
  // untouched. Async and awaits persist() (previously fired-and-forgot) so
  // a caller that reloads the page right after -- the debug panel's
  // individual relation delete -- can actually wait for the write to
  // finish first instead of racing it.
  // `opts.keepCoarse` opts out of the nameplate-level blacklisting just
  // below. Used by exactly one caller -- app.js's wireRelationRetry, whose
  // "reject then immediately re-check with the user's feedback" is a
  // deliberate *forget it and try again*, not a rejection of the underlying
  // connection. Blacklisting the coarse key there would quietly delete the
  // very link the retry is trying to resolve, which is the opposite of what
  // typing a hint and pressing Retry means.
  async function rejectRelation(key, opts) {
    const e = store.relations && store.relations[key];
    if (store.relations) delete store.relations[key];
    store.rejectedRelations[key] = true;
    if (opts && opts.keepCoarse) { await persist(); return; }
    // Real bug report (Ford Focus <-> VW Jetta): deleting a relation removed
    // its entry, but the connection was still right there in the graph on the
    // next reload. Two separate things carry a relationship: the store entry
    // keyed by the two SPECIFIC generations, and the coarse nameplate-level
    // `platform` link resolveOnePlatformMention pushes when it can't pin the
    // generation down. Blacklisting only the specific key left the coarse
    // fallback free to be recreated from scratch on every boot -- so "no"
    // never actually meant no. Record the nameplate-level key too, in every
    // relation type, so declining a pair severs BOTH representations of it.
    if (e && e.famA && e.famB && e.relType) {
      store.rejectedRelations[relKey(e.famA, e.famB, e.relType)] = true;
      // ...and the mirror-image where a side is a plain model standing in
      // for itself (genIdA/genIdB can differ from famA/famB, see
      // resolveOnePlatformMention's targetFamId).
      if (e.genIdA && e.genIdB) store.rejectedRelations[relKey(e.genIdA, e.genIdB, e.relType)] = true;
    }
    await persist();
  }
  // ---------- live graph half of "deleted means deleted" ----------
  // rejectRelation above stops a severed connection from ever being
  // RECREATED, but the copy already sitting in this tab's live `links` array
  // is a separate problem: nothing removed it, so the line kept drawing and
  // the detail panel kept listing it until a full reload. Real user request:
  // "When I delete an entry (whether that's a nameplate or a model or a
  // relationship), it should also reflect that in the graph and information
  // cards as well, thereby reverting them to before the LLM generation."
  //
  // Marks (never splices -- same "never delete, just make invisible"
  // discipline the rest of this file uses, so nothing holding an index into
  // `links` is invalidated mid-frame) every link representing this
  // relationship as retired: the resolved generation<->generation link, the
  // coarse nameplate-level link, and any family-level mirror of either.
  // app.js's linkInLayer()/openDetail() both skip retired links, so this
  // takes effect on the very next draw with no reload. Only ever touches
  // llmDiscovered/llmResolved/mirror links -- a genuine build-time DBpedia
  // fact is left alone, since the user is rejecting the LLM's reading of a
  // relationship, not asserting the underlying harvested data is wrong.
  function severRelationLinks(links, aIds, bIds, relType) {
    const a = new Set(aIds.filter(Boolean)), b = new Set(bIds.filter(Boolean));
    let n = 0;
    links.forEach(l => {
      if (l.retired || l.type !== relType) return;
      if (!l.llmDiscovered && !l.llmResolved && !l.mirror) return;
      const s = idOf(l.source), t = idOf(l.target);
      if (!((a.has(s) && b.has(t)) || (a.has(t) && b.has(s)))) return;
      l.retired = true;
      l.retiredReason = "severed when its LLM-discovered relationship was deleted";
      n++;
    });
    return n;
  }
  // Convenience wrapper used by app.js right after rejectRelation/
  // retractConfirmedRelation: takes the summary entry shape
  // allRelationEntries() hands out (id/famA/famB/relType/genIdA/genIdB) and
  // severs every live link either representation could have produced.
  function severRelationEntryLinks(entry, links) {
    if (!entry || !entry.relType) return 0;
    return severRelationLinks(links,
      [entry.famA, entry.genIdA], [entry.famB, entry.genIdB], entry.relType);
  }

  // ---------- runtime rewiring: apply every confirmed relation resolution ----------
  // Mirrors applyConfirmed's own idempotent, additive style: creates the new
  // generation-to-generation link (never touching/removing the original,
  // less-specific one), and retroactively tags that original link with the
  // SAME mirrorSourceFam/mirrorTargetFam fields build_family_layer.py's
  // mirror_relation_links already uses -- reusing the exact precedence rule
  // from linkInLayer() (hide the less-specific line once that family is
  // expanded) instead of inventing a second mechanism. Per spec, the
  // original model/family-level connection is NEVER deleted, only ever
  // superseded-when-visible.
  // l.source/l.target start out as plain id STRINGS but d3-force's link
  // force (via app.js's buildSim(), which has already run at least once by
  // the time this can be called at runtime, e.g. from applyRelationConfirm/
  // applySharedPlatformLive) mutates them into direct NODE OBJECT
  // references the moment the simulation first initializes -- the same
  // gotcha app.js's applyFamilyOverrideConfirm already documents and
  // guards against ("the whole screen goes blank" bug). The `orig` lookup
  // below used to compare l.source/l.target against famA.id/famB.id with
  // plain ===, which silently NEVER matched anything once the sim had run
  // once -- meaning the original, coarser connection never got tagged
  // `mirror: true` after the first live confirm in a session, so both the
  // old nameplate-wide link AND the new specific generation<->generation
  // link stayed visible at once instead of the old one deferring to the
  // new, more specific one.
  function idOf(v) { return typeof v === "string" ? v : (v && v.id); }
  // A persisted relation entry can reference a node that has since been
  // retired as a standalone duplicate of some family's generation (see
  // supersedeStandalone) -- e.g. a platform match confirmed against the
  // standalone R107 before the SL-Class split existed. Wiring the link to
  // the retired node would make the connection permanently invisible
  // (links to hidden nodes never draw); follow the recorded supersededBy
  // pointer to its replacement generation instead, chained defensively in
  // case a replacement itself later gets superseded.
  function followSuperseded(byId, n) {
    let hops = 0;
    while (n && n.retired && n.supersededBy && hops++ < 5) {
      const next = byId.get(n.supersededBy);
      if (!next || next === n) break;
      n = next;
    }
    return n;
  }
  function applyResolvedRelations(nodes, links) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    // This used to `return` outright when store.relations was empty, which
    // silently skipped mirrorRelationLinks at the bottom too -- and that
    // rollup has nothing to do with resolved relations: it exists to give
    // every platform/related/succession link whose endpoint is a folded-in
    // generation a family-level stand-in, so a collapsed nameplate still
    // shows the connection. With no relations stored, no mirror was ever
    // created at boot; the first time ANY relation was later confirmed,
    // applyResolvedRelations ran properly and created the entire backlog at
    // once -- 62 links appearing from a single Yes click, which is how this
    // surfaced. Guard just the resolution loop instead, and always run the
    // rollup.
    Object.keys(store.relations || {}).forEach(key => {
      const entry = store.relations[key];
      if (entry.status !== "confirmed") return;
      const genA = followSuperseded(byId, byId.get(entry.genIdA));
      const genB = followSuperseded(byId, byId.get(entry.genIdB));
      const famA = byId.get(entry.famA), famB = byId.get(entry.famB);
      if (!genA || !genB || !famA || !famB) return;
      const already = links.some(l => l.type === entry.relType && l.llmResolvedKey === key);
      if (!already) {
        links.push({ source: genA.id, target: genB.id, type: entry.relType, llmResolved: true, llmResolvedKey: key });
      }
      // Find the original family<->family (or family<->model) connection
      // this resolution supersedes and tag it (idempotent -- setting the
      // same fields again on a later boot is harmless). Excludes the
      // newly-resolved link itself via llmResolved, not array position.
      const orig = links.find(l => l.type === entry.relType && !l.llmResolved &&
        ((idOf(l.source) === famA.id && idOf(l.target) === famB.id) || (idOf(l.source) === famB.id && idOf(l.target) === famA.id)));
      if (orig) {
        const s = idOf(orig.source), t = idOf(orig.target);
        // Only ever tag mirrorSourceFam/mirrorTargetFam for a side that's a
        // REAL family node -- famA/famB is sometimes a plain model standing
        // in for itself (resolveOnePlatformMention's targetFamId = match.familyOf
        // || match.id, see its own comment), which has no "expanded" concept
        // of its own at all. Tagging it anyway used to be silently harmless
        // (app.js's expandedFamilies set never contains a plain model's id,
        // so the mirror-hiding condition could never trigger off it), but
        // it's wrong data regardless, and worth being precise about now that
        // mirrorRelationLinks below performs the exact same kind of tagging
        // for brand-new mirrors and needs to agree with this block on what
        // "family" means.
        if (!orig.mirrorSourceFam && s === famA.id && famA.type === "family") orig.mirrorSourceFam = famA.id;
        if (!orig.mirrorTargetFam && t === famB.id && famB.type === "family") orig.mirrorTargetFam = famB.id;
        if (!orig.mirrorSourceFam && s === famB.id && famB.type === "family") orig.mirrorSourceFam = famB.id;
        if (!orig.mirrorTargetFam && t === famA.id && famA.type === "family") orig.mirrorTargetFam = famA.id;
        orig.mirror = true;
      }
    });
    // Real bug report (the Mercedes-Benz G-Class case): the loop above only
    // ever RETAGS an existing family<->family connection that happened to
    // already be sitting there from before -- a brand-new relation the LLM
    // discovered with no build-time equivalent (no prior DBpedia-harvested
    // link between these two nameplates at all) left the specific
    // generation<->generation link above as the ONLY connection, invisible
    // the moment its family collapses back down, since nothing else points
    // from the collapsed nameplate dot to anything. mirrorRelationLinks
    // below is the general fix: it re-derives a family-level stand-in for
    // EVERY platform/related/succession link currently in the graph whose
    // real endpoint is a folded-into-a-family generation, covering this
    // fresh-discovery case the retag-only loop above can't reach, not just
    // the ones this function's own loop happened to just add.
    mirrorRelationLinks(nodes, links);
  }

  // ---------- rollup: mirror platform/related/succession links up to the
  // family level whenever a real endpoint is a generation folded into a
  // collapsed nameplate ----------
  // Real user request (G-Class case): opening a specific generation's own
  // detail panel shows its shared-platform/related connections just fine --
  // they're real graph links -- but the collapsed parent nameplate shows
  // none of that, because a platform/related/succession link discovered
  // against one specific generation's own article is always wired directly
  // between that generation and its target, never rolled up to the family
  // it belongs to. This is the exact same problem build_family_layer.py's
  // own mirror_relation_links() already solves for build-time-harvested
  // links (see that file's own comment for the full reasoning) -- this is
  // its client-side counterpart, needed because links the LLM layer adds at
  // RUNTIME (via applyResolvedRelations/resolveOnePlatformMention above)
  // never go through that one-time offline pass. Never deletes or rewrites
  // the original link -- only adds a collapsed-view stand-in alongside it,
  // tagged mirror/mirrorSourceFam/mirrorTargetFam exactly like the
  // build-time version, so app.js's existing linkInLayer precedence rule
  // (family-level line while collapsed, generation-level line once
  // expanded -- see its own comment) applies identically regardless of
  // which side actually produced the mirror. Idempotent and safe to call on
  // every boot / after every apply: re-scans the full current link set each
  // time rather than tracking what's "new", so a mirror is only ever added
  // once no matter how many times this runs across a session.
  function mirrorRelationLinks(nodes, links) {
    const familyOfId = new Map();
    nodes.forEach(n => {
      if (n.type === "model" && n.familyOf) familyOfId.set(n.id, n.familyOf);
    });
    // Real bug report: the Cupra Terramar's card listed "Volkswagen Tiguan
    // 2007" twice, Škoda Kodiaq three times, and so on. Root cause was right
    // here, in this key. "Shares a platform with" and "related to" are
    // UNDIRECTED facts -- the graph stores whichever direction it happened to
    // learn them in -- but this key was built source-first, so an existing
    // nameplate-level link stored as `terramar|tiguan|platform` did not match
    // the mirror about to be derived from a generation-level link, which
    // computes `tiguan|terramar|platform`. The dedup missed, a second
    // family-level link was added alongside the one already there, and the
    // card (which lists one row per link) showed the same car twice.
    //
    // Succession is deliberately NOT sorted: "A is succeeded by B" and "B is
    // succeeded by A" are different claims, so direction is part of the fact
    // there and two opposite links are two facts, not a duplicate.
    const pairKey = (a, b, type) => (type === "succession"
      ? a + "|" + b
      : (a < b ? a + "|" + b : b + "|" + a)) + "|" + type;
    const existing = new Set();
    links.forEach(l => {
      if (l.type !== "platform" && l.type !== "related" && l.type !== "succession") return;
      existing.add(pairKey(idOf(l.source), idOf(l.target), l.type));
    });
    const toAdd = [];
    links.forEach(l => {
      // Never mirror a mirror -- this function re-scans the WHOLE link set
      // every time it runs (including stand-ins it, or the build-time
      // Python pass, already added on a previous run/boot), and a mirror's
      // own endpoints are family ids by construction, which familyOfId
      // never maps (only real generations are in that map), so this guard
      // is mostly redundant safety -- but explicit is cheaper than debugging
      // a mirror-of-a-mirror chain later.
      if (l.mirror) return;
      if (l.type !== "platform" && l.type !== "related" && l.type !== "succession") return;
      const s = idOf(l.source), t = idOf(l.target);
      const sFam = familyOfId.get(s), tFam = familyOfId.get(t);
      if (!sFam && !tFam) return; // neither endpoint belongs to a family -- nothing to mirror
      if (sFam && sFam === tFam) return; // both sides are generations of the SAME
                                          // nameplate -- that's what the gensucc chain
                                          // already represents, not a cross-model relation
                                          // (e.g. G-Class W463 succeeded by G-Class W465
                                          // needs no family-level mention of itself)
      const newSource = sFam || s, newTarget = tFam || t;
      // A generation-level link between two cars that BOTH roll up to the
      // same pair the link already connects has nothing to stand in for --
      // this would be a mirror identical to the real link beside it.
      if (newSource === s && newTarget === t) return;
      const key = pairKey(newSource, newTarget, l.type);
      if (existing.has(key)) return;
      existing.add(key);
      const nl = { source: newSource, target: newTarget, type: l.type, mirror: true };
      if (sFam) nl.mirrorSourceFam = sFam;
      if (tFam) nl.mirrorTargetFam = tFam;
      if (l.note) nl.note = l.note;
      toAdd.push(nl);
    });
    toAdd.forEach(nl => links.push(nl));
    return toAdd.length;
  }

  // ---------- universal delete, with recovery ----------
  // Real user request: "I want to also be able to delete makes (and models,
  // nameplates, or generations, or designers/engineers) within the 'tools'
  // tab underneath the 'modify existing cars' button. This should be
  // universally deletable, meaning that even if the data comes directly from
  // dbpedia or my database, it should also be deletable, however should be
  // stored somewhere that 'hard data' (not LLM data) has been deleted, and
  // therefore should also be recoverable."
  //
  // Deliberately implemented as a HIDE, not an erase. `cars.json`/`data.js`
  // are rebuilt from the pipeline and re-read from scratch on every boot, so
  // nothing here could permanently destroy harvested data even if it tried --
  // which is exactly the property that makes "recoverable" free rather than
  // an extra system to maintain: a deletion is a record saying "hide this
  // id", and restoring is deleting that record. It also reuses the same
  // `retired` flag the de-dup/override layers already use, so every view in
  // the app (nodeInLayer, linkInLayer, openDetail, searchAll, refreshCounts,
  // the LLM eligibility checks) already honours it with no further changes.
  //
  // `hard` records whether the node came from the build-time snapshot rather
  // than from anything this layer invented. That's the distinction the
  // request asks to be "stored somewhere": deleting an LLM-minted car is
  // cheap (re-run a check and it comes back), while deleting a harvested or
  // My Database-matched one removes real curated data until it's restored,
  // so the panel lists those separately and says so.
  function isHardData(n) {
    if (!n) return false;
    return !(n.llmGenerated || n.llmCreatedNode || n.userAdded || n.mergeGenerated);
  }
  // A make owns its models; a nameplate owns its generations. Deleting the
  // parent without the children would leave orphans visible with no route
  // back to anything -- so the cascade is computed here and recorded on the
  // same entry, which also means restoring the parent restores exactly the
  // set that went away with it, no more and no less.
  function deletionCascadeIds(nodes, target) {
    const out = new Set([target.id]);
    if (target.type === "make") {
      nodes.forEach(n => {
        if ((n.type === "model" || n.type === "family") && norm(n.make) === norm(target.label)) {
          out.add(n.id);
          (n.generations || []).forEach(g => out.add(g));
        }
      });
    } else if (target.type === "family") {
      (target.generations || []).forEach(g => out.add(g));
    }
    return [...out];
  }
  function applyDeletions(nodes, links) {
    if (!store.deletions || !Object.keys(store.deletions).length) return;
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    Object.keys(store.deletions).forEach(id => {
      const rec = store.deletions[id];
      if (!rec) return;
      (rec.cascadeIds && rec.cascadeIds.length ? rec.cascadeIds : [id]).forEach(cid => {
        const n = byIdLocal.get(cid);
        if (!n || n.retired) return;
        n.retired = true;
        n.deleted = true;              // distinguishes a user delete from a de-dup/override retirement
        n.deletedVia = id;             // which deletion record owns it, so restore is exact
        n.retiredReason = cid === id
          ? ("deleted by hand" + (rec.reason ? " — " + rec.reason : ""))
          : ("deleted by hand as part of removing " + (rec.label || id));
      });
    });
    // Links touching a deleted node are already invisible (nodeInLayer/
    // inGraphView both fail on a retired endpoint), but retiring them too
    // keeps refreshCounts and every links.some() dedup check honest, and
    // means a restore has an exact, symmetric undo.
    links.forEach(l => {
      const s = byIdLocal.get(idOf(l.source)), t = byIdLocal.get(idOf(l.target));
      if ((s && s.deleted) || (t && t.deleted)) { l.retired = true; l.retiredByDelete = true; }
    });
  }
  function deleteNode(node, nodes, links, reason) {
    if (!node) return { ok: false, error: "nothing selected" };
    if (store.deletions[node.id]) return { ok: false, error: "already deleted" };
    const cascadeIds = deletionCascadeIds(nodes, node);
    store.deletions[node.id] = {
      kind: node.type,
      label: node.type === "person" || node.type === "make" ? node.label : `${node.make || ""} ${node.label}`.trim(),
      hard: isHardData(node),
      cascadeIds,
      reason: reason || null,
      deletedAt: new Date().toISOString(),
    };
    applyDeletions(nodes, links);
    persist();
    return { ok: true, removed: cascadeIds.length };
  }
  // Restoring un-retires exactly what this record retired -- but only the
  // nodes it actually owns. A node that was ALSO retired for some other,
  // independent reason (superseded as a duplicate generation, retired by a
  // generation-list override) keeps that retirement, since undoing a hand
  // delete shouldn't quietly resurrect something a different mechanism
  // deliberately hid. `deletedVia` is what makes that distinction possible.
  function restoreNode(id, nodes, links) {
    const rec = store.deletions[id];
    if (!rec) return { ok: false, error: "no deletion on record for that id" };
    delete store.deletions[id];
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    (rec.cascadeIds && rec.cascadeIds.length ? rec.cascadeIds : [id]).forEach(cid => {
      const n = byIdLocal.get(cid);
      if (!n || n.deletedVia !== id) return;
      n.retired = false;
      delete n.deleted;
      delete n.deletedVia;
      delete n.retiredReason;
    });
    links.forEach(l => {
      if (!l.retiredByDelete) return;
      const s = byIdLocal.get(idOf(l.source)), t = byIdLocal.get(idOf(l.target));
      if ((s && s.deleted) || (t && t.deleted)) return; // still touching something else that's deleted
      l.retired = false;
      delete l.retiredByDelete;
    });
    persist();
    return { ok: true, restored: (rec.cascadeIds || [id]).length };
  }
  function allDeletions() {
    return Object.keys(store.deletions)
      .map(id => Object.assign({ id }, store.deletions[id]))
      .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id), undefined, { numeric: true, sensitivity: "base" }));
  }

  // ---------- newly added cars, and getting rid of them in one go ----------
  // Real user request: "any car that was added newly (for example through me
  // manually adding it or from it being added due to the car being added from
  // another wikipedia page that discovered a particular car), it should also
  // be fully deletable in an easy way... there should be a single button to
  // delete all newly created makes and models, like a resetting of the newly
  // added cars memory... (and a dropdown where the user can select a
  // particular make and model)."
  //
  // "Newly added" is exactly the complement of isHardData above: a node that
  // did NOT come from the build-time snapshot. Three ways one gets here --
  // typed in by hand through Add Car (`userAdded`), minted by the LLM from a
  // related-car mention that matched nothing in the graph (`llmCreatedNode`,
  // plus the `llm-make-*` marque it had to invent to hang it off), and the
  // generation stand-in a by-hand merge creates for its primary
  // (`mergeGenerated`). The last of those is deliberately EXCLUDED: it isn't
  // a car that wasn't here before, it's a re-shaping of one that was, and
  // undoing it is what the unmerge below is for.
  function isNewlyAdded(n) {
    if (!n || n.retired) return false;
    if (n.mergeGenerated) return false;
    if (n.familyOf) return false;                 // a generation goes with its nameplate, not on its own
    return !!(n.userAdded || n.llmCreatedNode ||
              (n.type === "make" && n.llmGenerated));
  }
  function newlyAddedNodes(nodes) {
    return nodes.filter(isNewlyAdded).sort((a, b) => {
      const al = (a.type === "make" ? a.label : `${a.make || ""} ${a.label}`).trim();
      const bl = (b.type === "make" ? b.label : `${b.make || ""} ${b.label}`).trim();
      return String(al).localeCompare(String(bl), undefined, { numeric: true, sensitivity: "base" });
    });
  }
  // One deletion RECORD covering the whole sweep, not one per car. That keeps
  // "Deleted so far" readable (a reset of a few dozen discovered cars would
  // otherwise bury every real deletion under it) and makes the undo exactly
  // as coarse as the action was -- restore puts back precisely the set that
  // went away. The synthetic record id is never a node id, which applyDeletions
  // and restoreNode already cope with: both only ever look node ids up out of
  // `cascadeIds`, and only the record key is used for `deletedVia`.
  function deleteNewCars(nodes, links, ids, reason) {
    const wanted = ids && ids.length ? new Set(ids) : null;
    const targets = newlyAddedNodes(nodes).filter(n => !wanted || wanted.has(n.id));
    if (!targets.length) return { ok: false, error: "no newly added cars to delete" };
    const cascade = new Set();
    targets.forEach(n => deletionCascadeIds(nodes, n).forEach(id => cascade.add(id)));
    const recId = "batch-newcars-" + Date.now();
    store.deletions[recId] = {
      kind: "batch",
      label: targets.length === 1
        ? (targets[0].type === "make" ? targets[0].label : `${targets[0].make || ""} ${targets[0].label}`.trim())
        : `${targets.length} newly added cars`,
      hard: false,
      batch: true,
      cascadeIds: [...cascade],
      reason: reason || null,
      deletedAt: new Date().toISOString(),
    };
    applyDeletions(nodes, links);
    persist();
    return { ok: true, removed: targets.length, total: cascade.size, id: recId };
  }

  // ---------- purge: deleted, and gone from every file too ----------
  // Real user request: "a 'clear' option which lets me remove the cars
  // completely, so they are still deleted but also do not appear in the
  // 'deleted so far', since they are completely deleted from the system,
  // including in any file which this information was ever stored."
  //
  // Every key in this store that can be keyed by, or can name, a node id is
  // swept here -- otherwise a purge would be cosmetic: the relation entry
  // that discovered the car re-mints it through applyResolvedRelations on the
  // very next boot, the userCars entry re-creates it through applyUserCars,
  // the mintedFacts cache hands its years straight back. The one thing that
  // CANNOT be erased is the build-time snapshot (`data.js` is rebuilt from
  // the pipeline and re-read from scratch every boot, and this layer has
  // never written to it), so a tombstone in store.purged carries the "stays
  // gone" half. For an LLM-minted or hand-added car the tombstone is belt and
  // braces; for a harvested one it's the whole mechanism.
  function purgeIds(idList) {
    const ids = new Set(idList.filter(Boolean));
    if (!ids.size) return 0;
    const touchesId = v => ids.has(v);
    ["families", "recheck", "genResearch", "mintedFacts", "wpLinks", "userCars",
     "renames", "merges", "mergeWpChoices", "dismissed"].forEach(bucket => {
      if (!store[bucket]) return;
      Object.keys(store[bucket]).forEach(k => { if (touchesId(k)) delete store[bucket][k]; });
    });
    // A merge record can also NAME a purged car as one of its members without
    // being keyed by it -- drop it from the member list rather than the whole
    // merge, which is about a different (still present) nameplate.
    Object.keys(store.merges || {}).forEach(pid => {
      const rec = store.merges[pid];
      if (!rec || !Array.isArray(rec.memberIds)) return;
      const kept = rec.memberIds.filter(id => !ids.has(id));
      if (kept.length !== rec.memberIds.length) rec.memberIds = kept;
    });
    // Relations and transitive proposals name their endpoints in the entry
    // (famA/famB/genIdA/genIdB) as well as inside the composite key, so both
    // are checked. A purged endpoint means the relation can never be valid
    // again, so it's removed outright rather than rejected -- there is
    // nothing left for a "no" to protect against.
    ["relations", "transitive"].forEach(bucket => {
      if (!store[bucket]) return;
      Object.keys(store[bucket]).forEach(k => {
        const e = store[bucket][k] || {};
        const named = [e.famA, e.famB, e.genIdA, e.genIdB, e.a, e.b].filter(Boolean);
        if (named.some(touchesId) || k.split("|").some(touchesId)) delete store[bucket][k];
      });
    });
    ["rejectedRelations", "unmergedDuplicates", "unmerges"].forEach(bucket => {
      if (!store[bucket]) return;
      Object.keys(store[bucket]).forEach(k => {
        if (k.split("|").some(touchesId)) delete store[bucket][k];
      });
    });
    return ids.size;
  }
  function purgeDeletion(id, nodes, links) {
    const rec = store.deletions[id];
    if (!rec) return { ok: false, error: "no deletion on record for that id" };
    const ids = (rec.cascadeIds && rec.cascadeIds.length) ? rec.cascadeIds.slice() : [id];
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    const now = new Date().toISOString();
    ids.forEach(cid => {
      const n = byIdLocal.get(cid);
      store.purged[cid] = {
        label: n ? ((n.type === "model" || n.type === "family") ? `${n.make || ""} ${n.label}`.trim() : n.label) : (rec.label || cid),
        kind: n ? n.type : rec.kind || null,
        purgedAt: now,
      };
    });
    delete store.deletions[id];
    purgeIds(ids);
    applyPurges(nodes, links);
    persist();
    return { ok: true, purged: ids.length };
  }
  // Same shape as applyDeletions, and runs beside it -- the node stays
  // retired, it just has no restorable record behind it any more. `purged` is
  // also what every mint path consults before creating a node (see
  // mintRelatedNode and applyUserCars), so on a normal boot most of these ids
  // never even come into existence and this loop simply finds nothing.
  function applyPurges(nodes, links) {
    if (!store.purged || !Object.keys(store.purged).length) return;
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    Object.keys(store.purged).forEach(id => {
      const n = byIdLocal.get(id);
      if (!n) return;
      n.retired = true;
      n.purged = true;
      n.retiredReason = "permanently removed";
    });
    links.forEach(l => {
      const s = byIdLocal.get(idOf(l.source)), t = byIdLocal.get(idOf(l.target));
      if ((s && s.purged) || (t && t.purged)) { l.retired = true; l.retiredByPurge = true; }
    });
  }
  function isPurged(id) { return !!(store.purged && store.purged[id]); }
  function allPurged() {
    return Object.keys(store.purged || {}).map(id => Object.assign({ id }, store.purged[id]));
  }

  // ---------- unmerge a nameplate back into standalone cars ----------
  // Real user request: "I also want an 'unmerge' option just like how there
  // is a 'merge' option in the 'modify existing car' section, if the car that
  // I selected is a nameplate. This would unmerge all of the generations of
  // the car from the existing 'nameplate' of the car."
  //
  // A nameplate can have been built four different ways -- baked into the
  // build-time snapshot, split out of one article by the LLM (store.families),
  // folded together by the automatic duplicate-nameplate merge, or merged by
  // hand (store.merges) -- and the point of doing this as its own recorded
  // decision, replayed at the END of the boot sequence, is that it undoes all
  // four identically instead of needing four different unwindings.
  //
  // What "unmerge" means concretely: every generation that was a real car in
  // its own right before it was adopted goes back to being a standalone
  // model (drop `familyOf`, drop the generation link, keep its own years,
  // links, credits and Wikipedia article untouched -- adoption never moved
  // any of those, which is exactly what makes this clean); every generation
  // that only ever existed AS a generation (minted by the LLM split, or the
  // stand-in a hand merge makes for its primary) is retired, since there is
  // no standalone car underneath it to go back to; and the nameplate node
  // itself becomes a plain model again, or is retired if it was never
  // anything but a container.
  function generationsOf(nodes, famId) {
    return nodes.filter(n => n.familyOf === famId && !n.retired);
  }
  function applyOneUnmerge(nodes, links, famId) {
    const fam = nodes.find(n => n.id === famId);
    if (!fam) return false;
    const gens = generationsOf(nodes, famId);
    if (!gens.length && fam.type !== "family") return false;
    let freed = 0;
    gens.forEach(g => {
      if (g.mergeGenerated || g.llmCreatedGeneration || g.supersededBy) {
        // Nothing to go back to: this node only ever existed as a slot in
        // this nameplate. Retiring rather than deleting keeps the same
        // never-erase discipline as everything else here, so re-merging
        // reuses the identical node.
        g.retired = true;
        g.retiredReason = "removed when its nameplate was unmerged";
        g.retiredByUnmerge = true;
        return;
      }
      delete g.familyOf;
      g.type = "model";
      freed++;
    });
    // The stand-in a hand merge minted for the primary carries anything the
    // primary itself has since gained; the primary keeps its own identity, so
    // there is nothing to transplant back -- it simply stops being a family.
    links.forEach(l => {
      if (l.type !== "generation") return;
      if (idOf(l.source) === famId || idOf(l.target) === famId) { l.retired = true; l.retiredByUnmerge = true; }
    });
    // Was this nameplate ever a car in its own right? Two cases say yes, and
    // deliberately nothing else: a hand merge minted a `merge-<id>-self`
    // stand-in for it (which only happens when the primary was a plain model
    // being promoted), or every generation it held was invented rather than
    // adopted (an LLM split of ONE article -- the article's car is the
    // nameplate itself, so freeing nothing means there is nothing else left
    // to be it). A build-time nameplate is neither: its year and article are
    // rolled up FROM its generations, so leaving it behind as a plain model
    // would put a third "Alpha" beside the real "Alpha I" and "Alpha II".
    const hadOwnCar = (fam.generations || []).some(id => {
      const g = nodes.find(n => n.id === id);
      return g && (g.mergeGenerated || g.id === "merge-" + famId + "-self");
    });
    fam.generations = [];
    if (fam.type === "family") {
      if (hadOwnCar || freed === 0) {
        fam.type = "model";
      } else {
        // A pure container -- the cars it held are standalone again, and an
        // empty nameplate beside them would be a duplicate of nothing.
        fam.retired = true;
        fam.retiredReason = "nameplate unmerged into its individual cars";
        fam.retiredByUnmerge = true;
      }
    }
    // A generation normally hangs off the graph through its NAMEPLATE's
    // "made" link, not one of its own -- so freeing it without this would
    // leave a car floating with no marque, invisible in the make's own view.
    // Only ever adds the link a standalone model would already have had.
    if (freed) {
      const makeNode = nodes.find(n => n.type === "make" && !n.retired && norm(n.label) === norm(fam.make));
      if (makeNode) {
        gens.filter(g => !g.retired && !g.familyOf).forEach(g => {
          const has = links.some(l => l.type === "made" && !l.retired &&
            ((idOf(l.source) === makeNode.id && idOf(l.target) === g.id) ||
             (idOf(l.target) === makeNode.id && idOf(l.source) === g.id)));
          if (!has) links.push({ source: makeNode.id, target: g.id, type: "made", fromUnmerge: true });
        });
      }
    }
    return true;
  }
  function applyUnmerges(nodes, links) {
    if (!store.unmerges || !Object.keys(store.unmerges).length) return;
    Object.keys(store.unmerges).forEach(famId => {
      try { applyOneUnmerge(nodes, links, famId); }
      catch (e) { console.warn("LlmFamilies: could not apply unmerge for " + famId, e); }
    });
  }
  function unmergeNameplate(famId, nodes, links) {
    const fam = nodes.find(n => n.id === famId);
    if (!fam) return { ok: false, error: "that car isn't in the graph" };
    if (fam.type !== "family" && !generationsOf(nodes, famId).length) {
      return { ok: false, error: "that car isn't a nameplate — there's nothing to unmerge" };
    }
    const count = generationsOf(nodes, famId).length;
    store.unmerges[famId] = {
      label: `${fam.make || ""} ${fam.label}`.trim(),
      generations: count,
      unmergedAt: new Date().toISOString(),
    };
    // The layers that BUILT this nameplate have to stop rebuilding it, or the
    // next boot re-creates exactly what was just taken apart and applyUnmerges
    // has to fight it every time. Clearing them here means the unmerge record
    // is the only thing left saying anything about this nameplate's shape.
    delete store.merges[famId];
    delete store.families[famId];
    delete store.recheck[famId];
    const ok = applyOneUnmerge(nodes, links, famId);
    if (!ok) { delete store.unmerges[famId]; return { ok: false, error: "nothing about that car could be unmerged" }; }
    persist();
    return { ok: true, generations: count };
  }
  // Undo the undo: forget the unmerge record, so whichever layer originally
  // built this nameplate is free to build it again on the next boot. Needs a
  // reload rather than a live re-apply -- the generations were re-typed and
  // their links retired in place, and re-deriving them is exactly what the
  // boot sequence already does correctly.
  async function redoMerge(famId) {
    delete store.unmerges[famId];
    await persist();
  }
  function allUnmerges() {
    return Object.keys(store.unmerges || {}).map(id => Object.assign({ id }, store.unmerges[id]));
  }
  function isUnmerged(id) { return !!(store.unmerges && store.unmerges[id]); }

  // ---------- rename anything ----------
  // Real user request: "within 'Modify existing cars', I should also be able
  // to change the name of the make, model, nameplate, engineer/designer,
  // etc..." Same never-rewrite-the-snapshot discipline as everything else
  // here: the new label is a record, re-stamped at every boot.
  //
  // Renaming a MAKE is the one case with a ripple: every model/family/
  // generation carries its make as a denormalized `make` STRING (that's what
  // the cards, search index and duplicate matcher all read), not a reference,
  // so all of them have to be updated together or the graph ends up with
  // children still claiming the old marque. Handled here rather than left to
  // the caller so it can't be forgotten at one of the call sites.
  function applyRenames(nodes) {
    if (!store.renames || !Object.keys(store.renames).length) return;
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    Object.keys(store.renames).forEach(id => {
      const rec = store.renames[id];
      const n = byIdLocal.get(id);
      if (!n || !rec || !rec.label) return;
      const before = n.label;
      n.label = rec.label;
      n.renamed = true;
      if (n.type === "make" && before && before !== rec.label) {
        nodes.forEach(o => {
          if ((o.type === "model" || o.type === "family") && norm(o.make) === norm(before)) o.make = rec.label;
        });
      }
      // A person's name also appears as free text in each car's own
      // designers/engineers arrays (what the detail card's "drawn by" line
      // reads) -- update those too, or the card and the graph disagree.
      if (n.type === "person" && before && before !== rec.label) {
        nodes.forEach(o => {
          ["designers", "engineers"].forEach(f => {
            if (!Array.isArray(o[f])) return;
            const i = o[f].findIndex(x => norm(x) === norm(before));
            if (i >= 0) o[f] = o[f].map((x, j) => (j === i ? rec.label : x));
          });
        });
      }
    });
  }
  function renameNode(node, newLabel, nodes) {
    if (!node) return { ok: false, error: "nothing selected" };
    const label = String(newLabel || "").trim();
    if (!label) return { ok: false, error: "enter a new name" };
    if (label === node.label) return { ok: false, error: "that's already its name" };
    // Keep the ORIGINAL label across repeated renames -- previousLabel is
    // what "revert" restores to, and it should mean "what the build-time
    // snapshot called it", not "whatever I typed last time".
    const existing = store.renames[node.id];
    store.renames[node.id] = {
      label,
      previousLabel: existing ? existing.previousLabel : node.label,
      kind: node.type,
      renamedAt: new Date().toISOString(),
    };
    applyRenames(nodes);
    persist();
    return { ok: true };
  }
  function revertRename(id, nodes) {
    const rec = store.renames[id];
    if (!rec) return { ok: false, error: "not renamed" };
    // Re-point the record at the original label and re-apply, so a make
    // rename's ripple onto its children is undone by the exact same code
    // path that applied it, rather than a second, subtly-different one.
    store.renames[id] = Object.assign({}, rec, { label: rec.previousLabel });
    applyRenames(nodes);
    delete store.renames[id];
    persist();
    return { ok: true };
  }
  function allRenames() {
    return Object.keys(store.renames).map(id => Object.assign({ id }, store.renames[id]));
  }

  // ---------- automatic merge of a nameplate duplicated as a bare umbrella model ----------
  // Real user report: "There are instances (like the Aston Martin Vantage
  // nameplate) where there are 2 nameplates that are exactly identical to
  // each other. They should automatically be merged if these exist."
  //
  // What's actually in the data: 42 (make, label) pairs where a plain,
  // ungrouped MODEL node sits alongside a FAMILY node of the same name --
  // Aston Martin Vantage, Toyota Corolla, Porsche 911, BMW 5 Series and so
  // on. The plain one is Wikipedia's general nameplate-overview article
  // (harvested by DBpedia as a model in its own right); the family is the
  // group build_family_layer.py formed from the per-generation articles. Two
  // dots with the identical label, which is exactly what "2 nameplates that
  // are exactly identical" describes.
  //
  // build_family_layer.py's "bare-fold" pass already handles this shape when
  // it fires (see its own comment -- Mercedes-Benz CLS is the case it was
  // written for), but it only runs while a group is being FORMED, so any
  // umbrella article it didn't catch then stays a permanent visual duplicate.
  // This is the runtime counterpart, applied on every boot.
  //
  // It folds rather than deletes: the bare model becomes one more generation
  // of the family, keeping its id and therefore every link, credit, My
  // Database match and Wikipedia article it already carried. That's both the
  // least destructive option and the most accurate one -- an umbrella article
  // usually describes the nameplate's earliest era, which genuinely is a
  // generation (Aston Martin's bare Vantage is the 1972-73 car; the family
  // starts at 2005). Derived deterministically from the data each boot rather
  // than persisted, so it needs no migration and self-corrects if the
  // underlying grouping changes; `unmergedDuplicates` is the escape hatch for
  // a pair that shouldn't be folded.
  function duplicateNameplatePairs(nodes) {
    const groups = new Map();
    nodes.forEach(n => {
      if (n.retired) return;
      if (n.type !== "model" && n.type !== "family") return;
      if (!n.make || !n.label) return;
      const k = norm(n.make) + "|" + norm(n.label);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    });
    const pairs = [];
    groups.forEach(members => {
      if (members.length < 2) return;
      const fams = members.filter(m => m.type === "family");
      if (fams.length !== 1) return;      // 0 families = two loose models (not this bug); 2+ = ambiguous, leave alone
      const fam = fams[0];
      members.forEach(m => {
        if (m === fam) return;
        if (m.type !== "model") return;
        if (m.familyOf) return;           // already a generation of something -- not a stray duplicate
        pairs.push({ fam, dup: m });
      });
    });
    return pairs;
  }
  function mergeDuplicateNameplates(nodes, links) {
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    let merged = 0;
    duplicateNameplatePairs(nodes).forEach(({ fam, dup }) => {
      if (store.unmergedDuplicates[fam.id + "|" + dup.id]) return;
      dup.familyOf = fam.id;
      dup.mergedFromDuplicate = fam.id;
      if (!links.some(l => l.type === "generation" && idOf(l.source) === fam.id && idOf(l.target) === dup.id)) {
        links.push({ source: fam.id, target: dup.id, type: "generation", autoMergedDuplicate: true });
      }
      // Re-derive the family's generation list and span, chronologically, so
      // an umbrella article covering an EARLIER era lands first and widens
      // the nameplate's start year rather than being appended out of order.
      const gens = [...new Set([...(fam.generations || []), dup.id])]
        .map(id => byIdLocal.get(id)).filter(g => g && !g.retired);
      gens.sort((a, b) => (a.year == null ? Infinity : a.year) - (b.year == null ? Infinity : b.year));
      fam.generations = gens.map(g => g.id);
      const years = gens.map(g => g.year).filter(y => y != null);
      if (years.length) fam.year = Math.min(...years);
      const ends = gens.map(g => g.end);
      fam.end = ends.some(e => e == null) ? null : Math.max(...ends);
      const ds = new Set(fam.designers || []), es = new Set(fam.engineers || []);
      (dup.designers || []).forEach(d => ds.add(d));
      (dup.engineers || []).forEach(d => es.add(d));
      fam.designers = [...ds]; fam.engineers = [...es];
      if (dup.db) { fam.db = true; fam.dbGenerations = [...new Set([...(fam.dbGenerations || []), dup.id])]; }
      if (dup.garage) fam.garage = true;
      if (dup.heritage) fam.heritage = true;
      // The umbrella article is very often the best general article for the
      // whole nameplate -- exactly what familyCheckTarget and the hover
      // card's own backfill already go looking for.
      if (!fam.wp && dup.wp) fam.wp = dup.wp;
      merged++;
    });
    return merged;
  }
  function unmergeDuplicate(famId, dupId) {
    store.unmergedDuplicates[famId + "|" + dupId] = true;
    return persist();
  }

  // ---------- merge several standalone models into ONE nameplate ----------
  // Real user request: "in the 'Tools' Section there should also be a
  // 'Modify Existing Car' button which lets the user modify the wikipedia
  // link or ask for a particular request with the LLM, like potentially
  // merging multiple models together into one nameplate if it has not been
  // previously caught."
  //
  // build_family_layer.py only groups a nameplate whose generations share a
  // recognizable label pattern AND form an unbroken succession chain (see
  // its own report file for every candidate it declines and why), and the
  // LLM split only fires when one article describes all the generations at
  // once. A nameplate whose generations sit in the graph under genuinely
  // unrelated labels -- different naming conventions across eras, a regional
  // rename, a chassis code where its siblings use ordinals -- falls through
  // both, and there has never been any way to say so by hand.
  //
  // Structurally this is the same operation applyConfirmed performs, just
  // driven by an explicit list of EXISTING node ids instead of an LLM
  // proposal: the primary model becomes the family (keeping its own id, so
  // every link already pointing at it keeps working untouched), and each
  // other model becomes one of its generations. Crucially the other models
  // are NOT re-minted as new nodes -- they're adopted in place by setting
  // `familyOf`, so every link, designer credit, My Database match and
  // Wikipedia article they already carry stays exactly where it is and
  // nothing has to be transplanted. That also makes the undo trivially
  // clean: delete the merge record and the next boot simply never adopts
  // them, leaving the original standalone models untouched (see applyMerges,
  // which is the only thing that ever applies this).
  function computeMergeOrder(members) {
    return [...members].sort((a, b) => {
      const ay = a.year == null ? Infinity : a.year, by = b.year == null ? Infinity : b.year;
      return ay - by || String(a.label).localeCompare(String(b.label));
    });
  }
  function applyOneMerge(nodes, links, primaryId, rec) {
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    const primary = byIdLocal.get(primaryId);
    if (!primary || primary.retired) return false;
    if (primary.familyOf) return false;              // already a generation of something else -- never re-parent it
    // Members may be plain models, generations of ANOTHER nameplate (re-homed
    // here), or another FAMILY entirely -- real user request: "My expectation
    // is to be able to merge all instances of the Honda civic names
    // together." A family member contributes its own generations rather than
    // itself (a nameplate isn't a generation of another nameplate), and is
    // then retired as an empty husk; see the expansion just below.
    const rawMembers = (rec.memberIds || []).map(id => byIdLocal.get(id))
      .filter(m => m && !m.retired && m.id !== primaryId && norm(m.make) === norm(primary.make));
    const absorbedFamilies = [];
    const expanded = [];
    rawMembers.forEach(m => {
      if (m.type === "family") {
        absorbedFamilies.push(m);
        (m.generations || []).map(id => byIdLocal.get(id))
          .filter(g => g && !g.retired)
          .forEach(g => expanded.push(g));
        return;
      }
      expanded.push(m);
    });
    const members = expanded
      .filter(m => m && !m.retired && m.type === "model" && m.id !== primaryId &&
                   // Same manufacturer, always. Generations of one nameplate
                   // are by definition the same marque's own continuous model
                   // line -- a same-platform car wearing a different badge is
                   // a `related` link, not a generation, and folding one in
                   // here would misrepresent it permanently and silently.
                   norm(m.make) === norm(primary.make));
    if (!members.length && !absorbedFamilies.length) return false;
    // The primary itself becomes the FIRST generation as well as the family
    // node -- it's a real car in its own right, not just a container, so it
    // needs a generation node of its own or its own years/credits/links
    // would be the one thing the merge silently lost. Minted with a distinct
    // id (the family keeps the original), and everything the original knew
    // is transplanted onto it by supersedeStandalone, exactly as
    // applyConfirmed does for a de-duplicated standalone.
    // Deterministic id, looked up BEFORE any uniquifying: a second merge onto
    // the same nameplate (adding one more generation later) must find and
    // reuse the stand-in it already created, not mint a second copy of the
    // primary car beside it.
    //
    // ...but ONLY when the primary is a plain model. Real bug report: merging
    // two cars into the existing `fam-honda-civic` nameplate minted a bogus
    // "merge-fam-honda-civic-self" generation labelled "Civic" beside its
    // eleven real ones. A family is already a container whose own car-ness is
    // fully represented by its generations -- there is nothing left to stand
    // in for, so there is nothing to mint.
    const selfGenId = "merge-" + primaryId + "-self";
    let selfGen = primary.type === "family" ? null : byIdLocal.get(selfGenId);
    if (!selfGen && primary.type !== "family") {
      selfGen = {
        id: selfGenId, type: "model", label: primary.label, make: primary.make,
        year: primary.year, end: primary.end, wp: primary.wp,
        designers: [...(primary.designers || [])], engineers: [...(primary.engineers || [])],
        familyOf: primaryId, llmGenerated: true, mergeGenerated: true,
      };
      nodes.push(selfGen);
      byIdLocal.set(selfGenId, selfGen);
      links.push({ source: primaryId, target: selfGenId, type: "generation" });
      // Copy the primary's own relation/person links down onto its
      // generation stand-in, so expanding the new nameplate doesn't make its
      // own connections vanish (the family-level originals stay put and are
      // mirrored by the ordinary precedence rules).
      supersedeStandaloneLinksOnly(links, primaryId, selfGenId);
    }
    // ---------- keep what the nameplate already had ----------
    // Real bug report: "I also get 'Honda Civic' as a nameplate (which
    // doesn't include the individual generations labeled as the generation
    // number)." This line used to be `computeMergeOrder([selfGen,
    // ...members])` and the result was assigned straight over
    // `primary.generations` -- so merging two cars into fam-honda-civic
    // REPLACED its eleven existing generations with just those two. They kept
    // their `familyOf` back-pointer, so they weren't orphaned exactly, but
    // they vanished from the nameplate's own list, from its detail panel and
    // from every expand. A merge must only ever ADD.
    const existing = (primary.generations || [])
      .map(id => byIdLocal.get(id))
      .filter(g => g && !g.retired && g.familyOf === primaryId);
    const seenIds = new Set();
    const ordered = computeMergeOrder(
      [selfGen, ...existing, ...members]
        .filter(g => g && !seenIds.has(g.id) && seenIds.add(g.id)));
    const genIds = [];
    let prev = null;
    ordered.forEach(m => {
      if (m.familyOf !== primaryId) {
        m.familyOf = primaryId;
        m.mergedInto = primaryId;
        links.push({ source: primaryId, target: m.id, type: "generation" });
      }
      genIds.push(m.id);
      if (prev && !links.some(l => l.type === "gensucc" && idOf(l.source) === prev && idOf(l.target) === m.id)) {
        links.push({ source: prev, target: m.id, type: "gensucc" });
      }
      prev = m.id;
    });
    const years = ordered.map(m => m.year).filter(y => y != null);
    const ends = ordered.map(m => m.end);
    const designers = new Set(), engineers = new Set();
    ordered.forEach(m => {
      (m.designers || []).forEach(d => designers.add(d));
      (m.engineers || []).forEach(d => engineers.add(d));
      if (m.db) { primary.db = true; primary.dbGenerations = [...new Set([...(primary.dbGenerations || []), m.id])]; }
      if (m.garage) primary.garage = true;
    });
    primary.type = "family";
    primary.generations = genIds;
    // Deliberately NOT touched: each member keeps its own `wp`. Real user
    // request: "typically if I am doing a merge of some kind, it's because
    // the individual generations of the nameplate are already accurate
    // (especially if they have a specific wikipedia page associated with the
    // generation), and so simply leave these generations alone when doing the
    // merge and don't override it with the general nameplate's wikipedia
    // information, as the information of the actual generation wikipedia page
    // would be more accurate in this case." Members are adopted in place, so
    // this holds by construction -- stated explicitly so it stays true.
    // The nameplate itself only ever FILLS a gap, never overwrites:
    if (!primary.wp) {
      // Candidates are the NAMEPLATE-level articles among the members: a
      // member whose own label is the nameplate's label (an umbrella model
      // harvested from Wikipedia's general article). A generation's article
      // is deliberately not a candidate -- "Honda Civic (first generation)"
      // describes one generation, not the nameplate, and promoting it would
      // mislabel the whole family.
      const candidates = [...new Set(ordered
        .filter(g => g.wp && norm(g.label) === norm(primary.label))
        .map(g => g.wp))];
      if (candidates.length === 1) primary.wp = candidates[0];
      else if (candidates.length > 1) {
        // Real user request: "If the LLM is unsure which to pick, then it
        // should prompt the user and have the user confirm which information
        // to take." Two different articles both claiming to BE this nameplate
        // is exactly that case, and it isn't guessable -- picking the first
        // one silently is how a nameplate ends up pointed at the wrong
        // article with nothing to show that a choice was ever made. Recorded
        // on the merge itself so it survives a reload and can be answered
        // later; the nameplate simply has no article until it is answered,
        // which is honest and harmless (every generation keeps its own).
        const chosen = (store.mergeWpChoices || {})[primaryId];
        if (chosen && candidates.indexOf(chosen) >= 0) primary.wp = chosen;
        else rec.wpConflict = { candidates, at: rec.wpConflict ? rec.wpConflict.at : new Date().toISOString() };
      }
      if (primary.wp && rec.wpConflict) delete rec.wpConflict;
    }
    primary.designers = [...designers];
    primary.engineers = [...engineers];
    primary.mergedNameplate = true;
    // An absorbed nameplate is now an empty husk -- every generation it had
    // has moved across. Retired (never deleted) and pointed at its
    // replacement, exactly like retireOrphanedFamily does, so anything still
    // holding its id resolves via followSuperseded. Real user request: "if
    // there are two 'Honda civic' model entries as well as a 'Honda civic'
    // nameplate entry, then choose only the nameplate entry and drop the
    // other two" -- this is the "drop" half, done non-destructively.
    absorbedFamilies.forEach(f => {
      if (f.id === primaryId) return;
      f.retired = true;
      f.retiredAt = new Date().toISOString();
      f.retiredReason = "merged into " + (primary.make ? primary.make + " " : "") + primary.label;
      f.supersededBy = primaryId;
      f.generations = [];
    });
    if (years.length) primary.year = Math.min(...years);
    primary.end = ends.some(e => e == null) ? null : Math.max(...ends);
    return true;
  }
  // Narrow sibling of supersedeStandalone: the primary model isn't being
  // RETIRED here (it becomes the family node and stays fully live), so none
  // of that function's flag/field transplanting applies -- only its link
  // duplication does, and only in the "copy down, leave the original" sense.
  function supersedeStandaloneLinksOnly(links, fromId, toId) {
    const n0 = links.length;
    for (let i = 0; i < n0; i++) {
      const l = links[i];
      if (REBOUND_LINK_TYPES.indexOf(l.type) < 0) continue;
      const s = idOf(l.source), t = idOf(l.target);
      if (s !== fromId && t !== fromId) continue;
      const ns = s === fromId ? toId : s, nt = t === fromId ? toId : t;
      if (ns === nt) continue;
      const exists = links.some(l2 => l2.type === l.type &&
        ((idOf(l2.source) === ns && idOf(l2.target) === nt) || (idOf(l2.source) === nt && idOf(l2.target) === ns)));
      if (exists) continue;
      const nl = { source: ns, target: nt, type: l.type, rebound: true, reboundFrom: fromId };
      if (l.note) nl.note = l.note;
      links.push(nl);
    }
  }
  function applyMerges(nodes, links) {
    if (!store.merges || !Object.keys(store.merges).length) return;
    Object.keys(store.merges).forEach(primaryId => {
      const rec = store.merges[primaryId];
      if (!rec || rec.status === "undone") return;
      try { applyOneMerge(nodes, links, primaryId, rec); }
      catch (e) { console.warn("LlmFamilies: could not apply merge for " + primaryId, e); }
    });
  }
  // Records the merge and applies it to the live arrays in one go, so the
  // calling tab sees it immediately AND every future boot replays it.
  function mergeModelsIntoNameplate(primaryId, memberIds, nodes, links) {
    const rec = {
      memberIds: [...new Set((memberIds || []).filter(id => id && id !== primaryId))],
      mergedAt: new Date().toISOString(),
    };
    if (!rec.memberIds.length) return { ok: false, error: "no other cars selected to merge in" };
    store.merges[primaryId] = rec;
    const ok = applyOneMerge(nodes, links, primaryId, rec);
    if (!ok) { delete store.merges[primaryId]; return { ok: false, error: "none of the selected cars could be merged (already grouped, retired, or not plain models)" }; }
    persist();
    return { ok: true, generations: (byIdOf(nodes, primaryId) || {}).generations || [] };
  }
  function byIdOf(nodes, id) { return nodes.find(n => n.id === id) || null; }
  async function undoMerge(primaryId) {
    delete store.merges[primaryId];
    await persist();
  }
  function allMerges() {
    return Object.keys(store.merges).map(id => Object.assign({ id }, store.merges[id]));
  }
  // ---------- "which article is this nameplate's?" ----------
  // See applyOneMerge's wpConflict branch for why this exists: when a merge
  // leaves two different articles both claiming to BE the nameplate, the
  // answer is asked for rather than guessed. Unanswered conflicts are what
  // the Modify Existing Car panel renders a prompt for.
  function pendingMergeWpConflicts() {
    return Object.keys(store.merges || {})
      .filter(id => store.merges[id] && store.merges[id].wpConflict &&
                    !(store.mergeWpChoices || {})[id])
      .map(id => ({ primaryId: id, candidates: store.merges[id].wpConflict.candidates.slice() }));
  }
  // Answering one is a recorded decision like every other in this file, so it
  // replays on the next boot instead of being re-asked forever.
  async function resolveMergeWpChoice(primaryId, wp, nodes) {
    const rec = store.merges && store.merges[primaryId];
    if (!rec || !rec.wpConflict) return false;
    if (rec.wpConflict.candidates.indexOf(wp) < 0) return false;
    if (!store.mergeWpChoices) store.mergeWpChoices = {};
    store.mergeWpChoices[primaryId] = wp;
    delete rec.wpConflict;
    const primary = Array.isArray(nodes) ? nodes.find(n => n.id === primaryId) : null;
    if (primary && !primary.wp) primary.wp = wp;   // live, no reload needed
    await persist();
    return true;
  }

  // ---------- free-text "ask the LLM about this car" ----------
  // The other half of Modify Existing Car. Deliberately narrow: the model is
  // NOT asked to perform an action, only to answer one specific structured
  // question -- which of these existing, already-listed cars (if any) are
  // really generations of the same nameplate as this one. It can only ever
  // return ids that were handed to it (same hallucination guard as
  // askDuplicateCheck), and its answer is always shown for confirmation
  // before mergeModelsIntoNameplate is called. A free-text request that
  // isn't about merging still gets a plain prose answer back, which the
  // panel just displays -- useful for "why is this linked to X?" without
  // giving the model any ability to change anything on its own.
  const MODIFY_CAR_SYSTEM_PROMPT = `You answer a user's question about one specific car in a car knowledge graph, and — only when the question is asking for it — identify which of a list of candidate cars are really other GENERATIONS of the same nameplate as that car.
Respond with ONLY JSON, no prose outside it, matching exactly this shape:
{"answer": string, "mergeIds": string[], "reason": string}
Rules:
- "answer" is a short, plain-language reply to the user's question. Always fill this in.
- "mergeIds" must be a subset of the candidate ids given to you, and must ONLY be non-empty when the user is genuinely asking to combine/merge cars into a single nameplate, or asking which cars belong to the same nameplate. Return an empty array otherwise.
- Only include a candidate id if it is genuinely another generation of the SAME nameplate as the target car — the same continuous model line under the same name. A different nameplate that merely shares a platform, is a rebadge, or is a sibling/related model is NOT the same nameplate and must never be included.
- Never invent an id that was not in the candidate list. If unsure, return an empty mergeIds array and say why in "reason".`;
  function buildModifyCarCandidates(nodes, node, limit) {
    const makeKey = norm(node.make);
    return nodes.filter(n => n.type === "model" && !n.retired && !n.familyOf &&
      n.id !== node.id && norm(n.make) === makeKey).slice(0, limit || 60);
  }
  async function askModifyCar(node, request, nodes) {
    const candidates = buildModifyCarCandidates(nodes, node);
    const list = candidates.map(c => `- id: ${c.id} | ${c.make} ${c.label}${c.year ? ` (${c.year}${c.end ? "–" + c.end : "–"})` : ""}`).join("\n") || "(none)";
    const raw = await askLlamaCpp([
      { role: "system", content: MODIFY_CAR_SYSTEM_PROMPT },
      { role: "user", content: `Target car: ${node.make} ${node.label}${node.year ? ` (${node.year}${node.end ? "–" + node.end : "–"})` : ""}\nWikipedia article on file: ${node.wp || "(none)"}\n\nUser's request: ${request}\n\nOther cars from the same manufacturer currently in the graph:\n${list}` },
    ], `${node.make} ${node.label} · ask`);
    const ids = Array.isArray(raw && raw.mergeIds) ? raw.mergeIds.filter(id => candidates.some(c => c.id === id)) : [];
    return { answer: (raw && raw.answer) || "", mergeIds: ids, reason: (raw && raw.reason) || "", raw };
  }

  // ---------- succession, pushed down to the specific generations it really describes ----------
  // Real user request: "The 'Succeeds' and 'Succeeded by' information and
  // the edge links should also be transferred to the generations of a
  // nameplate. They should only revert to the nameplate itself if there is
  // no proper reference to a specific generation. Currently the 'Succeeds'
  // and 'Succeeded by' information is still connected directly at the
  // nameplate level. Additionally, the 'Succeeds' and 'Succeeded by' should
  // only appear either on a nameplate level or a generation of a nameplate
  // level, but never double counted."
  //
  // Platform/related links already get pushed down to a specific generation
  // pair by the LLM disambiguation flow (checkRelation) -- succession never
  // did, because succession is the one relation type where no LLM call is
  // needed to know the answer. A succession is a statement about the ENDS of
  // two production runs: "the Nissan Cedric was succeeded by the Nissan
  // Fuga" can only mean the LAST Cedric generation handing over to the FIRST
  // Fuga generation. That's derivable outright from the year-ordered
  // generation lists already in the graph, with no guessing and no round
  // trip, so this resolves it deterministically for every succession link
  // touching a family.
  //
  // "Never double counted" comes for free by reusing the exact mirror
  // precedence every other rolled-up relation already uses (see app.js's
  // linkInLayer): the original nameplate-level link is tagged
  // mirror/mirrorSourceFam/mirrorTargetFam rather than removed, so it shows
  // while the nameplate is collapsed and steps aside for the specific
  // generation-level line the moment it's expanded -- one or the other,
  // never both. And "revert to the nameplate itself if there is no proper
  // reference to a specific generation" is the plain-model case: a side
  // that isn't a family has no generation to resolve to, so it simply stays
  // itself and the link is still made as specific as it can be on the side
  // that does.
  //
  // Idempotent and additive, same discipline as mirrorRelationLinks: safe to
  // re-run at boot and after any live mutation. An LLM-resolved
  // generation<->generation succession between the same two nameplates
  // always wins -- this never adds a competing derived link alongside one.
  function endGenerationOf(fam, byIdLocal, which) {
    const gens = (fam.generations || []).map(id => byIdLocal.get(id))
      .filter(g => g && !g.retired && g.year != null);
    if (!gens.length) return null;
    const sorted = [...gens].sort((a, b) => a.year - b.year);
    return which === "newest" ? sorted[sorted.length - 1] : sorted[0];
  }
  function pushSuccessionToGenerations(nodes, links) {
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    const belongsTo = (n, famId) => !!n && (n.id === famId || n.familyOf === famId);
    const toAdd = [];
    links.forEach(l => {
      if (l.type !== "succession" || l.mirror || l.retired || l.genLevel) return;
      const s = byIdLocal.get(idOf(l.source)), t = byIdLocal.get(idOf(l.target));
      if (!s || !t || s.retired || t.retired) return;
      if (s.type !== "family" && t.type !== "family") return; // nothing to push down on either side
      // A succession's own direction is predecessor -> successor (see
      // app.js's `verbs` map: source is "succeeded by", target "succeeds"),
      // so the predecessor's LAST generation hands over to the successor's
      // FIRST one.
      const sGen = s.type === "family" ? endGenerationOf(s, byIdLocal, "newest") : s;
      const tGen = t.type === "family" ? endGenerationOf(t, byIdLocal, "oldest") : t;
      if (!sGen || !tGen) return;                 // a family with no dateable generations -- leave it at the nameplate level
      if (sGen.id === s.id && tGen.id === t.id) return; // neither side resolved any further
      // Something more specific already connects these two nameplates --
      // either a previous run of this function, or (better) a real
      // LLM-resolved pair. Don't add a second, competing line; just make
      // sure the coarse original defers to it.
      const specific = links.find(o => o !== l && o.type === "succession" && !o.mirror && !o.retired &&
        belongsTo(byIdLocal.get(idOf(o.source)), s.id) && belongsTo(byIdLocal.get(idOf(o.target)), t.id));
      if (!specific) toAdd.push({ source: sGen.id, target: tGen.id, type: "succession", genLevel: true, note: l.note });
      // Tag the nameplate-level original so linkInLayer hides it as soon as
      // the relevant nameplate is expanded and the specific line is on
      // screen instead -- exactly the precedence platform/related mirrors
      // already use. Only a real family side is ever tagged (a plain model
      // has no "expanded" state of its own to key off).
      if (s.type === "family" && sGen.id !== s.id) l.mirrorSourceFam = s.id;
      if (t.type === "family" && tGen.id !== t.id) l.mirrorTargetFam = t.id;
      if (l.mirrorSourceFam || l.mirrorTargetFam) l.mirror = true;
    });
    toAdd.forEach(nl => links.push(nl));
    return toAdd.length;
  }

  // ---------- debug: reset the whole layer, or one entry at a time ----------
  // For re-running a test after a code change (like the extraction fixes
  // that shipped after the Dacia Logan first came back "none") without
  // hand-editing llm_families.json. Only actually writes anything when
  // serverAvailable (persist() itself no-ops otherwise) -- on a static
  // file:// build there's nowhere to write to, so the debug panel shows
  // these as read-only/inspect-only there.
  function allEntries() {
    return Object.keys(store.families).map(id => {
      const e = store.families[id];
      return { id, sourceTitle: e.sourceTitle || id, status: e.status, checkedAt: e.checkedAt };
    }).sort((a, b) => (a.sourceTitle || "").localeCompare(b.sourceTitle || ""));
  }
  // Same shape as allEntries() above, for the SEPARATE nameplate generation
  // cross-check layer (store.recheck) -- kept as its own list rather than
  // merged into allEntries() so the debug panel can label the two kinds
  // differently ("generation check" vs "generation list override"), but
  // uses the exact same {id, sourceTitle, status, checkedAt} shape so the
  // panel can render/sort them identically.
  function allRecheckEntries() {
    return Object.keys(store.recheck).map(id => {
      const e = store.recheck[id];
      return { id, sourceTitle: e.sourceTitle || id, status: e.status, checkedAt: e.checkedAt };
    }).sort((a, b) => (a.sourceTitle || "").localeCompare(b.sourceTitle || ""));
  }
  // Third persisted layer (store.relations, see checkRelation/
  // resolvePlatformMention) -- previously invisible in the debug panel
  // entirely, which is exactly how "Clear ALL" could look like it silently
  // didn't work: nothing here ever showed the user this layer even existed.
  // No human-readable sourceTitle is stored on a relation entry itself (just
  // the two involved node ids + relType) -- app.js already has the node
  // labels in memory via byId, so it formats the display text itself, same
  // division of labor the other two lists already use.
  function allRelationEntries() {
    if (!store.relations) return [];
    return Object.keys(store.relations).map(key => {
      const e = store.relations[key];
      return {
        id: key, famA: e.famA, famB: e.famB, relType: e.relType, status: e.status, checkedAt: e.checkedAt,
        // Real user request: "Within the 'unconfirmed relationships', for
        // each car there should also be an explanation by the LLM for why it
        // thinks the relationship exists which it found." The reason has
        // always been recorded on the entry (every discovery path writes one
        // -- an explicit chassis code, a verified quote, an ordinal count, a
        // sanity-check verdict, or the model's own words) but this summary
        // shape dropped it, so the standing Unconfirmed Relationships list
        // could only ever show a bare "A ↔ B (platform)" with no way to tell
        // WHY it was proposed short of navigating to the car itself. Carried
        // through now, along with the two specific generation codes, so a
        // decision can actually be made from that panel.
        reason: e.reason || null, codeA: e.codeA || null, codeB: e.codeB || null,
        genIdA: e.genIdA || null, genIdB: e.genIdB || null,
        // Both set only by the manual "LLM re-check" flow (reworkRelationsForFamily) --
        // `rework` marks a freshly (re)proposed provisional entry, `reworkPending`
        // marks an ALREADY-confirmed entry the re-check could no longer back up
        // (see retractConfirmedRelation/dismissRework and initUnconfirmedRelPanel).
        rework: e.rework || undefined, reworkPending: e.reworkPending || undefined,
      };
    }).sort((a, b) => (a.checkedAt || "").localeCompare(b.checkedAt || ""));
  }
  // Full (not summary) relation entries touching a given node id on either
  // side -- used by app.js's unresolvedFamilyRelations to surface a
  // resolvePlatformMention-discovered proposal (see its own comment) even
  // when there's no ordinary graph link yet for the adjacency-based scan to
  // find: resolvePlatformMention only ever writes into store.relations, it
  // never pushes a link into the live graph until the user actually
  // confirms it, so a purely adjacency-driven scan would leave that
  // proposal permanently unreachable -- never shown, never confirmable,
  // never rejectable, just silently stuck. This closes that gap.
  function relationsTouching(nodeId) {
    if (!store.relations) return [];
    return Object.keys(store.relations)
      .filter(key => { const e = store.relations[key]; return e.famA === nodeId || e.famB === nodeId; })
      .map(key => Object.assign({ key }, store.relations[key]));
  }
  // Removes every relation-resolution entry (see checkRelation/
  // resolvePlatformMention) that touches this specific nameplate/model id on
  // EITHER side. Deleting a checked-generation entry or a generation-list
  // override for a nameplate used to leave any relation the LLM had
  // specifically resolved for it sitting untouched in store.relations --
  // which meant it kept showing a "✓ resolved" confirmation (and kept
  // re-creating its now-orphaned generation<->generation link, referencing
  // generation ids the delete just undid) on every future boot, looking
  // exactly like "the delete/reset didn't actually work." "Sever exactly
  // all connections made to it and revert to its default connections" is
  // precisely this: once every LLM-specific resolution touching this id is
  // gone, all that's left is the plain, undisambiguated nameplate<->nameplate
  // fact it always had (see applyResolvedRelations, which only ever adds to
  // or retags a link -- never deletes the original -- so nothing further is
  // needed to "restore" it).
  // Real user request: "If a nameplate that was created by the LLM is
  // deleted and turns into a model, all of the relationships that were also
  // discovered by the LLM should also be severed and revert to their
  // previous state." Deleting the entries alone was never enough for that --
  // applyConfirmed/applySharedPlatformForSingleGen re-derive relations from
  // scratch on every boot, so anything this purge removed was liable to be
  // rediscovered and recreated immediately. Every purged pair is recorded in
  // rejectedRelations too (both at its own key and at the coarse nameplate
  // level), which is what makes the revert actually stick. clearRejectionsFor
  // below is the deliberate escape hatch: an explicit, user-initiated fresh
  // check on that same car wipes those suppressions first, so "delete, then
  // re-run the LLM on it" still rediscovers everything from scratch rather
  // than being permanently poisoned by an earlier delete.
  function purgeRelationsFor(id) {
    if (!store.relations) return;
    Object.keys(store.relations).forEach(key => {
      const e = store.relations[key];
      if (e.famA !== id && e.famB !== id) return;
      if (e.relType) {
        store.rejectedRelations[key] = true;
        if (e.famA && e.famB) store.rejectedRelations[relKey(e.famA, e.famB, e.relType)] = true;
      }
      delete store.relations[key];
    });
  }
  // Does this rejectedRelations key involve `id` -- either as one of its two
  // endpoints outright, or as a generation minted under it (applyConfirmed's
  // own `llm-<nodeId>-<code>` id convention)?
  function rejectionKeyTouches(key, id) {
    return String(key).split("|").some(part => part === id || part.startsWith("llm-" + id + "-"));
  }
  function clearRejectionsFor(id) {
    if (!id || !store.rejectedRelations) return 0;
    let n = 0;
    Object.keys(store.rejectedRelations).forEach(key => {
      if (!rejectionKeyTouches(key, id)) return;
      delete store.rejectedRelations[key];
      n++;
    });
    return n;
  }
  async function deleteEntry(nodeId) {
    const e = store.families[nodeId];
    // A confirmed nameplate that gets deleted here is saying "this isn't
    // really a separate generation split after all" -- but the designers/
    // engineers the LLM found on its Wikipedia article are still real
    // facts about the car, just no longer attached to a generation that no
    // longer exists. Keep a small tombstone with only those names (dropping
    // the heavier proposal/attempts/feedback/debug fields) so
    // applyConfirmed can fall back to crediting the plain model node
    // directly. Anything that never made it to "confirmed" (provisional,
    // none, error, no-wiki-link) never had real generation data to begin
    // with, so those stay a clean, total delete exactly as before.
    if (e && e.status === "confirmed" &&
        (((e.allDesigners || []).length) || ((e.allEngineers || []).length))) {
      store.families[nodeId] = {
        status: "deleted", deletedAt: new Date().toISOString(),
        sourceTitle: e.sourceTitle || null,
        allDesigners: e.allDesigners || [], allEngineers: e.allEngineers || [],
      };
    } else {
      delete store.families[nodeId];
    }
    purgeRelationsFor(nodeId);
    await persist();
  }
  async function resetAll() {
    store.families = {};
    // "Clear ALL" is meant to wipe this whole layer back to nothing (see the
    // module header) -- that has to include the generation-list-override
    // layer too, or a previously-applied override survives a Clear ALL +
    // reload with no way to tell it's still there (the bug this comment is
    // fixing: it had no presence in the debug panel at all before).
    store.recheck = {};
    // ...and the relation-resolution layer too (see purgeRelationsFor above
    // for the exact bug report this fixes: "Clear ALL" left every
    // previously-verified generation<->generation/nameplate match sitting in
    // store.relations, which then re-created its link and re-showed its "✓
    // resolved" confirmation on the very next boot -- looking exactly like
    // the reset silently didn't work).
    store.relations = {};
    // Same reasoning as above, one layer further down -- see rejectRelation.
    store.rejectedRelations = {};
    // A dismissed message referencing a now-wiped entry would just be dead
    // weight -- and per "Clear ALL" wiping this whole layer back to
    // nothing" (see the module header), dismissals are part of that layer
    // too now that they're persisted.
    store.dismissed = {};
    await persist();
  }
  // Recheck entries don't need deleteEntry()'s tombstone dance: an override
  // only ever REARRANGES/relabels nodes that already exist in the build-time
  // snapshot (cars.json/data.js) -- deleting the decision and reloading
  // naturally reverts to that untouched original data, no separate tombstone
  // required (unlike a from-scratch LLM generation SPLIT, which invents
  // brand-new nodes that don't exist anywhere else). The one edge case --
  // an override that minted a genuinely NEW generation node with no old
  // counterpart -- loses that node's own designer/engineer credit on
  // revert, same "provisional until truly kept" tradeoff rejectFamilyRecheck
  // already accepts for a never-applied proposal.
  async function deleteRecheckEntry(famId) {
    delete store.recheck[famId];
    // Same reasoning as deleteEntry's own purgeRelationsFor call: undoing a
    // generation-list override (this is exactly the BMW X3 case from the bug
    // report -- a build-time family, corrected via Feature 4, that had gone
    // on to get its own relation resolutions against BMW iX3/X4) should sever
    // every relation the LLM specifically resolved for this nameplate too,
    // not just the override decision itself.
    purgeRelationsFor(famId);
    await persist();
  }

  // ---------- nameplate generation cross-check (catches a wrong generation list on an EXISTING family) ----------
  // Everything above assumes a family's generation list, once grouped
  // (build-time) or confirmed (LLM), is trustworthy. It usually is -- but
  // build_family_layer.py's BARE-FOLD pass is deliberately permissive (see
  // its own comment), and the one case it's known to get wrong is a bare,
  // un-suffixed article ending up listed as its own "generation" even
  // though it's really just the nameplate itself, duplicated (e.g. a bare
  // "BMW X3" article folded in right alongside the real X3 (G01)/(F25)/...
  // generations). This asks the same local LLM to independently re-derive
  // the generation list from a fresh read of the article and compares it
  // against what's currently shown; a genuine discrepancy is surfaced to the
  // user as a provisional "override?" proposal, never applied automatically.
  function compareGenerations(fam, genNodes, freshGens) {
    const bareLabelNorm = norm(fam.label);
    const bogus = genNodes.find(g => {
      const label = String(g.label || "");
      const stripped = norm(label.replace(fam.label, ""));
      return norm(label) === bareLabelNorm || stripped === "";
    });
    if (bogus) {
      return `an existing "generation" here (${bogus.label}) is really just the bare nameplate itself, not a distinct generation`;
    }
    if (freshGens.length && freshGens.length !== genNodes.length) {
      return `Wikipedia currently describes ${freshGens.length} generation${freshGens.length === 1 ? "" : "s"}, but this nameplate currently shows ${genNodes.length} here`;
    }
    return null;
  }

  // Same code-normalized matching applyFamilyOverride itself uses to line a
  // fresh generation list up against the current one (see that function's
  // own `pairs`/`orphaned` computation) -- pulled out here as a read-only,
  // non-mutating helper so forceRecheckFamily below (and its UI) can show
  // "what would change" WITHOUT committing to it, the same way
  // compareGenerations' free-text summary already does but as a real
  // structured list instead of just a sentence.
  function diffGenerationCodes(genNodes, freshGens) {
    const usedOld = new Set();
    const addedFresh = [];
    (freshGens || []).forEach(g => {
      const key = norm(g.code);
      const match = (genNodes || []).find(o => !usedOld.has(o.id) && key && norm(o.label).includes(key));
      if (match) usedOld.add(match.id); else addedFresh.push(g);
    });
    const removedOld = (genNodes || []).filter(o => !usedOld.has(o.id));
    return { addedFresh, removedOld };
  }

  // Whether a nameplate's pending cross-check only ADDS generations: every
  // generation already on the nameplate is still in Wikipedia's list, and
  // Wikipedia names at least one more.
  //
  // Real user request: "If the llm looks at a nameplate and finds from the
  // wikipedia that there are more generations than currently listed, then
  // automatically accept those changes and do not need to ask for my manual
  // approval."
  //
  // Scoped deliberately to that one shape. applyFamilyOverride can also
  // RETIRE generations, and a re-check that drops one is either the model
  // misreading the article or a real editorial change -- both worth a human
  // look, and neither what was asked for. So a diff with anything in
  // removedOld still waits, as does a diff that changes nothing. The matching
  // is applyFamilyOverride's own code-normalised pairing (via
  // diffGenerationCodes), so "W463" still recognises "G-Class (W463)" and a
  // pure reformatting of an existing generation is not mistaken for a new one.
  function additiveRecheck(famId, genNodes, nodes) {
    const entry = recheckEntryFor(famId);
    if (!entry || entry.status !== "provisional") return null;
    const fresh = (entry.proposal && entry.proposal.generations) || [];
    if (!fresh.length) return null;
    const { addedFresh, removedOld } = diffGenerationCodes(genNodes, fresh);
    if (removedOld.length || !addedFresh.length) return null;
    // "Adds a generation" has a second shape that is not purely additive at
    // all: applyFamilyOverride does not always MINT the new generation. If the
    // car already exists somewhere else in the graph -- a never-grouped
    // standalone, or a generation under a different family -- it absorbs that
    // node and retires it (see findDuplicateGeneration/supersedeStandalone).
    // The Mercedes-Benz SL-Class R107 is the case on record. Nothing is lost
    // when that happens, but a car does disappear from where it was, and
    // deciding that is exactly the kind of call the user asked to keep.
    if (nodes) {
      const fam = nodes.find(n => n.id === famId);
      const absorbs = addedFresh.some(g =>
        !!findDuplicateGeneration(nodes, g.code, famId, fam && fam.make, fam && fam.label));
      if (absorbs) return null;
    }
    return { added: addedFresh.map(g => g.code), had: (genNodes || []).length, now: fresh.length };
  }

  // ---------- manual "LLM re-check": relation side ----------
  // Real user request: "...it should also be able to perform an 'LLM
  // re-check' in case the user has accidentally accepted or declined some
  // models, or if in general the user wants to 'refresh' the relationships
  // again... which includes the potential that the llm has re-checked the
  // relationships and has determined that certain matches actually don't
  // make sense." checkFamily/retryFamilyCheck (above) only ever diff this
  // family's own GENERATION list -- neither one re-examines a relation
  // that's already `"confirmed"`. This is that missing half: for every
  // confirmed platform/related link touching one of this family's
  // generations, see whether the FRESH read of the article still backs it
  // up, and if not, flag it (via `reworkPending` on the *same* stored
  // entry, never deleting/overwriting the confirmed link itself) for the
  // user to review in the Unconfirmed Relationships panel. It also
  // discovers genuinely NEW mentions on generations that survived the
  // diff, via the exact same resolveOnePlatformMention this file's normal
  // discovery flows already use -- tagging anything it produces `rework:
  // true` so the panel can label it "potential re-work" rather than an
  // ordinary first-time proposal.
  function reworkRelationsForFamily(fam, nodes, links, freshGens, removedOld) {
    const removedIds = new Set(removedOld.map(o => o.id));
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    const freshByCode = new Map();
    (freshGens || []).forEach(g => { const k = norm(g.code); if (k) freshByCode.set(k, g); });

    // Pass 1: does every EXISTING confirmed relation touching this family
    // still hold up against the fresh read?
    Object.keys(store.relations).forEach(key => {
      const e = store.relations[key];
      if (e.status !== "confirmed") return;
      // Succession included alongside platform/related as of the "re-check
      // should also check the relationships to other models (or
      // generations), as well as designers and engineers" request -- a
      // succession resolved to a specific generation pair can go stale in
      // exactly the same way (the generation it hangs off gets retired by
      // this same re-check, or the article stops naming the other car), and
      // there was no reason beyond oversight for it to be excluded here.
      if (e.relType !== "platform" && e.relType !== "related" && e.relType !== "succession") return;
      let ownGenId = null, otherGenId = null;
      if (e.famA === fam.id) { ownGenId = e.genIdA; otherGenId = e.genIdB; }
      else if (e.famB === fam.id) { ownGenId = e.genIdB; otherGenId = e.genIdA; }
      else return; // doesn't touch this family at all
      if (!ownGenId) return;
      if (removedIds.has(ownGenId)) {
        const own = byIdLocal.get(ownGenId);
        e.reworkPending = {
          kind: "remove", checkedAt: new Date().toISOString(),
          reason: `the generation this connected (${own ? own.label : ownGenId}) no longer appears in the current article -- this re-check would retire it`,
        };
        return;
      }
      const ownGenOld = byIdLocal.get(ownGenId);
      if (!ownGenOld) return;
      const fresh = freshByCode.get(norm(ownGenOld.label));
      if (!fresh) return; // couldn't confidently line this generation up with a fresh entry -- not enough signal either way, leave it alone
      const texts = Array.isArray(fresh.sharedPlatforms) ? fresh.sharedPlatforms
        : (fresh.sharedPlatform ? [fresh.sharedPlatform] : []);
      if (!texts.length) return; // the fresh read said nothing about shared platforms/related cars at all for this generation -- silence isn't evidence of anything, don't second-guess a real prior confirmation off an absence
      const otherNode = byIdLocal.get(otherGenId);
      const otherFamId = otherNode && (otherNode.familyOf || otherNode.id);
      const stillMentioned = texts.some(t => {
        const m = findMatchingNameplate(nodes, t, fam.id);
        return m && m.node && (m.node.id === otherGenId || m.node.id === otherFamId);
      });
      if (!stillMentioned) {
        e.reworkPending = {
          kind: "remove", checkedAt: new Date().toISOString(),
          reason: `the current article text no longer mentions ${otherNode ? (otherNode.make ? otherNode.make + " " + otherNode.label : otherNode.label) : "this car"} alongside ${ownGenOld.label} -- this re-check couldn't confirm the match still holds`,
        };
      } else if (e.reworkPending) {
        // A previous re-check flagged this, but the LATEST read confirms it
        // again -- clear the stale flag rather than leaving a resolved
        // concern sitting in the review queue.
        delete e.reworkPending;
      }
    });

    // Pass 2: any genuinely NEW mention on a generation that survived the
    // diff (i.e. wasn't just retired above)? Reuses the real
    // resolveOnePlatformMention matcher/minter so this benefits from every
    // trust-tier rule (exact match, explicit code, LLM sanity check, mint)
    // that mechanism already implements -- this pass only ever tags the
    // RESULT, never reimplements the matching itself.
    (freshGens || []).forEach(fresh => {
      const key = norm(fresh.code);
      const old = (genNodesFor(fam, byIdLocal) || []).find(o => !removedIds.has(o.id) && key && norm(o.label).includes(key));
      if (!old) return; // this fresh generation is a brand-new one this pass doesn't mint (that's applyFamilyOverride's job once the user accepts the generation diff) -- nothing to resolve relations against yet
      const gn = Object.assign({}, old, {
        sharedPlatformTexts: Array.isArray(fresh.sharedPlatforms) ? fresh.sharedPlatforms
          : (fresh.sharedPlatform ? [fresh.sharedPlatform] : []),
        sharedPlatformMatches: fresh.sharedPlatformMatches || {},
        makeVariantMatches: fresh.makeVariantMatches || {},
      });
      const keysBefore = new Set(Object.keys(store.relations));
      // The person asked for this re-check, so a loose mention it turns up
      // is surfaced for them to judge rather than dropped as an automatic
      // pass would drop it -- see surfaceLooseMatches. Synchronous call, and
      // the finally means the flag can never leak into an ordinary
      // background pass even if the matcher throws.
      surfaceLooseMatches = true;
      try { resolvePlatformMention(nodes, links, fam.id, gn); }
      finally { surfaceLooseMatches = false; }
      Object.keys(store.relations).forEach(k => {
        if (keysBefore.has(k)) return; // pre-existing entry, not something this pass just produced
        const e = store.relations[k];
        if (e.status === "provisional") e.rework = true; // auto-confirmed ones stay silent per the same "no need to report unless genuinely unsure" rule the sanity-check auto-approval already follows
      });
    });
  }
  // ---------- manual "LLM re-check": designer/engineer side ----------
  // Real user request: "When doing the LLM Re-check on a model or a
  // nameplate, it should also check the relationships to other models (or
  // generations), as well as designers and engineers associated with the
  // cars." reworkRelationsForFamily above covers the relationship half; this
  // is the people half, which the re-check previously ignored entirely --
  // a fresh read could turn up a chief engineer or a styling credit the
  // original check missed (or that Wikipedia has since gained) and it just
  // went nowhere.
  //
  // Deliberately ADDITIVE only, and applied straight away rather than
  // queued for review. A credit that survived validate()'s hallucination
  // guard is, by construction, a name stated verbatim in the article text
  // next to that generation -- the same bar every credit already in the
  // graph had to clear. Adding one takes nothing away and contradicts
  // nothing, so there's no decision for a human to make; REMOVING a credit
  // on the strength of a fresh read not mentioning it would be a different
  // matter entirely (silence isn't evidence of absence -- the same
  // reasoning reworkRelationsForFamily's pass 1 already applies to
  // relations), so this never does that. Credits are wired onto the
  // specific generation AND rolled up to the nameplate, exactly as
  // applyConfirmed does, so the family-level line stays correct while
  // collapsed.
  function applyFreshPeopleCredits(fam, nodes, links, freshGens, removedOld) {
    const removedIds = new Set((removedOld || []).map(o => o.id));
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    const genNodes = genNodesFor(fam, byIdLocal).filter(g => !removedIds.has(g.id) && !g.retired);
    const added = [];
    const famDesigners = new Set(fam.designers || []);
    const famEngineers = new Set(fam.engineers || []);
    (freshGens || []).forEach(fresh => {
      const key = norm(fresh.code);
      if (!key) return;
      const gen = genNodes.find(o => norm(o.label).includes(key));
      if (!gen) return; // a brand-new generation this pass doesn't mint -- that's applyFamilyOverride's job once the diff is accepted
      [["designer", "designed", fresh.designers, famDesigners],
       ["engineer", "engineered", fresh.engineers, famEngineers]].forEach(([role, linkType, names, famSet]) => {
        (Array.isArray(names) ? names : []).forEach(name => {
          const p = resolvePersonNode(nodes, byIdLocal, name, role);
          if (!p) return;
          const own = new Set(gen[role === "designer" ? "designers" : "engineers"] || []);
          if (!own.has(name)) {
            own.add(name);
            gen[role === "designer" ? "designers" : "engineers"] = [...own];
            added.push({ generation: gen.label, role, name });
          }
          famSet.add(name);
          if (!links.some(l => l.type === linkType && idOf(l.source) === gen.id && idOf(l.target) === p.id)) {
            links.push({ source: gen.id, target: p.id, type: linkType, llmDiscovered: true });
          }
          // Family-level rollup, same as applyConfirmed's famPersonLinks --
          // so the credit still shows on the collapsed nameplate dot.
          if (!links.some(l => l.type === linkType && idOf(l.source) === fam.id && idOf(l.target) === p.id)) {
            links.push({ source: fam.id, target: p.id, type: linkType, llmDiscovered: true });
          }
        });
      });
    });
    fam.designers = [...famDesigners];
    fam.engineers = [...famEngineers];
    return added;
  }

  // currentGenNodes lives in app.js (it has byId); this file only ever sees
  // whatever genNodes array its caller already built, so mirror that same
  // (fam.generations || []).map(...).filter(Boolean) shape locally rather
  // than depending on app.js at all -- llm_families.js has no reference to
  // app.js's own byId map.
  function genNodesFor(fam, byIdLocal) {
    return (fam.generations || []).map(id => byIdLocal.get(id)).filter(Boolean);
  }

  // ---------- manual "LLM re-check": entry point ----------
  // Unlike checkFamily/retryFamilyCheck (both of which only ever run ONCE
  // per family -- see their own `if (existing) return` short-circuit),
  // this deliberately ignores whatever's already in store.recheck[fam.id]
  // and always performs a brand-new Wikipedia fetch + LLM call, no matter
  // how settled the existing entry is ("applied", "none", mid-review,
  // whatever). That's the whole point of a user-triggered "re-check at any
  // time" button, per the real user request quoted above
  // reworkRelationsForFamily. The GENERATION side of the result is written
  // in the exact same shape checkFamily/retryFamilyCheck already produce
  // (status/proposal/discrepancy/attempts/feedback/debug), so the existing
  // renderFamilyDiscrepancy Accept/Reject UI and applyFamilyOverride apply
  // logic need no changes at all to handle it -- only the brand-new
  // RELATION side (reworkRelationsForFamily) is genuinely new plumbing.
  // Deliberately does NOT gate the persist on `engagedId === fam.id` the
  // way checkFamily/retryFamilyCheck's "provisional" branch does -- that
  // guard exists to stop a PASSIVE background scan from writing a stale
  // proposal for a nameplate the user has since browsed away from while
  // several checks race each other. This is the opposite situation: a
  // single explicit button click on a nameplate the user is looking at
  // right now, so its result is worth keeping even if they've since
  // navigated elsewhere by the time the LLM responds.
  function forceRecheckFamily(fam, genNodes, nodes, links) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    if (!fam.wp) {
      // Persisted (mirrors checkNode's own no-wiki-link handling) so the
      // paste-a-link UI (see app.js's renderFamilyNoWikiLink) has something
      // stable to render instead of re-running this check on every render.
      const entry = { status: "no-wiki-link", checkedAt: new Date().toISOString() };
      store.recheck[fam.id] = entry; persist();
      return Promise.resolve(entry);
    }
    const flightKey = "recheck:" + fam.id;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    // "Re-check the whole car from scratch" has to include the powertrain
    // side, and the engine scan's own records are what would otherwise make
    // it a no-op: every generation already scanned is skipped, misses
    // included. See clearEngineScansFor.
    const engineScansCleared = clearEngineScansFor(fam, genNodes);
    note(`re-check: ${fam.label} from scratch -- forgetting ${engineScansCleared} stored ` +
         "engine scan(s) and every earlier rejection, so both get rediscovered");
    const p = (async () => {
      try {
        const { wp, wikitext, clean, raw, dropped } = await runCheck(fam, null, null, undefined, nodes);
        const discrepancy = compareGenerations(fam, genNodes, clean.generations);
        const { addedFresh, removedOld } = diffGenerationCodes(genNodes, clean.generations);
        const entry = {
          status: (discrepancy || addedFresh.length || removedOld.length) ? "provisional" : "none",
          checkedAt: new Date().toISOString(),
          sourceTitle: wp, proposal: clean, discrepancy,
          attempts: 1, feedback: [],
          engines: engineMentions(wikitext),
          debug: { raw, dropped },
          manualRecheck: true,
          engineScansCleared,
          generationDiff: { addedCodes: addedFresh.map(g => g.code), removedIds: removedOld.map(o => o.id) },
        };
        store.recheck[fam.id] = entry;
        // An explicit, user-initiated re-check is the deliberate escape
        // hatch out of any earlier delete's permanent suppression (see
        // purgeRelationsFor/clearRejectionsFor): "delete this nameplate's
        // relationships, then re-run the LLM on it" should genuinely
        // rediscover them from scratch rather than silently finding
        // everything blacklisted. Cleared BEFORE reworkRelationsForFamily
        // below, which is what does the rediscovering.
        clearRejectionsFor(fam.id);
        reworkRelationsForFamily(fam, nodes, links, clean.generations, removedOld);
        entry.peopleAdded = applyFreshPeopleCredits(fam, nodes, links, clean.generations, removedOld);
        await persist();
        return entry;
      } catch (e) {
        const entry = { status: "error", checkedAt: new Date().toISOString(), error: String(e.message || e), attempts: 1, manualRecheck: true };
        store.recheck[fam.id] = entry; await persist();
        return entry;
      } finally {
        inFlight.delete(flightKey);
      }
    })();
    inFlight.set(flightKey, p);
    return p;
  }

  // ---------- research ONE generation, against its OWN Wikipedia article ----------
  // Real user request, in full: "it says that the Mercedes E Class W211 is
  // related to the mercedes C class. If I look further into the Mercedes
  // E Class W211 wikipedia page which is the one representing the
  // generation, it shows many more related cars: CLK-Class (C209),
  // CLS-Class (C219), Chrysler 300, Dodge Charger (LX/LD), Dodge Magnum,
  // SsangYong Chairman (Second generation). So, it would be actually worth
  // checking if there exists a separate wikipedia page for each of these
  // generations, and then use that wikipedia page for the LLM to read
  // through and get a better understanding of all of the relationships.
  // Additionally, the user should also be able to do an LLM search on an
  // individual generation as well... Even if there might be a wikipedia
  // page associated with this submodel, the LLM should try and see if
  // there's a more specific wikipedia page and replace it with that."
  //
  // Every existing check in this file is aimed at a NAMEPLATE: it reads the
  // nameplate's overview article and splits it into generations. That's
  // exactly the wrong article for this question. An LLM-minted generation
  // inherits its parent's `wp` (applyConfirmed: `wp: (dup && dup.wp) ||
  // orig.wp`), so W211 has always pointed at the general "Mercedes-Benz
  // E-Class" page -- whose infobox names one or two related cars for the
  // nameplate as a whole, while the dedicated "Mercedes-Benz W211" article
  // lists six. Nothing ever went and read the specific one.
  //
  // This does both halves: upgrade the generation's own `wp` to its
  // dedicated article when one genuinely exists, then run the ordinary
  // check machinery against THAT text. Everything discovered flows through
  // the same trust tiers as any other discovery -- validate()'s
  // hallucination guard, resolveOnePlatformMention's exact/loose/
  // sanity-checked matching, minting for a genuinely-new car -- so nothing
  // here is a second, weaker discovery path; it's the existing one, pointed
  // at better source material.
  function isEligibleForGenerationResearch(n) {
    return !!n && n.type === "model" && !!n.familyOf && !n.retired;
  }
  function genResearchEntryFor(nodeId) { return store.genResearch[nodeId] || null; }
  // Candidate titles for a generation's own dedicated article, most
  // specific first. Wikipedia files these under several conventions --
  // "Mercedes-Benz W211" (bare chassis code), "Audi A4 (B9)" (nameplate +
  // parenthetical code), "Ford Focus (third generation)" -- so all the
  // plausible shapes are tried rather than betting on one. A candidate only
  // counts if it resolves to a genuinely DIFFERENT article from the one the
  // generation already uses; a guess that just redirects back to the
  // nameplate overview page is no upgrade at all (see fetchArticleDigest's
  // resolvedTitle).
  // ---------- engines: reading an engine article ----------
  // Real user request: "the link to, for example, the engine M256 contains
  // information about the variants of that motor - this should be like the
  // 'nameplate' equivalent for the main page, but now we use the engines and
  // transmissions as the 'nameplates'. M256 also contains information about
  // the cars which contain these engines."
  //
  // Written against the real Mercedes-Benz M256 and BMW N55 articles, which
  // agree on shape: an {{Infobox automobile engine}}, a table of variants with
  // power/torque/years, then one sub-section per variant whose body is a
  // bulleted list of the cars that got it. What they disagree about is
  // everything else, and the disagreements are the whole job:
  //
  //   - The link target is not always the car. The M256's
  //     "[[Austro-Daimler|Austro Daimler Bergmeister PHEV]]" points at the
  //     COMPANY; the car's name is only in the display text. Matching on the
  //     target alone would wire an engine to a manufacturer article.
  //   - The target often carries a section anchor:
  //     "[[Mercedes-Benz S-Class (W223)#Technical data|S 400 L/S 450 L]]".
  //   - One M256 entry is not a bullet at all: an image got glued to the front
  //     of the line, so "[[File:IAA 2021...]]2018-2023 [[...CLS-Class
  //     (C257)|...]]" has no "*" and opens with a File link.
  //   - One entry is commented out with <!-- --> and must stay out.
  //   - Not every sub-heading is a variant. The N55 article also has
  //     "=== 272 kW version ===", "=== Alpina ===", and an entire SECOND
  //     engine ("== S55 engine =="). Requiring the heading to carry the
  //     engine's own name keeps all three out without a list of exceptions.
  const ENGINE_INFOBOX_RE = /\{\{\s*Infobox\s+automobile\s+engine\b/i;

  function isEngineArticle(wikitext) { return ENGINE_INFOBOX_RE.test(String(wikitext || "")); }

  // The infobox as a plain field map. Brace-counted, because a field value
  // routinely contains {{convert}} and a naive split on "|" tears it apart.
  function engineInfobox(wikitext) {
    const src = String(wikitext || "");
    const m = ENGINE_INFOBOX_RE.exec(src);
    if (!m) return null;
    let i = m.index + 2, depth = 1;
    while (i < src.length && depth > 0) {
      if (src.startsWith("{{", i)) { depth++; i += 2; continue; }
      if (src.startsWith("}}", i)) { depth--; i += 2; continue; }
      i++;
    }
    const body = src.slice(m.index + m[0].length, i - 2);
    const out = {};
    let depth2 = 0, buf = "";
    const push = () => {
      const eq = buf.indexOf("=");
      if (eq > 0) out[buf.slice(0, eq).trim().toLowerCase()] = buf.slice(eq + 1).trim();
      buf = "";
    };
    for (let k = 0; k < body.length; k++) {
      const two = body.substr(k, 2);
      if (two === "{{" || two === "[[") { depth2++; buf += two; k++; continue; }
      if (two === "}}" || two === "]]") { depth2--; buf += two; k++; continue; }
      if (body[k] === "|" && depth2 <= 0) { push(); continue; }
      buf += body[k];
    }
    push();
    return out;
  }

  function stripEngineMarkup(s) {
    return String(s || "")
      .replace(/<ref[^>]*\/?>[\s\S]*?<\/ref>|<ref[^>]*\/>/gi, "")
      .replace(/\[\[\s*(?:File|Image)\s*:[^\]]*\]\]/gi, "")
      // {{convert}} and {{cvt}} carry the actual number, so they are unwrapped
      // rather than dropped: an infobox is mostly these, and stripping them
      // wholesale left a displacement field reading "<br/>".
      .replace(/\{\{\s*c(?:onvert|vt)\s*\|([^{}]*)\}\}/gi, (m0, args) => {
        const parts = args.split("|").map(x => x.trim()).filter(x => x && !/=/.test(x));
        return parts.length >= 2 ? parts[0] + " " + parts[1] : (parts[0] || "");
      })
      .replace(/\{\{[^{}]*\}\}/g, "")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m0, t, d) => d || t)
      .replace(/<[^>]+>/g, " ")
      .replace(/'{2,}/g, "")
      .replace(/^[*#:;\s]+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // One "* 2020-present [[Target|Display]] (note)" line.
  const APP_YEARS_RE = /(\d{4})\s*[-–—]\s*(\d{4}|present|Present)?/;
  function parseApplicationLine(raw) {
    let line = String(raw || "");
    if (!line.trim()) return null;
    line = line.replace(/<ref[^>]*\/?>[\s\S]*?<\/ref>|<ref[^>]*\/>/gi, "")
               .replace(/\{\{\s*(?:citation needed|cn)[^{}]*\}\}/gi, "")
               .replace(/\[\[\s*(?:File|Image)\s*:[^\]]*\]\]/gi, "");
    const link = line.match(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/);
    if (!link) return null;
    const target = link[1].trim();
    const display = (link[2] || link[1]).trim();
    if (!target || /^(?:File|Image|Category)\s*:/i.test(target)) return null;
    const ys = APP_YEARS_RE.exec(line);
    const note = (line.match(/\(([^()]*only[^()]*)\)/i) || [])[1] || null;
    return {
      target,
      display: display.replace(/\s+/g, " ").trim(),
      // BMW keeps the trim OUTSIDE the link ("[[...|F10/F11/F07]] 535i"), so
      // the whole line's plain text is kept too: it is what says which car,
      // in the cases where the target is only a company.
      text: stripEngineMarkup(line),
      yearStart: ys ? Number(ys[1]) : null,
      yearEnd: ys && ys[2] && /^\d/.test(ys[2]) ? Number(ys[2]) : null,
      note: note ? note.trim() : null,
    };
  }

  function engineApplications(body) {
    const src = String(body || "").replace(/<!--[\s\S]*?-->/g, "");
    const out = [];
    const seen = new Set();
    src.split(/\n/).forEach(line => {
      if (!/\[\[/.test(line)) return;
      if (/^\s*[!|]/.test(line)) return;          // a wikitable row, not an application
      if (!APP_YEARS_RE.test(line)) return;       // every real entry opens with a year
      const e = parseApplicationLine(line);
      if (!e) return;
      const key = norm(e.target) + "|" + norm(e.display);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    });
    return out;
  }

  // The engine's own variants, as sections. `name` is its short name ("M256",
  // "N55") -- a heading has to carry it to count.
  function engineVariants(wikitext, name) {
    const key = norm(name || "");
    const secs = wikitextSections(wikitext);
    const out = [];
    for (const sec of secs) {
      const t = norm(sec.title);
      if (!key || !t.startsWith(key) || t === key) continue;
      out.push({ code: sec.title.replace(/\s+/g, " ").trim(),
                 applications: engineApplications(sec.body) });
    }
    return out;
  }

  // The whole article, in the shape the engine layer stores.
  function readEngineArticle(wikitext, name) {
    const info = engineInfobox(wikitext) || {};
    // The short name is what every variant heading is prefixed with ("M256 E30
    // DEH LA GR"), so it has to come out as "M256" whether this was called
    // with the article TITLE ("Mercedes-Benz M256 engine"), the infobox name
    // ("Mercedes-Benz M256") or the bare code. Leaving the word "engine" on
    // the end silently matched no heading at all and reported an engine with
    // no variants -- which reads exactly like an article that has none.
    const short = String(name || info.name || "")
      .replace(/\s+engines?$/i, "")
      .replace(/^[A-Z][A-Za-z-]*\s+(?=[A-Za-z]{0,2}\d)/, "")
      .trim();
    const variants = engineVariants(wikitext, short);
    // No variant sections at all still means applications -- they just sit in
    // the article body. Same fallback the nameplate side uses for a car that
    // turns out to have only one generation.
    const loose = variants.length ? [] : engineApplications(wikitext);
    return {
      name: stripEngineMarkup(info.name || name || ""),
      shortName: short,
      manufacturer: stripEngineMarkup(info.manufacturer || ""),
      production: stripEngineMarkup(info.production || ""),
      configuration: stripEngineMarkup(info.configuration || ""),
      displacement: stripEngineMarkup(info.displacement || ""),
      predecessor: stripEngineMarkup(info.predecessor || ""),
      successor: stripEngineMarkup(info.successor || ""),
      variants,
      applications: loose,
    };
  }

  // ---------- engines: matching an application to a car in the graph ----------
  // Real user request, on which end of a nameplate an engine hangs off:
  // "specify to the nameplate's generation. Fallback is to specify to the
  // nameplate itself, but don't do both. For example, if m256 appears in e
  // class, w213, and w214, then only have it connect to w213 and w214. So
  // long as one generation is mentioned, never connect the engine to the main
  // nameplate but only the gen."
  //
  // That rule is per NAMEPLATE, not per article, which is what makes it
  // awkward on real data. The M256 links the same GLE three different ways in
  // one page -- "Mercedes GLE#Fourth generation (W167/C167; 2018)",
  // "Mercedes-Benz M-Class" and "Mercedes-Benz GLE-Class" -- because Wikipedia
  // renamed the article twice and both old titles still redirect. Applying
  // the rule to the titles as written would hang the engine off the GLE
  // nameplate AND off one of its generations at once, which is exactly what
  // was asked against. So every target is resolved through its redirects
  // first, and the grouping is done on the node each one lands on.
  const ENGINE_ID_PREFIX = "eng-";
  const ENGINE_VARIANT_ID_PREFIX = "engv-";
  function engineIdFor(name) { return ENGINE_ID_PREFIX + slugify(name); }
  function engineVariantIdFor(engineId, code) {
    return ENGINE_VARIANT_ID_PREFIX + engineId.slice(ENGINE_ID_PREFIX.length) + "-" + slugify(code);
  }

  // A car's nameplate: the family it belongs to, itself when it IS one, and
  // itself again when it is an ungrouped standalone -- a car that was never
  // split has no generation level to prefer.
  function nameplateOfCar(node, byId) {
    if (!node) return null;
    if (node.familyOf) return byId.get(node.familyOf) || node;
    return node;
  }
  function isGenerationNode(node) { return !!(node && node.familyOf); }

  // Resolve one application entry to a car already in the graph. Returns the
  // node, or null if nothing matches -- minting is the caller's business,
  // since only it knows whether this engine is allowed to create cars.
  function carForApplication(app, byId, byWp, resolvedTitle) {
    const wp = resolvedTitle || app.target;
    const hit = byWp.get(norm(wp));
    if (hit) return hit;
    // The display text is the only place the car's name exists when the link
    // points at a company (the M256's Austro-Daimler Bergmeister). Try it as
    // "<make> <model>" against what is already here before giving up.
    const spaced = String(app.display || "").replace(/\s+/g, " ").trim();
    if (!spaced) return null;
    const byLabel = byWp.get(norm(spaced));
    return byLabel || null;
  }

  // The whole set of edges one engine should have, with the generation rule
  // applied. `resolve` maps a Wikipedia title to the title it redirects to;
  // `mint` creates a car for an application that matched nothing, and may
  // return null to decline.
  // The network half, kept separate so the boot replay can skip it entirely:
  // every title an engine's applications name, mapped to what it redirects to.
  async function resolveApplicationTitles(applications, resolve) {
    const out = new Map();
    if (!resolve) return out;
    const titles = [...new Set((applications || []).map(a => a.target).filter(Boolean))];
    for (const t of titles) {
      let r = null;
      try { r = await resolve(t); } catch (e) { r = null; }
      out.set(t, r || t);
    }
    return out;
  }

  async function planEngineEdges(applications, nodes, opts) {
    const o = opts || {};
    const resolved = await resolveApplicationTitles(applications, o.resolve);
    return planEngineEdgesWith(applications, nodes, resolved, o.mint);
  }

  // Everything after the titles are known. Synchronous on purpose: app.js
  // replays this layer at boot, in the same breath as applyConfirmed, and
  // has to have every engine node in `nodes` before it builds its indexes.
  function planEngineEdgesWith(applications, nodes, resolvedTitles, mintFn) {
    const resolved = resolvedTitles || new Map();
    const mint = mintFn || (() => null);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const byWp = new Map();
    for (const n of nodes) {
      if (n.wp) byWp.set(norm(n.wp), n);
      if (n.type === "model" || n.type === "family") {
        const full = ((n.make ? n.make + " " : "") + n.label).trim();
        if (full && !byWp.has(norm(full))) byWp.set(norm(full), n);
      }
    }
    const placed = [];
    for (const app of applications) {
      let node = carForApplication(app, byId, byWp, resolved.get(app.target));
      if (!node) {
        node = mint(app) || null;
        if (node) {
          byId.set(node.id, node);
          if (node.wp) byWp.set(norm(node.wp), node);
          byWp.set(norm(((node.make ? node.make + " " : "") + node.label).trim()), node);
        }
      }
      if (!node) continue;
      // A link that lands on a MAKE is not an application -- it is the
      // company article standing in for a car nobody wrote a page for. The
      // mint path above is what turns those into cars; if it declined, drop
      // the entry rather than hanging an engine off a manufacturer.
      if (node.type === "make" || node.type === "person") continue;
      placed.push({ app, node, from: app.__from || null });
    }

    // The rule, applied per nameplate -- across the WHOLE engine, not per
    // variant. That distinction is the rule: the M256's variants name the
    // E-Class only ever as W213 or W214, but an engine whose first variant
    // said "E-Class" and whose second said "W213" would, grouped per variant,
    // end up attached at both levels at once. Which is the thing the user
    // asked against, in those words: "so long as one generation is mentioned,
    // never connect the engine to the main nameplate but only the gen".
    const byNameplate = new Map();
    for (const p of placed) {
      const np = nameplateOfCar(p.node, byId);
      const key = np ? np.id : p.node.id;
      if (!byNameplate.has(key)) byNameplate.set(key, []);
      byNameplate.get(key).push(p);
    }
    const out = [];
    const seen = new Set();
    for (const [, group] of byNameplate) {
      const gens = group.filter(p => isGenerationNode(p.node));
      const keep = gens.length ? gens : group;
      for (const p of keep) {
        // One edge per (variant, car). Two variants that both went into the
        // same car are two real facts, not a duplicate.
        const k = (p.from || "") + "|" + p.node.id;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(p);
      }
    }
    return out;
  }

  // ---------- engines: putting one into the graph ----------
  // The powertrain side mirrors the nameplate side deliberately, node for node
  // and link for link, so that merging, renaming, un-merging and the
  // additive-recheck rule all work on it without a second copy of any of them:
  //
  //   engine      <-> family        an M256
  //   enginevar   <-> model/gen     an "M256 E30 DEH LA GR"
  //   enginegen   <-> generation    the link between the two
  //   fitted      <-> (new)         an engine or variant, to a car
  //
  // `fitted` is the one genuinely new edge, and it is the whole point: it is
  // what carries "this engine went in that car".
  // What to call a car that only exists as an application entry. The display
  // text is the name, but the marque has to be split off it, and splitting on
  // the first space gets that wrong exactly where it matters: "Austro Daimler
  // Bergmeister PHEV" becomes an "Austro" called "Daimler Bergmeister PHEV".
  // The link target is the missing piece -- it points at [[Austro-Daimler]],
  // the company -- so where the display text starts with the target's own
  // words, the target's spelling is restored as the marque.
  function carNameFromApplication(app) {
    const display = String((app && app.display) || "").replace(/\s+/g, " ").trim();
    if (!display) return null;
    const target = String((app && app.target) || "").replace(/\s+/g, " ").trim();
    if (!target) return display;
    const dn = norm(display), tn = norm(target);
    if (!tn || !dn.startsWith(tn) || dn === tn) return display;
    // Walk the display's words until they account for the target, then keep
    // the target's own hyphenation and drop those words from the rest.
    let acc = "", words = display.split(" "), i = 0;
    for (; i < words.length; i++) {
      acc += words[i];
      if (norm(acc) === tn) { i++; break; }
      if (norm(acc).length > tn.length) return display;
    }
    const rest = words.slice(i).join(" ").trim();
    return rest ? target + " " + rest : display;
  }

  function engineNodeFrom(article, title) {
    const label = String(article.name || article.shortName || title || "").trim();
    if (!label) return null;
    // From the TITLE, not the label: a mention of this engine on some car's
    // page knows only the article title, and both have to land on one node.
    const id = engineIdFromTitle(title || label);
    const yearMatch = /(\d{4})/.exec(article.production || "");
    const endMatch = /(\d{4})\s*[-–—]\s*(\d{4})/.exec(article.production || "");
    return {
      id, type: "engine", label,
      make: article.manufacturer || null,
      wp: title || label,
      year: yearMatch ? Number(yearMatch[1]) : null,
      end: endMatch ? Number(endMatch[2]) : null,
      configuration: article.configuration || null,
      displacement: article.displacement || null,
      llmGenerated: true,
      variants: [],
    };
  }

  // Apply a read engine article to the live graph. Idempotent: every branch
  // either finds what is already there or creates it once, so the boot replay
  // and a fresh scan land in the same place. Returns what it did.
  async function applyEngineArticle(article, title, nodes, links, opts) {
    const o = opts || {};
    const flatApps = []
      .concat(...((article.variants || []).map(v => v.applications || [])))
      .concat(article.applications || []);
    const resolved = await resolveApplicationTitles(flatApps, o.resolve);
    return applyEngineArticleWith(article, title, nodes, links, resolved, o);
  }

  function applyEngineArticleWith(article, title, nodes, links, resolvedTitles, opts) {
    const o = opts || {};
    const byId = new Map(nodes.map(n => [n.id, n]));
    const eng = (() => {
      const draft = engineNodeFrom(article, title);
      if (!draft) return null;
      const existing = byId.get(draft.id);
      if (existing) {
        // Fill only what is empty, the same discipline the live layer used.
        ["make", "wp", "year", "end", "configuration", "displacement"].forEach(k => {
          if (!existing[k] && draft[k]) existing[k] = draft[k];
        });
        return existing;
      }
      nodes.push(draft); byId.set(draft.id, draft);
      return draft;
    })();
    if (!eng) return { engine: null, variants: 0, fitted: 0, minted: [] };

    const linkKey = new Set();
    for (const l of links) {
      const s0 = typeof l.source === "string" ? l.source : l.source && l.source.id;
      const t0 = typeof l.target === "string" ? l.target : l.target && l.target.id;
      linkKey.add(s0 + "|" + t0 + "|" + l.type);
      linkKey.add(t0 + "|" + s0 + "|" + l.type);
    }
    const addLink = (a, b, type, extra) => {
      if (!a || !b || a === b) return false;
      const k = a + "|" + b + "|" + type;
      if (linkKey.has(k)) return false;
      linkKey.add(k); linkKey.add(b + "|" + a + "|" + type);
      links.push(Object.assign({ source: a, target: b, type, llmGenerated: true }, extra || {}));
      return true;
    };

    const minted = [];
    const mint = app => {
      if (!o.mintCars) return null;
      const name = carNameFromApplication(app);
      if (!name) return null;
      const n = mintRelatedNode(nodes, links, name, null, eng.id);
      if (n) minted.push(n);
      return n;
    };

    let variantCount = 0, fittedCount = 0;
    // Every application the engine has, tagged with the variant it belongs to,
    // so the nameplate rule can be applied to all of them at once and the
    // surviving edges still know where to hang.
    const flat = [];
    if (article.variants && article.variants.length) {
      eng.variants = eng.variants || [];
      let prev = null;
      for (const v of article.variants) {
        const vid = engineVariantIdFor(eng.id, v.code);
        let vn = byId.get(vid);
        if (!vn) {
          vn = { id: vid, type: "enginevar", label: v.code, make: eng.make || null,
                 engineOf: eng.id, wp: eng.wp, llmGenerated: true, year: null, end: null };
          nodes.push(vn); byId.set(vid, vn);
          variantCount++;
        }
        vn.engineOf = eng.id;
        if (eng.variants.indexOf(vid) < 0) eng.variants.push(vid);
        addLink(eng.id, vid, "enginegen");
        // Variants run in article order, which is the order they were
        // introduced -- the same succession the generation side draws.
        if (prev) addLink(prev, vid, "enginesucc");
        prev = vid;
        (v.applications || []).forEach(a => flat.push(Object.assign({}, a, { __from: vid })));
      }
    }
    // An engine with no variant sections still has cars; they hang off the
    // engine itself, exactly as a single-generation nameplate's do.
    (article.applications || []).forEach(a => flat.push(Object.assign({}, a, { __from: eng.id })));

    const cars = [];
    if (flat.length) {
      const edges = planEngineEdgesWith(flat, nodes, resolvedTitles, mint);
      const seenCar = new Set();
      for (const e of edges) {
        if (addLink(e.from || eng.id, e.node.id, "fitted",
                    { yearStart: e.app.yearStart || null, yearEnd: e.app.yearEnd || null,
                      note: e.app.note || null })) fittedCount++;
        if (!seenCar.has(e.node.id)) { seenCar.add(e.node.id); cars.push(e.node); }
      }
    }

    return { engine: eng, variants: variantCount, fitted: fittedCount, minted, cars };
  }

  // ---------- engines: the stored layer ----------
  // Same contract as every other layer in this file: the decision is stored,
  // the graph is rebuilt from it at boot, and data.js is never touched. An
  // engine scan is therefore undoable by deleting its entry, and a rebuild
  // cannot clobber it.
  function engineEntryFor(id) { return store.engines[id] || null; }
  function allEngineEntries() {
    return Object.keys(store.engines).map(id => {
      const e = store.engines[id];
      return { id, sourceTitle: e.sourceTitle || id, status: e.status, checkedAt: e.checkedAt,
               variants: ((e.article && e.article.variants) || []).length };
    }).sort((a, b) => (a.sourceTitle || "").localeCompare(b.sourceTitle || ""));
  }
  function deleteEngineEntry(id) { delete store.engines[id]; return persist(); }

  // Follow every title to the article it actually serves. Engine pages link
  // the same car under titles left behind by two renames; without this the
  // nameplate rule sees three different cars. Cached per call, since one page
  // names the same article a dozen times.
  function redirectResolver() {
    const seen = new Map();
    return async title => {
      if (seen.has(title)) return seen.get(title);
      let out = title;
      try { out = (await fetchArticleDigest(title)).resolvedTitle || title; }
      catch (e) { out = title; }
      seen.set(title, out);
      return out;
    };
  }

  // Read one engine article and put it in the graph. `title` is a Wikipedia
  // article title. Everything it finds is stored, so this is the only place
  // that needs the network.
  function checkEngine(title, nodes, links, opts) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    const flightKey = "engine:" + norm(title);
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const p = (async () => {
      try {
        const { wikitext, resolvedTitle } = await fetchArticleDigest(title);
        if (!isEngineArticle(wikitext)) {
          return { status: "not-an-engine", title: resolvedTitle || title };
        }
        const article = readEngineArticle(wikitext, title);
        const id = engineIdFromTitle(resolvedTitle || title);
        const flatApps = []
          .concat(...((article.variants || []).map(v => v.applications || [])))
          .concat(article.applications || []);
        // Resolved ONCE, here, and stored with the entry. Every later boot
        // replays from this rather than asking Wikipedia again, which is what
        // lets the replay be synchronous -- and also means a redirect that
        // changes later cannot silently move an existing edge.
        const resolved = await resolveApplicationTitles(flatApps, redirectResolver());
        const entry = {
          status: "confirmed", checkedAt: new Date().toISOString(),
          sourceTitle: resolvedTitle || title, article,
          resolved: [...resolved.entries()],
        };
        store.engines[id] = entry;
        await persist();
        const applied = applyEngineArticleWith(article, entry.sourceTitle, nodes, links,
          resolved, opts || {});
        // Depth 1: every car this engine named now gets the ordinary check.
        // Opt-outable, because the boot replay and the tests have no business
        // starting a dozen model calls.
        const queued = (opts && opts.cascade === false)
          ? 0 : scheduleEngineCascade(id, applied.cars, nodes);
        return Object.assign({ status: "confirmed", id, entry, queued }, applied);
      } catch (e) {
        return { status: "error", error: String((e && e.message) || e) };
      } finally {
        inFlight.delete(flightKey);
      }
    })();
    inFlight.set(flightKey, p);
    return p;
  }

  // Every car an engine named, handed to the ordinary generation check.
  //
  // Real user request: "For all of the cars listed there, the LLM should check
  // if the car already exists or not. Regardless, it should also automatically
  // do an LLM check on whichever car is connected to this engine, as if it's
  // doing an LLM check on the car as well. Once again, it should use the
  // cascade matching that within serve.py so that it doesn't get out of
  // control."
  //
  // So it goes through schedulePartnerCheck, the same queue and the same
  // budget a shared-platform partner uses -- not a second path with its own
  // rules. The engine is the origin at depth 0, which puts its cars at depth
  // 1: they get the full check (is this a nameplate, what are its generations,
  // who drew it), and THEIR partners and engines are depth 2 and are recorded
  // but never followed. That is the shape the user chose when asked where to
  // stop.
  //
  // A car that is already a generation of a split nameplate is skipped, and
  // schedulePartnerCheck would skip it anyway: there is no "is this a
  // nameplate" question left to ask about a car that is already inside one.
  function scheduleEngineCascade(engineId, cars, nodes) {
    if (!serverAvailable || !backgroundAllowed) return 0;
    if (!engineId || !cars || !cars.length) return 0;
    // An engine the user deliberately asked to read is the origin, exactly as
    // a car they clicked is. Without this the cars compute a depth from
    // whatever happened to be engaged and the budget refuses them.
    cascadeDepth.set(engineId, 0);
    if (!engagedId) engagedId = engineId;
    let queued = 0;
    for (const car of cars) {
      if (!car || car.retired) continue;
      if (car.type !== "model" || car.familyOf) continue;
      if (entryFor(car.id)) continue;
      schedulePartnerCheck(car, nodes, engineId);
      queued++;
    }
    return queued;
  }

  // Replayed at boot, next to applyConfirmed and applyAllFamilyOverrides.
  // Every engine already scanned is put back into the graph from what was
  // stored, with no network: the article was already read once.
  // Every engine a checked car mentioned, put back into the graph at boot.
  // Stored on the car's own entry (see checkNode), so this needs no network
  // and nothing to re-read: a mention is a fact about the car, recorded when
  // the car was checked.
  function applyEngineMentions(nodes, links) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    let engines = 0, fitted = 0;
    const replay = (carId, hits) => {
      const car = byId.get(carId);
      if (!car || car.retired || !hits || !hits.length) return;
      const r = recordEngineMentionsFrom(hits, car, nodes, links);
      engines += r.engines; fitted += r.fitted;
      r.added.forEach(n => byId.set(n.id, n));
    };
    Object.keys(store.families || {}).forEach(id => replay(id, (store.families[id] || {}).engines));
    Object.keys(store.recheck || {}).forEach(id => replay(id, (store.recheck[id] || {}).engines));
    // genResearch is keyed by GENERATION id, and is the bucket that actually
    // has engines in it for a split nameplate -- see researchGeneration.
    Object.keys(store.genResearch || {}).forEach(id => replay(id, (store.genResearch[id] || {}).engines));
    Object.keys(store.engineScans || {}).forEach(id => replay(id, (store.engineScans[id] || {}).engines));
    return { engines, fitted };
  }

  function applyEngines(nodes, links) {
    const ids = Object.keys(store.engines || {});
    if (!ids.length) return { engines: 0, variants: 0, fitted: 0 };
    let variants = 0, fitted = 0, engines = 0;
    for (const id of ids) {
      const entry = store.engines[id];
      if (!entry || entry.status !== "confirmed" || !entry.article) continue;
      // No network and no minting. A boot replay cannot wait on Wikipedia --
      // app.js builds its indexes on the next line -- and every car this
      // engine reached was either already in the graph or minted the first
      // time round, which means it is in the overlay and already back.
      // The stored titles are what the first pass resolved them to, so the
      // redirects are already followed.
      const r = applyEngineArticleWith(entry.article, entry.sourceTitle, nodes, links,
                                       new Map(entry.resolved || []), {});
      if (r.engine) engines++;
      variants += r.variants; fitted += r.fitted;
    }
    return { engines, variants, fitted };
  }

  // ---------- engines: what a car's own article says it had ----------
  // Real user request: "The user can either select a car and have the LLM
  // search it normally, after which the information about the engine also gets
  // revealed. New nodes (in a new graph view) will appear with all of the
  // engines that came up, but they will not get researched."
  //
  // So this is the cheap half: read the car's infobox, note which engines it
  // names, and put them in the graph unresearched. No article is followed --
  // that only happens when the engine itself is scanned.
  //
  // The real Mercedes-Benz E-Class (W213) infobox is the shape to survive:
  //
  //   | engine = {{ubl
  //     | '''[[Petrol engine|Petrol]]:'''
  //     | 3.0&nbsp;L ''[[Mercedes-Benz M256 engine|M256]]'' turbo [[Straight-six engine|I6]]
  //     | 2.0&nbsp;L ''[[Mercedes-Benz M270/M274 engine#M274 DE20 LA|M274]]'' turbo I4
  //     | 3.0&nbsp;L ''M256'' mild hybrid turbo I6
  //
  // Nearly every link on those lines ends in "engine" and nearly none of them
  // is one: "Petrol engine", "Straight-six engine", "V8 engine" are the fuel
  // and the layout. What separates a real one is that its title carries a
  // model code -- M256, OM654, N55 -- which is also why the generic ones can
  // be excluded by rule rather than by a list that would need maintaining.
  const GENERIC_ENGINE_TITLE = /^(?:petrol|diesel|gasoline|hybrid|electric|steam|rotary|piston|internal[\s-]combustion|reciprocating|two[\s-]stroke|four[\s-]stroke|mild hybrid)$/i;
  const LAYOUT_ENGINE_TITLE = /^(?:(?:straight|inline|flat|boxer|slant|vee)[\s-]?\w*|[vwbihrlu][\s-]?\d{1,2}|\d{1,2}[\s-]?cylinder)$/i;

  // "Mercedes-Benz M256 engine" -> a real engine; "V8 engine" -> not one.
  function looksLikeEngineArticleTitle(title) {
    const t = String(title || "").split("#")[0].trim();
    if (!t) return false;
    const m = /^(.*?)\s+engines?$/i.exec(t);
    const core = (m ? m[1] : t).trim();
    if (!core) return false;
    if (GENERIC_ENGINE_TITLE.test(core) || LAYOUT_ENGINE_TITLE.test(core)) return false;
    // A real engine article is named for a code, and a code has a digit in it.
    // Without the " engine" suffix a title has to earn it some other way, so
    // only suffixed ones qualify here -- "BMW N55" is reached by scanning it
    // directly, not by being mentioned.
    if (!m) return false;
    return /\d/.test(core);
  }

  // The id an engine gets, from the article title rather than whatever short
  // name a mention happened to display. "Mercedes-Benz M256 engine" and the
  // infobox's own "Mercedes-Benz M256" have to land on the SAME node, or
  // scanning a car and then scanning its engine would produce two.
  function engineIdFromTitle(title) {
    const t = String(title || "").split("#")[0].trim().replace(/\s+engines?$/i, "");
    return engineIdFor(t || title || "");
  }

  // Every engine a car's article names, as {title, name, variant}.
  function engineMentions(wikitext) {
    const src = String(wikitext || "");
    // EVERY engine field, not just the first. A merged, single-article
    // nameplate gives each generation its own infobox -- the Mercedes-Benz
    // G-Class is the case already on record for years and designers -- and
    // reading only the first one would report the engines of whichever era
    // happens to come first in the document.
    const fields = [];
    const fieldRx = /\|\s*engines?\s*=/gi;
    let m;
    while ((m = fieldRx.exec(src))) {
      let i = m.index + m[0].length, depth = 0, end = src.length;
      for (; i < src.length; i++) {
        const two = src.substr(i, 2);
        if (two === "{{" || two === "[[") { depth++; i++; continue; }
        if (two === "}}" || two === "]]") {
          if (depth === 0) { end = i; break; }
          depth--; i++; continue;
        }
        if (src[i] === "|" && depth === 0 && /^\|\s*[a-z_]+\s*=/i.test(src.slice(i, i + 40))) { end = i; break; }
      }
      fields.push(src.slice(m.index + m[0].length, end));
    }
    if (!fields.length) return [];
    const field = fields.join("\n");
    const out = [];
    const seen = new Set();
    const rx = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
    let l;
    while ((l = rx.exec(field))) {
      const raw = l[1].trim();
      if (!looksLikeEngineArticleTitle(raw)) continue;
      const title = raw.split("#")[0].trim();
      const anchor = raw.indexOf("#") >= 0 ? raw.slice(raw.indexOf("#") + 1).trim() : null;
      const name = (l[2] || title).replace(/''+/g, "").trim();
      const key = norm(title) + "|" + norm(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, name, variant: anchor || null });
    }
    return out;
  }

  // Put those mentions in the graph, unresearched, connected to this car.
  // Idempotent, and deliberately incapable of following anything: an engine
  // node minted here carries `unresearched` until checkEngine reads its
  // article, which is what stops one car scan from pulling in the whole
  // powertrain of every marque it touches.
  function recordEngineMentions(wikitext, carNode, nodes, links) {
    return recordEngineMentionsFrom(engineMentions(wikitext), carNode, nodes, links);
  }
  function recordEngineMentionsFrom(mentions, carNode, nodes, links) {
    if (!carNode) return { engines: 0, fitted: 0, added: [] };
    if (!mentions || !mentions.length) return { engines: 0, fitted: 0, added: [] };
    const byId = new Map(nodes.map(n => [n.id, n]));
    const linkKey = new Set();
    for (const l of links) {
      const s0 = typeof l.source === "string" ? l.source : l.source && l.source.id;
      const t0 = typeof l.target === "string" ? l.target : l.target && l.target.id;
      linkKey.add(s0 + "|" + t0 + "|" + l.type);
      linkKey.add(t0 + "|" + s0 + "|" + l.type);
    }
    let engines = 0, fitted = 0;
    const added = [];
    for (const mention of mentions) {
      const id = engineIdFromTitle(mention.title);
      let n = byId.get(id);
      if (!n) {
        n = { id, type: "engine", label: mention.name || mention.title, wp: mention.title,
              make: null, year: null, end: null, llmGenerated: true, unresearched: true,
              variants: [] };
        nodes.push(n); byId.set(id, n); added.push(n);
        engines++;
      }
      // Keep the article title even on a node that already existed: a mention
      // is often the first place it is known.
      if (!n.wp) n.wp = mention.title;
      const k = n.id + "|" + carNode.id + "|fitted";
      if (!linkKey.has(k)) {
        linkKey.add(k); linkKey.add(carNode.id + "|" + n.id + "|fitted");
        links.push({ source: n.id, target: carNode.id, type: "fitted",
                     llmGenerated: true, fromCar: true,
                     variantHint: mention.variant || null });
        fitted++;
      }
    }
    return { engines, fitted, mentions, added };
  }

  // ---------- engines: merging two into one ----------
  // Real user request: "It is also possible in this step to merge some of the
  // engines together, if they are all M256 but some are older generations than
  // other, for example. Alternatively, they should be able to be merged in the
  // future, like a nameplate (remember this functionality should work the same
  // as for regular nameplates)."
  //
  // The same SHAPE as a nameplate merge -- members fold in, their generations
  // join the primary's, the husk is retired rather than deleted, the decision
  // is stored and replayed at boot, and undoing it is deleting that record.
  // Not the same CODE: applyOneMerge requires a plain model of a matching
  // marque and mints a generation stand-in for the primary out of the car it
  // already was. None of that maps -- an engine often has no marque at all,
  // and its variants come from its own article rather than from the node
  // being a car in its own right. Bending it to fit would have cost more than
  // the sixty lines below and made both harder to follow.
  function applyOneEngineMerge(nodes, links, primaryId, rec) {
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    const primary = byIdLocal.get(primaryId);
    if (!primary || primary.retired || primary.type !== "engine") return false;
    const members = (rec.memberIds || [])
      .map(id => byIdLocal.get(id))
      .filter(m => m && !m.retired && m.type === "engine" && m.id !== primaryId);
    if (!members.length) return false;

    const linkKey = new Set();
    for (const l of links) {
      const s0 = typeof l.source === "string" ? l.source : l.source && l.source.id;
      const t0 = typeof l.target === "string" ? l.target : l.target && l.target.id;
      linkKey.add(s0 + "|" + t0 + "|" + l.type);
    }
    const addLink = (a, b, type, extra) => {
      if (!a || !b || a === b) return;
      const k = a + "|" + b + "|" + type;
      if (linkKey.has(k) || linkKey.has(b + "|" + a + "|" + type)) return;
      linkKey.add(k);
      links.push(Object.assign({ source: a, target: b, type, llmGenerated: true }, extra || {}));
    };

    primary.variants = primary.variants || [];
    members.forEach(m => {
      const own = (m.variants || []).map(id => byIdLocal.get(id)).filter(v => v && !v.retired);
      if (own.length) {
        // Its variants become the primary's, keeping their own ids so every
        // fitted edge already pointing at them still lands.
        own.forEach(v => {
          v.engineOf = primary.id;
          if (primary.variants.indexOf(v.id) < 0) primary.variants.push(v.id);
          addLink(primary.id, v.id, "enginegen");
        });
      } else {
        // An engine nobody has read has no variants of its own. It becomes one
        // -- which is what "some are older generations than other" means when
        // the older one was never more than a name on a car's infobox.
        const vid = engineVariantIdFor(primary.id, m.label || m.id);
        if (!byIdLocal.get(vid)) {
          const vn = { id: vid, type: "enginevar", label: m.label, make: m.make || primary.make || null,
                       engineOf: primary.id, wp: m.wp || primary.wp, llmGenerated: true,
                       fromMergedEngine: m.id, year: m.year || null, end: m.end || null };
          nodes.push(vn); byIdLocal.set(vid, vn);
        }
        if (primary.variants.indexOf(vid) < 0) primary.variants.push(vid);
        addLink(primary.id, vid, "enginegen");
        // Everything the husk was fitted to now hangs off that variant, so no
        // connection is lost by the merge.
        links.forEach(l => {
          if (l.type !== "fitted" || l.retired) return;
          const s0 = typeof l.source === "string" ? l.source : l.source && l.source.id;
          const t0 = typeof l.target === "string" ? l.target : l.target && l.target.id;
          if (s0 === m.id) { l.source = vid; if (l.sn) l.sn = byIdLocal.get(vid); }
          else if (t0 === m.id) { l.target = vid; if (l.tn) l.tn = byIdLocal.get(vid); }
        });
      }
      // Retired, never spliced out -- anything holding its id keeps working,
      // and undoing the merge is a flag flip rather than a rebuild. Same
      // discipline as every other retirement in this file.
      m.retired = true;
      m.supersededBy = primary.id;
      m.retiredReason = "merged into " + (primary.label || primary.id);
      m.variants = [];
      // The primary keeps whatever it already knew and gains what it did not.
      ["make", "wp", "configuration", "displacement"].forEach(k => {
        if (!primary[k] && m[k]) primary[k] = m[k];
      });
      if (m.year && (!primary.year || m.year < primary.year)) primary.year = m.year;
    });
    return true;
  }

  function mergeEngines(primaryId, memberIds, nodes, links) {
    // Accumulated, not replaced. Folding a second engine in later is a second
    // decision about the same primary, and overwriting the record would
    // silently un-merge the first one at the next boot -- the graph would look
    // right for the rest of the session and wrong after a reload, which is the
    // worst shape a bug can have.
    const prior = (store.engineMerges[primaryId] || {}).memberIds || [];
    const rec = {
      memberIds: [...new Set(prior.concat(memberIds || []).filter(id => id && id !== primaryId))],
      mergedAt: new Date().toISOString(),
    };
    if (!rec.memberIds.length) return { ok: false, error: "no other engine selected to merge in" };
    const before = store.engineMerges[primaryId];
    store.engineMerges[primaryId] = rec;
    const ok = applyOneEngineMerge(nodes, links, primaryId, rec);
    if (!ok) {
      if (before) store.engineMerges[primaryId] = before; else delete store.engineMerges[primaryId];
      return { ok: false, error: "none of the selected engines could be merged (retired, already merged, or not engines)" };
    }
    persist();
    const primary = nodes.find(n => n.id === primaryId);
    return { ok: true, variants: ((primary && primary.variants) || []).length };
  }

  function undoEngineMerge(primaryId) {
    delete store.engineMerges[primaryId];
    return persist();
  }
  function allEngineMerges() {
    return Object.keys(store.engineMerges || {})
      .map(id => Object.assign({ id }, store.engineMerges[id]));
  }
  function applyEngineMerges(nodes, links) {
    if (!store.engineMerges || !Object.keys(store.engineMerges).length) return 0;
    let n = 0;
    Object.keys(store.engineMerges).forEach(primaryId => {
      const rec = store.engineMerges[primaryId];
      if (!rec || rec.status === "undone") return;
      try { if (applyOneEngineMerge(nodes, links, primaryId, rec)) n++; }
      catch (e) { console.warn("LlmFamilies: could not apply engine merge for " + primaryId, e); }
    });
    return n;
  }

  // ---------- engines: the pass that actually finds them ----------
  // Real bug report: "I ran an llm check on the mercedes E class... there
  // didn't appear to be any information in the terminal on serve.py, nor was
  // there any indication that there was any powertrain research performed...
  // even when clicking the 'powertrain' tab it says nothing is scanned yet."
  //
  // Correct behaviour, wrong hook. The engines were being read off whichever
  // article the GENERATION CHECK happened to fetch, and for a nameplate that
  // is the umbrella page -- which does not list engines at all. The real
  // Mercedes-Benz E-Class article has no engine field anywhere in it; its
  // W213 generation article names nine. So a check on the nameplate most
  // worth asking about found nothing, every time, and said so by staying
  // silent.
  //
  // This is the pass that goes where the engines are: each generation's OWN
  // article. It needs no model call -- an infobox field is a regex, not a
  // judgement -- so the whole cost is one Wikipedia fetch per generation,
  // which is the same fetch findGenerationArticle already makes to decide
  // which article that is.
  function engineScanEntryFor(id) { return store.engineScans[id] || null; }

  // Forget what a car's engine scan concluded, so the next scan genuinely
  // goes and reads the article again. A recorded "no-article" or
  // "unreadable" miss is deliberately sticky -- without that, every check of
  // a nameplate pays several fetches to reach the same dead end forever (see
  // scanEnginesFor). The cost is that a miss recorded while an article was
  // briefly unreachable, or before anyone had written it, is permanent, and
  // a plain re-check silently skips that car. An explicit 🔄 LLM Re-check is
  // the escape hatch, exactly as it already is for a deleted relationship's
  // permanent suppression (see clearRejectionsFor).
  function clearEngineScansFor(node, genNodes) {
    if (!node) return 0;
    const ids = [node.id].concat((genNodes || []).map(g => g && g.id).filter(Boolean),
                                 (node.generations || []));
    let n = 0;
    for (const id of new Set(ids)) {
      if (store.engineScans[id]) { delete store.engineScans[id]; n++; }
    }
    return n;
  }

  // Which article to read a car's engines out of. For a generation that is
  // its own article, not the nameplate's: a minted generation inherits the
  // nameplate's `wp` (see applyFamilyOverride), so reading gen.wp would fetch
  // the umbrella again and find nothing, which is precisely the bug.
  // `famWikitext` is the nameplate's article, fetched once by the caller.
  // Deliberately the section reader alone, not findGenerationArticle: that one
  // also brute-forces title shapes, which costs several failed fetches per
  // generation and would make reading the engines of a six-generation
  // nameplate a few dozen round trips. The section reader is one regex over
  // wikitext already in hand, and on real articles it is the one that works --
  // the E-Class states every generation's article in a hatnote.
  function engineArticleFor(car, fam, famWikitext) {
    if (!car) return null;
    const famWp = fam && fam.wp;
    const isGeneration = !!(car.familyOf || (fam && fam !== car));
    if (isGeneration) {
      if (famWikitext) {
        const tc = trailingCode(String(car.label || ""));
        const code = tc && tc.code;
        const sec = code ? sectionForCode(famWikitext, code) : null;
        const stated = sec ? (hatnoteArticle(sec.body) || proseArticle(sec.body, car.make, code)) : null;
        if (stated && (!famWp || norm(stated) !== norm(famWp))) return stated;
      }
      // No article of its own. Reading the nameplate's again would be a wasted
      // round trip for a page already known to say nothing here.
      if (!car.wp || (famWp && norm(car.wp) === norm(famWp))) return null;
    }
    return car.wp || null;
  }

  // Read the engines for one car, or for every generation of a nameplate.
  // Done once per car and remembered, so re-opening a nameplate is free.
  async function scanEnginesFor(node, nodes, links) {
    const out = { engines: 0, fitted: 0, scanned: 0, skipped: 0 };
    if (!serverAvailable || !node) return out;
    const byIdLocal = new Map(nodes.map(n => [n.id, n]));
    const fam = node.type === "family" ? node
              : (node.familyOf ? byIdLocal.get(node.familyOf) : null);
    const targets = node.type === "family"
      ? (node.generations || []).map(id => byIdLocal.get(id)).filter(Boolean)
      : [node];
    // The nameplate's own article, read ONCE for the whole pass: it is what
    // says where each generation's article is, and fetching it per generation
    // would be the same page six times.
    const pending = targets.filter(c => c && !c.retired && !store.engineScans[c.id]);
    if (!pending.length) return out;
    note(`powertrain: reading engines for ${node.label} -- ` +
         `${pending.length} article(s) to check (no model call, infobox only)`);
    let famWikitext = null;
    if (fam && fam.wp) {
      try { famWikitext = (await fetchArticleDigest(fam.wp)).wikitext; } catch (e) { famWikitext = null; }
    }
    for (const car of targets) {
      if (!car || car.retired) continue;
      if (store.engineScans[car.id]) { out.skipped++; continue; }
      let title = null;
      try { title = engineArticleFor(car, fam, famWikitext); } catch (e) { title = null; }
      // A miss is recorded too. Finding a generation's article costs several
      // fetches (findGenerationArticle tries each title shape in turn), and a
      // car whose article does not exist would pay that on every single check
      // of its nameplate, forever, for the same answer. Clearing it is what
      // the deliberate re-check does.
      if (!title) {
        store.engineScans[car.id] = {
          checkedAt: new Date().toISOString(), sourceTitle: null, status: "no-article", engines: [],
        };
        note(`powertrain: ${car.label} -- no article of its own to read engines from`);
        out.scanned++; out.skipped++;
        continue;
      }
      let wikitext = null;
      try { wikitext = (await fetchArticleDigest(title)).wikitext; } catch (e) { wikitext = null; }
      // Recorded on failure too, for the same reason a miss is: the nameplate
      // states an article that does not exist (a red link, or one written
      // since), and without this every later check of that nameplate fetches
      // it again to get the same 404. Cleared by a deliberate re-check.
      if (!wikitext) {
        store.engineScans[car.id] = {
          checkedAt: new Date().toISOString(), sourceTitle: title,
          status: "unreadable", engines: [],
        };
        note(`powertrain: ${car.label} -- could not read "${title}"`);
        out.scanned++; out.skipped++;
        continue;
      }
      const hits = engineMentions(wikitext);
      store.engineScans[car.id] = {
        checkedAt: new Date().toISOString(), sourceTitle: title, engines: hits,
      };
      note(`powertrain: ${car.label} -- ${hits.length} engine(s) in "${title}"`);
      // Worth keeping even when the article named no engine: it is also the
      // generation's own page, which is a better link than the nameplate's.
      if (title && (!car.wp || (fam && fam.wp && norm(car.wp) === norm(fam.wp)))) {
        car.wp = title;
        store.wpLinks[car.id] = title;
      }
      out.scanned++;
      const r = recordEngineMentionsFrom(hits, car, nodes, links);
      out.engines += r.engines; out.fitted += r.fitted;
    }
    if (out.scanned) await persist();
    note(`powertrain: ${node.label} done -- ${out.engines} engine(s), ` +
         `${out.fitted} connection(s) from ${out.scanned} article(s)`);
    return out;
  }

  // ---------- reading the link a generation's own section points at ----------
  // Real user request: "not all the info about each generation exists within
  // this page, but there are links in each of the sections where the
  // generations are given a summary. Those links are where the actual
  // information exists about that given generation... there are many links on
  // this page, and the only actual relevant ones are the ones that come right
  // after the description of a particular generation, so context matters in
  // which link is followed."
  //
  // Two article shapes, confirmed against real ones rather than assumed:
  //
  //   Volkswagen Golf -- the umbrella nameplate. Every generation heading is
  //     followed on the next line by a hatnote naming the article outright:
  //       == Fourth generation (Mk4/A4, ''Typ'' 1J; 1997) ==
  //       {{Main article|Volkswagen Golf Mk4}}
  //     Nothing has to be guessed, and "context matters" solves itself: the
  //     hatnote is the only link in that position.
  //
  //   Mercedes-Benz E-Class -- no hatnotes anywhere. The per-generation
  //     articles are linked from the section's running prose, among many
  //     links that are not the article (4Matic, catalytic converter, Motor
  //     Trend). Guessing the title works here, because the articles are named
  //     "Mercedes-Benz E-Class (W213)" -- which is exactly the shape
  //     findGenerationArticle below already tries, and exactly the shape the
  //     Golf's "Volkswagen Golf Mk4" is not.
  //
  // So the two are complements, not alternatives: read the section first,
  // guess second. Everything here is deterministic -- no model call is needed
  // to decide which link is the right one, which also means no model can get
  // it wrong.

  // Split wikitext into sections, keyed by heading text. A section runs from
  // its heading to the next heading at the SAME OR HIGHER level, so a
  // generation's own sub-headings stay part of it.
  function wikitextSections(wikitext) {
    const out = [];
    const rx = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
    const heads = [];
    let m;
    while ((m = rx.exec(wikitext))) {
      heads.push({ level: m[1].length, raw: m[2], at: m.index, end: m.index + m[0].length });
    }
    heads.forEach((h, i) => {
      let stop = wikitext.length;
      for (let j = i + 1; j < heads.length; j++) {
        if (heads[j].level <= h.level) { stop = heads[j].at; break; }
      }
      // Headings carry anchors and italics: "<span class="anchor" id="A4">
      // </span>Fourth generation (Mk4/A4, ''Typ'' 1J; 1997)".
      const title = h.raw.replace(/<[^>]*>/g, "").replace(/'{2,}/g, "").trim();
      out.push({ title, level: h.level, body: wikitext.slice(h.end, stop) });
    });
    return out;
  }

  // The article a hatnote in this section names, if any. {{Main}},
  // {{Main article}} and {{Further}} all take the title as their first
  // positional argument. Only the section's own opening is considered -- a
  // {{Main}} deeper inside belongs to a sub-topic (the Golf's
  // "{{Main|Volkswagen e-Golf}}" sits under its own sub-heading), not to the
  // generation.
  function hatnoteArticle(body) {
    const head = String(body || "").slice(0, 600);
    const m = head.match(/\{\{\s*(?:main|main article|further)\s*\|\s*([^|{}\n]+?)\s*(?:\||\}\})/i);
    if (!m) return null;
    const t = m[1].trim();
    if (!t || /^[a-z]/.test(t) && !/\s/.test(t)) return null;   // {{main|section-name}} style self-reference
    return t.split("#")[0].trim() || null;
  }

  // No hatnote: score the section's own wiki-links. The right one names the
  // nameplate and the generation's code ("Mercedes-Benz E-Class (W213)"),
  // sits early, and is not one of the dozens of incidental links. Anything
  // that does not carry the code is refused outright rather than guessed at
  // -- a wrong article here is worse than none, since the whole point is to
  // read facts out of it.
  function proseArticle(body, make, code) {
    if (!code) return null;
    const key = norm(code);
    if (!key) return null;
    const mk = norm(make || "");
    const links = [];
    const rx = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = rx.exec(body))) links.push({ title: m[1].trim(), at: m.index });
    for (const l of links) {
      const t = norm(l.title);
      if (!t.includes(key)) continue;
      if (mk && !t.includes(mk)) continue;     // same marque, or it is some other car entirely
      return l.title;
    }
    return null;
  }

  // The generation section of `wikitext` that belongs to this generation,
  // matched on its code the same way applyFamilyOverride pairs a fresh
  // generation list against the current one.
  function sectionForCode(wikitext, code) {
    if (!code) return null;
    const key = norm(code);
    if (!key) return null;
    const secs = wikitextSections(wikitext);
    // Longest heading match loses to the most specific one: "Mk4" appears in
    // both "Fourth generation (Mk4/A4...)" and "Extended production (Mk4.5)",
    // and the first is the one that owns the generation.
    let best = null;
    for (const sec of secs) {
      if (!norm(sec.title).includes(key)) continue;
      if (!best || sec.level < best.level) best = sec;
    }
    return best;
  }

  // Public entry point: the article THIS generation's section points at,
  // read from the nameplate's article. Null when the section says nothing.
  async function articleFromNameplateSection(gen, famWp, famLabel) {
    if (!famWp) return null;
    const tc = trailingCode(String(gen.label || ""));
    const code = tc && tc.code;
    if (!code) return null;
    let wikitext;
    try { wikitext = (await fetchArticleDigest(famWp)).wikitext; }
    catch (e) { return null; }
    const sec = sectionForCode(wikitext, code);
    if (!sec) return null;
    return hatnoteArticle(sec.body) || proseArticle(sec.body, gen.make, code) || null;
  }

  async function findGenerationArticle(gen, famLabel, currentWp, famWp) {
    const make = String(gen.make || "").trim();
    const label = String(gen.label || "").trim();
    const tc = trailingCode(label);
    const code = tc && tc.code ? tc.code : null;
    const base = (tc && tc.base) || famLabel || label;
    const seen = new Set();
    const candidates = [];
    const push = t => { const s = String(t || "").replace(/\s+/g, " ").trim(); if (s && !seen.has(s)) { seen.add(s); candidates.push(s); } };
    if (code) {
      push(`${make} ${code}`);             // "Mercedes-Benz W211"
      push(`${make} ${base} (${code})`);   // "Audi A4 (B9)"
      push(`${base} (${code})`);
      push(code);                          // "W211" on its own (redirects are followed)
    }
    push(`${make} ${label}`);
    push(label);
    let currentResolved = null;
    if (currentWp) {
      try { currentResolved = (await fetchArticleDigest(currentWp)).resolvedTitle; }
      catch (e) { currentResolved = currentWp; }
    }
    const isUpgrade = t => t && norm(t) !== norm(currentResolved || "") && norm(t) !== norm(famLabel ? `${make} ${famLabel}` : "");
    // What the nameplate's own article says, before anything is guessed --
    // see articleFromNameplateSection. The Volkswagen Golf names
    // "Volkswagen Golf Mk4" outright, and none of the shapes below would
    // ever have produced it.
    const stated = await articleFromNameplateSection(gen, famWp, famLabel);
    if (stated) {
      let resolved = null;
      try { resolved = (await fetchArticleDigest(stated)).resolvedTitle; }
      catch (e) { resolved = null; }
      if (isUpgrade(resolved)) return resolved;
    }
    for (const t of candidates) {
      let resolved = null;
      try { resolved = (await fetchArticleDigest(t)).resolvedTitle; }
      catch (e) { continue; }             // no such article -- try the next shape
      if (isUpgrade(resolved)) return resolved;
    }
    return null;
  }
  // `fam` is the generation's own nameplate node (for its label and for
  // rolling credits back up); `nodes`/`links` are the live graph arrays.
  function researchGeneration(gen, fam, nodes, links) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    if (!isEligibleForGenerationResearch(gen)) return Promise.resolve({ status: "not-a-generation" });
    const flightKey = "genresearch:" + gen.id;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const p = (async () => {
      try {
        const famLabel = fam ? fam.label : null;
        const upgraded = await findGenerationArticle(gen, famLabel, gen.wp, fam && fam.wp);
        if (upgraded) {
          gen.wp = upgraded;
          store.wpLinks[gen.id] = upgraded;
        }
        if (!gen.wp) {
          const entry = { status: "no-wiki-link", checkedAt: new Date().toISOString() };
          store.genResearch[gen.id] = entry; await persist();
          return entry;
        }
        // The ordinary generation-extraction prompt, aimed at this one
        // generation's article. Its own "hasMultipleGenerations" answer is
        // irrelevant here (a generation isn't split further) -- what matters
        // is the designers/engineers/sharedPlatforms it attributes, all of
        // which are already hallucination-guarded by validate(). Union them
        // across whatever entries come back rather than trusting the model
        // to return exactly one.
        const { wp, wikitext, clean, raw, dropped } = await runCheck(
          { make: gen.make, label: gen.label, wp: gen.wp, id: gen.id }, null, null, undefined, nodes);
        const texts = [], matches = {}, makeMatches = {};
        const designers = new Set(), engineers = new Set();
        (clean.generations || []).forEach(g => {
          (g.sharedPlatforms || []).forEach(t => { if (texts.indexOf(t) < 0) texts.push(t); });
          Object.assign(matches, g.sharedPlatformMatches || {});
          Object.assign(makeMatches, g.makeVariantMatches || {});
          (g.designers || []).forEach(d => designers.add(d));
          (g.engineers || []).forEach(d => engineers.add(d));
        });
        // Relations: resolved against the graph exactly the way a nameplate's
        // own discovery does, but anchored on THIS generation (genIdA) rather
        // than the nameplate, which is the whole point of reading the
        // specific article.
        const relationKeysBefore = new Set(Object.keys(store.relations || {}));
        resolvePlatformMention(nodes, links, gen.familyOf || gen.id, {
          id: gen.id, label: gen.label, year: gen.year, end: gen.end,
          sharedPlatformTexts: texts, sharedPlatformMatches: matches, makeVariantMatches: makeMatches,
        });
        const newRelations = Object.keys(store.relations || {}).filter(k => !relationKeysBefore.has(k));
        // People: additive, same reasoning as applyFreshPeopleCredits.
        const byIdLocal = new Map(nodes.map(n => [n.id, n]));
        const peopleAdded = [];
        [["designer", "designed", designers], ["engineer", "engineered", engineers]].forEach(([role, linkType, set]) => {
          const field = role === "designer" ? "designers" : "engineers";
          const own = new Set(gen[field] || []);
          set.forEach(name => {
            const person = resolvePersonNode(nodes, byIdLocal, name, role);
            if (!person) return;
            if (!own.has(name)) { own.add(name); peopleAdded.push({ role, name }); }
            if (!links.some(l => l.type === linkType && idOf(l.source) === gen.id && idOf(l.target) === person.id)) {
              links.push({ source: gen.id, target: person.id, type: linkType, llmDiscovered: true });
            }
            if (fam && !links.some(l => l.type === linkType && idOf(l.source) === fam.id && idOf(l.target) === person.id)) {
              links.push({ source: fam.id, target: person.id, type: linkType, llmDiscovered: true });
              const famSet = new Set(fam[field] || []); famSet.add(name); fam[field] = [...famSet];
            }
          });
          gen[field] = [...own];
        });
        const entry = {
          status: "done", checkedAt: new Date().toISOString(),
          sourceTitle: wp, upgradedArticle: upgraded || null,
          relatedTexts: texts, newRelationKeys: newRelations, peopleAdded,
          // This is where engines actually are. A nameplate's umbrella article
          // does not list them -- the real Mercedes-Benz E-Class page has no
          // engine field at all, while its W213 generation article names nine
          // -- so hooking the extraction only to the generation CHECK found
          // nothing for exactly the cars most worth asking about.
          engines: engineMentions(wikitext),
          debug: { raw, dropped },
        };
        store.genResearch[gen.id] = entry;
        await persist();
        return entry;
      } catch (e) {
        const entry = { status: "error", checkedAt: new Date().toISOString(), error: String(e.message || e) };
        store.genResearch[gen.id] = entry; await persist();
        return entry;
      } finally {
        inFlight.delete(flightKey);
      }
    })();
    inFlight.set(flightKey, p);
    return p;
  }

  // ---------- public: forget a node's verdict so a fresh check can run ----------
  // Real user request: "If a wikipedia link was found by the LLM at any
  // point, then the user should have the option to change the wikipedia link
  // in case it's inaccurate. Then, if the user presses 'recheck with llm'
  // then it should recheck it with the new wikipedia link provided."
  // checkNode/checkFamily both short-circuit on ANY existing entry, so a
  // corrected link would otherwise change nothing at all -- the next check
  // would just hand back the stale verdict derived from the wrong article.
  // setNodeWikiLink already cleared a "no-wiki-link" dead end for exactly
  // this reason; this is the general case, for a node that DID get a real
  // (but wrong-article) answer. Never touches store.relations -- those are
  // separately re-derivable and separately deletable.
  function clearNodeEntry(nodeId) {
    delete store.families[nodeId];
    delete store.recheck[nodeId];
    delete store.genResearch[nodeId];
    return persist();
  }

  // Symmetric counterpart to confirmRelation -- for a `reworkPending`
  // "remove" proposal (an already-CONFIRMED relation the re-check could no
  // longer back up), Accept means "yes, retract it", not "yes, add it".
  // Never truly deletes the decision history: recorded in
  // rejectedRelations exactly like an ordinary human "no" would be, so
  // nothing (a stale mention still sitting in some cached proposal, a
  // future recheck) can silently re-propose the exact same pair without a
  // fresh, independent piece of evidence.
  function retractConfirmedRelation(key) {
    const e = store.relations[key]; if (!e) return;
    delete store.relations[key];
    store.rejectedRelations[key] = true;
    persist();
  }
  // Decline on a reworkPending proposal: "no, keep it as it is" -- clears
  // only the flag, leaving the original confirmed relation (and its live
  // graph link) completely untouched.
  function dismissRework(key) {
    const e = store.relations[key]; if (!e || !e.reworkPending) return;
    delete e.reworkPending;
    persist();
  }

  function checkFamily(fam, genNodes, nodes) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    const existing = recheckEntryFor(fam.id);
    if (existing) return Promise.resolve(existing);
    const flightKey = "recheck:" + fam.id;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    if (!fam.wp) {
      const entry = { status: "no-wiki-link", checkedAt: new Date().toISOString() };
      store.recheck[fam.id] = entry; persist();
      return Promise.resolve(entry);
    }
    const p = (async () => {
      try {
        const { wp, wikitext, clean, raw, dropped } = await runCheck(fam, null, null, undefined, nodes);
        const discrepancy = compareGenerations(fam, genNodes, clean.generations);
        const entry = {
          status: discrepancy ? "provisional" : "none",
          checkedAt: new Date().toISOString(),
          sourceTitle: wp, proposal: clean, discrepancy,
          attempts: 1, feedback: [],
          engines: engineMentions(wikitext),
          debug: { raw, dropped },
        };
        if (entry.status === "provisional") {
          if (engagedId === fam.id) store.recheck[fam.id] = entry;
          return entry;
        }
        store.recheck[fam.id] = entry; await persist();
        return entry;
      } catch (e) {
        const entry = { status: "error", checkedAt: new Date().toISOString(), error: String(e.message || e), attempts: 1 };
        if (engagedId !== fam.id) return entry;
        store.recheck[fam.id] = entry; await persist();
        return entry;
      } finally {
        inFlight.delete(flightKey);
      }
    })();
    inFlight.set(flightKey, p);
    return p;
  }

  function retryFamilyCheck(fam, genNodes, reason, nodes) {
    if (!serverAvailable) return Promise.resolve({ status: "unavailable" });
    const existing = recheckEntryFor(fam.id) || {};
    if ((existing.attempts || 0) >= MAX_ATTEMPTS) {
      return Promise.resolve(Object.assign({}, existing, { status: "max-attempts" }));
    }
    const flightKey = "recheck:" + fam.id;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const p = (async () => {
      try {
        const { clean, raw, dropped } = await runCheck(fam, existing.proposal || null, reason, undefined, nodes);
        const discrepancy = compareGenerations(fam, genNodes, clean.generations);
        const entry = {
          status: discrepancy ? "provisional" : "none",
          checkedAt: new Date().toISOString(),
          sourceTitle: existing.sourceTitle || fam.wp, proposal: clean, discrepancy,
          attempts: (existing.attempts || 0) + 1,
          feedback: [...(existing.feedback || []), reason],
          debug: { raw, dropped },
        };
        if (entry.status === "provisional") {
          if (engagedId === fam.id) store.recheck[fam.id] = entry;
          return entry;
        }
        store.recheck[fam.id] = entry; await persist();
        return entry;
      } catch (e) {
        const entry = Object.assign({}, existing, {
          status: "error", checkedAt: new Date().toISOString(), error: String(e.message || e),
          attempts: (existing.attempts || 0) + 1,
        });
        if (engagedId !== fam.id) return entry;
        store.recheck[fam.id] = entry; await persist();
        return entry;
      } finally {
        inFlight.delete(flightKey);
      }
    })();
    inFlight.set(flightKey, p);
    return p;
  }

  // Same "forget it happened, re-checkable later" semantics as rejectNode.
  function rejectFamilyRecheck(famId) {
    delete store.recheck[famId];
  }

  // ---------- runtime rewiring: apply a user-confirmed generation-list override ----------
  // REPLACES the family's generation node set with the freshly-proposed one
  // -- the one place in this file that isn't purely additive, since the
  // whole point is undoing a wrong grouping. Still never truly deletes
  // anything: an old generation node with no match in the new list is
  // "retired" (flagged, hidden everywhere via app.js's nodeInLayer) rather
  // than spliced out of the arrays, and any designer/engineer credit it
  // carried is folded up onto the family node -- both as plain text (for
  // display) and as a real graph link (so the connection still shows up in
  // search / Six Degrees), same "never lose an attribution" rule
  // deleteEntry()'s tombstone already follows elsewhere in this file. An old
  // generation that DOES match a fresh one (by normalized code) keeps its
  // own id, so anything already pointing at it (search history, a path
  // traced through Six Degrees) stays valid; only its year/designers/
  // engineers/photo get refreshed.
  function applyFamilyOverride(famId, nodes, links) {
    const entry = recheckEntryFor(famId);
    // Also re-runs for an ALREADY-"applied" entry -- this is what makes the
    // override survive a page reload: nodes/links are rebuilt fresh from
    // cars.json/data.js on every boot (the override only ever lives in
    // llm_families.json, same as every other layer in this file), so
    // without re-running this on an "applied" entry too, the fix would only
    // ever hold for the live tab that clicked Accept and silently revert the
    // moment the page reloaded. See applyAllFamilyOverrides, called from
    // app.js's boot sequence right alongside applyConfirmed.
    if (!entry || (entry.status !== "provisional" && entry.status !== "applied")) return;
    const wasProvisional = entry.status === "provisional";
    const byId = new Map(nodes.map(n => [n.id, n]));
    const fam = byId.get(famId);
    if (!fam || fam.type !== "family") return;
    const oldGens = (fam.generations || []).map(id => byId.get(id)).filter(Boolean);
    const freshGens = (entry.proposal && entry.proposal.generations) || [];

    const usedOld = new Set();
    const pairs = freshGens.map(g => {
      const key = norm(g.code);
      const match = oldGens.find(o => !usedOld.has(o.id) && key && norm(o.label).includes(key));
      if (match) usedOld.add(match.id);
      return { fresh: g, old: match || null };
    });
    const orphaned = oldGens.filter(o => !usedOld.has(o.id));

    const allDesigners = new Set(fam.designers || []);
    const allEngineers = new Set(fam.engineers || []);
    orphaned.forEach(o => {
      o.retired = true;
      o.retiredFrom = famId;
      o.retiredAt = new Date().toISOString();
      (o.designers || []).forEach(name => {
        allDesigners.add(name);
        const p = resolvePersonNode(nodes, byId, name, "designer");
        if (p && !links.some(l => l.type === "designed" && l.source === famId && l.target === p.id)) {
          links.push({ source: famId, target: p.id, type: "designed", llmDiscovered: true });
        }
      });
      (o.engineers || []).forEach(name => {
        allEngineers.add(name);
        const p = resolvePersonNode(nodes, byId, name, "engineer");
        if (p && !links.some(l => l.type === "engineered" && l.source === famId && l.target === p.id)) {
          links.push({ source: famId, target: p.id, type: "engineered", llmDiscovered: true });
        }
      });
    });

    const newGenIds = [];
    let prevGid = null;
    // Deduped set of every generation-level designer/engineered link minted
    // below, mirrored up to the family node itself too -- same reasoning
    // and same shape as applyConfirmed's own famPersonLinks (e.g. so
    // "BMW X3 -> Calvin Luk" exists even while the nameplate is collapsed,
    // not just once G01/F97 is expanded).
    const famPersonLinks = new Map(); // key `${type}|${personId}` -> {type, personId}
    const orphanedOldFamIds = new Set(); // old families a duplicate generation was pulled out of -- see retireOrphanedFamily below
    // Same duplicate-id backstop as applyConfirmed's -- see its own comment
    // for the G-Class case. This path re-derives ids for a family override, so
    // it can collide in exactly the same way.
    const usedGids = new Set(nodes.map(n => n.id));
    pairs.forEach(({ fresh, old }) => {
      let gid = old ? old.id : "llm-" + famId + "-" + String(fresh.code).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (!old && usedGids.has(gid) && !byId.get(gid)) {
        gid += "-" + (fresh.yearStart != null ? fresh.yearStart : usedGids.size + 1);
      }
      usedGids.add(gid);
      let gn = old || byId.get(gid);
      let dup = null;
      if (!gn) {
        // De-duplication: this fresh generation has no match among the
        // family's OWN existing generations, but the exact same car may
        // already sit elsewhere in the graph -- either as a fully
        // independent, never-grouped standalone model, or as a generation
        // already grouped under a DIFFERENT, pre-existing family -- e.g. the
        // Mercedes-Benz SL-Class's R107 (1971-1989, standalone) and
        // R129/R230/R231 (already grouped under an earlier build-time
        // family), none of which build_family_layer.py's automatic
        // (make, base-name) grouping recognized as belonging to THIS fresh
        // override. Left alone, this would mint brand-new "llm-..." nodes
        // for cars that already exist elsewhere -- visible duplicates. Per
        // the same "the LLM's own read of Wikipedia wins, the stale
        // pre-existing entry just becomes invisible" policy this file
        // already uses for THIS family's own orphaned generations (see
        // `orphaned` above), retire that duplicate instead of leaving two
        // nodes for one car -- never deleted, so if this override itself
        // later gets deleted (see deleteRecheckEntry), applyFamilyOverride
        // simply stops running for this family and the duplicate reverts to
        // its normal, visible state on the very next boot with nothing
        // further to unwind. The actual retirement + full transplant of
        // everything the duplicate carried (relation links, person links,
        // My Database data, years, article) happens via supersedeStandalone
        // below, once gn's own fields are settled; here we only fold its
        // designer/engineer names up to the family level, same as the
        // orphaned-generation handling above.
        dup = findDuplicateGeneration(nodes, fresh.code, famId, fam.make, fam.label);
        if (dup && dup.familyOf && dup.familyOf !== famId) orphanedOldFamIds.add(dup.familyOf);
        if (dup) {
          (dup.designers || []).forEach(name => {
            allDesigners.add(name);
            const p = resolvePersonNode(nodes, byId, name, "designer");
            if (p && !links.some(l => l.type === "designed" && l.source === famId && l.target === p.id)) {
              links.push({ source: famId, target: p.id, type: "designed", llmDiscovered: true });
            }
          });
          (dup.engineers || []).forEach(name => {
            allEngineers.add(name);
            const p = resolvePersonNode(nodes, byId, name, "engineer");
            if (p && !links.some(l => l.type === "engineered" && l.source === famId && l.target === p.id)) {
              links.push({ source: famId, target: p.id, type: "engineered", llmDiscovered: true });
            }
          });
        }
        gn = { id: gid, type: "model", label: `${fam.label} ${fresh.code}`, make: fam.make,
               familyOf: famId, wp: (dup && dup.wp) || fam.wp, llmGenerated: true };
        nodes.push(gn);
        byId.set(gid, gn);
      }
      // Year preference: the LLM's own extracted year, an existing value on
      // a reused node, the superseded standalone's real harvested year, the
      // family's own year as the last resort.
      gn.year = fresh.yearStart || gn.year || (dup && dup.year) || fam.year;
      gn.end = fresh.yearEnd != null ? fresh.yearEnd
        : (gn.end != null ? gn.end : (dup && dup.end != null ? dup.end : null));
      if (fresh.designers && fresh.designers.length) gn.designers = fresh.designers;
      if (fresh.engineers && fresh.engineers.length) gn.engineers = fresh.engineers;
      if (fresh.wikiFile) gn.wikiFile = fresh.wikiFile;
      // Real gap found while adding multi-relation support: this override
      // flow called resolvePlatformMention below on every pass, but never
      // actually SET gn.sharedPlatformTexts first -- so an EXISTING
      // nameplate's generation-list correction never once resolved a
      // shared-platform/rebadge mention, even though build-time and
      // first-time-creation nameplates both already did. Wired in now, same
      // array-of-every-mention shape as applyConfirmed's own per-generation
      // mint above.
      gn.sharedPlatformTexts = Array.isArray(fresh.sharedPlatforms) ? fresh.sharedPlatforms
        : (fresh.sharedPlatform ? [fresh.sharedPlatform] : []);
      // LLM sanity-check verdicts (if the check ran), carried forward the
      // same way -- see the other sharedPlatformMatches assignments in this
      // file for the full comment.
      gn.sharedPlatformMatches = fresh.sharedPlatformMatches || {};
      if (dup) {
        // Retires the standalone AND transplants everything it knew onto gn
        // -- see supersedeStandalone's own comment. Runs after gn's fields
        // above are settled so its gap-filling never overwrites the LLM's
        // own fresher values.
        supersedeStandalone(nodes, links, dup, gn, famId, fam.make + " " + fam.label);
        // Same family-level inheritance build_family_layer.py applies.
        if (gn.db && !fam.db) {
          fam.db = true;
          fam.dbGenerations = [...(fam.dbGenerations || []), gn.id];
        }
        if (gn.garage) fam.garage = true;
      }
      (gn.designers || []).forEach(d => allDesigners.add(d));
      (gn.engineers || []).forEach(d => allEngineers.add(d));
      newGenIds.push(gid);
      if (prevGid) {
        const already = links.some(l => l.type === "gensucc" && l.source === prevGid && l.target === gid);
        if (!already) links.push({ source: prevGid, target: gid, type: "gensucc" });
      }
      const hub = links.some(l => l.type === "generation" && l.source === famId && l.target === gid);
      if (!hub) links.push({ source: famId, target: gid, type: "generation" });
      prevGid = gid;
      resolvePlatformMention(nodes, links, famId, gn);

      // Wire this generation directly to its designer(s)/engineer(s) -- a
      // real "G01/F97 -> Calvin Luk" graph link, not just the text field
      // gn.designers reads for the detail panel's "drawn by" line. Without
      // this, a nameplate corrected by this override showed the credit as
      // text but never actually connected the person node in the graph
      // (visible in search / Six Degrees / the graph canvas). Idempotent
      // (guarded by links.some) since this re-runs on every boot for an
      // already-"applied" entry.
      const seenOnThisGen = new Set();
      (gn.designers || []).forEach(name => {
        const p = resolvePersonNode(nodes, byId, name, "designer");
        if (!p || seenOnThisGen.has("designed|" + p.id)) return;
        seenOnThisGen.add("designed|" + p.id);
        if (!links.some(l => l.type === "designed" && l.source === gid && l.target === p.id)) {
          links.push({ source: gid, target: p.id, type: "designed", llmDiscovered: true });
        }
        famPersonLinks.set("designed|" + p.id, { type: "designed", personId: p.id });
      });
      (gn.engineers || []).forEach(name => {
        const p = resolvePersonNode(nodes, byId, name, "engineer");
        if (!p || seenOnThisGen.has("engineered|" + p.id)) return;
        seenOnThisGen.add("engineered|" + p.id);
        if (!links.some(l => l.type === "engineered" && l.source === gid && l.target === p.id)) {
          links.push({ source: gid, target: p.id, type: "engineered", llmDiscovered: true });
        }
        famPersonLinks.set("engineered|" + p.id, { type: "engineered", personId: p.id });
      });
    });
    famPersonLinks.forEach(({ type, personId }) => {
      if (!links.some(l => l.type === type && l.source === famId && l.target === personId)) {
        links.push({ source: famId, target: personId, type, llmDiscovered: true });
      }
    });

    // Retire the structural family<->generation / gensucc links touching an
    // orphaned id too -- the node itself is hidden via the `retired` flag
    // (app.js's nodeInLayer), this just keeps the family's own Generations
    // list and gensucc chain from still counting it.
    const orphanIds = new Set(orphaned.map(o => o.id));
    links.forEach(l => {
      if (l.type === "generation" && l.source === famId && orphanIds.has(l.target)) l.retired = true;
      if (l.type === "gensucc" && (orphanIds.has(l.source) || orphanIds.has(l.target))) l.retired = true;
    });

    fam.generations = newGenIds;
    fam.designers = [...allDesigners];
    fam.engineers = [...allEngineers];
    const freshNodes = newGenIds.map(id => byId.get(id)).filter(Boolean);
    const years = freshNodes.map(g => g.year).filter(y => y != null);
    const ends = freshNodes.map(g => g.end);
    if (years.length) fam.year = Math.min(...years);
    fam.end = ends.length && !ends.some(e => e == null) ? Math.max(...ends) : (ends.length ? null : fam.end);
    orphanedOldFamIds.forEach(oldFamId => retireOrphanedFamily(byId, oldFamId, famId, fam.make + " " + fam.label));

    entry.status = "applied";
    if (wasProvisional) {
      entry.appliedAt = new Date().toISOString();
      persist();
    }
  }

  // ---------- boot-time: re-apply every already-"applied" override ----------
  // Called from app.js's boot sequence right alongside applyConfirmed --
  // without this, an override only ever took effect in the live tab that
  // clicked Accept and reverted on the very next reload, since nothing else
  // ever re-ran applyFamilyOverride for a decision that was already made in
  // a previous session.
  function applyAllFamilyOverrides(nodes, links) {
    Object.keys(store.recheck).forEach(famId => {
      if (store.recheck[famId] && store.recheck[famId].status === "applied") {
        applyFamilyOverride(famId, nodes, links);
      }
    });
  }

  // ---------- playground: manual LLM prompt/response testing ----------
  // Real user request: a way to see EXACTLY what gets sent to the local
  // model, and try out a response by hand, for the times an automatic
  // check's verdict looks wrong and it's genuinely unclear whether that's
  // the model's own read of the article or a prompt/parsing gap in this
  // file. A remote second pair of eyes on this codebase has no way to reach
  // the user's local llama-server instance directly -- this is the
  // "tell me what to type and I'll bring back what it said" bridge
  // instead. Deliberately built by splitting the REAL check functions
  // above into a "gather material" half (buildCheckMaterial,
  // buildRelationMaterial) and a "resolve from a raw response" half
  // (validate, computeRelationEntry) rather than writing a second,
  // parallel implementation here -- this can never silently drift out of
  // sync with what a live check actually does, because it reuses the exact
  // same functions.
  //
  // Two flows, mirroring the two real check types:
  //   node: buildNodePrompt(node) -> { wp, messages } to show/copy,
  //         then previewNodeResult(node, raw) / applyNodeResult(node, raw)
  //         once a response (real or hand-typed) is available.
  //   relation: buildRelationPrompt(infoA, infoB, relType, note) -> { messages, evidence, effectiveNote },
  //         then previewRelationResult(...) / applyRelationResult(...).
  //
  // Fetches the article fresh on every call rather than caching it between
  // "build prompt" and "preview result" -- simpler, and the small re-fetch
  // cost is irrelevant next to a human reading/pasting a prompt by hand in
  // between. previewX never writes anything; applyX writes the exact same
  // entry shape a successful live check would and persists it (a no-op on
  // a static build, same as every other write in this file), so a
  // playground-supplied answer shows up in the ordinary review UI
  // (Yes/No, or "N generations found") exactly like a real one would.
  async function buildNodePrompt(node) {
    const { wp, messages } = await buildCheckMaterial(node, null, null);
    return { wp, messages };
  }
  async function previewNodeResult(node, raw) {
    const { wp, wikitext } = await buildCheckMaterial(node, null, null);
    const clean = validate(raw, wikitext);
    const dropped = (Array.isArray(raw && raw.generations) ? raw.generations : [])
      .filter(g => !clean.generations.some(c => c.code === String(g && g.code)));
    return { wp, clean, raw, dropped };
  }
  async function applyNodeResult(node, raw) {
    const preview = await previewNodeResult(node, raw);
    const entry = {
      status: preview.clean.generations.length > 1 ? "provisional" : "none",
      checkedAt: new Date().toISOString(),
      sourceTitle: preview.wp, proposal: preview.clean,
      attempts: 1, feedback: [],
      debug: { raw: preview.raw, dropped: preview.dropped },
      // Marks this entry as having come from a hand-supplied response
      // rather than a live llama.cpp call this session actually made --
      // purely informational, doesn't change how anything else treats it.
      manuallySupplied: true,
    };
    store.families[node.id] = entry;
    await persist();
    return entry;
  }
  async function buildRelationPrompt(infoA, infoB, relType, note) {
    return buildRelationMaterial(infoA, infoB, relType, note);
  }
  async function previewRelationResult(infoA, infoB, relType, note, raw) {
    const { evidence, effectiveNote } = await buildRelationMaterial(infoA, infoB, relType, note);
    return computeRelationEntry(infoA, infoB, relType, effectiveNote, evidence, raw);
  }
  async function applyRelationResult(key, infoA, infoB, relType, note, raw) {
    const entry = await previewRelationResult(infoA, infoB, relType, note, raw);
    entry.manuallySupplied = true;
    if (!store.relations) store.relations = {};
    store.relations[key] = entry;
    await persist();
    return entry;
  }

  return {
    serverAvailable, isEligible, entryFor,
    checkNode, checkNodeCascade, retryNode, confirmNode, rejectNode,
    applyConfirmed, filePathUrl,
    setEngaged, discardPending,
    allEntries, deleteEntry, resetAll,
    relationEntryFor, checkRelation, confirmRelation, rejectRelation, applyResolvedRelations,
    isDismissed, dismiss, dismissMany, allDismissed,
    reconcileDbGenerations, applySharedPlatformForSingleGen, applyPeopleForSingleGen,
    isEligibleForRecheck, recheckEntryFor, checkFamily, retryFamilyCheck,
    rejectFamilyRecheck, applyFamilyOverride, applyAllFamilyOverrides,
    allRecheckEntries, deleteRecheckEntry,
    forceRecheckFamily, retractConfirmedRelation, dismissRework,
    // "I want it to essentially do a re-check of the entire car that I
    // selected, as well as its cascade max depth length" -- see resetCascadeFrom.
    resetCascadeFrom,
    applyWpLinks, setNodeWikiLink,
    allRelationEntries, relationsTouching,
    // Exposed so app.js can bring a nameplate's generation list up to date
    // from its own Wikipedia article BEFORE asking for a generation match --
    // see generationGapFor's own comment for the request this implements.
    generationGapFor,
    // Transitive relationships -- see inferTransitiveRelations' own comment.
    inferTransitiveRelations, transitiveProposals, transitiveEntryFor, transitiveAnswerFor,
    confirmTransitive, rejectTransitive, allTransitiveDecisions, confirmedTransitive,
    transitiveMaxHops, setTransitiveMaxHops,
    buildNodePrompt, previewNodeResult, applyNodeResult,
    buildRelationPrompt, previewRelationResult, applyRelationResult,
    // Background year/born/died/country fact-backfill (see
    // scheduleFactBackfill's own comment) finishes well after the
    // synchronous mint/apply pass that created the node -- this is how
    // app.js finds out a node it already drew has since had a field filled
    // in, so it can redraw. Same "subscribe to a listener list" shape as
    // app.js's own onFamilyChange/onDbFilterChange.
    onFactsUpdate: f => factsListeners.push(f),
    // The one-hop cascade budget -- see cascadeMaxDepth's own comment, and
    // serve.py's CASCADE_MAX_DEPTH for where it's configured.
    cascadeAllowedFrom, cascadeDepthOf: depthOf, cascadeMaxDepth: () => cascadeMaxDepth,
    // Fired when a related PARTNER turns out to hide generations and has been
    // confirmed as a nameplate -- app.js subscribes and does the actual
    // minting/splicing. See schedulePartnerCheck's own comment for the Honda
    // Odyssey / Acura MDX report this closes.
    onSplitReady: f => splitListeners.push(f),
    pendingWork,
    // The single gate every background scheduler consults -- app.js drives it
    // from the 🤖 LLM Check toggle. See setBackgroundAllowed's own comment.
    setBackgroundAllowed,
    // Exposed purely so the playground's "Run it here" button can make the
    // exact same call a real check would, against whichever prompt is
    // currently showing -- not used by any of the automatic flows above,
    // which all call it internally instead.
    askLlamaCpp,
    // Used by app.js's "Add Car" panel (see initAddCarPanel) to resolve a
    // Wikipedia article for a manually-typed make/model, with a user-
    // supplied URL as the fallback when neither guess nor search finds one.
    findWikipediaTitleFor, titleFromWikipediaUrl, tryWikipediaTitle,
    // Add Car persistence -- see applyUserCars's own comment for the bug
    // this fixes (a manually-added car vanishing on reload). applyUserCars
    // must run first in app.js's boot sequence, before applyConfirmed.
    applyUserCars, registerUserCar,
    // Succession rollup to the specific generations it really describes --
    // must run after applyResolvedRelations in app.js's boot sequence, so an
    // LLM-resolved generation pair always wins over the derived one.
    pushSuccessionToGenerations,
    // Generation-level research against a generation's OWN (more specific)
    // Wikipedia article -- see researchGeneration's own comment.
    isEligibleForGenerationResearch, genResearchEntryFor, researchGeneration,
    // "Change this car's Wikipedia link, then re-check with it" -- see
    // clearNodeEntry / setNodeWikiLink's `force` option.
    clearNodeEntry,
    // Modify Existing Car: merge several standalone models into one
    // nameplate, plus the free-text LLM request behind it. applyMerges must
    // run early in app.js's boot sequence (right after applyUserCars) so
    // everything downstream sees the merged family, not the loose models.
    applyMerges, mergeModelsIntoNameplate, undoMerge, allMerges, askModifyCar,
    // "If the LLM is unsure which to pick, then it should prompt the user and
    // have the user confirm which information to take" -- see applyOneMerge's
    // wpConflict branch. Rendered by the Modify Existing Car panel.
    pendingMergeWpConflicts, resolveMergeWpChoice,
    // Live-graph half of "deleted means deleted" -- see severRelationLinks.
    severRelationEntryLinks, clearRejectionsFor,
    // Universal delete + recovery (see deleteNode's own comment). applyDeletions
    // and applyRenames must run at the very START of app.js's boot sequence:
    // everything downstream branches on node type/label/retired state, so they
    // need the final answer, not the pre-edit one.
    applyDeletions, applyRenames, deleteNode, restoreNode, allDeletions, isHardData,
    // "delete all newly created makes and models... (and a dropdown where the
    // user can select a particular make and model)" -- see newlyAddedNodes.
    isNewlyAdded, newlyAddedNodes, deleteNewCars,
    // "a 'clear' option which lets me remove the cars completely... including
    // in any file which this information was ever stored" -- see purgeDeletion.
    // applyPurges runs beside applyDeletions at the end of app.js's boot.
    purgeDeletion, applyPurges, isPurged, allPurged,
    // "an 'unmerge' option just like how there is a 'merge' option in the
    // 'modify existing car' section" -- see unmergeNameplate. applyUnmerges
    // must run AFTER every layer that can build a nameplate (applyMerges,
    // applyConfirmed, applyAllFamilyOverrides, mergeDuplicateNameplates) and
    // before applyRenames/applyDeletions.
    unmergeNameplate, applyUnmerges, redoMerge, allUnmerges, isUnmerged,
    renameNode, revertRename, allRenames,
    // Automatic fold of a nameplate duplicated as a bare umbrella model --
    // must run before applyConfirmed, since it changes which nodes are
    // already grouped. See mergeDuplicateNameplates' own comment.
    mergeDuplicateNameplates, duplicateNameplatePairs, unmergeDuplicate,
    // Exposed for the jsdom suite: the hallucination-guard/parsing helpers
    // and the per-generation image picker, whose exact behavior several
    // regression tests pin down directly rather than through a whole check
    // round trip.
    refreshGenerationImages,
    setDecisionSource, decisionSource: () => decisionSource,
    resolveWeakRelations, makeRelationship, weakProposalRejection,
    additiveRecheck, diffGenerationCodes,
    // The section-reading half of the generation-article lookup, exposed so
    // the suite can drive it against real cached wikitext without a network.
    wikitextSections, hatnoteArticle, proseArticle, sectionForCode,
    isEngineArticle, engineInfobox, engineVariants, engineApplications,
    parseApplicationLine, readEngineArticle,
    engineIdFor, engineVariantIdFor, nameplateOfCar, planEngineEdges,
    engineNodeFrom, applyEngineArticle, applyEngineArticleWith,
    carNameFromApplication, resolveApplicationTitles,
    checkEngine, applyEngines, engineEntryFor, allEngineEntries, deleteEngineEntry,
    scheduleEngineCascade, scanEnginesFor, engineScanEntryFor, engineArticleFor,
    clearEngineScansFor, note,
    mergeEngines, undoEngineMerge, allEngineMerges, applyEngineMerges,
    engineMentions, recordEngineMentions, recordEngineMentionsFrom, applyEngineMentions,
    looksLikeEngineArticleTitle, engineIdFromTitle,
    articleFromNameplateSection, findGenerationArticle,
    orphanedEntries, orphanKind, pruneStandInOrphans, clearRenamedOrphans,
    // The archive both of those write to. `store` is a shallow copy of the
    // seeded object, so a NEW top-level key on it is not visible through
    // window.LLM_FAMILIES -- read it through here.
    prunedDecisions: () => store.prunedDecisions || {},
    parseLlmJson, codeAnchorIn, codeVerifiedIn, findGenerationImage, infoboxImageForCode,
    looksLikePlatformNotCar,
    // Exposed for the regression suite only: a persisted proposal from before
    // the platform guard existed replays through mintRelatedNode on every
    // boot, so the guard has to hold HERE too, not just in validate() -- and
    // that second line of defence is worth a test of its own.
    mintRelatedNode,
    // Exposed for the regression suite: the identity-match year veto (see
    // verifySharedPlatformMention's own comment on the Daewoo Arcadia/Magnus
    // case). Worth pinning down directly rather than through a whole check
    // round trip -- it is the one guard standing between a fluent, confident,
    // completely false identity claim and a permanent wrong link in the graph.
    verifySharedPlatformMention,
    // Exposed for the regression suite only. validate() is where a proposal
    // stops being whatever the model said and becomes what the graph will
    // believe -- the hallucination guards, the per-generation photo picker and
    // the repeated-code reconciliation all live there -- so the suite drives it
    // directly rather than through a whole check round trip. __seedFamilyEntry
    // is its companion: it plants an already-validated proposal so applyConfirmed
    // can be exercised on it without a network call.
    __validateForTest: validate,
    __seedFamilyEntry(nodeId, clean, sourceTitle) {
      store.families[nodeId] = {
        status: "confirmed", checkedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
        sourceTitle: sourceTitle || null, proposal: clean, attempts: 1, feedback: [],
      };
    },
  };
})();
