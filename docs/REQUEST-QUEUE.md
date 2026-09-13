# Requesting an LLM scan from the hosted site

The hosted site is a static copy. The local model, `serve.py` and the whole
generation-discovery flow live on one Mac, which has no public address and is
usually asleep, so nothing on the internet can call it.

So the button does not call the machine. It leaves a **job**, and the machine
picks the job up when it is next awake.

```
  hosted site                 Cloudflare Worker + KV          the Mac
  ───────────                 ──────────────────────          ───────
  focus a car
  ⚡ Request scan  ──────▶     POST /api/request/queue
  (passphrase)                {targetId, targetLabel}
                              job:queue  [A][B][C]
                                            ▲    │
                              GET /api/request/jobs│  agent polls
                                            └────┴──▶ claims the head
                                                      scans THAT car
                                                      git push
                                                      exits
                              POST /api/request/done ◀─┘
  queue, by car name  ◀──     GET /api/request/status
```

**A request names one car.** You focus a nameplate or a model in the graph and
ask for it; that car is what gets scanned. The panel prefills whatever card is
open, retargets if you click a different car while it is open, and searches
the graph if you want a third one. A request with no car would mean "go and do
something", which is not a thing anyone can act on or review afterwards.

What comes back is covered under **What it confirms** below — a first-time
nameplate split is applied without asking, a correction to an existing
generation list waits for a human, and everything the agent confirmed is
stamped so it can be reviewed afterwards.

## Two different lists

- The **job queue** lives in Cloudflare KV and holds *requests* — one per car,
  up to 25, oldest first. `GET /api/request/status` returns it by car name, and
  the ⚡ Request scan panel shows the same list. Asking for a car already in
  the queue returns the existing request rather than stacking a duplicate. A
  request nobody claims for two days is dropped.
- The **review backlog** lives in `data_src/harvest/family_match_report.txt`
  and is the list of cars `--now` works through when there is no request to
  read. Nothing to do with Cloudflare.

## Routes

Everything lives under `/api/request/` and nothing else is touched — in
particular `/api/llm-families`, which is how `llm_families.js` decides whether
a local server exists, still 404s on the hosted site, so the public build
keeps hiding every server-only control.

| Route | Auth | Who calls it |
|---|---|---|
| `GET /api/request/status` | none | the panel, to list what is waiting, by car |
| `POST /api/request/queue` | passphrase in the body | the panel; body names the car |
| `GET /api/request/jobs` | `Authorization: Bearer <AGENT_TOKEN>` | the agent; returns the head plus how many wait |
| `POST /api/request/cancel` | passphrase, or bearer for `all` | withdraw a request |
| `POST /api/request/claim` | bearer | the agent, before it starts |
| `POST /api/request/done` | bearer | the agent, with a one-line summary |

One job at a time. A second request while one is pending returns the existing
job rather than stacking another behind it — two queued scans of the same graph
is one scan and one wasted wake-up. A job nobody claims expires after two days,
because a week-old "scan everything" is not what anyone wants run when the
machine finally comes back.

Two separate secrets, deliberately: `REQUEST_SECRET` is typed into a browser
and can only *enqueue*; `AGENT_TOKEN` lives on one machine and can read and
complete jobs. Neither can do the other's job if it leaks.

## Turning it on

The KV namespace exists (`CARWEB_JOBS`, id `0f0a2ae5a4a749c4a34d10feab0357e6`)
and `wrangler.jsonc` binds it as `JOBS`. What is left is the two secrets, and
they are deliberately not set from here — a secret typed into a chat is a
secret that has been written down somewhere it shouldn't be. Generate them
where they will be used:

```
openssl rand -base64 24          # run twice, keep both values
npx wrangler secret put REQUEST_SECRET    # the button's passphrase
npx wrangler secret put AGENT_TOKEN       # the polling agent's token
```

or Cloudflare dashboard → the `carweb` Worker → Settings → Variables and
Secrets → Add, type **Secret**.

`REQUEST_SECRET` is the one you will type into the button, so a passphrase you
can remember is fine. `AGENT_TOKEN` is only ever pasted into the agent's
config on the Mac, so make it long and random.

Until both exist, `/api/request/queue` answers `queue-unconfigured` and the
button says so rather than failing.

## Changing the queue

A request is a suggestion, so it can be withdrawn.

- **From the site:** the ⚡ Request scan panel lists what is waiting with a ✕
  on each one. Removing needs the passphrase, same as adding.
- **From the machine:**

  ```
  .venv/bin/python scripts/llm_agent.py --queue                  # list
  .venv/bin/python scripts/llm_agent.py --drop m-buick-century   # one, by car
  .venv/bin/python scripts/llm_agent.py --drop <job id>          # one, by job
  .venv/bin/python scripts/llm_agent.py --clear                  # all of them
  ```

- **By hand:** dashboard → Workers KV → CARWEB_JOBS → KV Pairs → `job:queue`
  is a plain JSON array. Editing it there works and is the last resort.

Two rules. **A request being scanned right now cannot be withdrawn** — the
agent is mid-pass on it and its own `/done` is what closes it out, so dropping
it would leave that result with nowhere to land; `--clear` leaves it in place
too. And **emptying the whole queue needs the agent token**, not the
passphrase: if the passphrase ever leaks, one person should not be able to
wipe everyone else's requests in a click.

## The agent

`scripts/llm_agent.py`. Stdlib plus playwright.

Homebrew's Python refuses a system-wide `pip install` (PEP 668), so playwright
lives in a virtualenv in the repo, and the agent is run with that venv's
python:

```
python3 -m venv .venv
.venv/bin/pip install -q playwright
.venv/bin/python -m playwright install chromium
.venv/bin/python scripts/llm_agent.py --now --seeds 1
```

The `AGENT_TOKEN` secret is read from `~/.carweb-agent-token`, or from
`CARWEB_AGENT_TOKEN` if that is set. Put it in the file once:

```
printf %s 'THE_TOKEN' > ~/.carweb-agent-token && chmod 600 ~/.carweb-agent-token
```

An `export` lasts one shell, so it came back as "set CARWEB_AGENT_TOKEN" in
every new terminal — and a scheduled run has no shell to have exported it in.
The file is in HOME, not the repo: this repo is public, and a secret one
`git add -A` away from being published is a secret waiting to leak.

`serve.py` itself is stdlib only, and the agent launches it with whatever
python is running the agent, so the venv covers both.

```
export CARWEB_AGENT_TOKEN='<the AGENT_TOKEN secret>'
python3 scripts/llm_agent.py            # wait up to 10 min for a job, run it, exit
python3 scripts/llm_agent.py --watch    # keep waiting (for launchd/cron)
python3 scripts/llm_agent.py --now      # run a scan now, no job needed
python3 scripts/llm_agent.py --targets m-chevrolet-suburban,m-jaguar-xjs
```

**How much one run scans is governed by the cascade**, not by a count in the
agent. One seed car pulls in whatever its own article names, out to serve.py's
`CASCADE_MAX_DEPTH` — the same budget a click gets, so the agent spends the
model the way a person does.

| flag | default | what it does |
|---|---|---|
| `--seeds` | 1 | how many review-queue cars to start from |
| `--cascade-depth` | serve.py's setting | overrides `CASCADE_MAX_DEPTH` for this run |
| `--settle-seconds` | 300 | hard cap on waiting for a seed's cascade |
| `--settle-quiet` | 60 | seconds with nothing written that counts as finished |
| `--budget-minutes` | 45 | wall-clock cap on the scanning phase |
| `--node-timeout` | 180 | how long one car gets before it is logged as an error |

`--settle-seconds` exists because a seed's own answer landing is not the end of
the work: confirming a split is what kicks off the partner cascade, and those
checks run afterwards, in the background. Stopping `serve.py` at that moment
would cut them off mid-flight and throw away calls already paid for. The run
waits until nothing new has been written for a full minute. Each partner
check is a whole LLM call, so the gap between two writes is the length of a
call -- a few seconds of quiet is the normal state mid-cascade, not the end of
one.

The summary reports all three numbers — seeds, cascade depth, and how many
cars ended up with an entry — so "1 seed at depth 1, 7 cars now have an entry,
5 reached by the cascade" is legible without opening anything.

What one run does:

1. `GET /api/request/jobs`, then `POST /api/request/claim`.
2. If the job names a car, that car is the seed — not the backlog, and not
   skipped for already having an entry, since "look at this again" is a
   perfectly good request. `--now` has no job to read, so it picks from
   `data_src/harvest/family_match_report.txt`, minus
   anything already scanned, dismissed or awaiting a re-check.
   **UN-SPLIT NAMEPLATE CANDIDATES first** — those are the models where a
   credited designer's dates contradict the article's own range (Wayne Cherry
   cannot have designed the 1933 Suburban), so there is positive evidence of
   hidden generations. UNCONFIRMED is the weaker signal and comes second.
3. Starts `app/serve.py`, which starts `llama-server` itself and does not
   begin listening until the model has loaded — so the port opening *is* the
   readiness check.
4. Drives the real UI with Playwright: arms 🤖 LLM Check, opens each target,
   waits for its entry to land. Opening a node with the check armed is exactly
   what a human does, and it is the code path that ships — no second
   implementation to drift from it.
5. SIGTERMs `serve.py`, whose handler stops `llama-server`. That is what
   "closes the program running locally".
6. Commits **only** `app/llm_families.json` and `app/llm_families_data.js`,
   and only if they moved, then pushes. Never `git add -A`: this runs
   unattended in a working copy that may have anything else half-finished in
   it.
7. `POST /api/request/done` with a one-line summary, and exits.

### What it confirms

It drives the real UI, so it inherits the app's own rule — which is **not**
"nothing is ever confirmed":

- A plain model that turns out to hide several generations is **split and
  applied immediately**. That is an existing deliberate decision ("if a car is
  creating a nameplate for the first time... you do not need my approval to
  turn it into a nameplate"), and it is most of the review queue.
- A correction to a nameplate that **already** has a generation list stays
  **provisional** and waits for a human, because it rewrites data someone may
  already be relying on.

Nothing in the agent widens that. Every claim still has to appear verbatim in
the article before it is kept — the guard in `llm_families.js` runs on this
path because this path *is* the app.

Two things make an unattended run reviewable afterwards:

- Every confirmation the agent makes is stamped `decidedBy: "agent"` in
  `llm_families.json`, so a split nobody looked at is distinguishable from one
  you approved. The agent refuses to confirm anything if it cannot set that
  stamp.
- The run **names** what it did, rather than only counting it. The commit body
  lists every node under "Split and applied without review", "Awaiting your
  review", "Nothing found" and "Skipped"; the queue summary carries a short
  version, truncated to fit its 400-character cap.

What the guard still cannot do: it proves the codes and years appear in the
article, not that they are generations of *this* car. A "Related models" or
"See also" section can supply perfectly real strings. That is the reason to
read the first few diffs before raising `--max-scans`.

### Tests

`qa/qa_llm_agent.py` covers the decisions made before any model call: which
nodes are picked, in what order, which are treated as already done, and which
files may be committed. Pure functions over fixtures, so unlike the other
`qa_*.py` suites it needs no browser, no server and no network.
