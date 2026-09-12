#!/usr/bin/env python3
"""Nameplate 'family' layer: groups a model's individual generation nodes
(e.g. Volkswagen Golf Mk1..Mk8) under one collapsed family node (e.g. "Golf"),
so the default view shows one node per nameplate. Expanding a family reveals
its generations, chained by the existing succession links.

Grouping is a two-step, conservative process:
  1. HEURISTIC — strip known generation-suffix patterns ("(...)", " Mk\\d+")
     from each model's label; models sharing (make, base_name) are candidates.
  2. VALIDATION — a candidate group is only "confirmed" if its members form a
     single, unbroken succession chain (a simple path, no gaps, no branches
     to outside models). This is the one signal actually reliable enough to
     trust: Wikipedia's automotive categories turn out NOT to carry nameplate
     groupings (checked directly against live DBpedia data — a model's
     categories are body-style/decade/country, never "Category:Make Model"),
     so the succession chain — already fully harvested — is the real source
     of truth here, not category cross-referencing.

Unconfirmed candidate groups are never silently grouped — they're listed in
family_match_report.txt for manual review, same policy as the My Database
matcher and the live-refresh merge logic elsewhere in this codebase.

Run standalone against an already-built ../app/cars.json for fast iteration:
    python3 build_family_layer.py
"""
import re, json, unicodedata, datetime
from pathlib import Path
from collections import defaultdict

SCRIPT_DIR = Path(__file__).resolve().parent
REPORT_PATH = SCRIPT_DIR / "harvest" / "family_match_report.txt"

GEN_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*$")
GEN_MK_RE = re.compile(r"\s+Mk\.?\s?\d+.*$", re.I)
CLASS_SUFFIX_RE = re.compile(r"[\s-]Class$", re.I)

# A trailing parenthetical that names nothing but a market. Deliberately a
# closed list rather than "any capitalised word": the whole point is to be sure
# a label really is market-scoped before excluding it from a nameplate.
MARKET_RE = re.compile(r"""^(?:
      china | japan | korea | india | australia | australasia | new\s+zealand
    | north\s+america | south\s+america | latin\s+america | americas | canada
    | mexico | brazil | argentina | chile | colombia | europe | european
    | uk | united\s+kingdom | britain | ireland | international | worldwide
    | global | asia | south\s+africa | africa | russia | middle\s+east
    | taiwan | thailand | indonesia | malaysia | philippines | vietnam
    | united\s+states | usa | us
)$""", re.I | re.X)

# Anything that marks a discrete generation: an ordinal, the word "generation",
# an Mk number, or any digit (year-disambiguated titles like "500 (2007)").
GEN_MARKER_RE = re.compile(
    r"\b(?:gen|generation|mk\.?\s?\d+|first|second|third|fourth|fifth|sixth|"
    r"seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|"
    r"facelift|restyling)\b|\d", re.I)


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def slug(s):
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"ß", "ss", s)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "x"


def base_name(label):
    """Strip a trailing generation marker off a model label.
    'Golf (Mk1)' -> 'Golf'; 'Golf Mk2' -> 'Golf'; 'Corolla (E170)' -> 'Corolla';
    'Golf Plus' -> 'Golf Plus' (not a generation suffix, stays its own model)."""
    b = GEN_PAREN_RE.sub("", label).strip()
    b = GEN_MK_RE.sub("", b).strip()
    return b


def declass(base):
    """Mercedes-Benz (and a few others) inconsistently include "-Class" in
    some generations' article titles but not others for the exact same
    nameplate -- e.g. "CLS-Class (C218)" and "CLS-Class (C219)" vs. the next
    generation's "CLS (C257)", no "-Class" at all. Used only to MERGE
    candidate groups that are the same nameplate under this naming drift;
    deliberately not folded into base_name() itself, since that would also
    change what counts as "has a generation suffix at all" (a bare "C-Class"
    would wrongly start looking like a suffixed generation of something
    called "C") and would rename every unaffected "X-Class" family's label."""
    return CLASS_SUFFIX_RE.sub("", base).strip() or base


def market_variant(label):
    """The market a label's trailing parenthetical names, if the parenthetical
    is ONLY a market and carries no generation marker -- otherwise None.

    "Taurus (China)" is a different car built and sold for a different market,
    not the seventh generation of the North American Taurus. DBpedia hands us a
    succession edge saying otherwise, which is exactly how it ended up appended
    to the end of the mainline chain. Same shape: "Escort (China)", "Falcon
    (Australia)", "Odyssey (international)", "Ranger (Americas)", "Bora
    (China)". Excluding them leaves each as its own model, which is what it is.

    The generation-marker check is load-bearing in the other direction. A
    parenthetical naming a market AND a generation is a real generation that
    happens to be market-specific, and must NOT match here: Ford Focus's
    "(second generation, North America)" and Honda Accord's "(North America
    seventh generation)" are steps in a sequence, and dropping those would cost
    the nameplate a generation it really has."""
    m = re.search(r"\(([^)]*)\)\s*$", label)
    if not m:
        return None
    inner = m.group(1).strip()
    if not inner or GEN_MARKER_RE.search(inner):
        return None
    # "North America and China", "Japan, Europe" -> every part must be a market
    parts = [x.strip() for x in re.split(r"\s+and\s+|,|/", inner) if x.strip()]
    return inner if parts and all(MARKET_RE.match(x) for x in parts) else None


# ---------------- candidate grouping ----------------

def candidate_groups(nodes):
    """Group model nodes by (make, base_name). Only groups with 2+ members
    are candidates; everything else is left as a normal standalone model.

    Two extra passes catch nameplates the plain (make, base_name) grouping
    above misses entirely, both found via the Mercedes-Benz CLS: three real
    generations (C219, C218, C257) plus one unrelated bare "CLS" article
    with no succession data of its own at all.

    1. DECLASS-MERGE — Mercedes-Benz (and a few others) inconsistently
       includes "-Class" in some generations' article titles but not others
       for the exact same nameplate: "CLS-Class (C218)"/"(C219)" vs. the
       next generation's "CLS (C257)", no "-Class" at all. Without this,
       (make, "CLS-Class") and (make, "CLS") never even look like the same
       candidate group. Groups sharing a declassed base name are merged.

    2. BARE-FOLD — a nameplate's original generation sometimes kept its
       Wikipedia article at the plain, unsuffixed title (written before a
       second generation existed to disambiguate from), while every later
       generation got its own qualified title. base_name() correctly leaves
       a bare label like "CLS" alone so it's never treated as ITS OWN
       candidate group by default — but folds it into an already-forming
       group (exact match OR declassed match) when one exists. If it turns
       out to be unrelated (no real succession link, like the CLS case
       above), validate_chain's isolate-pruning drops it right back out and
       reports why — it's never silently grouped on a guess either way.
    """
    raw_groups = defaultdict(list)
    for n in nodes:
        if n.get("type") != "model":
            continue
        b = base_name(n["label"])
        if b == n["label"]:
            continue  # no generation-style suffix found at all — not a candidate (yet)
        raw_groups[(n["make"], b)].append(n)

    groups = defaultdict(list)
    for (make, base), members in raw_groups.items():
        groups[(make, declass(base))].extend(members)

    by_bare = {}
    for n in nodes:
        if n.get("type") != "model":
            continue
        label = n["label"]
        if base_name(label) == label:  # unsuffixed
            by_bare[(n["make"], label)] = n
            by_bare.setdefault((n["make"], declass(label)), n)
    for key, members in groups.items():
        bare = by_bare.get(key)
        if bare is not None and bare not in members:
            members.append(bare)

    return {k: v for k, v in groups.items() if len(v) > 1}


# ---------------- succession-chain validation ----------------





def _clean_handover(a, b):
    """True when a's run finishes before b's begins, with no overlap at all.

    A missing succession edge between two chronologically adjacent members is
    usually just harvest incompleteness rather than evidence that they are
    parallel variants -- but only when their runs genuinely hand over. Jeep
    Cherokee is the case that motivated this: SJ[1974-1983] -> XJ[1984-2001] ->
    KL[2013-2023] -> KM[2025-] carries no harvested XJ->KL edge at all, and the
    whole nameplate went ungrouped over it, even though nothing about that
    ordering is in doubt -- XJ had been out of production for twelve years when
    KL arrived, and both are otherwise linked into the chain.

    Deliberately strict on two points, because overlap is the exact signal that
    separates a sequential generation from a parallel or regional one, and
    getting that wrong is what this entire layer exists to avoid. `a` must have
    a known end year (a run still in production cannot have handed over to
    anything), and the two spans must not share even a single year."""
    a_end, b_start = a.get("end"), b.get("year")
    return a_end is not None and b_start is not None and a_end <= b_start


def looks_like_distinct_marques(members, succ_pairs):
    """Two unrelated things sharing a Wikipedia title are disambiguated with a
    parenthetical -- "ABC (1906 automobile)" and "ABC (1920 automobile)" are two
    different defunct manufacturers, not two generations of one car. They land
    in the candidate set because base_name() strips the parenthetical and leaves
    nothing, so every article collapses onto the same empty base.

    Needs BOTH an empty base on every member AND no succession edge between any
    of them. The second half is load-bearing: Range Rover's generations are also
    titled as bare parentheticals under the Land Rover marque -- "(P38A)",
    "(L322)", "(L405)", "(L460)" -- and those are a real, confirmed chain, which
    their succession edges prove."""
    if not all(base_name(n["label"]) == "" for n in members):
        return False
    ids = {n["id"] for n in members}
    return not any(src in ids and dst in ids for (src, dst) in succ_pairs)


def validate_chain(members, links_by_pair):
    """A candidate group is confirmed if, once sorted chronologically, every
    consecutive pair is joined by a direct succession edge. This tolerates
    harvest noise like redundant "skip" edges (e.g. Golf Mk1 also linking
    straight to Mk3 in addition to Mk2 — a real artifact in the data) while
    still catching genuinely disconnected or ambiguously-ordered groups.

    Before that check, any candidate with NO succession edge to any other
    candidate in the group at all is pruned out first (e.g. BMW 1 Series
    (F52) is a China-market regional variant with no harvested succession
    link to E87/F20/F40/F70 at all) — one disconnected regional/parallel
    variant no longer vetoes grouping the rest of a genuinely clean chain.
    Pruned members are reported, never silently dropped.

    One more targeted retry after that: if the chronological-adjacency check
    still fails on exactly one pair, and dropping ONE of that pair's two
    members would make the rest of the group validate cleanly, drop it and
    retry once (found via Porsche 911: "911 (classic)" is a broad 1964-1989
    retrospective covering the 901/912/930 era rather than a single discrete
    generation, so its year span overlaps 930's outright, and its own
    succession edge skips straight to 964 instead of 930 — chronological
    sort still puts it right next to 930, and that specific adjacent pair
    has no direct edge between them, even though the REST of the chain
    — 930->964->993->996->997->991->992 — is completely clean on its own).
    This never forces a fit: it only accepts the retry if the remaining
    chain validates outright, and always reports what got dropped and why.

    Returns (ok, ordered_ids, reason, pruned) where pruned is a list of
    (node, reason) for anything excluded even when ok is True."""
    ids = {n["id"] for n in members}
    edges = {(s, t) for (s, t) in links_by_pair if s in ids and t in ids}
    edges |= {(t, s) for (s, t) in edges}  # undirected lookup

    pruned = []
    working = list(members)

    no_year = [n for n in working if n.get("year") is None]
    if no_year:
        working = [n for n in working if n.get("year") is not None]
        pruned += [(n, "missing year data, can't place it chronologically") for n in no_year]

    # A market-scoped article is a different car for a different market, not a
    # step in this nameplate's sequence -- see market_variant(). Pruned before
    # the connectivity check rather than after, because DBpedia often DOES give
    # it a succession edge (that edge is what put "Taurus (China)" on the end of
    # the Taurus chain), so it would otherwise pass as connected.
    market = [(n, market_variant(n["label"])) for n in working]
    market = [(n, mk) for n, mk in market if mk]
    if market:
        drop = {n["id"] for n, _ in market}
        working = [n for n in working if n["id"] not in drop]
        pruned += [(n, f"market-specific variant ({mk}) rather than a generation of this "
                       f"nameplate -- left as its own model") for n, mk in market]

    connected_ids = {a for a, _ in edges} | {b for _, b in edges}
    isolates = [n for n in working if n["id"] not in connected_ids]
    if isolates:
        working = [n for n in working if n["id"] in connected_ids]
        pruned += [(n, "no succession link to any other candidate generation here") for n in isolates]

    def try_order(items):
        """(ok, ordered_ids_or_offending_pair, reason)"""
        if len(items) < 2:
            return False, None, "fewer than 2 chronologically-connected generations remain after pruning"
        ordered = sorted(items, key=lambda n: (n["year"], n.get("end") or n["year"]))
        for i in range(len(ordered) - 1):
            a, b = ordered[i], ordered[i + 1]
            if (a["id"], b["id"]) in edges:
                continue
            if a["year"] == b["year"]:
                return False, (a, b), f"tied/ambiguous year with no direct link to disambiguate order: {a['id']} vs {b['id']}"
            if _clean_handover(a, b):
                continue  # see _clean_handover: gap-separated, order not in doubt
            return False, (a, b), f"no succession link between chronologically adjacent {a['label']!r} and {b['label']!r}"
        return True, [n["id"] for n in ordered], "ok"

    # Retry-pruning: if the chronological-adjacency check fails on exactly one
    # pair, try dropping either side and accept it only if the REST of the group
    # then validates outright.
    #
    # Deliberately ONE round, not a loop. A loop was tried and prunes too hard:
    # on Honda Accord it chipped away the North America seventh and eighth
    # generations -- real generations, not umbrella articles -- to force a clean
    # Japan/Europe chain, and would have had the app present a nameplate that
    # ran 1997-2017 when the Accord started in 1976 and is still in production.
    # One round can only ever discard a single member, which is the shape an
    # umbrella or lone parallel variant actually has.
    ok, result, reason = try_order(working)
    if not ok and isinstance(result, tuple):
        a, b = result
        for offender, other in ((a, b), (b, a)):
            retry_items = [n for n in working if n["id"] != offender["id"]]
            ok2, result2, reason2 = try_order(retry_items)
            if ok2:
                pruned.append((offender, f"chronologically overlaps other generations here with no direct "
                               f"succession link to its would-be neighbor {other['label']!r} -- likely a "
                               f"broader retrospective/umbrella article (like Porsche '911 (classic)') or a "
                               f"regional/parallel-market generation running outside the mainline succession "
                               f"chain (like a China- or NA-only generation), rather than a discrete step in "
                               f"this sequence"))
                working, ok, result, reason = retry_items, ok2, result2, reason2
                break

    if not ok:
        return False, None, reason, pruned

    reason_out = "ok" if not pruned else f"ok (excluded {len(pruned)} disconnected candidate(s), see below)"
    return True, result, reason_out, pruned


def build_link_pairs(links, links_type="succession"):
    return {(l["source"], l["target"]) for l in links if l["type"] == links_type}


# ---------------- reporting ----------------

def analyze(nodes, links):
    groups = candidate_groups(nodes)
    succ_pairs = build_link_pairs(links, "succession")
    confirmed, unconfirmed, collisions = [], [], []
    for (make, base), members in sorted(groups.items()):
        ok, order, reason, pruned = validate_chain(members, succ_pairs)
        by_id = {n["id"]: n for n in members}
        if ok:
            confirmed.append((make, base, [by_id[i] for i in order], pruned))
            continue
        members_sorted = sorted(members, key=lambda n: n.get("year") or 0)
        # Unrelated marques that merely share a name are a correct refusal, not
        # a miss. Reported separately so the review count means something.
        if looks_like_distinct_marques(members, succ_pairs):
            collisions.append((make, base, members_sorted, reason))
        else:
            unconfirmed.append((make, base, members_sorted, reason))
    return confirmed, unconfirmed, collisions


def write_report(confirmed, unconfirmed, collisions=()):
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines = ["FAMILY GROUPING REPORT", f"Generated: {datetime.date.today().isoformat()}", ""]
    lines.append(f"CONFIRMED FAMILIES ({len(confirmed)}) -- clean, unbroken succession chain")
    for make, base, ordered, pruned in confirmed:
        span = f"{ordered[0].get('year')}–{ordered[-1].get('end') or ''}"
        lines.append(f"  {make} {base}  ({len(ordered)} generations, {span})")
        lines.append("      " + " -> ".join(f"{n['label']}[{n.get('year')}-{n.get('end') or ''}]" for n in ordered))
        for n, why in pruned:
            lines.append(f"      EXCLUDED: {n['label']} [{n.get('year')}-{n.get('end') or ''}] id={n['id']} -- {why}")
    lines.append("")
    lines.append(f"UNCONFIRMED ({len(unconfirmed)}) -- candidate group found, NOT auto-grouped, needs review")
    for make, base, members, reason in unconfirmed:
        lines.append(f"  {make} {base}  ({len(members)} candidates) -- {reason}")
        for n in members:
            lines.append(f"      {n['label']} [{n.get('year')}-{n.get('end') or ''}] id={n['id']}")
    lines.append("")
    lines.append(f"NAME COLLISIONS ({len(collisions)}) -- unrelated marques sharing a name, correctly not grouped")
    lines.append("  Nothing to review here. Wikipedia disambiguates two different things with the")
    lines.append("  same title using a parenthetical, so these collapse onto one empty base name,")
    lines.append("  and no succession edge joins any of them. Listed separately so they stop")
    lines.append("  inflating the review count above.")
    for make, base, members, _reason in collisions:
        lines.append(f"  {make}  ({len(members)} unrelated articles)")
        for n in members:
            lines.append(f"      {n['label']} [{n.get('year')}-{n.get('end') or ''}] id={n['id']}")
    lines.append("")
    report = "\n".join(lines)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(report)


# ---------------- rewiring: create family nodes, reroute links ----------------

def build_families(nodes, links):
    """Mutates nodes/links in place: adds one 'family' node per confirmed
    group, tags each generation with familyOf, replaces each generation's
    direct 'made' link to its make with a family->make link (generations stay
    reachable through the family), adds family->generation 'generation'
    links, and mirrors each generation's designed/engineered links up to the
    family (deduped) so the family behaves like a normal, fully-connected
    node for search/hover/six-degrees. A family also inherits db/garage
    flags from its generations, so a documented or "my garage" car doesn't
    disappear from the default collapsed view.

    Also (re)writes harvest/family_match_report.txt on every call, so the
    report always reflects the actual grouping decisions made in this real
    build -- it used to only get refreshed by manually running this file
    standalone, so it silently went stale after every normal rebuild.sh
    run and no longer matched what was actually in cars.json/data.js."""
    confirmed, unconfirmed, collisions = analyze(nodes, links)
    write_report(confirmed, unconfirmed, collisions)
    make_id_by_label = {n["label"]: n["id"] for n in nodes if n["type"] == "make"}
    person_links_by_model = defaultdict(list)
    for l in links:
        if l["type"] in ("designed", "engineered"):
            person_links_by_model[l["source"]].append(l)

    drop_made = set()
    new_nodes, new_links = [], []

    for make, base, ordered, _pruned in confirmed:
        gen_ids = [n["id"] for n in ordered]
        fam_id = "fam-" + slug(make) + "-" + slug(base)
        years = [n["year"] for n in ordered if n.get("year") is not None]
        ends = [n.get("end") for n in ordered]
        fam_end = None if any(e is None for e in ends) else max(e for e in ends)
        designers, engineers = [], []
        for n in ordered:
            for d in (n.get("designers") or []):
                if d not in designers: designers.append(d)
            for e in (n.get("engineers") or []):
                if e not in engineers: engineers.append(e)

        fam = {
            "id": fam_id, "type": "family", "label": base, "make": make,
            "year": min(years) if years else None, "end": fam_end,
            "designers": designers, "engineers": engineers,
            "generations": gen_ids,
        }
        db_gens = [n["id"] for n in ordered if n.get("db")]
        if db_gens:
            fam["db"] = True
            fam["dbGenerations"] = db_gens
        if any(n.get("garage") for n in ordered):
            fam["garage"] = True
        if any(n.get("heritage") for n in ordered):
            fam["heritage"] = True
        new_nodes.append(fam)

        for n in ordered:
            n["familyOf"] = fam_id

        mk_id = make_id_by_label.get(make)
        if mk_id:
            for gid in gen_ids:
                drop_made.add((gid, mk_id))
            new_links.append({"source": fam_id, "target": mk_id, "type": "made"})

        for gid in gen_ids:
            new_links.append({"source": fam_id, "target": gid, "type": "generation"})

        # sequential chain between consecutive generations, in the validated
        # chronological order -- a visible line distinct from the structural,
        # undrawn family->generation hub link above. `ordered` is already the
        # chronologically-validated sequence from validate_chain().
        for i in range(len(gen_ids) - 1):
            new_links.append({"source": gen_ids[i], "target": gen_ids[i + 1], "type": "gensucc"})

        seen = set()
        for gid in gen_ids:
            for l in person_links_by_model.get(gid, []):
                key = (l["type"], l["target"])
                if key in seen: continue
                seen.add(key)
                nl = {"source": fam_id, "target": l["target"], "type": l["type"]}
                if l.get("note"): nl["note"] = l["note"]
                new_links.append(nl)

    links[:] = [l for l in links if (l["source"], l["target"]) not in drop_made]
    nodes.extend(new_nodes)
    links.extend(new_links)
    mirrored = mirror_relation_links(nodes, links)
    return {"families": len(confirmed), "generations": sum(len(o) for _, _, o, _ in confirmed),
            "unconfirmed": len(unconfirmed), "collisions": len(collisions),
            "mirroredRelations": mirrored}


def mirror_relation_links(nodes, links):
    """A platform/related/succession link is always harvested at whatever
    specificity its source Wikipedia infobox actually stated -- often a
    single generation (e.g. BMW X1 (F48) directly related to the Zinoro
    60H rebadge), sometimes a bare model. Once that generation gets folded
    into a collapsed family node above, the fact becomes invisible in the
    default (collapsed) view -- nothing connects the visible "X1" nameplate
    dot to anything until you expand it. Mirror each such link up to the
    family level too (same reasoning, and same dedup pattern, as the
    designed/engineered mirror above), tagging which side(s) were promoted
    from a real generation to a family id so the client can hide the
    now-redundant mirror once that specific family is expanded -- the
    untouched original link keeps working independently the moment its own
    two real endpoints are both visible. Never deletes or rewrites the
    original link, only adds a collapsed-view stand-in alongside it."""
    fam_of = {n["id"]: n.get("familyOf") for n in nodes if n["type"] == "model"}
    seen = set()
    new_links = []
    for l in links:
        if l["type"] not in ("platform", "related", "succession"):
            continue
        s_fam = fam_of.get(l["source"])
        t_fam = fam_of.get(l["target"])
        if not s_fam and not t_fam:
            continue  # neither endpoint belongs to a family -- nothing to mirror
        if s_fam and s_fam == t_fam:
            continue  # both sides are generations of the SAME nameplate -- that's
                       # what the gensucc chain already represents, not a cross-model relation
        new_source = s_fam or l["source"]
        new_target = t_fam or l["target"]
        key = (new_source, new_target, l["type"])
        if key in seen:
            continue
        seen.add(key)
        nl = {"source": new_source, "target": new_target, "type": l["type"], "mirror": True}
        if s_fam: nl["mirrorSourceFam"] = s_fam
        if t_fam: nl["mirrorTargetFam"] = t_fam
        if l.get("note"): nl["note"] = l["note"]
        new_links.append(nl)
    links.extend(new_links)
    return len(new_links)


if __name__ == "__main__":
    cars_json = SCRIPT_DIR.parent / "app" / "cars.json"
    data = json.loads(cars_json.read_text(encoding="utf-8"))
    confirmed, unconfirmed, collisions = analyze(data["nodes"], data["links"])
    write_report(confirmed, unconfirmed, collisions)
    print(f"\nconfirmed={len(confirmed)} unconfirmed={len(unconfirmed)} collisions={len(collisions)} "
          f"total generation nodes in confirmed families={sum(len(o) for _,_,o,_ in confirmed)}")
    stats = build_families(data["nodes"], data["links"])
    print(f"rewired: {stats}")
    cars_json.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    data_js = SCRIPT_DIR.parent / "app" / "data.js"
    data_js.write_text("window.CARDATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
                        encoding="utf-8")
