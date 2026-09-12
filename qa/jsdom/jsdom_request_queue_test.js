// The Worker behind the hosted site's "⚡ Request scan" button.
//
// Two things here are load-bearing beyond the obvious happy path.
//
// The first is that this Worker must NOT answer /api/llm-families. That route
// belongs to serve.py, and llm_families.js decides whether the entire LLM
// layer exists by asking for it and seeing whether anything replies. If this
// answered it, every server-only control -- LLM check, delete/restore,
// rebuild, add car -- would light up on the PUBLIC site and then fail. Hence
// the /api/request/ prefix, and hence the passthrough test below.
//
// The second is the split between the two secrets: the passphrase is typed
// into a browser and may only enqueue; the bearer token lives on one machine
// and may read and complete jobs. Holding one must not confer the other.
//
// Loaded by rewriting `export default` into a `return`, so the shipped file
// is executed as-is (no second copy, no build step) from a plain CJS test.
const fs = require("fs"), path = require("path");
const WORKER = path.resolve(__dirname, "..", "..", "src", "worker.js");
const worker = new Function(fs.readFileSync(WORKER, "utf-8").replace(/^export default/m, "return"))();

let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };

const PASS = "correct horse", TOKEN = "agent-token-abc";

function fakeKv() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) { const v = m.get(k); return v == null ? null : (type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}
function fakeEnv(over) {
  return Object.assign({
    JOBS: fakeKv(),
    REQUEST_SECRET: PASS,
    AGENT_TOKEN: TOKEN,
    ASSETS: { fetch: async () => new Response("static asset", { status: 200 }) },
  }, over || {});
}
const req = (p, opts) => new Request("https://carweb.example" + p, opts);
const post = (p, body, headers) => req(p, {
  method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers || {}),
  body: JSON.stringify(body || {}),
});
const bearer = tok => ({ authorization: "Bearer " + tok });

(async () => {
  // ---- passthrough ---------------------------------------------------------
  {
    const env = fakeEnv();
    for (const p of ["/", "/index.html", "/api/llm-families", "/api/rebuild", "/cars.json"]) {
      const r = await worker.fetch(req(p), env);
      t("passes " + p + " to the static assets", await r.text() === "static asset");
    }
  }

  // ---- degrades without a KV binding, rather than throwing -----------------
  {
    const env = fakeEnv({ JOBS: undefined });
    const r = await worker.fetch(req("/api/request/status"), env);
    const d = await r.json();
    t("says so plainly when no namespace is bound", r.status === 503 && d.error === "queue-unconfigured", r.status);
    const r2 = await worker.fetch(req("/"), env);
    t("...and still serves the site", await r2.text() === "static asset");
  }

  // ---- the passphrase gate -------------------------------------------------
  {
    const env = fakeEnv();
    const bad = await worker.fetch(post("/api/request/queue", { passphrase: "nope" }), env);
    t("a wrong passphrase is refused", bad.status === 403, bad.status);
    t("...and queues nothing", await env.JOBS.get("job:pending", "json") === null);

    const empty = await worker.fetch(post("/api/request/queue", {}), env);
    t("a missing passphrase is refused", empty.status === 403, empty.status);

    const unset = fakeEnv({ REQUEST_SECRET: "" });
    const r = await worker.fetch(post("/api/request/queue", { passphrase: "" }), unset);
    t("an unset passphrase cannot be satisfied by sending an empty one", r.status === 503, r.status);
  }

  // ---- queue, dedupe, status ----------------------------------------------
  {
    const env = fakeEnv();
    const r = await worker.fetch(post("/api/request/queue", { passphrase: PASS, note: "the review queue" }), env);
    const d = await r.json();
    t("the right passphrase queues a job", r.status === 200 && d.ok && d.pending && d.pending.state === "queued", JSON.stringify(d));
    t("...carrying the note", d.pending.note === "the review queue", d.pending.note);
    const id = d.pending.id;

    const again = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, note: "something else" }), env)).json();
    t("a second request returns the job already waiting", again.already === true && again.pending.id === id);
    t("...and does not overwrite its note", again.pending.note === "the review queue", again.pending.note);

    const st = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("status is public, no secret needed", st.ok && st.pending.id === id);
    t("...and never echoes a secret back", !JSON.stringify(st).includes(PASS) && !JSON.stringify(st).includes(TOKEN));
  }

  // ---- the agent half is bearer-only --------------------------------------
  {
    const env = fakeEnv();
    await worker.fetch(post("/api/request/queue", { passphrase: PASS }), env);
    for (const [name, p, opts] of [
      ["jobs", "/api/request/jobs", {}],
      ["claim", "/api/request/claim", { method: "POST" }],
      ["done", "/api/request/done", { method: "POST" }],
    ]) {
      const r = await worker.fetch(req(p, opts), env);
      t("the agent route " + name + " refuses an unauthenticated caller", r.status === 401, r.status);
      const r2 = await worker.fetch(req(p, Object.assign({ headers: bearer(PASS) }, opts)), env);
      t("...and refuses the button's passphrase as a token", r2.status === 401, r2.status);
    }
  }

  // ---- claim / done --------------------------------------------------------
  {
    const env = fakeEnv();
    const q = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, note: "n" }), env)).json();
    const id = q.pending.id;

    const got = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    t("the agent can read the pending job", got.ok && got.job.id === id);

    const claimed = await (await worker.fetch(post("/api/request/claim", { id }, bearer(TOKEN)), env)).json();
    t("claiming marks it running", claimed.job.state === "running" && claimed.job.claimedAt, JSON.stringify(claimed.job));

    const stale = await worker.fetch(post("/api/request/claim", { id: "some-other-id" }, bearer(TOKEN)), env);
    t("a claim for a job that is no longer the pending one is refused", stale.status === 409, stale.status);

    const reclaim = await (await worker.fetch(post("/api/request/claim", { id }, bearer(TOKEN)), env)).json();
    t("re-claiming the same job is not an error", reclaim.ok && reclaim.already === true);

    const done = await (await worker.fetch(post("/api/request/done", { id, summary: "12 provisional generations" }, bearer(TOKEN)), env)).json();
    t("finishing records the result", done.ok && done.job.state === "done" && done.job.finishedAt);

    const after = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("...empties the queue", after.pending === null);
    t("...and keeps the summary for the button to show",
      after.last.id === id && after.last.summary === "12 provisional generations", JSON.stringify(after.last));
    t("...so a new request can be queued again",
      (await (await worker.fetch(post("/api/request/queue", { passphrase: PASS }), env)).json()).already === false);
  }

  // ---- a failed run is recorded as failed, not silently as done -----------
  {
    const env = fakeEnv();
    const q = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS }), env)).json();
    await worker.fetch(post("/api/request/done", { id: q.pending.id, state: "failed", summary: "llama-server never came up" }, bearer(TOKEN)), env);
    const after = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("a failed run is reported as failed", after.last.state === "failed" && /llama-server/.test(after.last.summary), JSON.stringify(after.last));
  }

  // ---- unknown routes under our own prefix 404, they do not fall through ---
  {
    const env = fakeEnv();
    const r = await worker.fetch(req("/api/request/anything-else", { headers: bearer(TOKEN) }), env);
    t("an unknown /api/request/ route 404s instead of serving an asset", r.status === 404, r.status);
  }

  console.log("\n" + fails + " failure(s)");
  process.exit(fails ? 1 : 0);
})();
