#!/bin/bash
# Wipe the LLM overlay -- every decision the local model layer has ever
# recorded -- and optionally re-bake the graph underneath it too.
#
# Real user question: "Is there a way for me to specifically refresh my entire
# database, and clear all of the LLM queries, clear the purged cars, and reset
# the entire dataset to scratch?"
#
# There are two separate datasets, and "from scratch" means different work for
# each:
#
#   1. The BAKED graph -- app/cars.json and app/data.js, built from DBpedia
#      plus the curated tables in data_src/. Rebuilt by data_src/rebuild.sh,
#      which is idempotent: it re-harvests and re-bakes, and nothing the LLM
#      layer did has ever been written into it.
#
#   2. The LLM OVERLAY -- app/llm_families.json, replayed over the baked graph
#      on every page load. Generation splits, relations, rejections, deletions,
#      the permanently-cleared (purged) blacklist, engines, engine scans,
#      minted facts, renames, merges: all of it. There has never been a way to
#      clear this, which is what this script is for.
#
# The overlay is the only irreplaceable half -- the baked graph can always be
# rebuilt from public sources, while the overlay is hours of local model time
# and your own accept/reject decisions. So it is backed up here, always, before
# anything is written.
#
#   bash scripts/reset_llm_layer.sh                # overlay only
#   bash scripts/reset_llm_layer.sh --with-rebuild # overlay, then re-bake the graph
#   bash scripts/reset_llm_layer.sh --dry-run      # say what it would do
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/app"
JSON="$APP/llm_families.json"
MIRROR="$APP/llm_families_data.js"
BACKUPS="$ROOT/llm_layer_backups"

REBUILD=0
DRY=0
for a in "$@"; do
  case "$a" in
    --with-rebuild) REBUILD=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try --help)"; exit 2 ;;
  esac
done

if [ ! -f "$JSON" ]; then
  echo "no $JSON -- the overlay is already empty, nothing to reset."
else
  echo "── what is in the overlay now ──"
  python3 - "$JSON" <<'PY'
import json, sys, io
path = sys.argv[1]
try:
    data = json.load(io.open(path, encoding="utf-8"))
except Exception as e:
    print("  (could not read it: %s)" % e); raise SystemExit(0)
if not isinstance(data, dict):
    print("  (unexpected shape)"); raise SystemExit(0)
rows = [(k, len(v)) for k, v in data.items() if isinstance(v, (dict, list)) and len(v)]
for k, n in sorted(rows, key=lambda r: -r[1]):
    print("  %-22s %d" % (k, n))
if not rows:
    print("  (empty)")
PY
fi

if [ "$DRY" = "1" ]; then
  echo
  echo "── dry run, nothing written ──"
  echo "would back up   $JSON"
  echo "           to   $BACKUPS/llm_families-<timestamp>.json"
  echo "would reset     $JSON  and  $MIRROR  to {}"
  [ "$REBUILD" = "1" ] && echo "would then run  bash data_src/rebuild.sh"
  exit 0
fi

# Refuse while serve.py is holding the file: it rewrites the whole overlay on
# every decision, so a reset underneath a running session is undone the moment
# the page saves anything.
if command -v lsof >/dev/null 2>&1 && lsof -t "$JSON" >/dev/null 2>&1; then
  echo
  echo "!! something has $JSON open -- stop serve.py first, or the next save"
  echo "   from the open page will write the old overlay straight back."
  exit 1
fi

echo
if [ -f "$JSON" ]; then
  mkdir -p "$BACKUPS"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  cp "$JSON" "$BACKUPS/llm_families-$STAMP.json"
  echo "backed up -> llm_layer_backups/llm_families-$STAMP.json"
  echo "   (to undo this reset: cp that file back over app/llm_families.json)"
fi

printf '{}\n' > "$JSON"
printf 'window.LLM_FAMILIES_STATIC = {};\n' > "$MIRROR"
echo "reset     -> app/llm_families.json, app/llm_families_data.js"

if [ "$REBUILD" = "1" ]; then
  echo
  echo "── re-baking the graph (data_src/rebuild.sh) ──"
  bash data_src/rebuild.sh
fi

echo
echo "Done. The graph is back to what DBpedia and the curated tables say, with"
echo "no LLM decisions over it: no splits, no relations, no engines, no"
echo "rejections, and nothing on the permanently-cleared list."
