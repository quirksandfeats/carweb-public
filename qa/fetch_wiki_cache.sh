#!/usr/bin/env bash
# Fetch Wikipedia wikitext fixtures into qa/wiki_cache/.
#
# The regression suite reads real articles rather than invented ones -- every
# extraction bug this project has had came from a shape nobody would have
# thought to invent. en.wikipedia.org is not reachable from the sandbox the
# work happens in, so this is run here, on the machine, by hand:
#
#   bash qa/fetch_wiki_cache.sh                 # every page listed below
#   bash qa/fetch_wiki_cache.sh Jaguar_XE ...   # just these
#
# Already-cached pages are skipped unless FORCE=1.
set -u
cd "$(dirname "$0")/.."
OUT="qa/wiki_cache"
mkdir -p "$OUT"

PAGES=(
  # a car whose engine field links the family, not the variant
  Jaguar_XE
  Jaguar_Ingenium_engine
  Ford_EcoBoost_engine
  # engines named only by displacement, linked to a section of a family page
  Land_Rover_series
  Land_Rover_engines
  # one article, eight generations, each with its own engine field
  Cadillac_de_Ville_series
  # one article, one generation, a clean petrol/diesel engine list
  Mercedes-Benz_GLA
  # "List of ..." articles: an index of many engines, not one engine
  List_of_Isuzu_engines
  List_of_Porsche_engines
  # an engine article whose applications sit in prose and tables
  Oldsmobile_Diesel_engine
  Buick_Riviera
  # duplicates: one engine reachable under two names
  Duramax_V8_engine
  Isuzu_Aska
)

[ $# -gt 0 ] && PAGES=("$@")

for page in "${PAGES[@]}"; do
  file="$OUT/$(printf '%s' "$page" | tr -c 'A-Za-z0-9_.-' '_').wikitext"
  if [ -s "$file" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "have    $page"
    continue
  fi
  url="https://en.wikipedia.org/w/api.php?action=parse&page=${page}&prop=wikitext&format=json&formatversion=2&redirects=1"
  body=$(curl -sS --compressed --max-time 60 \
              -H 'User-Agent: carweb-fixtures/1.0 (local regression fixtures)' \
              "$url")
  if [ -z "$body" ]; then echo "FAILED  $page (no response)"; continue; fi
  printf '%s' "$body" > "$OUT/.raw.json"
  python3 -c '
import json, sys, io
out, page, src = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(io.open(src, encoding="utf-8"))
except Exception as e:
    print("FAILED  %s (bad json: %s)" % (page, e)); raise SystemExit(0)
if "error" in d:
    print("FAILED  %s (%s)" % (page, d["error"].get("info", "?"))); raise SystemExit(0)
wt = d.get("parse", {}).get("wikitext", "")
if isinstance(wt, dict): wt = wt.get("*", "")
if not wt:
    print("FAILED  %s (empty)" % page); raise SystemExit(0)
io.open(out, "w", encoding="utf-8").write(wt)
print("fetched %s  (%d chars)" % (page, len(wt)))
' "$file" "$page" "$OUT/.raw.json"
  sleep 1
done
