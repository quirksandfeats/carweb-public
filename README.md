# The Car Web

An explorable knowledge graph of the automobile industry: **about 11,600 car
models** (about 1,330 of them nameplates split into their generations),
**about 1,200 makes** and **about 3,050 people** (2,829 designers and about 380
engineers), joined by **about 56,700 connections**, from 1883 to today. The
counts grow with each scan; the footer of the site shows the current ones.

Made-by, designed-by, engineered-by, shared-platform, rebadge, succession and
generation-succession links, all on one canvas.

## Run it

Double-click `app/index.html`. No server, no build step, works offline.

## The four views

- **Graph** — the whole web on canvas. Positions are baked at build time, so it
  opens instantly. Click to focus, double-click to widen, Esc to release.
- **Powertrain** — engines, their variants and the cars they were fitted to.
- **Timeline** — every debut from 1883 to today across ten country lanes. Follow a
  designer's or engineer's career threading through the decades, or a nameplate
  through all its generations.
- **Six Degrees** — shortest path between any two nodes. Try Peter Rawlinson →
  Colin Chapman.

A **Shared Platforms** button narrows any view to the cars that share a
platform with, or are a rebadge of, some other car.

A **None | Designers | Engineers | Both** switch re-lenses every view, and a
year-range slider (all years by default) narrows the view without hiding
anything you navigate to directly.

## The chief-engineer layer

DBpedia carries no chief-engineer data at all. The 139 curated engineers, and
the 245 attributions tying them to specific cars, are hand-compiled from articles,
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
article text before it is kept. Discoveries live in `app/llm_families.json` and
its browser mirrors `app/llm_families_data*.js`. `bash scripts/reset_llm_layer.sh`
backs them up and empties them, which resets the layer to nothing and leaves the
harvested graph untouched.

What the layer does:

- **Generations.** Splits a nameplate into its generations. A first split
  applies itself, and so does a re-check: the article's headings decide what it
  adds, and it retires only an overview or a duplicate of a kept generation. A
  generation the re-read leaves out otherwise stays. What the headings cannot
  settle waits in **Tools → Pending Generation Splits**. A car the article states as the predecessor or the
  successor is not a generation. A car with no stated year stays undated.
  Generations of one nameplate can overlap in years, and that alone never makes
  them one car.
- **Placing a generation.** A scanned car named as a nameplate and a code or
  generation, such as "Ford Falcon (XG)", joins that nameplate and keeps its own
  article. It folds into a generation that is the same car, and otherwise becomes
  a new one. A year, a place or another word in the brackets needs the nameplate's
  own page to point at the car, so the Lancia Delta (1911) stays apart. The
  nameplate is then read at the same cascade level, and that read only adds. A
  page that only lists other articles is not read as a car's article.
- **Shared platforms.** Reads which other cars each generation shares a
  platform with or is a rebadge of, and connects it to the right generation of
  the right car. A connection to a nameplate is hidden once a generation of
  that nameplate is connected.
- **Waiting relationships.** A connection the layer is unsure of is decided by
  rule wherever the evidence allows: the sentence behind it is matched again
  against the whole graph (make, model words, trim words, chassis codes,
  "II"/"Mk5"/"third generation", Wikipedia redirects, and which generation was
  built at the same time). It is confirmed, moved to the right car, refused, or
  left for you. Checked against Wikipedia on 100 real cases, the rules never
  confirmed or moved one wrongly.
- **Engines (Powertrain mode).** Reads each generation's engines from its own
  infobox section, with no model call, and links them to engine articles.

## Requesting a scan remotely

The hosted copy can ask the machine with the model on it to run a pass:
a button on the site queues a job in a Cloudflare Worker, and
`scripts/llm_agent.py` on that machine picks it up, runs a full scan (every
reached car is re-read, to the configured cascade depth), pushes, and shuts
itself down. There is no overall time limit; a car that hangs or crashes the
page three times is set aside for a later `--resume`. See
[`docs/REQUEST-QUEUE.md`](docs/REQUEST-QUEUE.md).

While it runs, the agent can keep a one-page status dashboard up to date
(`scripts/status_page.py`): written when it starts, every 15 minutes, and as a
final report when it stops. It also lists the five cars that would add the most
new cars, with a slider for cascade levels 1 to 7, worked out when a run starts and
when it ends. Say
where in `scripts/agent_settings.local.json`, which git ignores:

```json
{"statusPage": "/path/to/a/synced/folder/CarWeb scan status.html"}
```

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

178 headless jsdom regression tests, plus the `qa/qa_*.py` suites (those
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
development log — about 2,700 lines covering every design decision, the measured
speculative-decoding benchmark, and the bug reports behind most of the features
above.
