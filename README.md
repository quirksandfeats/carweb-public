# The Car Web

An explorable knowledge graph of the automobile industry: **6,786 car models**
(101 of them grouped into nameplate families spanning 427 generations),
**1,124 makes** and **2,356 people** — 2,253 designers and 139 chief engineers —
joined by **19,695 relations**, from 1883 to today.

Made-by, designed-by, engineered-by, shared-platform, rebadge, succession and
generation-succession links, all on one canvas.

## Run it

Double-click `app/index.html`. No server, no build step, works offline.

## The four views

- **Graph** — the whole web on canvas. Positions are baked at build time, so it
  opens instantly. Click to focus, double-click to widen, Esc to release.
- **Timeline** — every debut from 1886 to 2026 across ten country lanes. Follow a
  designer's or engineer's career threading through the decades, or a nameplate
  through all its generations.
- **Six Degrees** — shortest path between any two nodes. Try Peter Rawlinson →
  Colin Chapman.
- **Platforms** — only the cars that actually share a platform with, or are a
  rebadge of, some other car.

A **None | Designers | Engineers | Both** switch re-lenses every view, and a
year-range slider (2000–present by default) keeps the opening view uncluttered
without hiding anything you navigate to directly.

## The chief-engineer layer

DBpedia carries no chief-engineer data at all. The 139 engineers here, and the
243 attributions tying them to specific cars, are hand-compiled from articles,
published interviews and marque histories, then spot-verified against source
text: Chapman's Lotuses, Toyota's shusa system, the Corvette dynasty from
Duntov through Juechter, Materazzi from the Stratos to the EB110.

It is the one layer of this dataset with no upstream equivalent.

## Optional: the local-LLM layer

Wikipedia documents some nameplates' generations as sections of a single article,
so DBpedia never sees them as separate things to harvest. Run
`python3 app/serve.py` with [llama.cpp](https://github.com/ggml-org/llama.cpp)'s
`llama-server` on your PATH and the app can ask a local model to find them —
nothing is sent to any cloud service.

Every generation code, year and name the model returns is checked against the
article text before it is kept, and nothing reaches the graph without your
confirmation. Discoveries live only in `app/llm_families.json`; delete that file
and the layer resets to nothing, leaving the harvested graph untouched.

## Rebuilding

```bash
bash data_src/rebuild.sh              # re-harvest from DBpedia, rebuild, re-bake the layout
bash data_src/rebuild.sh --no-harvest # rebuild from what is already merged
```

## Tests

```bash
cd qa/jsdom && npm install jsdom --no-save
for f in jsdom_*_test.js; do node "$f" >/dev/null 2>&1 || echo "FAILED: $f"; done
```

84 headless jsdom regression tests, plus the `qa/qa_*.py` suites (those
need Playwright, or a running `llama-server` for the MTP benchmark).

## Data and licence

Compiled from [DBpedia](https://www.dbpedia.org/) and
[Wikipedia](https://en.wikipedia.org/), whose text is CC BY-SA, plus the
hand-curated designer and chief-engineer layers. Images are fetched live from
Wikimedia Commons and never stored in this repository.

| | |
|---|---|
| Code | [Apache-2.0](LICENSE) |
| Data | [CC BY-SA 4.0](LICENSE-DATA) — ShareAlike carries forward from the sources |
| Provenance | [ATTRIBUTION.md](ATTRIBUTION.md) |

## Further reading

[`docs/ENGINEERING-LOG.md`](docs/ENGINEERING-LOG.md) is the project's full
development log — 1,800 lines covering every design decision, the measured
speculative-decoding benchmark, and the bug reports behind most of the features
above.
