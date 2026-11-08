# Attribution and data provenance

The Car Web is compiled from several sources with different licences. This
file records exactly which layer came from where, both to satisfy the
CC BY-SA attribution requirement and so anyone reusing the data knows what
they are handling.

## Ready-to-paste attribution

> Data from [The Car Web](https://github.com/quirksandfeats/carweb-public) by Andrew
> Goldenberg, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
> Derived from [DBpedia](https://www.dbpedia.org/) and
> [Wikipedia](https://en.wikipedia.org/), also CC BY-SA.

## Layer by layer

### Harvested core — DBpedia and Wikipedia
Most of the graph. Models, makes, designer credits, and the
succession/related/platform edges between them are harvested from the DBpedia
SPARQL endpoint (`data_src/harvest.py`), plus the live Wikipedia category API
for the newest model years.

* Source: <https://www.dbpedia.org/> and <https://en.wikipedia.org/>
* Licence: CC BY-SA — <https://creativecommons.org/licenses/by-sa/4.0/>
* Files: `data_src/harvest/carweb_dbpedia_harvest.csv` → `data_src/d_auto.py`

### Curated designer layer
`data_src/d_people.py` — 120 designers with dates, nationality and a one-line
note. Compiled by hand from Wikipedia articles and marque histories.

### Curated chief-engineer layer
`data_src/d_engineers.py` — 138 chief engineers and project leads, and 224
attributions linking them to specific cars. Compiled by hand from Wikipedia
articles, published interviews and marque histories, and spot-verified against
article text. DBpedia carries no chief-engineer data at all, so this layer has
no upstream equivalent; it is an original compilation.

### Curated pre-1959 landmarks
`data_src/d_models.py` — 435 hand-curated models, including about 40 pre-1959
landmarks (Benz
Patent-Motorwagen, Ford Model T, Bugatti Type 35, Citroën Traction Avant and
others). Curated entries always win over an auto-harvested duplicate.

### Local-LLM generation layer
`app/llm_families.json` (mirrored for the browser in `app/llm_families_data.js`
and `app/llm_families_data_N.js`) — nameplate generation splits, people credits,
engines and platform relations extracted from Wikipedia article text by a
locally-run model. Every claim is validated verbatim against the source article
before it is kept. Most entries are then confirmed by rules or by the scan agent
(a nameplate's first split, a re-check the article's headings settle); a few by
hand. Derived from Wikipedia text, therefore CC BY-SA.
`bash scripts/reset_llm_layer.sh` empties the store and its mirrors, which resets
this layer to nothing.

### Generated lists
`app/article_ends.js`, `app/namesake_people.js`, `app/redirect_years.js`,
`app/list_page_reads.js`, `app/borrowed_reads.js` and `app/shared_names.js` are generated from Wikipedia
by the scripts of the same names in `scripts/`. Derived from Wikipedia, therefore
CC BY-SA.

### Images
Article thumbnails and extracts are fetched live from Wikipedia and Wikimedia
Commons at view time and are **never stored in this repository**. Individual
images carry their own licences. A car's card credits the photo it shows with
its author and licence, read from the file's page when the card opens, and links
to that page and to the licence.

### Bundled third-party code
`app/d3.min.js` — D3.js, Copyright 2010–2023 Mike Bostock, ISC License.

## What is deliberately excluded

The **"My Database"** layer is a private, personal collection of magazine
road-test figures and photographs (from *auto motor und sport*, published by
Motor Presse Stuttgart). It is **not part of this repository** and is not
redistributable:

* Motor Presse Stuttgart has reserved its rights under Germany's text-and-data-mining
  exception (§44b UrhG), so systematic extraction of that data is not permitted.
* Photographs and verbatim measurement/scoring tables are protected in their
  own right.

Accordingly:

* `app/db_pages/`, `app/db_photos/`, `app/db_match*` and the `Car Database/`
  tree are excluded from this repository and gitignored.
* No node in the published dataset carries a `db`, `dbspecs`, `dbPage`,
  `dbphoto`, `dbSourceFolders` or `dbGenerations` field.
* `data_src/build_db_layer.py` is not part of this repository. `build_data.py`
  skips the layer when it is absent, runs it only when `CARWEB_DB_LAYER=1` is set,
  and `build_data.py` refuses to write a snapshot
  containing any `db*` field while the layer is off.

If you want a road-test or specification layer on top of this graph, use a
source you are licensed to redistribute. Openly licensed options include the
German Kraftfahrt-Bundesamt's open data (Datenlizenz Deutschland –
Namensnennung – Version 2.0).
