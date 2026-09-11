#!/bin/bash
# Full project refresh: re-harvest from DBpedia/Wikipedia, rebuild the graph,
# re-bake the layout. Run from anywhere:  bash data_src/rebuild.sh
# Skip the (slow) harvest step with:      bash data_src/rebuild.sh --no-harvest
set -e
cd "$(dirname "$0")"

if [ "$1" != "--no-harvest" ]; then
  echo "── harvesting fresh data (needs internet, ~1-2 min) ──"
  python3 harvest.py
fi

echo "── merging harvest into source tables ──"
python3 merge_harvest.py

echo "── building the graph ──"
# The My Database layer (build_db_layer.py) is OFF unless CARWEB_DB_LAYER=1 is
# set -- it reads a private road-test tree that is not part of this repository.
python3 build_data.py

if command -v node >/dev/null 2>&1; then
  echo "── baking the layout (~30 s) ──"
  [ -d node_modules/d3-force ] || npm install --silent
  node layout.mjs
else
  echo "!! node not found — layout not baked. The app still works, but the"
  echo "   first page load will spend ~a minute settling the layout itself."
  echo "   Install Node (https://nodejs.org) and rerun for instant loads."
fi

echo "── done — reload app/index.html ──"
if [ "${CARWEB_DB_LAYER:-0}" = "1" ]; then
  echo "   (My Database match report: data_src/harvest/db_match_report.txt)"
fi
