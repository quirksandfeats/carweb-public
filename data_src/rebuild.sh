#!/bin/bash
# Full project refresh: re-harvest from DBpedia/Wikipedia, rebuild the graph,
# re-bake the layout. Run from anywhere:  bash data_src/rebuild.sh
# Skip the (slow) harvest step with:      bash data_src/rebuild.sh --no-harvest
set -e
cd "$(dirname "$0")"

if [ "$1" != "--no-harvest" ]; then
  echo "── harvesting fresh data (needs internet, ~1-2 min) ──"
  # A failed harvest must not abandon the rebuild. DBpedia's endpoint goes down
  # for hours at a time, and when it does the harvest CSV from last time is
  # still sitting in harvest/ -- so every step after this one can still run and
  # still pick up any changes to the curated tables or the build code. Only a
  # missing CSV is genuinely fatal. (harvest.py exits 2 for an unreachable
  # endpoint and has already explained itself by this point.)
  set +e
  python3 harvest.py
  harvest_status=$?
  set -e
  if [ $harvest_status -ne 0 ]; then
    if [ -f harvest/carweb_dbpedia_harvest.csv ]; then
      echo
      echo "── harvest failed (exit $harvest_status) — continuing from the existing CSV ──"
      echo "   The graph will rebuild from the last successful harvest, so anything"
      echo "   that changed in the curated tables or the build code still applies."
      echo "   Re-run without --no-harvest once the endpoint is back to pick up new cars."
    else
      echo "!! harvest failed and there is no previous harvest/carweb_dbpedia_harvest.csv"
      echo "   to fall back on, so there is nothing to build from. Aborting."
      exit $harvest_status
    fi
  fi
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
