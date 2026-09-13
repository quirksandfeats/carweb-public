# Requesting an LLM scan from the hosted site

The hosted site is a static copy. The local model, `serve.py` and the whole
generation-discovery flow live on one Mac, which has no public address and is
usually asleep, so nothing on the internet can call it.

So the button does not call the machine. It leaves a **job**, and the machine
picks the job up when it is next awake.

```
  hosted site            Cloudflare Worker + KV            the Mac
  ───────────            ──────────────────────            ───────
  ⚡ Request scan   ──▶   POST /api/request/queue
                         (passphrase)      job: queued
                                              ▲   │
                         GET /api/request/jobs│   │   agent polls
                                              └───┴──▶ claims it
                                                       runs the pass
                                                       git push
                                                       exits
                         POST /api/request/done ◀──────┘
  status line       ◀──   GET /api/request/status
```

Findings arrive as **provisional**. The whole point of this layer is that
nothing enters the graph without a human confirming it, and an unattended run
that pushed confirmed records would quietly remove that. The agent's job ends
at "here is what the article says"; the confirming is still yours, on the site,
afterwards.

## Routes

Everything lives under `/api/request/` and nothing else is touched — in
particular `/api/llm-families`, which is how `llm_families.js` decides whether
a local server exists, still 404s on the hosted site, so the public build
keeps hiding every server-only control.

| Route | Auth | Who calls it |
|---|---|---|
| `GET /api/request/status` | none | the button, to show where a request got to |
| `POST /api/request/queue` | passphrase in the body | the button |
| `GET /api/request/jobs` | `Authorization: Bearer <AGENT_TOKEN>` | the agent |
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

## The agent (not built yet)

A polling script on the Mac that:

1. `GET /api/request/jobs` on a timer; nothing to do most of the time.
2. On a job: `POST /api/request/claim`, start `llama-server` and `serve.py`.
3. Drive the pass through Playwright against the real UI, reusing
   `qa/qa_llm_families.py`'s harness — so the code path that runs is the one
   that ships, rather than a second implementation that can drift from it.
4. `git commit && git push` the resulting `app/llm_families.json`.
5. `POST /api/request/done` with a one-line summary, stop `llama-server` and
   `serve.py`, exit.

Nothing in step 3 confirms anything. It writes provisional records only.
