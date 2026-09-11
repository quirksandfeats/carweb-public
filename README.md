# The Car Web — v2 (exhaustive + live + My Database + nameplates)

> **Note on this repository.** This is the public build. The personal
> "My Database" road-test layer described below is **not included** and its
> build step is disabled by default — see `ATTRIBUTION.md` for why. Everything
> else works exactly as documented. This README is also the project's full
> engineering log (1,800 lines); if you just want to run the thing, see
> "Run it" immediately below.

An explorable knowledge graph of **6,757 car models (101 grouped into nameplate
families, spanning 394 individual generations), 1,128 makes and 2,356 people**
(2,253 designers · 139 chief engineers/project leads, some are both) from 1883
to today, with **19,620 real connections** — made-by, designed-by,
engineered-by, shared-platform/rebadge, succession, generation-succession and
related-car links (676 of those are family-level "mirrors" of a platform/
related/succession link one of whose endpoints is a collapsed nameplate — see
"Nameplate families" below).

## Run it

Double-click **`app/index.html`**. No server, no build, works offline.

Want the LLM generation-check feature (below)? Run `python3 app/serve.py`
instead and open `http://localhost:8077/index.html` — everything else works
identically either way.

## Live data (new)

The app boots instantly from its local snapshot, then — on every page load —
queries the **DBpedia SPARQL API** (plus the live Wikipedia category API for the
newest model years) directly from your browser. If anything new is found you get
a one-click **Apply** toast; the status chip in the footer shows the data state
(click it to force a refresh). Offline? You just keep the last snapshot.

`app/data_live.js` persists what it finds to `localStorage` so the next boot
starts from it without re-querying — but only the **delta** (the brand-new
nodes/links, plus a small `{end year, designers}` patch map for existing
nodes), never the whole multi-MB dataset. That distinction mattered in
practice: an earlier version persisted the *entire* merged snapshot on every
refresh, which silently exceeded Safari's (much tighter than Chrome's)
localStorage quota — the write just failed there, so the cache never actually
stuck and the same "diff" kept reappearing on every load. It also had no way
to re-apply a field-level update (like a newly-discovered production-end
year) onto a node that already existed, so even on Chrome an "N updated"
count never resolved to 0. The delta is tens of KB, comfortably inside every
browser's quota, and the boot-time splice now applies its patch map to
matching existing nodes — see `jsdom_live_splice_test.js` for the full
regression coverage of both fixes.

The hand-curated layers (chief engineers, platform groups, the verified core) are
never touched by a live refresh — DBpedia has no chief-engineer data at all, which
is why that layer is compiled and verified by hand.

## The people layer toggle (new)

The **None | Designers | Engineers | Both** switch in the top bar re-lenses every view:

- **None** — hide every designer/engineer node and their links; just makes and models.
- **Designers** — the people who drew the cars (steel-blue rings).
- **Engineers** — chief engineers & project leads (bronze rings): Chapman's Lotuses,
  Toyota's shusa system (Uchiyamada → Prius, Tada → 86), Corvette's dynasty
  (Duntov → McLellan → Hill → Juechter), Materazzi (Stratos → 288 GTO → F40 → EB110),
  Rawlinson (Model S → Lucid Air)…
- **Both** — both layers at once; dual-role people (Chapman, Murray, Issigonis…)
  get a two-tone ring.

Six Degrees pathfinding respects the active layer. The timeline's "Follow…"
picker respects it for people, and separately lets you follow a **nameplate**
instead (see "Nameplate families" below) — either way it draws the same kind
of connecting line across the years.

**A person's card counts each car once, at its most specific level.** Real
user request: *"when I click on a designer or an engineer and it counts how
many cars that a given person (or group) worked on, it should not count the
nameplate of the car and then a generation of the nameplate separately. In
the case where the person (or group) is associated with both, then it should
only be counted once, and it should explicitly display only the generation of
the nameplate of the car… Naturally, if a nameplate doesn't have further info
about who designed the generations but only has info on the nameplate itself,
then fall back to the nameplate linking."*

The double link is created deliberately upstream and is correct there: both
`build_family_layer.py` (build time) and `llm_families.js`'s `applyConfirmed`
(runtime, its `famPersonLinks` rollup) mirror the deduped set of
generation-level credits **up** onto the nameplate node, precisely so a
collapsed nameplate still shows who drew it. `linkInLayer` already gives the
generation-level line precedence in the *graph* once a family is expanded —
the person's own card just had no equivalent rule and read its raw adjacency,
so "G-Class" and "G-Class W463" counted and listed as two separate cars.
`personCreditedCars()` collapses that: a family-level credit is dropped
whenever the same person holds a generation-level credit **of the same type**
on one of its own generations. Scoping by type matters — someone credited as
engineer on the nameplate and designer on one generation keeps both facts.
Nothing is removed from the data, so the fallback the request ends on is
automatic: a nameplate whose generations carry no credits still counts and
displays exactly as before. The headline number counts **cars** rather than
credits or nodes (`familyOf || id`), so one car worked on in two roles reads
as one car while the list below still shows both rows.

## My Database (new)

A build-time layer that connects my personal Car Database (magazine road tests,
processed by the `update-car-database` skill into `Car Database/[Make]/[Model]/specs.md`
outside this repo) onto the graph.

- Matched cars get a **gold ring** around their model dot (graph, timeline, six degrees)
  and a **✦ From my database** block in the hover card and detail panel — power, torque,
  0–100, top speed, weight, price, consumption, whatever the test actually reported —
  plus my own photo (takes priority over the Wikipedia thumbnail) when one exists.
- My own car, a 2024 BMW X1 xDrive30e, is separately flagged **"my garage"** with a
  dashed marker on the BMW X1 (U11) node, independent of whether it's in the database.
- The **✦ My Database** button in the top bar highlights documented cars and fades
  everything else, in both the Graph and Timeline views — same interaction feel as
  focusing a neighborhood, but as a persistent toggle rather than a click target.
- Matching is deliberately conservative: `data_src/build_db_layer.py` matches by
  normalized make + model name against the graph's node labels, and never guesses on
  ambiguous cases (e.g. a nameplate reused decades apart, like a 2026 Alfa Romeo Giulia
  test vs. the graph's 1962 Giulia node) or on true generation ambiguity (e.g. a BMW
  "540d" test with no chassis code, where several 5 Series generations are all
  plausible). Every folder's outcome — matched, ambiguous, or unmatched — is listed in
  `data_src/harvest/db_match_report.txt` after each build.
- **Generation-level association:** when a matched nameplate is (or later becomes,
  via a build-time or LLM-confirmed split) a family with multiple generations,
  `build_db_layer.py`/`llm_families.js`'s `reconcileDbGenerations()` reads the car's
  own model year out of its specs and, if exactly one generation's span covers it,
  moves the gold ring/database block onto *that specific generation* instead of the
  collapsed family. Nothing is ever removed from the family/bare-model node itself
  though — it's always copied, never moved — so if that nameplate's LLM split later
  gets deleted, My Database falls straight back to showing on the plain model again
  with zero extra unwinding needed. 60 of the currently matched cars have a
  generation-level association today.
- **Full overview pages:** each matched car also gets a magazine-style, standalone
  HTML page (`build_db_layer.py`'s `render_db_page()`, written to `app/db_pages/<node
  id>.html` — 58 generated from the current Car Database) rendering everything the
  original road-test markdown had: spec tables, pros/cons, notes, competitors, in the
  app's own visual style. The detail panel's **✦ From my database** block links out
  to it ("Full overview ↗", opens in a new tab) — the link always resolves through
  the same family → resolved-generation fallback the gold ring/specs block itself
  uses, so it points at whichever node is actually showing the data. The **Matched**
  tab in `app/db_match.html` (below) links out to the same generated overview page
  for each matched car, so reviewing a match and reading its full write-up no
  longer means leaving the review page to go find it in the graph first.
- **Manual match review — `app/db_match.html`:** matching is deliberately
  conservative (see above), so real folders regularly land as ambiguous or
  unmatched with nothing more `build_db_layer.py` can safely decide on its
  own. The **🗂 Match Cars** button in the top bar (shows once at least one
  car is matched) opens a separate standalone page — a debug tab, not part
  of the graph view — with three tabs: **Needs Review** (every ambiguous or
  unmatched folder, with one-click candidate buttons plus a free-text search
  over every car in the graph for cases with no candidate at all — each
  candidate now also carries a small **↗** link to *that car's* own page: its
  generated overview page when it has one, otherwise its Wikipedia article.
  Real user report: *"the cars under 'need review' do not have an option for
  me to look at the html page for that car, so I don't know which car it
  might be referring to just by the name alone."* The Matched tab has had a
  "Full overview ↗" link for a while; Needs Review offered nothing, so
  deciding between two same-named candidates meant leaving this page,
  finding the car in the graph, and coming back.
  Each row also carries the folder's **own** "View overview page ↗" button —
  the same control, label and placement the Matched tab has, per *"I want to
  be able to see the overview page of my database car that the cars in the
  'needs review' tab corresponds to."* An overview page used to be generated
  only for an already-MATCHED folder, because `write_db_page` keys the file by
  the graph node id — precisely backwards, since a folder lands in this tab
  exactly when it's hard to place, which is when reading the original road
  test is most useful. `write_folder_db_page` keys a page by the folder path
  instead, so every folder gets one regardless of match state, including the
  `manually-unmatched` ones whose override branch returns early and used to
  skip page generation entirely. The road test's own headline is shown under
  the folder name too, often far more identifying than the folder name
  alone), **Matched**
  (every currently matched car, grouped by node, with Unmatch and re-match
  controls per folder), and **Archived** (folders set aside as having no real
  match in the graph yet, with Un-archive to send them back to Needs Review —
  and the same overview-page button, for the same reason: a folder is set
  aside precisely because nobody could place it, so deciding whether to
  un-archive it means looking at what the car actually is). All three tabs
  share one `appendOverviewLink` helper rather than three near-identical
  copies.
  Every action writes to `app/db_match_overrides.json` via
  `POST /api/db-match-overrides` and `build_db_layer.py`'s
  `load_overrides()` — an override always takes precedence over what the
  algorithm would otherwise decide for that folder, and persists across
  rebuilds until changed again. `serve.py` re-runs the full match (`enrich()`)
  synchronously inside that same request, so the graph, `db_match_report.json`,
  and the review page's own display all update immediately — no restart
  needed. Because `enrich()` fully re-scans every folder on every run, it
  resets each model node's `db`/`dbspecs`/`dbPage`/`dbSourceFolders` fields
  to a clean slate before recomputing, so unmatching or re-pointing a folder
  never leaves a stale gold ring or specs block on a car it's no longer
  actually matched to.

## Nameplate families (new)

A build-time layer that groups a nameplate's individual generations — e.g. the
Volkswagen Golf's 8 generations, Mk1 through Mk8 — under one collapsed
**family** node, so the default view shows one "Golf" instead of 8 separate
Golfs. Clicking it reveals the generations.

- **Grouping is conservative and automatic:** `data_src/build_family_layer.py`
  strips generation-style suffixes ("(Mk1)", "Mk2"…) to find candidate groups,
  then only confirms a group if its members form a single, unbroken
  succession chain once sorted chronologically. Nothing is grouped on a guess
  — every candidate's outcome (confirmed or why not) is listed in
  `data_src/harvest/family_match_report.txt` after each build, which is now
  regenerated on every real `build_data.py` run (it used to only get
  refreshed by a separate, rarely-run standalone script path, so it could go
  stale after a rebuild without anyone noticing). 101 nameplates are
  confirmed this way, collapsing 394 individual generation nodes.
- Two extra passes catch patterns the plain suffix-stripping above misses
  entirely: an **isolated variant** with no succession link to the rest of
  its siblings (e.g. BMW 1 Series (F52), a China-market regional model) no
  longer vetoes grouping the rest of a genuinely clean chain — it's excluded
  and reported instead; and a **bare, unsuffixed first-generation article**
  (kept at its plain title from before a second generation existed to
  disambiguate from — Mercedes-Benz CLS is the case that found this, along
  with SL and SLK sharing the same "-Class"-vs-not naming drift) is folded
  into its suffixed siblings' group rather than silently never becoming a
  candidate at all.
- A third pass (`validate_chain()`'s retry-pruning) handles a chain that's
  otherwise clean except for exactly one problem member — a lone "umbrella"
  article or a parallel regional/market generation that breaks the strict
  chronological-adjacency check. It tries removing either side of the one
  bad pair and re-validates; if that cleanly fixes the whole chain, the
  troublemaker is excluded (and the reason logged) rather than the entire
  nameplate being left ungrouped. This is what got the Porsche 911 grouped
  at all (an umbrella "911 (classic)" article was blocking it) plus 8 others
  (Alpina B3, Chevrolet Silverado, Ford Focus, Holden Commodore, Honda Fit,
  Mercedes E-Class, Toyota Corolla, VW Passat).
- **Cross-nameplate relation links are mirrored up to the family level.** A
  platform/related/succession link whose endpoint is a specific generation
  that's currently collapsed inside a family (e.g. Porsche 911 ↔ Porsche
  Boxster/Cayman, both platform-mates at the generation level) gets mirrored
  onto the family node itself at build time (`mirror_relation_links()`,
  tagged `mirror: true`) and, for anything discovered later by the LLM
  generation-check layer, at runtime too (`applyResolvedRelations()`) — so
  the connection is never invisible just because you haven't expanded that
  nameplate yet. Once you *do* expand it, the family-level mirror hides
  itself in favor of the real, specific generation-to-generation link (never
  deleted, just precedence — the same "don't remove, just make invisible"
  rule used throughout this layer) — and clicking that expanded generation
  correctly pulls its own cross-nameplate links into the highlighted focus
  set too (`neighborhoodForFocus()`), not just the links belonging to the
  family as a whole.
- **Graph** — a family node looks like a model dot with a thin extra ring
  (see the legend). Click it to expand its generations into a clean
  chronological line and open its detail panel's **Generations** list; click
  a generation there (or search for one directly, e.g. "Golf Mk3") to jump
  straight to it — the app auto-expands its family first. Esc collapses back.
  Expanded generations are also connected to each other directly by a solid
  green **"next generation"** line (see legend) — e.g. G-Class W463 → W464 →
  W465 — distinct from the thin, translucent grey line used for an ordinary
  cross-nameplate succession (like one model replacing an unrelated one).
  This applies to every family, whether it was grouped at build time or by a
  confirmed local-LLM generation check. The legend spells out the two dashed
  line styles specifically, since they used to be easy to mix up at a glance:
  a **thick dash** is a shared-platform link (two different nameplates built
  on the same underlying platform), a **thin dash** is a looser "related"
  link (badge-engineered twins, sister models, that kind of connection) —
  same color, deliberately different weight.
- **Timeline** — a collapsed family shows as one dot spanning its *entire*
  production run (earliest generation's debut to the latest's end, or → if
  still in production). Click it to swap that overview dot for the
  individual generations, each at its own debut year with its own run line.
  The "Follow…" picker's **Nameplates** group does the same thing on
  selection — pick "Volkswagen Golf" and it expands and draws a line through
  all 8 generations, exactly like following a designer's career.
- **Six Degrees** — families are pathable nodes like any other; a search hit
  on a specific (currently-collapsed) generation still works as a path
  endpoint — its family auto-expands so the route can be traced and drawn.
- **A nameplate duplicated as a bare umbrella model is folded in
  automatically.** Real user report: *"There are instances (like the Aston
  Martin Vantage nameplate) where there are 2 nameplates that are exactly
  identical to each other. They should automatically be merged if these
  exist."* What's actually in the data is 42 (make, label) pairs where a
  plain, ungrouped MODEL node sits beside a FAMILY of the same name — Aston
  Martin Vantage, Toyota Corolla, Porsche 911, BMW 5 Series and so on. The
  plain one is Wikipedia's general nameplate-overview article, which DBpedia
  harvested as a model in its own right; the family is the group formed from
  the per-generation articles. Two dots, identical labels.
  `build_family_layer.py`'s bare-fold pass already handles this shape when it
  fires, but it only runs while a group is being *formed*, so any umbrella
  article it didn't catch then stayed a permanent visual duplicate.
  `mergeDuplicateNameplates` is the runtime counterpart, applied every boot.
  It **folds rather than deletes**: the bare model becomes one more
  generation, keeping its id and therefore every link, credit, My Database
  match and article it already carried — both the least destructive option
  and usually the most accurate one, since an umbrella article typically
  describes the nameplate's earliest era (Aston Martin's bare Vantage is the
  1972–73 car; the family starts at 2005), so folding it in correctly widens
  the nameplate's span backwards. Ordering is the opposite of what it first
  looks like: this runs **after** `applyConfirmed`, not before. The first
  version ran before, on the reasoning that those passes branch on whether a
  node is already grouped — and it cost 15 real nameplates, because a bare
  model with a confirmed LLM split is *about* to become a family in its own
  right and folding it first destroys the split. Running afterwards means
  every node's type is final, so a bare model still sitting as one genuinely
  is a leftover umbrella, and a group that has since become two real families
  is left alone (only a group with exactly one family is ever folded).
- **Succession is pushed down to the specific generations it describes.**
  Real user request: *"The 'Succeeds' and 'Succeeded by' information and the
  edge links should also be transferred to the generations of a nameplate.
  They should only revert to the nameplate itself if there is no proper
  reference to a specific generation… Additionally, the 'Succeeds' and
  'Succeeded by' should only appear either on a nameplate level or a
  generation of a nameplate level, but never double counted."*
  Platform/related links have had a generation-level disambiguation flow for
  a while (the LLM `checkRelation` pass); succession never did — and it's
  the one relation type that needs **no LLM call at all**, because a
  succession is a statement about the *ends* of two production runs: the
  predecessor's **last** generation hands over to the successor's **first**.
  That's derivable outright from the year-ordered generation lists already
  in the graph, so `pushSuccessionToGenerations` resolves it
  deterministically for every succession link touching a family, at boot and
  after any live mutation. A side that isn't a family has no generation to
  resolve to, so it stays itself — that's the "revert to the nameplate
  itself" fallback. "Never double counted" comes for free by reusing the
  same mirror precedence every other rolled-up relation uses: the original
  nameplate-level link is tagged `mirror` rather than removed, so it shows
  while collapsed and steps aside for the specific line the moment the
  nameplate is expanded — one or the other, never both. A genuine
  LLM-resolved generation pair always wins; no competing derived link is
  ever added alongside one.
- The family aggregates its generations' designers/engineers (deduped) and
  inherits the `db` / `garage` / `heritage` flags, so a documented or "my
  garage" generation never disappears from the default collapsed view — its
  family just shows the gold ring / dashed marker instead.

## LLM generation check (new)

The nameplate-family layer above only catches nameplates where Wikipedia
already gives each generation its own article (Golf Mk1, Mk2, …). Some
nameplates — the Mercedes-Benz G-Class is the case that prompted this —
document *all* their generations (W460, W461, W463…) as sections of one
single article, sharing one infobox, so DBpedia never sees them as separate
things to harvest at all. This layer fills that gap, on demand, using a
**local LLM** — nothing here calls out to a cloud AI service.

**Requires:** `python3 app/serve.py` (not double-click) and
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` on your
PATH. Setup, step by step:

1. **Install llama.cpp.**
   - macOS/Linux, easiest: `brew install llama.cpp`
   - Or build from source (needed for some GPU setups):
     ```
     git clone https://github.com/ggml-org/llama.cpp
     cmake llama.cpp -B llama.cpp/build -DBUILD_SHARED_LIBS=OFF
     cmake --build llama.cpp/build --config Release -j --target llama-server
     cp llama.cpp/build/bin/llama-server /usr/local/bin/
     ```
     (on Apple Silicon, Metal support is on by default — no extra flag
     needed; add `-DGGML_CUDA=ON` instead only if you have an Nvidia GPU)
   - Confirm it worked: `llama-server --version`
   - **This app now needs a llama.cpp from 2026-05-16 or newer**, because
     the default model below uses MTP (see the next step). `brew install`
     today is comfortably new enough; an install you did before mid-May 2026
     is not, and `brew upgrade llama.cpp` fixes it.
     `./scripts/llama_server_start.sh` checks this for you before it starts
     anything and tells you both ways out if the check fails, so you should
     never have to diagnose this from a log.
2. **That's it — no separate model download step.** Just run
   `python3 app/serve.py` as usual. The first time, it launches
   `llama-server` itself with `-hf unsloth/Qwen3.5-9B-MTP-GGUF:UD-Q4_K_XL`,
   which downloads that GGUF file straight from Hugging Face on demand (a
   few GB — this first run can take a few minutes depending on your
   connection; every run after that should be well under a minute, since
   it's cached locally). The model is cached in a fixed, project-local
   `llama_model_cache/` directory (next to `llama_logs/`) — both `serve.py`
   and `scripts/llama_server_start.sh` explicitly pin `LLAMA_CACHE` to this
   same path, rather than relying on llama.cpp's own OS-default location
   (`~/Library/Caches/llama.cpp` on macOS), which can end up looking
   unstable if this ever gets launched from a context with a different
   `$HOME` than your usual terminal. **If you ever see the model download
   again on a restart that should've been cached**, check
   `ls -la llama_model_cache/` — it should contain a multi-GB file; if it's
   missing or empty, something (disk space, permissions, an antivirus/backup
   tool touching the folder) is preventing the write, and `llama-server:
   ready (took Ns...)` in the terminal at startup tells you directly whether
   that run was a real download (minutes) or a cached load (seconds) rather
   than you having to guess.
3. **(Optional) Start llama-server ahead of time**, e.g. to pre-warm the
   download before you actually want to use the app, or to keep it running
   across multiple `serve.py` restarts without repaying the load time each
   time: `./scripts/llama_server_start.sh` (stop it with
   `./scripts/llama_server_stop.sh`, check its health with
   `./scripts/llama_server_check.sh`). `serve.py` detects an already-running
   instance and reuses it rather than starting a second one.

### The model, and why it's the `-MTP-` build

The default is **`unsloth/Qwen3.5-9B-MTP-GGUF:UD-Q4_K_XL`**. As of August
2026 Qwen's dense 9B tier still has no successor — 3.6 (April) shipped only
27B and 35B-A3B, 3.7 (May) was never open-weighted at all, and 3.8 (August)
starts at 27B — so 9B remains the current model at this size, and this is
still the same Qwen3.5-9B this app has always used.

What changed is the **`-MTP-`** in the repo name. It is the same model at the
same quant: identical weights, identical 6.14GB download, identical answers.
The MTP repo just also ships a **multi-token-prediction** head, which lets
llama-server draft several tokens per decode step and verify them in a single
pass instead of generating strictly one token at a time. Unsloth measures
**~1.5–2x faster generation** from it. Because the drafted tokens are
*verified* against the real model rather than trusted, quality is unchanged —
this buys speed, not accuracy, and it cannot cost accuracy either.

It is enabled by two flags that `serve.py` adds at startup:

```
--spec-type draft-mtp --spec-draft-n-max 3
```

### Why 3 — measured here, not guessed

There is an open llama.cpp bug,
[#23302](https://github.com/ggml-org/llama.cpp/issues/23302), where
`draft-mtp` produces a **different token sequence** than the same model
decoded without MTP once `--spec-draft-n-max` is 3 or higher, at temperature
0, on **macOS with the Metal backend**. That is this machine, so this setting
was originally pinned at a conservative 2 on the strength of that report.

It was then actually tested, with
`qa/qa_mtp_equivalence.py --source wikipedia --repeats 3` — five real
Wikipedia articles, 3 generations each per configuration, 15 samples per
configuration, baseline pooled across two separate server loads:

| n-max | vs baseline | tok/s | range | speedup |
|---|---|---|---|---|
| (off) | — | 27.7 | 22.3–29.5 | 1.00x |
| 1 | IDENTICAL | 27.1 | 23.8–29.1 | 0.98x |
| 2 | IDENTICAL | 25.8 | 21.8–27.9 | **0.93x** |
| **3** | **IDENTICAL** | **41.2** | **38.0–42.8** | **1.49x** |
| 4 | IDENTICAL | 41.4 | 33.7–43.6 | 1.49x |
| 5 | IDENTICAL | 33.2 | 29.0–37.4 | 1.20x |
| 6 | IDENTICAL | 38.2 | 34.6–40.1 | 1.38x |

**The bug does not reproduce here.** Every width 1–6 produced byte-identical
output to the non-speculative baseline on all five articles, with a two-run
determinism control passing first. The same run found **zero** ungrounded
chassis codes, people or related nameplates across 20 extracted generations.

**Low widths are worse than no MTP.** The drafting overhead isn't repaid
until the window is wide enough to land multiple tokens per verify, so n-max
1–2 pays ~2GB of extra RAM to run at or below plain decoding speed. The
originally-committed 2 was the single worst available setting.

**3 and 4 are statistically tied** — each one's median sits inside the
other's observed range. 3 takes the tie-break on a tighter spread (more
predictable per-request latency) and a narrower draft window (less memory).
5 and 6 are *not* tied with them and are genuinely slower: the curve peaks at
3–4 and falls off, because a wider window costs more when drafts get
rejected.

One thing worth knowing before you tune this: the same sweep over **short
synthetic prompts** measured only 1.33x. Real articles do **better** (1.49x),
because long, schema-constrained JSON over a long context is highly
predictable — exactly the condition a speculative decoder's draft-acceptance
rate rewards. This app's real workload is the favourable case, not the hard
one, so don't extrapolate a disappointing microbenchmark into a decision.

Three things it costs, all real:

1. **A recent llama.cpp.** MTP landed 2026-05-16 (PR #22673); the flag was
   renamed `--spec-type mtp` → `--spec-type draft-mtp` on 2026-05-13. Older
   builds don't know the flag. `scripts/llama_server_start.sh` preflights
   this and refuses with a readable message rather than letting llama-server
   die into a log file.
2. **One slot instead of several.** `-np`/`--parallel` > 1 is not supported
   with MTP yet, so `LLAMA_PARALLEL` is clamped to 1 whenever MTP is on (both
   in `serve.py` and in the start script, which now agree — see the note
   below). Nothing breaks: llama-server *queues* requests past the last free
   slot rather than rejecting them, so the concurrent checks `llm_families.js`
   fires during a cascade are served one after another instead of
   interleaved. The trade is that each individual generation is ~1.49x faster
   (measured, see the table above), but they no longer overlap. If you used to
   run cascades through `llama_server_start.sh` at its old 3-slot default,
   wall-clock on a multi-car cascade can get *worse* despite each call being
   faster — that is the one regression this change can cause.
3. **~2GB more RAM/VRAM** for the MTP head.

**`LLAMA_MTP=0` turns it off** and runs that same file as an ordinary model —
the clean fallback if your llama.cpp is too old, if you would rather have
concurrent slots back, or if you want to A/B the speed difference for
yourself. `LLAMA_SPEC_DRAFT_N_MAX` (default 3 — see the measured table above)
tunes how many tokens get drafted per step. The optimum is hardware-dependent,
so re-run `qa/qa_mtp_equivalence.py` rather than adjusting it on intuition —
the curve is not monotonic, and the symptom of a bad value is a *changed
answer*, not a crash.

`./scripts/llama_server_check.sh` reports whether the *running* server is
actually using MTP. That check exists because a server that quietly started
without the flags is the one failure mode with no visible symptom: it answers
every request perfectly correctly, just at ordinary speed, while still paying
the MTP build's extra RAM.

> **Fixed along the way:** `scripts/llama_server_start.sh` defaulted
> `LLAMA_PARALLEL` to **3** while `app/serve.py` defaulted it to **1**, despite
> the script's own comment claiming the two matched. A server started by the
> script and one started by `serve.py` therefore disagreed on slot count *and*
> on the `--ctx-size` product derived from it. Both are 1 now.

To use a different model, there is exactly **one** place to change it: the
`LLAMA_MODEL`/`LLAMA_MODEL_ALIAS` constants near the top of `app/serve.py`'s
"llama-server lifecycle" section (edit the defaults, or set the
`LLAMA_MODEL`/`LLAMA_MODEL_ALIAS` environment variables before starting
serve.py, e.g. `LLAMA_MODEL=unsloth/Qwen3.5-27B-GGUF:UD-Q4_K_XL
LLAMA_MODEL_ALIAS=qwen3.5-27b LLAMA_MTP=0 python3 app/serve.py`, for an
on-the-fly swap with no code edit at all — `LLAMA_MODEL` is llama.cpp's own
`-hf` download spec, a Hugging Face `repo[:quant]`). Note the `LLAMA_MTP=0`
in that example: most repos are not `-MTP-` builds, and pointing the MTP
flags at a model with no MTP head will not start, so a swap to a non-MTP repo
means turning MTP off in the same breath. That drives everything: the startup
download/load, the model actually sent on every request, and the 502 error
hint text.

Every request also asks the model to keep its internal "thinking"/reasoning
pass off — `--reasoning off` plus `--reasoning-budget 0`, both set once at
llama-server startup (see `start_llama_server` in `app/serve.py`) — since
this app's own system prompts are meant to fully control the output rather
than leaving room for a reasoning pass to second-guess them. (Earlier this
used `--chat-template-kwargs '{"enable_thinking": false}'` instead, stamped
both at startup and on every individual request; newer llama-server builds
print a deprecation warning for that specific mechanism — "Setting
'enable_thinking' via --chat-template-kwargs is deprecated. Use --reasoning
on / --reasoning off instead" — so this now uses the flag it points to.)
Two honest caveats worth knowing: Qwen3.5's small variants (0.8B/2B/4B/9B,
which includes the 9B default here) already disable reasoning **by
default**, per the model's own card, so this is defense-in-depth more than
the only thing standing in the way; and there's a currently-open llama.cpp
bug ([#20182](https://github.com/ggml-org/llama.cpp/issues/20182)) where
the softer `--reasoning off` alone doesn't always reliably suppress
reasoning for Qwen3.5 on every setup — `--reasoning-budget 0` is stacked on
top specifically because it's a stronger guarantee (it forces reasoning to
end immediately server-side, rather than just asking the template not to
emit one). Because every request also uses OpenAI-style JSON
mode (`response_format: {"type": "json_object"}`), even if a reasoning trace
were to occur, it can't corrupt the actual answer this app parses — grammar-
constrained decoding means the response text is forced into valid JSON from
the first token either way.

Every LLM call also prints **live tokens/sec** to the terminal `serve.py` is
running in, updating every half-second while a response is still generating —
**alongside a short description of what that particular call is actually
checking**. With `LLAMA_PARALLEL` slots all busy, several checks interleave
their progress lines at once, and a bare `[req-7] 214 tok in 4.1s` gave no
way to tell which car — let alone which *kind* of check — any given line
belonged to. Every call site now sends a short `purpose` label, so a run
reads like:

```
[req-3] qwen3.5-9b: starting -- generation split + designers/engineers/related cars — Toyota 86
[req-3] generation split + designers/engineers/related cars — Toyota 86 -- 47 tok in 3.2s (14.7 tok/s so far)...
[req-4] qwen3.5-9b: starting -- duplicate sanity check — is "Subaru BRZ" a car already in the graph?
[req-5] qwen3.5-9b: starting -- platform relation — which generation of Scion FR-S pairs with Subaru BRZ?
[req-3] generation split + designers/engineers/related cars — Toyota 86 -- done, 312 tok in 9.4s wall (33.2 tok/s generation)
```

The full description is printed once up front (the progress line is
rewritten in place on a single row, so it only has space for a short form).
`purpose` is popped off server-side before forwarding — it isn't part of
llama-server's OpenAI chat-completions schema. The labels cover every kind
of call this app makes: generation split + designers/engineers/related cars,
the duplicate sanity check, a specific `platform`/`related`/`succession`
relation between two named nameplates, a production-year lookup, and a
designer/engineer biography lookup (each further distinguished as "from the
article" vs "from model knowledge").

**Replies aren't required to be perfectly clean JSON.** Every request asks
for OpenAI-style JSON mode, which normally grammar-constrains the output —
but that guarantee is only as good as the server honoring it, and a
llama-server build where the JSON grammar silently isn't applied returns
`` ```json\n{...}\n``` `` instead, which a bare `JSON.parse` dies on at the
very first character (reported verbatim as *"Local LLM relation check
failed: JSON Parse error: Unrecognized token '`'"*). `parseLlmJson` strips a
code fence, then falls back to slicing out the outermost `{...}` span, before
giving up. It deliberately does **not** repair genuinely malformed JSON — a
truncated object still fails loudly rather than being half-guessed at.

If either serve.py or llama-server isn't there, the **🤖 LLM Check** button
in the top bar just stays hidden and nothing about the rest of the app
changes.

- Turn the toggle on, then open any plain (ungrouped) car's detail panel.
  The first time you open it, the app fetches its Wikipedia article, extracts
  the infobox, section headings, and any body-text sentence that reads like a
  generation announcement ("the second-generation Logan was revealed…") —
  not the whole article (G-Class's runs 80k+ characters, mostly irrelevant to
  this) — and asks the local model whether it describes multiple generations.
  That third piece matters: some nameplates (the Dacia Logan is the case that
  prompted adding it) never give their generations a dedicated heading or a
  chassis code in the infobox, only a body sentence, so headings + infobox
  alone missed them. A **definitive** verdict — "no multiple generations",
  or a fetch/llama.cpp error — is saved right away, so reopening the same car
  later never re-runs the check for it again automatically. A **"no multiple
  generations"** verdict still isn't a dead end though: there's a "see what
  it said" disclosure (the raw model output, plus anything it claimed that
  got dropped for not appearing verbatim in the article — a real miss vs.
  the hallucination guard just being strict) and the same retry-with-feedback
  loop the provisional flow has, in case it's wrong. A **provisional**
  proposal (multiple generations found, awaiting your Yes/No) is different:
  it's held in memory only, not written to disk, until you actually decide —
  closing the panel or switching straight to another car without deciding
  discards it completely, as if the check never ran, and it'll check fresh
  next time you open that car.
- Every generation code, year, and designer/engineer name the model returns
  is checked against the actual article text before being kept — anything
  the model claims that doesn't literally appear in the source is dropped.
  The code half of that guard matches **components, not one composed
  string**: the Toyota 86 case is the bug report behind this, where the
  model returned a perfectly correct, fully-sourced list — `"ZN6/ZC6 (First
  generation)"`, `"ZN8/ZD8 (Second generation)"` — and the guard dropped
  both, reporting "found no multiple generations here" with the real answer
  visible in the "claimed but dropped" disclosure. The article genuinely
  contains `ZN6`, `ZC6` and a *First generation* heading; it just never
  contains the exact string the model helpfully assembled out of them. So a
  trailing parenthetical is peeled off first, then the core — or, failing
  that, **every** slash/comma-separated part of it — has to appear verbatim.
  A parenthetical that's a plain ordinal descriptor ("First generation",
  "facelift") is a label rather than a factual claim and needs no match of
  its own; any other parenthetical still does. One invented half is still
  enough to reject the whole code, so this loosens the formatting, never the
  evidence bar.
  This doesn't make the result trustworthy on its own (a small local model
  can still misread what's genuinely there), which is why nothing is applied
  automatically:
- If it finds generations, they show up as a **provisional, unverified**
  proposal right in the detail panel — each with its own small thumbnail when
  one could be found (a `[[File:…]]` reference sitting next to that
  generation's own text in the article; not every generation has one nearby,
  in which case it just falls back to the shared article thumbnail) — with
  three choices: **✓ Yes, accurate** (splits the car into a real family,
  same as the build-time ones, everywhere in the app, each generation now
  showing its own photo instead of all of them sharing the parent's one
  thumbnail — this is also the first moment anything gets written to disk),
  **✗ No, inaccurate** (forgets the check ever happened — same as walking
  away undecided — and turns **🤖 LLM Check** off, since saying No is a
  signal to stop probing more cars right now), or type a reason and hit
  **Retry** to send it back to the model with your correction (up to 4
  attempts, still not written to disk until you land on Yes or No).
- It also actively looks for **who designed/engineered each generation**,
  not just the generation breakdown itself: the excerpts sent to the model
  are whole paragraphs (not single sentences) around any generation mention
  OR a design/engineering credit ("styled by", "chief engineer", "led by"…),
  so a person and the generation they actually worked on have a real chance
  of ending up in the same piece of context instead of just floating
  disconnected facts.
- Confirming ✓ applies instantly, in place — no page reload, and you stay on
  the exact car you just confirmed, now showing its new **Generations** list
  right where the provisional proposal was, everywhere in the app (Graph,
  Timeline's follow-picker, Six Degrees) at once.
- **Designer/engineer link precedence:** once a nameplate is split, the
  family-level "designed by"/"engineered by" line (aggregated across all its
  generations) hides itself as soon as you expand that family, in favor of
  each generation's own specific credit — same "never delete, just make
  invisible when something more specific is visible" rule the mirrored
  relation links (above) use. Collapse it back and the family-level line
  reappears, since there's nothing more specific on screen anymore.
- **Deletion fallback:** if you later hit ✗ on an already-*confirmed* split
  (via 🧹 LLM Debug), the credits aren't just lost — `deleteEntry()` converts
  the confirmed entry into a lightweight tombstone carrying the union of
  every generation's designers/engineers, and `applyConfirmed()` credits the
  plain model node directly from that tombstone the next time it boots. The
  nameplate goes back to being one ungrouped model, but it doesn't forget
  who designed it.
- **Platform/related/succession disambiguation between two split nameplates:**
  when a build-time or LLM-confirmed relation link connects two families (or
  a family and a plain model) that both/either have multiple generations, it's
  genuinely ambiguous *which* generations on each side the relationship
  actually applies to — a "related" link between two 5-generation nameplates
  could mean any of 25 generation pairings. Opening either endpoint's detail
  panel shows an unresolved-relations block that asks the same local LLM,
  given each side's generation list and the source article's relevant text,
  which specific pair it's really describing. Resolving a pair no longer
  strictly requires a literal quote from the source text: the model may also
  answer from well-established, concretely-named real-world knowledge (e.g.
  it knows exactly which shared platform ties two specific generations
  together) even when the two nameplates' own notes only describe their
  generations by vague ordinal/count language separately, rather than
  cross-referencing each other by name — real bug report: the GLA (X156) and
  A-Class (W176) share a well-documented platform, but the notes only said
  "first generation" and "four generations produced" on each side, so the
  old prompt's "EXPLICIT textual evidence" wording left the model no way to
  say so even though it clearly knew the right answer. A knowledge-based
  answer still isn't the same tier of evidence as a real quote — it's held
  for the same ordinary Yes/No review as any other LLM-only resolution
  (`llmVerified`/quote-backed answers are the only ones auto-confirmed) —
  and a bare "their production years happen to overlap" guess, with no
  concrete fact named, is still rejected exactly as before this change; only
  the specific, previously-unreachable "the model actually knows the real
  answer but has no literal quote to point to" case was unblocked.
  which specific pair it's really describing; a ✓ confirms and creates the
  real generation-to-generation link (tagged `llmResolved: true`) while
  retroactively marking the original family-level link as a `mirror` so the
  same precedence machinery takes over from there. Persisted in the same
  `llm_families.json`, under a separate `relations` key.
- **Multiple independent generation pairings between the same two
  nameplates** are fully supported — the Mazda Familia/Ford Escort case that
  motivated this: the 3rd-gen Familia corresponds to the 2nd-gen Escort, and
  the 4th-gen Familia separately corresponds to the 3rd-gen Escort, and both
  need to show up and be confirmable/rejectable independently rather than one
  colliding with (and silently overwriting) the other. Each provisional match
  found per generation, in `resolveOnePlatformMention`, is now keyed by the
  two *specific* generation ids actually involved rather than by the coarser
  nameplate-pair id, so two different generation pairs between the same
  nameplates get two entirely separate `store.relations` entries, two
  separate Yes/No boxes in the detail panel, and — once confirmed — two
  separate real graph links. (This automatic, per-generation discovery path
  is what supports multiple pairs; the interactive single-click "check
  relation" flow on an existing coarse link is unchanged and still resolves
  one pair at a time, since it isn't the path that discovers additional
  pairs to begin with.)
- **Each generation gets its own photo.** Real user report: *"Most of the
  time it uses the same picture for each generation of a nameplate."* Three
  compounding causes. The anchor was the code's FIRST occurrence anywhere in
  the article — and for most nameplates every code is first named in the lead
  paragraph or the top infobox ("produced 1979–1991 (W460), 1990–present
  (W463)…"), all within a few hundred characters of each other *and* of the
  article's lead image, so a forward scan from each of them found the same
  photo. The scan then ran a flat 4,000 characters regardless of structure, so
  a generation with no image of its own happily borrowed the next one's. And
  nothing stopped two generations resolving to the same file anyway.
  `findGenerationImage` now anchors on the generation's own **section
  heading** where one exists and stops at the end of that section, takes a
  caller-supplied `used` set so the choice is exclusive across the whole
  proposal, and skips non-photographic files (logos, badges, flags, diagrams,
  `.svg`) throughout — common in car infoboxes and a particularly bad
  thumbnail. A generation with genuinely no photo of its own now returns null
  and falls back to the shared article thumbnail, rather than duplicating a
  sibling's.
- **A marque already in the graph under a different spelling is reused, not
  duplicated.** Real user request: *"before creating a new make or model,
  check if there are any variants of the name already existing but maybe
  written slightly differently (do this with the LLM)."* The model half has
  existed for a while (`askDuplicateCheck` asks exactly this about a car);
  the MAKE half had nothing at all, so `mintRelatedNode`'s plain prefix
  matching would mint a brand-new marque for any spelling the graph didn't
  already have — "VW" beside "Volkswagen", "Mercedes Benz" beside
  "Mercedes-Benz", "Citroen" beside "Citroën", "Alfa" beside "Alfa Romeo".
  That's worse than a duplicate car, because every car minted under it
  inherits the wrong manufacturer. `verifyMakeVariant` now asks the same kind
  of constrained question, with the same guard rails (real candidates only,
  ids validated against the list it was given, high confidence required, and
  a null verdict simply lets the mint proceed as before). It's asked only
  when a mint is genuinely about to happen with a marque plain matching
  didn't find, and the verdict also reports how many leading words were the
  marque, so "VW Passat" filed under a matched "Volkswagen" correctly becomes
  the model "Passat" rather than "VW Passat". A parent company and its
  separate marque (Volkswagen/Audi, Toyota/Lexus) are explicitly *not* a
  match.
- **A pair with nothing to reason from is never sent to the model.** Real
  case: a `Pontiac G5` ↔ `Marcos TSO` check, where the model correctly
  answered *"No source text note was provided... Relying solely on the
  overlapping production years is explicitly forbidden by the rules."* That
  verdict was never in doubt — the prompt's own last rule already mandates
  it, and `computeRelationEntry` can't reach anything but "none" from a
  `resolved:false` with no evidence codes either. So when there's no note,
  neither article mentions the other car, and no chassis code turns up in
  either one, the check short-circuits straight to "none" without spending a
  round trip (or a llama-server slot other checks are queueing for). The
  "see what it said" disclosure explains the skip rather than showing an
  empty response, and the ordinary Retry row still forces a real check once
  you type a hint.
- **A relationship the LLM itself won't stand behind is removed, not left
  standing.** Real bug report: *"the program states that the ford focus and
  the vw jetta are related, even though they are not. It made the connection
  to the edge even when this is what the playground was reporting
  [`resolved:false` … 'the text does not explicitly link the specific codes,
  and year overlap is insufficient'] … it should have automatically rejected
  the connection. However, it didn't."* The edge came from
  `resolveOnePlatformMention`'s coarse fallback — the Jetta's article really
  does contain the words "Ford Focus" (in a sentence about rear suspension
  resembling it), so a nameplate-level `platform` link got pushed and stayed
  forever. That fallback is right for a **harvested** fact, where an
  unresolvable generation pair is no reason to discard the underlying data;
  it isn't right for a link whose only reason for existing was the LLM's own
  reading, once a second, more focused pass over that same article has
  explicitly declined to support it. Such a link is now severed (marked
  retired — never spliced out, same "don't delete, make invisible"
  discipline used throughout) and the pair blacklisted so a later boot can't
  recreate it. Strictly scoped to `llmDiscovered` links: a genuine
  DBpedia-harvested relation is never auto-deleted, and still surfaces as an
  ordinary unresolved pair.
- **Deleting really deletes, in the graph and on the cards.** Previously,
  rejecting or deleting a relationship only removed its stored entry —
  *"When I try to delete that connection … I deleted it but it still
  appeared and didn't seem to actually get deleted."* Two separate things
  carry a relationship (the entry keyed by the two specific generations, and
  the coarse nameplate-level link), and the coarse one was the single branch
  in `resolveOnePlatformMention` with no `rejectedRelations` guard of its
  own — so it was faithfully recreated from scratch on the very next boot,
  every time. Now: `rejectRelation` blacklists the nameplate-level key
  alongside the specific one, that branch honors it, `severRelationLinks`
  retires the live copies immediately (so the line stops drawing and the
  connection disappears from both endpoints' cards with no reload), and
  `linkInLayer`/`openDetail` both treat a retired link as gone. A rejected
  pair is also no longer re-offered for checking, which used to produce an
  endless propose→reject→re-propose loop. `purgeRelationsFor` (deleting a
  whole nameplate or a generation-list override) does the same for every
  relation touching it, so *"if a nameplate that was created by the LLM is
  deleted and turns into a model, all of the relationships that were also
  discovered by the LLM should also be severed and revert to their previous
  state"* actually holds. The suppression is deliberately escapable:
  `clearRejectionsFor` wipes it for that car whenever an explicit, user-
  initiated re-check runs, so "delete, then re-run the LLM on it" genuinely
  rediscovers everything instead of being permanently poisoned.
- **A matched partner gets its own generation check, once.** Real bug
  report: *"I was checking the Lexus ES with the LLM, and saw that it was
  checking if the toyota crown is also a nameplate… Later, I also checked
  the Toyota Avalon with the LLM, and it also mentioned that it was checking
  if the toyota crown is also a nameplate (which it should have already
  determined was true from an earlier match). This makes me think that the
  Toyota Crown never actually had its generations created and laid out."*
  Exactly right, and structural: `mintRelatedNode` already kicks off a
  lookup-then-check for a brand-new car it invents, but a mention resolving
  onto a car **already in the graph** was wired up as a relation and then
  dropped — nothing ever asked whether that partner was itself hiding
  generations. `schedulePartnerCheck` now does, once, at the moment of the
  match, persisting the result so the next nameplate to name the same car
  finds an existing entry and skips straight past it. Runs one at a time
  through a small serial queue (a nameplate can name five or six siblings,
  and llama-server's slots are better spent on the check you're waiting on)
  and only while a detail panel is actually open — the same code path also
  runs during boot-time replay for every previously-confirmed family, and
  turning a page load into dozens of background LLM calls would be its own,
  much worse bug.

  A follow-up report showed that fix had disabled the very cascade it was
  meant to complement: *"I selected the Honda Odyssey Nameplate, and saw that
  it made a connection [to] the Acura MDX. In this case, the LLM should have
  also looked at the Acura MDX and... split up the Acura MDX into
  generations, to then make the links between the generations."*
  `checkNodeCascade` deliberately KEEPS a "provisional" verdict in memory
  waiting to be applied — but `needsCascadeCheck` asked only "does an entry
  exist?", so the moment the background partner check stored its provisional
  split, the cascade branch was skipped and the relation was disambiguated
  against the still-unsplit partner. The generations were found, then thrown
  away. A partner with an *unapplied* provisional split is now the strongest
  reason to take that branch rather than skip it — the answer is already in
  hand and just needs applying — and any relation verdict recorded before the
  partner had generations is forgotten, so the check genuinely re-runs against
  the new generation list instead of replaying an answer to a different
  question.

  Reproducing that report against the REAL Odyssey and MDX nodes (rather than
  a fixture) then exposed two further bugs that the fix above could never have
  reached on its own, because the pair never got as far as the relation panel:

  1. **A partner matched exactly by name never reaches the panel at all.**
     `resolveOnePlatformMention` hard-confirms an exact-name match at
     nameplate level the moment it finds it, and `unresolvedFamilyRelations`
     deliberately skips anything already confirmed — so the cascade branch,
     which is the only code that applies a partner's split, was never invoked
     for precisely the cars that need it. The generations were fetched,
     validated and stored, then sat in memory with nothing able to mint them.
     `schedulePartnerCheck` now confirms such a split itself and fires an
     `onSplitReady` listener; app.js subscribes and does the minting. (The
     split needs no approval for the same reason the panel's own cascade
     doesn't: the partner is becoming a nameplate for the first time.)
  2. **A split's own discovered relations were never wired into the live
     graph.** `applyConfirmed`'s `resolvePlatformMention` pass can resolve a
     mention straight to "confirmed" in `store.relations`, but that's only a
     store write — something has to push the real link. The ordering hid it:
     the auto-apply runs *inside* `afterLlmCheck`, which has already called
     `applySharedPlatformLive()` (and therefore `applyResolvedRelations`) on
     the way in, so the wiring pass ran a moment before the entry it needed to
     wire existed, and nothing ran it again. The connection lived only in the
     store until some unrelated later action happened to trigger another pass,
     or until the next page load. `applyLlmConfirmSilent` now calls
     `applyResolvedRelations` itself, the same way `applyFamilyOverrideConfirm`
     already did for exactly this reason.

  **How far one click cascades — `CASCADE_MAX_DEPTH` in `serve.py`.** Fixing
  the above surfaced a third question worth answering deliberately: *"does
  this code essentially just check the current model selected and its directly
  related models... [or does it also do] yet another (unintended) additional
  nameplate which is related to the nameplate that the original model was
  related to?"* It was the latter, without limit, and the recursion is easy to
  miss — applying a partner's split runs the same related-car discovery over
  ITS generations, which schedules a check on ITS partners, which when applied
  does the same again. Measured on a deliberate A→B→C→D→E chain: clicking A
  alone fetched, checked and split all five. The only brakes were incidental
  ("each car is checked at most once ever", a serial queue); there was no
  depth limit at all.

  A car you actually select is depth 0; the cars its own article names are
  depth 1. The default limit is **1** — the click plus its direct partners,
  and no further. Nothing is lost by that: a second-hop car is still linked in
  the graph, still has no verdict recorded, and clicking it makes it depth 0
  in its own right, so it cascades one hop from there. What it buys is a
  predictable cost per click, roughly one LLM call per directly-named partner
  rather than an unknown walk across the graph.

  Configured in exactly one place — `CASCADE_MAX_DEPTH` near the top of
  `serve.py`, or the environment variable of the same name — and delivered to
  the browser as `__config.cascadeMaxDepth` on the same `GET
  /api/llm-families` that seeds the store, so there's no second round trip and
  no client-side copy to drift. Raise it to let one click fill in a whole
  platform family at once; `0` disables the automatic partner check entirely.
  Both cascade paths (the background `schedulePartnerCheck` and the relation
  panel's own `needsCascadeCheck`) share the one budget, so it can't be
  escaped through the UI.
- Everything this discovers lives in **`app/llm_families.json`** —
  completely separate from `cars.json`/`data.js`. If anything ever looks
  wrong, delete that file (or overwrite it with `{"families": {}, "relations":
  {}}`) and this whole layer resets to nothing; the DBpedia-built graph
  underneath is untouched either way.
- `app/serve.py` also keeps **`app/llm_families_data.js`** — a
  `<script>`-loadable mirror of `llm_families.json`, regenerated on every
  write — so a plain double-clicked `index.html` (no server) shows exactly
  the same confirmed generations as the live serve.py session that produced
  them. Only the live session can check a new car or record a new decision;
  the static build is read-only for this layer.
- **🧹 LLM Debug** (top bar, next to 🤖 LLM Check) resets this layer for
  re-testing — **Clear ALL** wipes every checked car, or pick one from the
  dropdown to delete just that one. That dropdown is now sorted
  alphabetically across all three layers at once (real user report: *"when I
  look at the 'Delete one at a time' cars, they should be in alphabetical
  order. Currently they are not and it's hard to find car brands and
  models"*) — previously three separate lists were appended one after
  another, each sorted only within itself and by a different key (Wikipedia
  article title for two of them, discovery timestamp for relations, which
  reads as random). They're now merged and sorted by the text actually shown,
  with a checked car labelled by its real graph name ("Make Model") rather
  than an article title, so everything about one brand sits together
  regardless of which layer an entry belongs to. Both write straight to
  `llm_families.json` and then reload the page (an already-confirmed split
  has already rewired the live graph in that tab; reloading is the clean way
  to unwind that, same as any other "start over" action). On a static
  `index.html` with no server running, the panel is inspect-only — nothing
  to write to.

Under the hood, `app/serve.py` does one more thing besides serving the
static files: it proxies the LLM request server-to-server to llama-server,
so the browser never talks to `localhost:8080` directly. That sidesteps
CORS entirely rather than requiring any browser-side configuration. It also
manages llama-server's own context window: `--ctx-size` at startup is set to
131072 tokens **per concurrent request slot** (`LLAMA_CTX_PER_REQUEST *
LLAMA_PARALLEL_EFFECTIVE`, both in `app/serve.py` — "effective" because MTP
forces the slot count to 1, see the model section above) — comfortably inside
qwen3.5:9b's
256K ceiling, and well above the largest prompt this app has ever actually
sent (under 8K tokens even worst-case), so this mostly exists to take
context length off the table as a possible cause of a miss. llama.cpp
divides a server's total `--ctx-size` evenly across its `--parallel` slots
(a gotcha worth knowing if you ever tune these yourself outside this app —
raising `LLAMA_PARALLEL` alone, without also raising `--ctx-size` to match,
would silently shrink the usable context per request), which is exactly why
`start_llama_server()` computes the actual `--ctx-size` value as a product
of the two rather than a flat constant. A bigger per-request context costs
more RAM per slot, so dial `LLAMA_CTX_PER_REQUEST` back if that's a problem
on your machine.

This app also moved from a pool of several separate Ollama processes (one
full copy of the model loaded per process, to get real concurrency) to a
single `llama-server` process using its native `--parallel` "slots" instead
— one loaded copy of the model shared across up to `LLAMA_PARALLEL`
concurrent requests via continuous batching, which is both simpler to
manage and considerably lighter on RAM than duplicating the whole model N
times over.

**Auto-minting related cars and people, plus a "big attempt" at their year/
bio data.** A shared-platform/rebadge mention this layer finds doesn't
always name a car (or a designer/engineer) that's already in the graph —
`mintRelatedNode`/`resolvePersonNode` in `llm_families.js` create a genuinely
new node for it instead of just dropping the fact (the Mercedes-Benz G-Class
naming its badge-engineered Austrian sibling, the Puch G, is the real case
this was built for). A brand-new node used to be stuck at year/end (or born/
died/country) hardcoded to `null` forever, with nothing ever trying to fill
it in. `scheduleFactBackfill` fixes that: right after minting, it runs a
background, two-tier lookup — first fetching the new node's own Wikipedia
article and asking the LLM to extract the fact from that real text
(grounded, same hallucination-guarded discipline as the rest of this file),
and only if that finds nothing, falling back to asking the LLM to recall the
fact from its own training knowledge, trusting only a high-confidence answer
over an honest null. Whatever's found — including a genuine "couldn't find
one" — is cached in `llm_families.json`'s `mintedFacts` map, keyed by node
id, so a later page load reuses the answer (or the confirmed absence of one)
instead of repeating the same Wikipedia/LLM round trip every single boot.
Runs in the background rather than blocking the mint itself; `LlmFamilies`
exposes an `onFactsUpdate` listener (subscribed once in `app.js`'s boot code)
so the graph redraws — and the year-filter bounds recompute — the moment a
field is actually filled in, even though that happens well after the node
was first drawn with nulls.

**Nothing runs unless you asked for it.** Real bug report: *"Sometimes it
seems like the program does an LLM search on a car even though I didn't
specify that I wanted to do an LLM search on it. The LLM search toggle isn't
turned on, I simply clicked on a car and it did the search anyways."*
Correct, and worse than it looked: three background schedulers
(`scheduleWpLookupAndCheck`, `scheduleFactBackfill`, `schedulePartnerCheck`)
never consulted the toggle at all, and the first two didn't consult
`engagedId` either — so `mintRelatedNode` running inside `applyConfirmed`'s
ordinary **boot replay** could fire LLM calls on a bare page load, before any
click happened. The toggle lives in `app.js` and these schedulers live in
`llm_families.js`, which is why the gap existed at all; `setBackgroundAllowed`
is now the one explicit bridge between them, called from `syncLlmAuthorized`
whenever the toggle changes or a one-shot check is armed, and every scheduler
returns early without it. Note that a card's own Wikipedia thumbnail/summary
fetch is *not* covered by this and shouldn't be — that's just how a card draws
itself, and it has always run on click regardless of any LLM setting.

**A platform is not a car.** Real bug report: *"I'm trying to understand how
it got to the GM platform of cars… I can't personally think of the link
between the Honda Prelude all the way to a GM Delta platform."* Neither could
the graph, and the chain turned out to be four steps of one small mistake
compounding. The infobox's `platform =` field was being surfaced to the model
as a strong `sharedPlatforms` signal right alongside `related =`, so it
answered with the *platform's name* as a related car. `mintRelatedNode`
created a model called "C1 platform" under a make called "Ford";
`scheduleWpLookupAndCheck` then found the real **Ford C1 platform** article;
and checking that article — which by its nature lists every car ever built on
the platform — dragged in a dozen unrelated marques. Two fixes, because a
prompt is a request and not a guarantee: the `platform =` line is now labelled
"context only, NEVER list this in sharedPlatforms", and `looksLikePlatformNotCar`
drops anything that reads as a platform rather than a car. That guard runs in
`validate()` *and* at the top of `mintRelatedNode` — the second is
load-bearing, because a proposal persisted before the guard existed replays
through minting on every single boot, and without it the junk nodes would keep
coming back. It's deliberately conservative (names that *say* platform,
architecture or chassis; bare engineering codes with no marque; a short
curated list of all-letter architecture acronyms like MQB that carry no
digits), so no real car is lost to it.

**Confident, concretely-named knowledge counts as evidence.** A relation
verdict normally has to quote the source article — that's the hallucination
guard. But the model would sometimes write, in as many words, *"it is a
well-established fact that the Ford Fusion (First Gen) and Mazda6 (First Gen)
share the CD3 platform"* and then answer `resolved:false` anyway, because the
generation list it was given had no entry literally spelled "first
generation". Andy's request: *"it should automatically accept this information
if it knows it to be true."* `computeRelationEntry` now also auto-confirms on
`knowledgeBacked` — a resolved verdict whose reasoning **names something
specific**, either a platform code ("CD3", "PQ35") or an explicit
well-established/well-documented claim. The bar stays narrow on purpose: a
vague "these seem similar" still lands in review, and a bare year-overlap
guess is still rejected outright, so this loosens the guard for stated facts
without loosening it for guesses.

**Following the article's own generation links.** Real bug report, on the Kia
Pride: *"there are actually links within this Wikipedia page which describe
the details about the specific car generations. I want that the LLM also
considers this."* Wikipedia's convention for this is a section hatnote —
`{{Main|Kia Pride (first generation)}}` — meaning "the real detail lives over
there". When a nameplate delegates that way its own article genuinely doesn't
contain the detail, so no amount of re-reading it helps. `extractDigest` now
collects those targets and `buildCheckMaterial` fetches up to
`MAX_SUB_ARTICLES` of them (Wikipedia fetches only, no extra LLM calls), each
attributed to the heading it sat under. Crucially their text is appended to
the haystack the hallucination guard checks against, not just shown to the
model — otherwise every fact read from a page the article itself points at
would be validated away as "not in the source", which is the exact opposite of
what that guard is for.

**Merging into a nameplate is additive.** Real bug report on the Honda Civic:
the generations didn't appear as merge options, and merging produced a
nameplate that *lost* the generations it already had. `applyOneMerge` was
assigning `primary.generations = genIds` where `genIds` held only the newly
merged members — so an existing family's own generations were silently
dropped. They're merged with the existing list now, a family can be absorbed
into another (its generations move across, the husk is retired with
`supersededBy` rather than erased), and per Andy's instruction — *"simply leave
these generations alone when doing the merge and don't override it with the
general nameplate's Wikipedia information, as the information of the actual
generation Wikipedia page would be more accurate"* — `primary.wp` only ever
fills a gap and a generation's own `wp` is never overwritten. And when the gap
*can't* be filled unambiguously — two different articles among the members
both claiming to BE this nameplate — it asks instead of guessing, per *"if the
LLM is unsure which to pick, then it should prompt the user and have the user
confirm which information to take"*: the conflict is recorded on the merge,
Modify Existing Car renders a "which one describes this nameplate?" prompt the
next time you open that car, and the answer is stored in `mergeWpChoices` so it
replays like every other decision. Leaving it unanswered costs nothing — the
nameplate simply has no article of its own, and every generation still has its
correct one — which is why this is a quiet prompt rather than a modal.

**A refusal that states its own answer is treated as an answer.** Two more
reported verdicts, same shape: `resolved:false`, `codeA:null`, `codeB:null` —
and then the reason explains the answer. *"...confirms it uses the Volkswagen
Group MQB Evo platform, which is also the platform for the current-generation
Tiguan (Tiguan AD1/AX1). However, the note does not explicitly state that..."*
and *"While real-world knowledge confirms the 2006 Concept A was the design
precursor to the first-generation Tiguan (5N), the input constraints
require..."* Andy: *"if it's confident about sharing a platform... it doesn't
need to make this request to the user."* The knowledge tier above couldn't
help, because it requires `resolved:true` and these are refusals. So
`assertedCodeInReason` reads the answer back out of the refusal. The whole risk
of doing that sits in one place — a refusal is *full* of mentions the model is
disclaiming — so two properties make it sound rather than reckless: it can only
ever pick a code that was already in the list handed to the model, and it
ignores any mention sitting in a negated clause. That second one is not
theoretical: the Terramar reason names `Tiguan AD1/AX1` twice, once as the
answer and once inside *"the note does not explicitly state that the Tiguan
AD1/AX1 is..."*, and names 5N and CT1 only inside *"nor does it mention..."*. A
naive substring scan resolves to whichever it hits first. The prompt also now
says outright that sharing a platform IS the evidence — you don't additionally
need the text to call the two cars "related".

**MQB is not MQB Evo.** Andy, in capitals: *"THERE IS A DIFFERENCE BETWEEN MQB
AND MQB EVO PLATFORMS, so make sure to be explicit about the platform names
when doing the matching."* Two changes. The prompt states the rule with
examples (MQB/MQB Evo, MLB/MLB Evo, PQ35/PQ46) and asks for the full name in
the reason. And the platform-name pattern now extends over a trailing qualifier
— previously it required an all-caps token immediately before the word
"platform", so *"MQB Evo platform"* wasn't even recognised as naming a
platform. Plus a guard: a reason naming both a base platform and a qualified
version of that same base doesn't get to auto-confirm, since it's either
conflating them or drawing a distinction fine enough to be worth a human
glance. Two genuinely different platforms in one reason ("MQB Evo" and "PQ35")
are ordinary and don't trip it.

**A designer found on a one-generation car now reaches the graph.** Reported on
the Audi Nuvolari: the check returned `"designers": ["Massimo Frascella"]` and
the Designers layer showed nothing. Not a rendering bug — the credit genuinely
never arrived. `applyConfirmed` is the only thing that mints person nodes out of
a check result, and it opens `if (entry.status !== "confirmed") return;`
followed by `if (gens.length < 2) return;`. A car that turns out to have exactly
ONE generation is recorded as status `"none"` (there's no split to confirm and
nothing to ask about), so it fell through both guards and every designer and
engineer found on it was discarded. That's the same hole
`applySharedPlatformForSingleGen` was written to close for the *platform* half
of a `"none"` verdict; `applyPeopleForSingleGen` is its twin for the people
half, wired into both the boot replay and the live post-check apply so the
credit appears immediately rather than on the next reload.

**One car, one row.** Reported on the Cupra Terramar, whose "shares platform
with" list showed *"Volkswagen Tiguan 2007"* twice, Škoda Kodiaq three times,
and SEAT Tarraco three times — twenty rows for nine cars. Two independent
causes. First, `mirrorRelationLinks` keyed an **undirected** relation
source-first, so an existing nameplate-level link stored as
`terramar|tiguan|platform` didn't match the mirror about to be derived from a
generation-level link, which computes `tiguan|terramar|platform`; the dedup
missed and a second family-level link was added beside the one already there.
(Succession is deliberately still keyed directionally — "A is succeeded by B"
and "B is succeeded by A" are different claims.) Second, the card builds one row
per **link** while the canvas draws one line per **pair** via `linkInLayer`'s
mirror-vs-real precedence, so the card had no equivalent of that rule and would
surface any future double-link the same way; it now dedupes by node id, which
means it can't, whatever the reason for the second link. The reported list is
nine rows with no repeats.

**The dismiss ✕ leads the row.** *"Have the 'dismiss' 'x' button be to the left
of the description of the match, like a bullet point. That way, I can simply
hover my mouse on one location and as I continue dismissing the messages I
won't have to move my mouse to the end of the text."* Every message now emits
`llmCloseBtn()` first and the button floats left at a fixed width, so the target
lands in the same place on every row and the mouse never has to move between
clicks. `float` rather than flex on purpose: these messages are inline prose
with links and debug toggles mixed in, and the text needs to wrap around the
button rather than become a flex row.

**A refresh changes nothing.** *"Make sure that if I do refresh the page that
it doesn't affect any of the calculations or matchings in the backend."* This
is guaranteed by the architecture rather than by care: nothing in this layer
ever writes back into `cars.json`/`data.js`, so every boot rebuilds from the
same immutable snapshot plus the same append-only records replayed in the same
order. A refresh mid-run loses only in-flight LLM results, which were never
recorded and so can't leave anything half-applied. It's also now pinned by a
test that boots twice over the same store and compares every node and every
edge (see `jsdom_merge_subarticle_refresh_test.js` below).

## Tools menu (new)

Every debug/tool feature — **LLM Check**, **LLM Debug**, **Match Cars**,
**Playground**, **Unconfirmed Relationships**, **Add Car**, and **Modify
Existing Car** — now lives under a single **Tools ▾** dropdown in the top bar
instead of a growing row of standalone pill buttons. Each item keeps its own original behavior and id
(nothing about how they work changed, just where you find them); a small dot
on the Tools button itself shows when LLM Check is armed and waiting on your
next click, so that state is visible even with the menu closed. The whole
button hides itself automatically if every item inside it would currently be
hidden (e.g. no server running, so nothing server-backed applies).

- **Unconfirmed Relationships** — browses every platform/related pairing the
  LLM layer has proposed but you haven't confirmed or rejected yet (status
  `provisional` in `llm_families.json`), across every nameplate at once,
  rather than only surfacing one at a time as you happen to open each car's
  detail panel. Clicking a row's pair label flies the graph to both endpoints
  (`Graph.focusPair()`/`gotoPair()`, since an unconfirmed pair has no real
  graph link yet to focus through the normal single-node `goto`). Each row
  also has its own inline **✓ Accept** / **✕ Decline** buttons, so a
  relationship can be resolved right here without detouring through the
  graph and either endpoint's detail panel first. Each row also shows the
  two specific generation codes being proposed **and the LLM's own stated
  reason for proposing them** — the explicit chassis code it found, the
  verified quote, the ordinal it counted, the sanity check's verdict, or its
  own words. That reason has always been recorded on the entry; it just
  never made it into this list, so a row read as a bare "A ↔ B (platform)"
  with no way to judge it without navigating to the car itself.
- **Modify Existing Car** — Add Car's counterpart, for anything that's
  already here. Four things, none of which previously had any entry point at
  all: **rename** it; fix a wrong or missing **Wikipedia link** and re-check
  against it (the same operation the detail panel's own link row offers,
  reachable without hunting the car down in the graph first); **merge several
  standalone models into one nameplate**; or **ask the local LLM a free-text
  question** about the car. Renaming applies to every node type, not just
  cars (*"I should also be able to change the name of the make, model,
  nameplate, engineer/designer, etc..."*), and carries its own ripples:
  renaming a **make** rewrites the denormalized `make` string on every one of
  its cars — that's what the cards, the search index and the duplicate
  matcher all read, so leaving it would strand children still claiming the
  old marque — and renaming a **person** rewrites their name inside every
  car's own `designers`/`engineers` text so the card and the graph agree.
  Persisted under a `renames` key and re-stamped at every boot; Revert always
  returns to what the build-time snapshot called it, not to whatever was
  typed last time. The merge fills a real gap —
  `build_family_layer.py` only groups generations whose labels share a
  pattern *and* form an unbroken succession chain, and the LLM split only
  fires when one article describes them all, so a nameplate whose
  generations sit under genuinely unrelated labels falls through both with
  no way to say so by hand. Structurally it's the same operation
  `applyConfirmed` performs, driven by an explicit list of existing node ids:
  the primary model becomes the family (keeping its own id, so every link
  already pointing at it keeps working), and the others are adopted **in
  place** by setting `familyOf` rather than being re-minted — so every link,
  credit, My Database match and article they already carry stays exactly
  where it is, and undoing is as clean as deleting the record (the next boot
  simply never adopts them). Restricted to plain, ungrouped models of the
  same make: a same-platform car wearing another badge is a `related` link,
  not a generation. The free-text question is the weakest of the three by
  design — the model can answer in prose and *suggest* a merge (pre-ticking
  the boxes), but can only ever return ids from a list it was handed, and a
  structural change always takes a deliberate click. Persisted under a new
  `merges` key in `llm_families.json` and replayed at every boot
  (`applyMerges`, run right after `applyUserCars`/`applyWpLinks`).
- **Delete / Restore** — *"I want to also be able to delete makes (and
  models, nameplates, or generations, or designers/engineers)... This should
  be universally deletable, meaning that even if the data comes directly from
  dbpedia or my database, it should also be deletable, however should be
  stored somewhere that 'hard data' (not LLM data) has been deleted, and
  therefore should also be recoverable."* Every other feature in this app
  only ever ADDS to the build-time snapshot; this is the only one that takes
  something away, which is why it's implemented as a recorded **hide**
  rather than an erase. `cars.json`/`data.js` are rebuilt from the pipeline
  and re-read from scratch on every boot, so nothing here could permanently
  destroy harvested data even if it tried — and that's exactly what makes
  "recoverable" free rather than a second system to maintain: a deletion is a
  record saying "hide this id", and restoring is deleting that record. It
  reuses the same `retired` flag the de-dup and override layers already use,
  so every view (graph, cards, search, counts, the year filter, the LLM
  eligibility checks) honours it immediately with no reload.
  Deleting a **make** takes its whole model range with it and deleting a
  **nameplate** takes its generations — the exact set is computed and stored
  on the record, so restoring puts back precisely that and nothing more; a
  node that was *also* retired for some independent reason (superseded as a
  duplicate, retired by a generation-list override) keeps that retirement,
  since undoing a hand delete shouldn't quietly resurrect something a
  different mechanism deliberately hid. Each record is flagged `hard` when
  the node came from the build-time snapshot (DBpedia harvest, curated core,
  My Database match) rather than from the LLM layer — that's the distinction
  the request asked to be stored, and the restore list surfaces those first
  and says so, since losing one loses genuinely curated data until it's put
  back while an LLM-invented node can always be rediscovered by re-running a
  check.
- **Add Car** — for a make/model Wikipedia hasn't given DBpedia its own
  harvestable entry for yet, or that's missing from the graph for any other
  reason. Type a make and model; it creates the make if it doesn't exist,
  mints a bare model node, then either auto-guesses the Wikipedia article
  (direct title, then a search fallback) or asks you to paste the URL
  yourself if both fail. Once it has an article, the brand-new node is
  opened with LLM Check armed — running through the exact same generation/
  designer/platform discovery pipeline used everywhere else (including the
  standalone/generation de-duplication described below), with zero separate
  discovery logic of its own. A hand-added car's own id/make/model/Wikipedia
  link is persisted under a new `userCars` key in `llm_families.json` and
  replayed at every boot (`applyUserCars`, run first in `app.js`'s boot
  sequence, before any other LLM-layer replay) — without this, a car added
  by hand vanished from the graph again on the very next reload, since
  nothing had ever made it durable beyond the live tab that created it.

**Auto-approving confident duplicate matches.** The LLM sanity-check pass
(`annotateSharedPlatformMatches`/`resolveOnePlatformMention`, described
above) used to always leave its verdict for a human Yes/No, even a
high-confidence one. It now auto-confirms straight away — no review box, no
entry in Unconfirmed Relationships — whenever the sanity check is
confident (`confidence: "high"`) that a loosely-matched mention really is
the same car; a genuinely uncertain result (no sanity check ran, or it came
back `"low"`) still goes through ordinary review exactly as before. The
`reason` field on an auto-approved entry is always prefixed
`"auto-approved in the background"`, so the LLM Debug panel still shows
*why* a match was made even when nobody was asked to confirm it.

**Ordinal corroboration, so an obvious answer isn't sent for review.** Real
user report on a Scion FR-S ↔ Subaru BRZ pair: the note said outright that
the two were *"jointly developed"* and that *"the first-generation model"* is
the one marketed as the Scion FR-S; the model read that correctly, said
`resolved: true`, named `FR-S ZN6/ZC6` and `BRZ ZN6/ZC6`, and explained
exactly why — and it *still* landed in the review queue, because it gave no
literal `evidenceQuote` and neither article's own extraction pass had turned
up a chassis code. *"In this case, it's obvious that the LLM should have
already validated this without telling me."*

An "Nth generation" phrase sitting next to a nameplate's own name in the real
note text, counted against that nameplate's year-ordered generation list, is
read out of the source deterministically — exactly as trustworthy as the
chassis-code extraction already treated as proof. What it is **not** is a way
to pick an answer on its own, and that distinction is load-bearing:
`effectiveNote` is a merged excerpt of *both* articles, and a nameplate's own
article naturally describes its own generations in ordinal terms ("the second
generation was introduced in…"), so letting that pick a generation outright
would mean an article's internal prose could override the actual
cross-referenced evidence about the *relationship*. An early version of this
did exactly that and silently re-pointed a correctly-resolved Mercedes CLA
match at the wrong generation. So it's only ever used to **agree**: when the
ordinal resolves to the same generation the answer already landed on, that
counts as independent textual corroboration and earns the same auto-confirm
an explicit code would; when it disagrees, or resolves nothing, it changes
nothing at all.

**Generation/standalone de-duplication also applies to Add Car.** If the
model currently being analyzed turns out to be a multi-generation nameplate,
and one of its generations already exists elsewhere in the graph as its own
independent standalone model (never grouped into any family) — the
Mercedes-Benz SL-Class's R107 case is the original bug report this was built
for — that standalone's designer/engineer credits, My Database match, and
any links it carried transfer onto the newly-minted generation, and the
standalone itself is retired (never deleted) rather than left behind as a
visible duplicate. This mechanism (`findDuplicateGeneration`/
`supersedeStandalone`) already existed for the automatic discovery flow; it
runs unmodified for a hand-added car too, since Add Car's `mintAndOpen` goes
through the exact same `checkNode → confirmNode → applyConfirmed` pipeline
as any other newly-opened plain model.

**LLM Re-check.** Every nameplate eligible for the generation cross-check
(any family node — build-time-grouped or LLM-discovered) now has a
standing **🔄 LLM Re-check** button at the bottom of its LLM panel, visible
at all times regardless of whether it's ever been checked before or what
that earlier check found. Unlike the ordinary automatic cross-check
(`checkFamily`/`retryFamilyCheck`, both of which only ever run once per
nameplate — see their own comments), this always performs a brand-new
Wikipedia fetch and LLM call, useful when a match was accidentally accepted
or declined, or you just want to "refresh" a nameplate against whatever
Wikipedia says today. Its generation-list result (added/removed/changed
generations) reuses the exact same review UI a first-time discrepancy
already gets — Apply Wikipedia's version, or keep what's here — no separate
interface needed for that half. It goes further than the ordinary check,
though: it also re-examines every already-**confirmed** relationship
touching this nameplate's generations, and flags one for review (without
touching the live relationship at all until you decide) whenever the fresh
read no longer backs it up — either because the generation it's attached to
is being retired by this same re-check, or because the current article text
simply no longer mentions that platform-mate at all. Any genuinely new
mention discovered on a generation that survived the diff is proposed as an
ordinary ADD, same as any other new find. Both kinds of result surface in
**Unconfirmed Relationships**, explicitly labeled *"potential re-work"* so
they read differently from a first-time proposal — a re-work flagging an
already-confirmed match gets **✓ Remove** / **✕ Keep** buttons instead of
Accept/Decline, since accepting it means retracting a relationship that
already has a real graph link, not creating a new one.

Per the follow-up request — *"When doing the LLM Re-check on a model or a
nameplate, it should also check the relationships to other models (or
generations), as well as designers and engineers associated with the cars"* —
a re-check now also covers **succession** links (previously only
platform/related were re-examined, though a succession resolved to a
specific generation pair can go stale in exactly the same way) and
**designer/engineer credits**. The people half is additive and applied
straight away rather than queued for review: a credit that survived the
hallucination guard is, by construction, a name stated verbatim in the
article next to that generation — the same bar every credit already in the
graph had to clear — so adding one takes nothing away and contradicts
nothing, and there's no decision for a human to make. *Removing* a credit
because a fresh read didn't mention it is a different matter entirely
(silence isn't evidence of absence, the same reasoning already applied to
relations), so it never does that. A re-check also clears any suppression
left by an earlier delete for that car, so "delete this nameplate's
relationships, then re-run the LLM on it" genuinely rediscovers them.

**Newly-minted related cars are LLM-searchable on their own, automatically.**
Real user request: "If the program makes new models/nameplates, then these
should also be able to be 'LLM-searchable', and should be requested for an
LLM check... if it hasn't been checked already, which it should be." Before
this, a related car minted mid-check (see `mintRelatedNode`, above) had no
Wikipedia link of its own and no automatic path to ever get one — its detail
panel just dead-ended at "no Wikipedia link on file" the first time someone
happened to open it, with no generation/designer/platform discovery ever
attempted. `mintRelatedNode` now kicks off a background lookup
(`scheduleWpLookupAndCheck`, the same title-guess-then-search strategy Add
Car already uses) the moment it mints a node; if a real article turns up, it
immediately runs the ordinary LLM check against it too (via the cascading
`checkNodeCascade`, not a plain `checkNode`, since nobody is necessarily
looking at this node's own panel right now — it was just discovered as a
side effect of checking some OTHER car). A pasted or auto-discovered link is
persisted under a new `wpLinks` key in `llm_families.json` and replayed at
every boot (`applyWpLinks`, run immediately after `applyUserCars`), the same
deterministic-replay discipline every other piece of this layer already
follows.

**Every car's Wikipedia link is visible and editable, right on its card.**
Real user request: *"If a card doesn't have a wikipedia link to it… there
should be an option in the card itself to add a wikipedia link. For example,
the Ford Maverick model is in my knowledge graph but has no wikipedia link,
and I cannot even do an LLM search on it for some reason… If a wikipedia
link was found by the LLM at any point, then the user should have the option
to change the wikipedia link in case it's inaccurate. Then, if the user
presses 'recheck with llm' then it should recheck it with the new wikipedia
link provided."* Before this there were two separate, both-incomplete paths:
a paste field that only appeared for a car with **no** link (and only after
a check had already run and dead-ended recording that fact), and no way at
all to correct a link that existed but pointed at the wrong article. The
Maverick case was the first of those exactly — with 🤖 LLM Check **off** the
panel rendered nothing whatsoever for a linkless car, and arming it just
burned the check on recording the dead end.

Now every model/nameplate/generation card carries a persistent link row with
all three actions: see the current link, **Change/Add link** (paste one by
hand), and **🔎 Find it** (run the same title-guess-then-search lookup Add
Car uses). Showing the row costs no LLM call, so it appears regardless of
the toggle and regardless of whether anything has been checked yet — nothing
is recorded just to surface it. A corrected link goes through
`setNodeWikiLink(…, {force: true})`, which additionally forgets the stale
verdict, because `checkNode`/`checkFamily` both short-circuit on **any**
existing entry — without that, correcting the article would change nothing
at all and the next check would hand back the answer derived from the wrong
one. The row lives outside the check's own body element on purpose: nearly
every async handler in that panel replaces its container's `innerHTML`
wholesale, which would wipe the row mid-flight if it were nested inside.

Offered on **makes** too, as of a follow-up report: *"Currently with car marks
that are brand new and the LLM cannot find a link, I as the user cannot enter
a link after the fact. However, I should be able to add a wikipedia link to
it."* Makes were excluded originally because none of the three LLM checks
applies to one — but the link row isn't a check, it's the card's own "what
article is this?" control, and a marque (especially one minted from a related
car's badge) needs it just as much: its link is what drives that card's own
photo and extract.

**Researching one specific generation, against its OWN article.** Real user
request: *"it says that the Mercedes E Class W211 is related to the mercedes
C class. If I look further into the Mercedes E Class W211 wikipedia page
which is the one representing the generation, it shows many more related
cars: CLK-Class (C209), CLS-Class (C219), Chrysler 300, Dodge Charger
(LX/LD), Dodge Magnum, SsangYong Chairman (Second generation). So, it would
be actually worth checking if there exists a separate wikipedia page for each
of these generations, and then use that wikipedia page for the LLM to read
through and get a better understanding of all of the relationships.
Additionally, the user should also be able to do an LLM search on an
individual generation as well… Even if there might be a wikipedia page
associated with this submodel, the LLM should try and see if there's a more
specific wikipedia page and replace it with that."*

Every check described above is aimed at a **nameplate**: it reads the
nameplate's overview article and splits it into generations. That's the
wrong article for this question. An LLM-minted generation inherits its
parent's `wp` (`applyConfirmed`: `wp: (dup && dup.wp) || orig.wp`), so W211
has always pointed at the general "Mercedes-Benz E-Class" page — whose
infobox names one or two related cars for the nameplate as a whole, while
the dedicated "Mercedes-Benz W211" article lists six. Nothing ever went and
read the specific one.

A generation's card now has its own **🔎 Research this generation** button
(always available, like the nameplate's 🔄 LLM Re-check — this is a
deliberate action on one car, not a background probe). It first tries to
upgrade the generation's link to its own dedicated article, trying the
several conventions Wikipedia actually uses ("Mercedes-Benz W211", "Audi A4
(B9)", "Ford Focus (third generation)"…) and accepting a candidate only if
it resolves to a genuinely **different** article than the one already in use
— a guess that just redirects back to the nameplate page is no upgrade, and
comparing *resolved* titles (after redirects) is the only reliable way to
tell those apart. Then it runs the ordinary check machinery against that
better text. Everything it finds flows through the same trust tiers as any
other discovery — the hallucination guard, `resolveOnePlatformMention`'s
exact/loose/sanity-checked matching, minting for a genuinely-new car — so
this is not a second, weaker discovery path; it's the existing one, pointed
at better source material. Designer/engineer credits it finds are added to
the generation **and** rolled up to the nameplate (so they still show while
collapsed), additively only: a fresh read not mentioning a credit is silence,
not evidence of absence. Results live under a new `genResearch` key in
`llm_families.json`.

**"No Wikipedia link on file" now has a fix, not just a dead end.** If the
automatic lookup above (or the original build-time harvest) never finds an
article for a car, its LLM panel shows an inline paste-a-link field instead
of nothing — the same real user request continues: "If the wikipedia page is
not available and the program isn't able to find it, then the info box
should have a location for the user to be able to put in the wikipedia link
with the car associated." It runs the pasted URL through the exact same
`titleFromWikipediaUrl → tryWikipediaTitle` verification Add Car's own URL
fallback already uses, then stamps it onto the node (`setNodeWikiLink`) and
immediately re-runs a real check against it. This works for both a plain
model (`renderLlmNoWikiLink`) and a nameplate's generation cross-check
(`renderFamilyNoWikiLink`), sharing one small UI helper (`renderWpPasteUi`)
between them.

## The four views

- **Graph** — the whole web on canvas (positions precomputed at build time, so it
  opens instantly). Click to focus, double-click to widen, Esc to release.
  **Clicking something reveals everything its own card claims.** Two
  reported gaps, both from the same root cause — the detail panel lists
  connections straight off a node's adjacency with no filtering, while the
  canvas goes through `inGraphView` (which includes the year filter and the
  collapsed-family gate), so the card could confidently list things the
  graph then didn't draw. *"sometimes when I click on a specific make, it
  does not reveal all of the models/nameplates associated in the knowledge
  graph view, even though this information is present in the card details of
  the company itself. It seems to be a visual bug."* — it wasn't a rendering
  bug, it was the year slider: at its 2000-present default, every pre-2000
  nameplate the card lists is filtered out. Clicking a make now widens the
  range to cover its whole model range, applying the same principle
  `ensureYearVisible` already encodes for a single node ("explicit
  navigation always wins over the slider"). And: *"some cars that state they
  are related for a particular model do not show up in the knowledge graph
  as being connected, until I click to reveal them. I want all of the cars
  that are related to immediately be revealed as well when I click on a
  particular model (or make)."* — a related car is frequently a *generation*
  of another nameplate, hidden while its own family is collapsed, so the
  link had nothing visible to draw to; focusing now expands exactly the far
  nameplates a platform/related/succession link points at, so the connection
  appears on the same click rather than the second one.
  A **year-range slider**, in the control bar just below the header, keeps
  the default view uncluttered and fast to open — it starts at
  **2000–present**, drag either handle to widen or narrow it. A make/model
  is shown if its own production span overlaps the selected range at all (a
  1980–2000 run stays visible even with the lower bound at 1990 — it was
  still being made partway into the range); still-in-production counts as
  extending indefinitely. This is checked per-node, not per-nameplate: a
  collapsed family is judged by its own overall span, but expand it and each
  generation is judged individually — an early generation that ended well
  before the lower bound drops out even while a later sibling generation
  stays. Makes and designers/engineers stay visible as long as at least one
  of their models is. Searching for or clicking through to something outside
  the current range widens it automatically rather than hiding what you
  asked for — the slider is a decluttering default, not a wall. Timeline,
  Six Degrees, and Platforms aren't affected by it (the slider itself is
  hidden on those tabs): Timeline already has its own complete year axis,
  Six Degrees needs full connectivity to trace a path through any era, and
  Platforms is already a narrow, hand-filtered subset.
- **Timeline** — every debut 1886–2026 in ten country lanes; scrub or play; follow
  a designer's or engineer's career threading across decades.
- **Six Degrees** — shortest path between any two nodes, across all edge types
  (try Peter Rawlinson → Colin Chapman).
- **Platforms** — a narrow subset view: only cars that actually share a
  platform with, or are a rebadge/twin of, some OTHER car (plus the
  designers/engineers credited on those specific cars) are shown at all —
  everything else, including the make hierarchy, is left out entirely
  rather than dimmed. Positions are read straight off the Graph view's own
  simulation rather than running a second layout; the same collapse/expand,
  people-layer, and retirement rules the other views already respect apply
  here too, so this is always a strict subset of what Graph would draw for
  the same settings.

Search and the year-range slider now live together in a **persistent control
bar directly below the header** (search on the left, the slider on the
right) — visible above the Graph view's legend on every view, so it can
never get crowded out as more toggles/buttons land in the top bar over time.

## Data

- **Floor: 1883.** The pipeline used to start at 1959 (DBpedia's own
  `Cars_by_year_of_introduction` categories and this project's curation
  policy were both scoped that way). `harvest.py`'s SPARQL query,
  `merge_harvest.py`'s merge filter, and `build_data.py`'s validation now all
  accept years back to **1880**, and a full live re-harvest has since been
  run — 1,681 pre-1959 models are now in the graph (vs. ~5,100 before, all
  1959+). `data_src/d_models.py` still carries a hand-curated set of ~30
  extra-verified pre-1959 landmarks (Benz Patent-Motorwagen, Ford Model T,
  Bugatti Type 35/57, Duesenberg Model J, Citroën Traction Avant, the
  original Jaguar XK120 and Land Rover, Chevrolet Corvette C1, BMW 507, and
  others) — curated entries always win over an auto-harvested duplicate, so
  these stay hand-verified rather than falling back to DBpedia's guess.
  One fix worth knowing about: the initial re-harvest surfaced a handful of
  pre-1959 Wikipedia articles titled with a leading model year (e.g. "1937
  Ford"), which `merge_harvest.py`'s make-detection heuristics — tuned for
  1959+ naming conventions — mistook for marque names ("1937" as a make).
  Fixed by excluding purely-numeric first-word tokens from the marque
  fallback; re-running `bash data_src/rebuild.sh --no-harvest` picks up the
  fix without a fresh network harvest.
- `app/cars.json` / `app/data.js` — the canonical snapshot (with baked layout).
- `app/data_live.js` — the live DBpedia/Wikipedia refresh layer (see "Live
  data" above for its delta-based localStorage persistence).
- `app/db_photos/` — thumbnail photos (~480px wide) copied in from the Car Database
  by the My Database build step; referenced by relative path so `file://` can load them.
- `app/db_pages/` — auto-generated magazine-style HTML overview pages: one per
  matched My Database car, plus one per *unmatched or ambiguous* folder
  (`write_folder_db_page`, keyed by folder path rather than node id, so the
  Match Cars review page can link to a road test for a car that hasn't been
  placed yet) (`build_db_layer.py`'s `render_db_page()`; see "My
  Database" above), linked from the detail panel's "Full overview ↗".
- `app/db_match.html` — the standalone manual match review page (see "My
  Database" above); `app/db_match_report.json` is its machine-readable data
  source (`build_db_layer.py`'s `write_report_json()`, regenerated on every
  match run) and `app/db_match_overrides.json` is where its own edits
  persist (read/written via `serve.py`'s `/api/db-match-overrides`).
- `app/serve.py` — optional local server (static files + llama-server proxy
  + the `llm_families.json` read/write API); see "LLM generation check" above.
- `app/llm_families.js` / `app/llm_families.json` / `app/llm_families_data.js`
  — the LLM generation-check layer's client logic, its separate,
  freely-resettable data file (`{"families": {...}, "relations": {...},
  "recheck": {...}, "rejectedRelations": {...}, "dismissed": {...},
  "mintedFacts": {...}, "userCars": {...}, "wpLinks": {...}, "genResearch":
  {...}, "merges": {...}, "deletions": {...}, "renames": {...},
  "unmergedDuplicates": {...}, "mergeWpChoices": {...}}`), and the `<script>`-loadable static mirror of
  that same file (kept in sync by serve.py on every write). Every one of
  those keys is replayed deterministically at boot rather than being baked
  into the graph — deleting the file still resets this whole layer to
  nothing, leaving the DBpedia-built graph underneath untouched.
- `data_src/` — the pipeline:
  - `d_models.py`, `d_people.py`, `d_links.py` — curated core (always wins)
  - `d_engineers.py` — hand-compiled, spot-verified chief-engineer attributions
  - `harvest/` + `merge_harvest.py` → `d_auto.py` — the DBpedia harvest (4,700+ models)
  - `build_db_layer.py` — matches the personal Car Database onto graph nodes
    (called from `build_data.py`; see "My Database" above)
  - `build_family_layer.py` — groups generations into nameplate families and
    mirrors cross-nameplate platform/related/succession links up to the
    family level (called from `build_data.py`; see "Nameplate families" above)
  - `build_data.py` — validates + assembles the graph, runs the My Database and
    family layers, flags the garage car
  - `layout.mjs` — bakes the force layout (node, ~30 s)

  Full rebuild (recommended): `bash data_src/rebuild.sh` (or `--no-harvest` to skip
  the slow DBpedia re-harvest and just rebuild from what's already merged/curated —
  this is what picks up new `update-car-database` runs). Manual equivalent:
  `python3 merge_harvest.py && python3 build_data.py && node layout.mjs`

**Provenance:** compiled from DBpedia + Wikipedia (text CC BY-SA); the engineer
layer is hand-compiled from documented attributions and spot-verified against
article text. Images/extracts are fetched live from Wikipedia/Wikimedia Commons
and never stored.

`qa/` holds QA screenshots (`qa_run.py` for the core app, `qa_dblayer.py` for the My
Database layer, `qa_families.py` for the nameplate-family layer, `qa_follow_none.py`
for the None-layer toggle and Timeline nameplate-follow, `qa_llm_families.py` +
`stub_llama_server.py` for the LLM generation-check layer against a stand-in
llama-server); verified on file:// and http://. Also `qa_db_match_overrides.py`
(the manual-match override precedence rules inside `build_db_layer.py`'s
`enrich()` — matched/archived/pending/dangling-node-id, in isolation) and
`qa_serve_db_match_overrides.py` (the same feature end to end over a real
HTTP round trip against `serve.py`'s `/api/db-match-overrides` endpoints,
confirming a POST synchronously re-runs the match and the graph/report
reflect it immediately) — both plain `python3 qa/<file>.py`, no browser.

**Live graph mutations can't kill the canvas any more.** Real bug report:
*"when the llm is trying to find matches, sometimes the viewfinder
periodically freezes and then goes blank, forcing me to do a refresh of the
page. Also, this occurs when I accept or decline an approval from the LLM on
a specific model/nameplate."* Four separate functions each hand-rolled the
same "splice what just got added into every index" loop, and three of them
assumed `adj` already had an entry for every id a newly-pushed link points at
— `adj.get(id).push(...)` throws a bare `TypeError` when it doesn't, which
happens for real (a node minted inside `applyResolvedRelations`, a
`supersededBy` redirect onto a node retired since the last rebuild). Thrown
from inside a click handler, that aborted the apply **halfway**: some links
wired, others not, `buildSim()`/`Graph.touch()` never reached. The render
loop's own `try/catch` then caught the resulting inconsistency on every
subsequent frame, logging and skipping each one — a canvas that silently
stops updating, fixable only by reload. There's now one shared
`spliceIntoIndexes()` that creates a missing `adj` entry instead of throwing
and skips (with a warning) any link whose endpoints can't be resolved, plus
matching guards on the camera and draw paths: `flyToSet` filters to nodes
that exist and have finite coordinates and bails rather than computing a
`NaN` zoom transform (which blanks the canvas outright with nothing logged),
`neighborhood`/`neighborhoodForFocus` tolerate an unindexed id, and `draw()`
skips an individual link or node with unresolved/non-finite coordinates
rather than letting one bad edge cost the whole frame.

That fixed the *crash* form of the freeze but not all of it — the report came
back as *"the viewfinder gets completely blocked / goes blank during live
connection generation; only a refresh recovers."* The second cause was
performance, not an exception, and was found by measuring rather than reading:
`indexMirrorReplacements()` ran an inner scan over every link for every mirror
link — O(mirrors × links) — which on the real graph took **over a second per
call**, on a function called from a dozen places including inside the
live-update path. A second of blocked main thread per graph mutation is
indistinguishable from a hang. It now builds a `Map` keyed by the unordered
family pair plus link type and does one pass, which measured ~84× faster and
is verified to produce identical `mirrorAllRetired` values across all ~860 real
mirror links. (The key separator is a literal `|`: node ids are slugs, so it
can't appear inside one and collapse two distinct pairs.)

`qa/jsdom/` holds a growing suite of headless jsdom regression tests
(`jsdom_*_test.js`, 77 files as of this writing) covering every feature above
end-to-end without needing a real browser — boots the real `app.js` +
`llm_families.js` + `data_live.js` against a stubbed DOM/localStorage/fetch
and asserts on real app state. See each file's header comment for exactly
what it guards against (several exist specifically to pin down a bug that
actually shipped once — e.g. `jsdom_live_splice_test.js` for the Safari/
Chrome live-refresh recurrence, `jsdom_family_link_precedence_test.js` for
designer/engineer link duplication on expand, `jsdom_fact_backfill_test.js`
for the year/bio "big attempt" backfill on a newly-minted car or person —
see "LLM generation check" above). The four newest:

- `jsdom_person_credit_dedup_test.js` — a designer/engineer's card counting
  and listing each car once, at its most specific level, with the
  nameplate-only fallback and per-role independence both pinned down.
- `jsdom_succession_generation_test.js` — succession resolved to the
  predecessor's newest and the successor's oldest generation, the plain-model
  fallback, "never both at once" across expand/collapse, and an LLM-resolved
  pair winning over the derived one.
- `jsdom_llm_robustness_test.js` — fenced/prose-wrapped JSON replies (and
  genuinely malformed ones still failing loudly), the composite-code
  hallucination guard (including every way it must still reject), the
  no-evidence short-circuit, and a `resolved:false` verdict severing an
  LLM-invented link while leaving a harvested one untouched.
- `jsdom_modify_car_test.js` — the Ford Maverick case (a linkless car with
  the toggle off), correcting an existing link and confirming the re-check
  really re-reads the new article, merging models into a nameplate (plus its
  guard rails), and generation-level research picking the more specific
  article.
- `jsdom_cascade_depth_test.js` — the `CASCADE_MAX_DEPTH` budget, on an
  A→B→C→D→E chain where each car's article names only the next, so the number
  of cars checked *is* the depth reached. Pins down all three properties that
  matter: the default stops after one hop, the un-cascaded car is still fully
  checkable (and cascades one hop from there when clicked directly, so nothing
  is lost), and raising the limit really does go one further while still
  stopping. `0` checks only the clicked car.
- `jsdom_odyssey_mdx_real_test.js` — the Honda Odyssey / Acura MDX report,
  reproduced against the REAL graph nodes rather than a fixture, and
  deliberately so: in the shipped dataset there is no pre-existing link
  between those two cars at all, so the pair can only reach the relation panel
  as a provisional store entry, not through the adjacency scan every other
  relation test exercises. A fixture with a convenient `related` link would
  have tested the wrong code path and passed while the bug remained — which is
  exactly what happened, twice, until this test was written. Walks the whole
  reported flow: open the Odyssey with LLM Check on, and assert the Odyssey
  splits, the MDX's own article is fetched, the MDX splits into all four of
  its generations, and the connection ends up pinned to a specific generation
  on both sides.
- `jsdom_db_match_needs_review_page_test.js` — drives the REAL `db_match.html`
  against the REAL, current `db_match_report.json`, not a synthetic fixture.
  That's deliberate: the failure mode worth guarding against here is "the
  rendering code is right but the data on disk doesn't carry the field", which
  a hand-built fixture papers over completely. Asserts that every reviewable
  folder has a page generated, that each page actually exists on disk, that
  the button renders once per folder with the Matched tab's exact label and
  target, and that the generated page is a real road test rather than a stub.
- `jsdom_delete_rename_test.js` — every node type deletable (harvested or
  not), a delete being an exactly-undoable hide rather than an erase, the
  parent/child cascade restoring precisely what it removed, a node retired
  for some *other* reason surviving that undo, the `hard` flag, and both
  renames' ripples (a make onto its children, a person into every car's
  credits) plus revert-to-original and survival across a reload.
- `jsdom_dupmerge_reveal_test.js` — the umbrella-model fold (including the
  chronological reordering, the span widening, and the two-families guard),
  focus release collapsing everything it expanded while leaving a
  deliberately-opened nameplate alone, the Wikipedia-link row on a make, and
  distinct per-generation photos (including the non-photo file filter).
- `jsdom_partner_split_variant_test.js` — a related partner being split into
  generations and *then* matched generation-to-generation, and a marque
  spelled differently being reused rather than duplicated (with a control
  case proving that check is load-bearing rather than decorative).
- `jsdom_real_data_boot_test.js` — the counterweight to all of the above.
  Every other file builds a small controlled fixture, which is right for
  pinning one behaviour down precisely but means a change can be provably
  correct on eight synthetic nodes and still fall over on 6,800 real ones.
  This one boots the app over the **actual** baked `data.js` *and* the actual
  `llm_families.json` currently on disk, then asserts very little about any
  specific car and a lot about "the whole thing still comes up and nothing
  throws": the boot sequence completes, the succession rollup produces only
  live/self-consistent links, no succession pair draws at both levels at
  once anywhere in the dataset, focusing a dozen real nameplates and the five
  biggest makes never throws, and every well-connected real person's card
  renders with a sane count (including a check that the dedup genuinely
  fires on real data, so the fix can't silently become a no-op).
- `jsdom_llm_gating_platform_test.js` — the three reports that all traced back
  to one terminal log (see "Nothing runs unless you asked for it" and "A
  platform is not a car" above). Asserts a bare page load and a toggle-off
  click make **zero** LLM calls — counting llama.cpp calls plus only the
  article fetches the LLM layer itself makes, deliberately *not* the card's
  own thumbnail fetch, which has always run on click and should; that the
  platform guard rejects every string from the real log while leaving awkward
  real cars ("Opel Zafira A", "Chevrolet HHR", "Mercedes-Benz A-Class (W176)")
  alone, and is wired into both `validate()` **and** `mintRelatedNode` (the
  second matters because a proposal persisted before the guard existed
  replays through minting on every boot); that the Ford Fusion / Mazda6
  "well-established fact… CD3 platform" verdict auto-confirms while a vague
  "these seem similar" stays provisional and a bare year-overlap guess is
  still rejected outright; and that the progress label leads with the make and
  model and fits in a scannable column.
- `jsdom_merge_subarticle_refresh_test.js` — the other four. The freeze fix is
  pinned by *equivalence plus speed*: the rewritten `indexMirrorReplacements`
  is checked against the old nested scan on all ~860 real mirror links (0
  disagreements) and expand/collapse is held to a per-operation budget, since
  the bug was a 1,000 ms call inside the live-update path. The Honda Civic
  merge keeps the nameplate's pre-existing generations instead of replacing
  them, leaves each generation's own Wikipedia article alone, folds the
  redundant standalone duplicate away without erasing the credit it carried,
  and records the merge so it can be undone. The Kia Pride case fetches both
  `{{Main|…}}` generation articles and proves the payoff — a generation and a
  designer named *only* in a sub-article survive the hallucination guard.
  Finally, refresh safety: the app is booted twice over the same store and
  every node and every edge is compared, then again with a decision added
  mid-session, with a control assertion that the decision really did change
  the graph (so "identical" can't pass for the trivial reason).
- `jsdom_knowledge_salvage_test.js` — the two reported refusals that stated
  their own answers, verbatim as reported, plus the four ways the salvage must
  still say no: every mention negated, knowledge language with no named
  generation, a named generation with no knowledge claim, and a code that was
  never in the supplied list. Then the MQB/MQB Evo rules (a base/variant
  mix-up doesn't auto-confirm; two genuinely different platforms still do), a
  check that the existing bars didn't move (vague reasoning still queues, a
  year-overlap guess is still rejected), and that the prompt asks for all of
  it too — a prompt rule and the code that backs it can drift apart silently
  otherwise.
- `jsdom_singlegen_people_dupes_test.js` — the Audi Nuvolari (the designer
  becomes a real person node, gets a `designed` link that survives the
  Designers layer filter, and re-running the apply credits nobody twice, which
  matters because it runs at boot AND after every live check); the duplicate
  rows, driven through the real `openDetail` rather than a re-implementation of
  it, including a deliberately re-added duplicate link to prove the card-level
  guard is load-bearing on its own and a check that succession still mirrors
  directionally; and the dismiss button leading every message it appears on. Each file resolves its own path to `app/`
relative to its own location, so they run from anywhere:

```
cd qa/jsdom
npm install jsdom --no-save   # only if node_modules/jsdom isn't already here (it's vendored in)
node jsdom_live_splice_test.js        # run one
for f in jsdom_*_test.js; do node "$f" || echo "FAILED: $f"; done   # run all
```
