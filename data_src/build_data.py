#!/usr/bin/env python3
"""Build The Car Web dataset (v2 — exhaustive).

Combines:
  d_people.py    curated MAKES + DESIGNERS
  d_models.py    curated MODELS (verified core, always wins)
  d_links.py     curated PLATFORM_GROUPS
  d_engineers.py curated ENGINEERS + MODEL_ENGINEERS (chief engineers / project leads)
  d_auto.py      harvest-generated AUTO_* tables + SUCCESSION/RELATED edges

Emits ../app/cars.json + ../app/data.js (positions added by layout.mjs).
People are emitted as type "person" with roles:["designer"] / ["engineer"] / both.
"""
import json, os, re, sys, datetime, unicodedata
from collections import Counter
from d_people import MAKES, DESIGNERS
from d_models import MODELS
from d_links import PLATFORM_GROUPS
from d_engineers import ENGINEERS, MODEL_ENGINEERS
from d_auto import AUTO_MAKES, AUTO_DESIGNERS, AUTO_MODELS, SUCCESSION, RELATED
from build_family_layer import build_families

# ---------------- My Database layer: opt-in, OFF by default ----------------
# The "My Database" layer enriches the graph from a private "Car Database"
# tree of magazine road tests that is deliberately NOT part of this
# repository, and whose contents may not be redistributed. A public build
# must never call it, so it is off unless explicitly switched on:
#
#     CARWEB_DB_LAYER=1 python3 build_data.py
#
# With the layer off, no node ever carries a db* field -- enforced by a hard
# guard immediately before cars.json/data.js are written, below.
DB_LAYER = os.environ.get("CARWEB_DB_LAYER", "0").strip().lower() in ("1", "true", "yes", "on")
try:
    from build_db_layer import enrich as enrich_db_layer, flag_garage
except ImportError:  # build_db_layer.py absent from this checkout
    enrich_db_layer = flag_garage = None

errors, warnings = [], []

def slug(s):
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"ß", "ss", s)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "x"

def norm(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s.lower())

# ---------------- makes ----------------
all_makes = dict(MAKES)
for k, v in AUTO_MAKES.items():
    if k not in all_makes: all_makes[k] = (v[0], v[1])

# ---------------- people ----------------
# key: norm(name) -> {label, kind, born, died, country, note, roles}
people = {}
def add_person(name, kind, born, died, country, note, role):
    k = norm(name)
    if k in people:
        p = people[k]
        if role not in p["roles"]: p["roles"].append(role)
        if born and not p["born"]: p["born"] = born
        if died and not p["died"]: p["died"] = died
        if country and not p["country"]: p["country"] = country
        if note and not p["note"]: p["note"] = note
        return p["label"]
    people[k] = dict(label=name, kind=kind, born=born, died=died,
                     country=country, note=note, roles=[role])
    return name

for name, (kind, b, d, c, note) in DESIGNERS.items():
    add_person(name, kind, b, d, c, note, "designer")
for name, (kind, b, d, c, note) in ENGINEERS.items():
    add_person(name, kind, b, d, c, note, "engineer")
for name, (kind, b, d, c, note) in AUTO_DESIGNERS.items():
    if norm(name) not in people:
        add_person(name, kind, b, d, c, note, "designer")
    else:
        add_person(name, kind, b, d, c, note, "designer")  # merges roles/meta

# ---------------- models ----------------
# curated first (win), then auto (skip if same make+name or same wp)
seen_mn, seen_wp = set(), set()
models = []  # dicts
for (make, name, y0, y1, designers, wp, note) in MODELS:
    if make not in all_makes: errors.append(f"unknown make {make!r} for {name}")
    # database floor is 1880 (the dawn of the automobile); curated pre-1959
    # icons no longer need to reach into the 1959+ era to be included
    if not (1880 <= y0 <= 2026): errors.append(f"odd year {y0} for {make} {name}")
    if y1 is not None and y1 < y0: errors.append(f"end<start for {make} {name}")
    w = wp or f"{make} {name}"
    models.append(dict(make=make, name=name, y0=y0, y1=y1, designers=list(designers),
                       wp=w, note=note, src="cur"))
    seen_mn.add((norm(make), norm(name))); seen_wp.add(norm(w))

for (make, name, y0, y1, designers, wp, note) in AUTO_MODELS:
    if (norm(make), norm(name)) in seen_mn or norm(wp) in seen_wp: continue
    if not (1880 <= y0 <= 2026): continue
    if y1 is not None and y1 < y0: y1 = None
    models.append(dict(make=make, name=name, y0=y0, y1=y1, designers=list(designers),
                       wp=wp, note=note, src="auto"))
    seen_mn.add((norm(make), norm(name))); seen_wp.add(norm(wp))

# canonicalize model designer names against people table
for m in models:
    ds = []
    for d in m["designers"]:
        k = norm(d)
        if k in people: ds.append(people[k]["label"])
        else:
            add_person(d, "person", None, None, None, None, "designer")
            ds.append(d)
    m["designers"] = list(dict.fromkeys(ds))

# ---------------- engineer attributions ----------------
model_by_wp = {norm(m["wp"]): m for m in models}
model_by_mn = {(norm(m["make"]), norm(m["name"])): m for m in models}
eng_misses = []
for entry in MODEL_ENGINEERS:
    wp_t, eng, role = (entry + (None,))[:3]
    m = model_by_wp.get(norm(wp_t))
    if not m:
        # try "make name" split match
        parts = wp_t.split(" ", 1)
        if len(parts) == 2:
            m = model_by_mn.get((norm(parts[0]), norm(parts[1])))
    if not m:
        eng_misses.append(wp_t); continue
    k = norm(eng)
    if k not in people:
        add_person(eng, "person", None, None, None, None, "engineer")
    label = people[k]["label"]
    if "engineer" not in people[k]["roles"]: people[k]["roles"].append("engineer")
    m.setdefault("engineers", [])
    if not any(e[0] == label for e in m["engineers"]):
        m["engineers"].append((label, role))

if eng_misses:
    warnings.append(f"engineer attributions unmatched: {len(eng_misses)} -> {eng_misses}")

# ---------------- build graph ----------------
nodes, links = [], []
make_ids, person_ids, model_ids = {}, {}, {}

WP_MAKE_OVERRIDE = {"Mini":"Mini (marque)","Smart":"Smart (marque)","Eagle":"Eagle (automobile)",
                    "Genesis":"Genesis Motor","DS":"DS Automobiles","Li":"Li Auto",
                    "Beijing":"Beijing Automotive Group","Lynk & Co":"Lynk & Co"}

used_makes = {m["make"] for m in models}
for mk in sorted(used_makes):
    country, founded = all_makes.get(mk, ("Unknown", None))
    mid = "mk-" + slug(mk)
    if mid in make_ids.values(): mid += "-2"
    make_ids[mk] = mid
    nodes.append({"id": mid, "type": "make", "label": mk, "country": country,
                  "year": founded, "wp": WP_MAKE_OVERRIDE.get(mk, mk)})

used_people = set()
for m in models:
    for d in m["designers"]: used_people.add(norm(d))
    for e, _ in m.get("engineers", []): used_people.add(norm(e))
for k in sorted(used_people):
    p = people[k]
    pid = "p-" + slug(p["label"])
    n = 2
    while pid in person_ids.values(): pid = f"p-{slug(p['label'])}-{n}"; n += 1
    person_ids[k] = pid
    node = {"id": pid, "type": "person", "kind": p["kind"], "label": p["label"],
            "roles": p["roles"], "born": p["born"], "died": p["died"],
            "country": p["country"], "wp": p["label"]}
    if p["note"]: node["note"] = p["note"]
    nodes.append(node)

for m in models:
    base = f"m-{slug(m['make'])}-{slug(m['name'])}"
    mid, n = base, 2
    while mid in model_ids.values(): mid = f"{base}-{n}"; n += 1
    model_ids[(norm(m["make"]), norm(m["name"]))] = mid
    m["id"] = mid
    node = {"id": mid, "type": "model", "label": m["name"], "make": m["make"],
            "year": m["y0"], "end": m["y1"], "designers": m["designers"], "wp": m["wp"]}
    if m.get("engineers"):
        node["engineers"] = [e for e, _ in m["engineers"]]
        node["engroles"] = {e: r for e, r in m["engineers"] if r}
    if m["note"]: node["note"] = m["note"]
    if m["y0"] < 1970: node["heritage"] = True
    if m["src"] == "auto": node["auto"] = True
    nodes.append(node)
    links.append({"source": mid, "target": make_ids[m["make"]], "type": "made"})
    for d in m["designers"]:
        links.append({"source": mid, "target": person_ids[norm(d)], "type": "designed"})
    for e, role in m.get("engineers", []):
        l = {"source": mid, "target": person_ids[norm(e)], "type": "engineered"}
        if role: l["note"] = role
        links.append(l)

# platform groups (curated)
pair_seen = set()
def model_id_of(ref):
    return model_ids.get((norm(ref[0]), norm(ref[1])))
for note, members in PLATFORM_GROUPS:
    ids = []
    for ref in members:
        mid = model_id_of(ref)
        if not mid: errors.append(f"platform ref not found: {ref} in '{note}'")
        else: ids.append(mid)
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = sorted((ids[i], ids[j]))
            if (a, b) in pair_seen: continue
            pair_seen.add((a, b))
            links.append({"source": a, "target": b, "type": "platform", "note": note})

# harvest succession / related edges
for (a_ref, b_ref) in SUCCESSION:
    a, b = model_id_of(a_ref), model_id_of(b_ref)
    if not a or not b or a == b: continue
    key = tuple(sorted((a, b)))
    if key in pair_seen: continue
    pair_seen.add(key)
    links.append({"source": a, "target": b, "type": "succession"})
for (a_ref, b_ref) in RELATED:
    a, b = model_id_of(a_ref), model_id_of(b_ref)
    if not a or not b or a == b: continue
    key = tuple(sorted((a, b)))
    if key in pair_seen: continue
    pair_seen.add(key)
    links.append({"source": a, "target": b, "type": "related"})

if errors:
    print("ERRORS:"); [print("  -", e) for e in errors]; sys.exit(1)

# ---------------- my database layer ----------------
garage_node = None
if DB_LAYER and enrich_db_layer:
    db_stats = enrich_db_layer(nodes)
    garage_node = flag_garage(nodes, "BMW", "X1", year_hint=2024)
    print(f"  db layer: matched={db_stats['matched']} ambiguous={db_stats['ambiguous']} "
          f"unmatched={db_stats['unmatched']} garage={'yes' if garage_node else 'NOT FOUND'}")
elif DB_LAYER:
    print("  db layer: REQUESTED but build_db_layer.py is not in this checkout -- skipped")
else:
    if flag_garage:
        garage_node = flag_garage(nodes, "BMW", "X1", year_hint=2024)
    print("  db layer: disabled (set CARWEB_DB_LAYER=1 to enable) -- public build")

# ---------------- nameplate family layer ----------------
fam_stats = build_families(nodes, links)
print(f"  family layer: families={fam_stats['families']} generations-collapsed={fam_stats['generations']} "
      f"unconfirmed={fam_stats['unconfirmed']} mirrored-relations={fam_stats.get('mirroredRelations', 0)} "
      f"(see harvest/family_match_report.txt)")

counts = {"nodes": len(nodes), "links": len(links),
          "models": sum(1 for n in nodes if n["type"] == "model"),
          "families": sum(1 for n in nodes if n["type"] == "family"),
          "makes": sum(1 for n in nodes if n["type"] == "make"),
          "people": sum(1 for n in nodes if n["type"] == "person"),
          "designers": sum(1 for n in nodes if n["type"] == "person" and "designer" in n["roles"]),
          "engineers": sum(1 for n in nodes if n["type"] == "person" and "engineer" in n["roles"])}
data = {
    "meta": {
        "title": "The Car Web",
        "version": 5,
        "generated": datetime.date.today().isoformat(),
        "source": "Compiled from Wikipedia/DBpedia (text under CC BY-SA); images fetched live from Wikipedia/Wikimedia Commons",
        "counts": counts,
        "dbLayer": DB_LAYER,
    },
    "nodes": nodes, "links": links,
}

# Hard guard: with the layer off, nothing db*-shaped may reach disk. A
# stale field surviving from an earlier enriched run, or a future code path
# adding one by accident, fails the build loudly rather than shipping
# non-redistributable road-test data into a public snapshot.
if not DB_LAYER:
    leaked = sorted({k for n in nodes for k in n if k.startswith("db")})
    if leaked:
        print("REFUSING TO WRITE: My Database fields present while the layer is "
              f"disabled: {leaked}")
        print("  Re-run a clean build, or set CARWEB_DB_LAYER=1 if this is a private build.")
        sys.exit(1)

os.makedirs("../app", exist_ok=True)
with open("../app/cars.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
with open("../app/data.js", "w", encoding="utf-8") as f:
    f.write("window.CARDATA = ")
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")

print(f"OK nodes={counts['nodes']} models={counts['models']} makes={counts['makes']} "
      f"people={counts['people']} (designers={counts['designers']} engineers={counts['engineers']}) links={counts['links']}")
print("  links:", dict(Counter(l['type'] for l in links)))
deg = Counter()
for l in links: deg[l["source"]] += 1; deg[l["target"]] += 1
iso = [n["id"] for n in nodes if deg[n["id"]] == 0]
if iso: print("  ISOLATED:", len(iso), iso[:10])
for w in warnings[:10]: print("  warn:", w)
