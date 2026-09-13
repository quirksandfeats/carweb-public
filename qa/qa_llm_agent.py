#!/usr/bin/env python3
"""Unit checks for scripts/llm_agent.py's decision-making.

Everything the agent does that is worth getting wrong happens before a single
model call: WHICH nodes it picks, in WHAT order, and WHICH files it is allowed
to commit. Those are pure functions over a text report and a JSON file, so
they are tested here with fixtures -- no llama-server, no browser, no network,
which is also why this suite (unlike the other qa_*.py files) runs anywhere.
"""
import importlib.util
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("llm_agent", os.path.join(ROOT, "scripts", "llm_agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (("  -- " + str(extra)) if extra != "" else ""))
    if not cond:
        fails.append(name)


# A report with all four sections, shaped like the real one -- including the
# ids that appear on the CONFIRMED section's own EXCLUDED lines, which must
# not be picked up, and one id present in BOTH review sections, which must
# appear once.
REPORT = """FAMILY GROUPING REPORT
Generated: 2026-09-13

CONFIRMED FAMILIES (2) -- clean, unbroken succession chain
  BMW 3 Series  (7 generations, 1975-)
      3 Series (E21)[1975-1983] -> 3 Series (E30)[1982-1994]
      EXCLUDED: 3 Series [1975-] id=m-bmw-3-series -- no succession link
  Porsche 911  (7 generations, 1975-)
      EXCLUDED: 911 (classic) [1964-1989] id=m-porsche-911-classic -- covers two or more

UNCONFIRMED (3) -- candidate group found, NOT auto-grouped, needs review
  Acura Integra  (2 candidates) -- fewer than 2 chronologically-connected generations
      Integra [1985-] id=m-acura-integra
      Integra (2022) [2022-] id=m-acura-integra-2022
  Ford Ranger  (2 candidates) -- fewer than 2 chronologically-connected generations
      Ranger [1982-] id=m-ford-ranger
      Ranger (T6) [2011-] id=m-ford-ranger-t6

NAME COLLISIONS (1) -- unrelated marques sharing a name, correctly not grouped
  Ajax  (2 unrelated articles)
      Ajax [1925-] id=m-ajax-collision

UN-SPLIT NAMEPLATE CANDIDATES (3) -- suggested by credit dates
  Chevrolet Suburban  [1933-2020]  id=m-chevrolet-suburban  -> split into generations
      Wayne Cherry (b. 1937) predates the car's start year
  Jaguar XJS  [1975-1996]  id=m-jaguar-xjs  -> split into generations
      Malcolm Sayer (d. 1970) died well before it
  Acura Integra  [1985-]  id=m-acura-integra  -> split into generations
      someone (b. 1990) predates the car's start year
"""

with tempfile.TemporaryDirectory() as tmp:
    rpath = os.path.join(tmp, "report.txt")
    open(rpath, "w", encoding="utf-8").write(REPORT)
    ids = agent.review_queue_ids(rpath)

    check("the evidence-backed section comes first",
          ids[:2] == ["m-chevrolet-suburban", "m-jaguar-xjs"], ids[:3])
    check("the weaker UNCONFIRMED section follows it",
          ids[3:] == ["m-acura-integra-2022", "m-ford-ranger", "m-ford-ranger-t6"], ids[3:])
    check("an id in both sections appears once, at its strongest position",
          ids.count("m-acura-integra") == 1 and ids.index("m-acura-integra") == 2, ids)

    check("nothing is taken from CONFIRMED, including its EXCLUDED lines",
          "m-bmw-3-series" not in ids and "m-porsche-911-classic" not in ids, ids)
    check("nothing is taken from NAME COLLISIONS -- those are different cars, "
          "not a nameplate to split",
          "m-ajax-collision" not in ids, ids)
    # 3 from UN-SPLIT + 4 from UNCONFIRMED, with Integra shared between them.
    check("every id is accounted for and none invented", len(ids) == 6, len(ids))

    check("a missing report is empty, not an error",
          agent.review_queue_ids(os.path.join(tmp, "nope.txt")) == [])

    # ---- already_scanned ----
    fpath = os.path.join(tmp, "llm_families.json")
    json.dump({
        "families": {"m-jaguar-xjs": {"status": "confirmed"}},
        "recheck": {"m-ford-ranger": {"status": "provisional"}},
        "dismissed": {"m-ford-ranger-t6": True},
    }, open(fpath, "w", encoding="utf-8"))
    scanned = agent.already_scanned(fpath)
    check("a family that already has an entry counts as scanned", "m-jaguar-xjs" in scanned)
    check("so does one with a pending re-check", "m-ford-ranger" in scanned)
    check("a node the user dismissed counts as scanned, so a run cannot "
          "undo that by hand every time", "m-ford-ranger-t6" in scanned)
    check("an unscanned node does not", "m-chevrolet-suburban" not in scanned)

    todo = [i for i in ids if i not in scanned]
    check("the run's target list is the queue minus what is already done",
          todo == ["m-chevrolet-suburban", "m-acura-integra", "m-acura-integra-2022"], todo)

    check("a missing or unreadable file is empty, not an error",
          agent.already_scanned(os.path.join(tmp, "nope.json")) == set())

# ---- what it is allowed to commit ----
check("only the two files the pass can write are committable",
      agent.TRACKED == ["app/llm_families.json", "app/llm_families_data.js"], agent.TRACKED)
src = open(os.path.join(ROOT, "scripts", "llm_agent.py"), encoding="utf-8").read()
check("it never stages the whole tree -- this runs unattended in a working "
      "copy that may have anything else half-finished in it",
      '"add", "-A"' not in src and '"add", "."' not in src)
check("the commit carries no Claude attribution",
      "Co-Authored-By" not in src and "Claude" not in src.replace("Claude Browser", ""))

print()
print("ALL GREEN" if not fails else "FAILURES: " + str(fails))
sys.exit(1 if fails else 0)
