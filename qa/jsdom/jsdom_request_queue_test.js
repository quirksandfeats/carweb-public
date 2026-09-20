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
    // Insertion order deliberately NOT sorted here: the Worker orders by
    // queuedAt, and a list that came back shuffled must still come out right.
    async list({ prefix }) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).reverse();
      return { keys: keys.map(name => ({ name })) };
    },
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
    const r = await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-buick-century", targetLabel: "Buick Century", note: "the 1930 Series 60 looks wrong" }), env);
    const d = await r.json();
    t("the right passphrase queues a job", r.status === 200 && d.ok && d.pending && d.pending.state === "queued", JSON.stringify(d));
    t("...naming the car that was asked for",
      d.pending.targetId === "m-buick-century" && d.pending.targetLabel === "Buick Century",
      JSON.stringify(d.pending));

    const id = d.pending.id;

    const again = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-buick-century", targetLabel: "Buick Century", note: "something else" }), env)).json();
    t("the SAME car asked for twice is one job, not two",
      again.already === true && again.queue.length === 1 && again.queue[0].id === id,
      JSON.stringify(again.queue));
    t("...and the first request's own timestamp survives",
      again.queue[0].queuedAt === d.pending.queuedAt, again.queue[0].queuedAt);

    // The whole reason the queue became a list: two different cars are two
    // different pieces of work.
    const second = await (await worker.fetch(post("/api/request/queue",
      { passphrase: PASS, targetId: "m-jaguar-xjs", targetLabel: "Jaguar XJS" }), env)).json();
    t("a DIFFERENT car stacks behind it", second.queue.length === 2, JSON.stringify(second.queue.map(j => j.targetId)));
    t("...in the order they were asked for",
      second.queue[0].targetId === "m-buick-century" && second.queue[1].targetId === "m-jaguar-xjs");

    const st = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("status is public, no secret needed", st.ok && st.pending.id === id);
    t("...and never echoes a secret back", !JSON.stringify(st).includes(PASS) && !JSON.stringify(st).includes(TOKEN));
  }

  // ---- the agent half is bearer-only --------------------------------------
  {
    const env = fakeEnv();
    await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-some-car" }), env);
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
    const q = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-jaguar-xjs", targetLabel: "Jaguar XJS", note: "n" }), env)).json();
    const id = q.pending.id;

    const got = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    t("the agent can read the pending job", got.ok && got.job.id === id);

    const claimed = await (await worker.fetch(post("/api/request/claim", { id }, bearer(TOKEN)), env)).json();
    t("claiming marks it running", claimed.job.state === "running" && claimed.job.claimedAt, JSON.stringify(claimed.job));

    // With a list rather than a single slot, an id that is not in the queue
    // is simply not there -- it was finished, expired, or never existed.
    const stale = await worker.fetch(post("/api/request/claim", { id: "some-other-id" }, bearer(TOKEN)), env);
    t("a claim for an id that is not in the queue is refused", stale.status === 404, stale.status);

    const reclaim = await (await worker.fetch(post("/api/request/claim", { id }, bearer(TOKEN)), env)).json();
    t("re-claiming the same job is not an error", reclaim.ok && reclaim.already === true);

    const done = await (await worker.fetch(post("/api/request/done", { id, summary: "12 provisional generations" }, bearer(TOKEN)), env)).json();
    t("finishing records the result", done.ok && done.job.state === "done" && done.job.finishedAt);

    const after = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("...empties the queue", after.pending === null);
    t("...and keeps the summary for the button to show",
      after.last.id === id && after.last.summary === "12 provisional generations", JSON.stringify(after.last));
    t("...so a new request can be queued again",
      (await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-some-car" }), env)).json()).already === false);
  }

  // ---- the agent takes the head, and finishing reveals what is behind it --
  {
    const env = fakeEnv();
    for (const [id, label] of [["m-a", "Car A"], ["m-b", "Car B"], ["m-c", "Car C"]]) {
      await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: id, targetLabel: label }), env);
    }
    const head = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    t("the agent is handed the oldest request first", head.job.targetId === "m-a", head.job.targetId);
    t("...and told how many are waiting", head.waiting === 3, head.waiting);

    await worker.fetch(post("/api/request/claim", { id: head.job.id }, bearer(TOKEN)), env);
    const mid = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("a visitor can see the whole queue, not just the one running",
      mid.queue.length === 3 && mid.queue[0].state === "running", JSON.stringify(mid.queue.map(j => j.state)));
    t("...by car name, which is what they asked for",
      mid.queue.map(j => j.targetLabel).join(",") === "Car A,Car B,Car C", JSON.stringify(mid.queue));

    const fin = await (await worker.fetch(post("/api/request/done",
      { id: head.job.id, summary: "split into 4" }, bearer(TOKEN)), env)).json();
    t("finishing one leaves the rest", fin.waiting === 2, fin.waiting);
    const next = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    t("...and the next one becomes the head", next.job.targetId === "m-b", next.job.targetId);
    const after = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("the finished one is remembered, with its car", after.last.targetLabel === "Car A", JSON.stringify(after.last));
  }

  // ---- a request has to name a car ---------------------------------------
  {
    const env = fakeEnv();
    const none = await worker.fetch(post("/api/request/queue", { passphrase: PASS }), env);
    t("a request with no car is refused", none.status === 400, none.status);
    t("...with something a visitor can act on",
      /Pick a car/i.test((await none.json()).message || ""));
    for (const bad of ["../../etc", "m-a m-b", "m-a;rm", "x".repeat(300)]) {
      const r = await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: bad }), env);
      t("a malformed id is refused: " + bad.slice(0, 12), r.status === 400, r.status);
    }
    t("nothing was queued by any of that",
      (await (await worker.fetch(req("/api/request/status"), env)).json()).queue.length === 0);
  }

  // ---- a stale job is dropped rather than run a week late -----------------
  {
    const env = fakeEnv();
    const old = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    await env.JOBS.put("job:car:m-old", JSON.stringify(
      { id: "stale", state: "queued", queuedAt: old, targetId: "m-old" }));
    await env.JOBS.put("job:car:m-new", JSON.stringify(
      { id: "fresh", state: "queued", queuedAt: new Date().toISOString(), targetId: "m-new" }));
    const d = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("a request older than the TTL is not offered", d.queue.length === 1 && d.queue[0].id === "fresh",
      JSON.stringify(d.queue.map(j => j.id)));
  }

  // ---- several people at once ---------------------------------------------
  // The queue used to be one KV array, read-modify-written on every request.
  // KV has no compare-and-swap, so two people pressing the button at the same
  // moment both read the same list and the second write erased the first. One
  // key per car removes the thing there was to race over.
  {
    const env = fakeEnv();
    const cars = ["m-a", "m-b", "m-c", "m-d", "m-e"];
    // Every request issued before any of them is awaited: interleaved, the
    // way two browsers actually arrive.
    await Promise.all(cars.map(id =>
      worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: id, targetLabel: id }), env)));
    const d = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("five simultaneous requests all survive -- none overwrites another",
      d.queue.length === 5, JSON.stringify(d.queue.map(j => j.targetId)));
    t("...and they come back oldest first",
      d.queue.map(j => j.queuedAt).join("") ===
      [...d.queue].sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)))
        .map(j => j.queuedAt).join(""));

    // The reported case: two people asking for the same car at the same time.
    const both = await Promise.all([
      worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-compass", targetLabel: "Jeep Compass" }), env),
      worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-compass", targetLabel: "Jeep Compass" }), env),
    ]);
    const after = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("the same car asked for twice at once is queued once",
      after.queue.filter(j => j.targetId === "m-compass").length === 1,
      JSON.stringify(after.queue.map(j => j.targetId)));
    t("...and both askers are told it is queued rather than one getting an error",
      both.every(r => r.status === 200));

    // One person queueing several cars while already waiting on another.
    await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-f", targetLabel: "F" }), env);
    await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-g", targetLabel: "G" }), env);
    const more = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("one person can queue several cars while waiting on an earlier one",
      more.queue.length === 8, more.queue.length);
  }

  // ---- and asking again for the car being scanned right now ---------------
  {
    const env = fakeEnv();
    await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-compass", targetLabel: "Jeep Compass" }), env);
    const head = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    await worker.fetch(post("/api/request/claim", { id: head.job.id }, bearer(TOKEN)), env);
    const dup = await (await worker.fetch(post("/api/request/queue",
      { passphrase: PASS, targetId: "m-compass", targetLabel: "Jeep Compass" }), env)).json();
    t("asking for the car being scanned right now does not queue it again",
      dup.already === true && dup.queue.length === 1, JSON.stringify(dup.queue));
    t("...and it is still the one that is running", dup.queue[0].state === "running");
  }

  // ---- a label is never trusted as markup ---------------------------------
  {
    const env = fakeEnv();
    const d = await (await worker.fetch(post("/api/request/queue", {
      passphrase: PASS, targetId: "m-x",
      targetLabel: "<img src=x onerror=alert(1)>\u0007 Jeep",
    }), env)).json();
    t("a label is stripped of markup and control characters before storage",
      !/[<>\u0000-\u001f]/.test(d.queue[0].targetLabel), JSON.stringify(d.queue[0].targetLabel));
    t("...and a free-text note is not stored at all",
      !("note" in d.queue[0]), JSON.stringify(d.queue[0]));
  }

  // ---- taking a request back out -----------------------------------------
  {
    const env = fakeEnv();
    for (const [id, label] of [["m-a", "Car A"], ["m-b", "Car B"], ["m-c", "Car C"]]) {
      await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: id, targetLabel: label }), env);
    }
    const nope = await worker.fetch(post("/api/request/cancel", { passphrase: "wrong", id: "m-b" }), env);
    t("removing needs the passphrase", nope.status === 403, nope.status);

    const byCar = await (await worker.fetch(post("/api/request/cancel", { passphrase: PASS, id: "m-b" }), env)).json();
    t("a request can be withdrawn by the car's own id -- the thing a visitor knows",
      byCar.ok && byCar.queue.map(j => j.targetId).join(",") === "m-a,m-c",
      JSON.stringify(byCar.queue.map(j => j.targetId)));

    const jobId = byCar.queue[1].id;
    const byJob = await (await worker.fetch(post("/api/request/cancel", { passphrase: PASS, id: jobId }), env)).json();
    t("...or by its job id", byJob.queue.map(j => j.targetId).join(",") === "m-a", JSON.stringify(byJob.queue));

    const gone = await worker.fetch(post("/api/request/cancel", { passphrase: PASS, id: "m-b" }), env);
    t("withdrawing something already gone is a plain not-found", gone.status === 404, gone.status);
  }

  // ---- the one being scanned is left alone -------------------------------
  {
    const env = fakeEnv();
    await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-a", targetLabel: "Car A" }), env);
    await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-b", targetLabel: "Car B" }), env);
    const head = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    await worker.fetch(post("/api/request/claim", { id: head.job.id }, bearer(TOKEN)), env);

    const running = await worker.fetch(post("/api/request/cancel", { passphrase: PASS, id: "m-a" }), env);
    t("a request being scanned right now cannot be withdrawn -- its result "
      + "would have nowhere to land", running.status === 409, running.status);

    const all = await worker.fetch(post("/api/request/cancel", { passphrase: PASS, all: true }), env);
    t("emptying the whole queue is refused to a passphrase holder", all.status === 403, all.status);
    t("...and says where it has to be done from", /from the machine/i.test((await all.json()).message || ""));

    const cleared = await (await worker.fetch(
      post("/api/request/cancel", { all: true }, bearer(TOKEN)), env)).json();
    t("the agent token can empty it", cleared.ok && cleared.removed === 1, JSON.stringify(cleared));
    t("...but leaves the one already running", cleared.queue.length === 1 &&
      cleared.queue[0].state === "running", JSON.stringify(cleared.queue));
  }

  // ---- a failed run is recorded as failed, not silently as done -----------
  {
    const env = fakeEnv();
    const q = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-some-car" }), env)).json();
    await worker.fetch(post("/api/request/done", { id: q.pending.id, state: "failed", summary: "llama-server never came up" }, bearer(TOKEN)), env);
    const after = await (await worker.fetch(req("/api/request/status"), env)).json();
    t("a failed run is reported as failed", after.last.state === "failed" && /llama-server/.test(after.last.summary), JSON.stringify(after.last));
  }

  // ---- a claim left behind by a dead run does not wedge the queue ---------
  //
  // The agent will not stampede a job someone else has claimed, so a run that
  // is Ctrl-C'd or crashes mid-pass used to leave its car marked running for
  // the full two-day TTL, with every later request stuck behind it and no way
  // to say so. Two ways out: it ages out by itself, or it is handed back.
  {
    const env = fakeEnv();
    await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-a-stuck", targetLabel: "Stuck Car" }), env);
    await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-z-behind", targetLabel: "Behind It" }), env);
    const head = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    await worker.fetch(post("/api/request/claim", { id: head.job.id }, bearer(TOKEN)), env);

    // --- by hand, by the short id the log prints ---------------------------
    const shortId = head.job.id.slice(0, 8);
    const rel = await worker.fetch(post("/api/request/release", { id: shortId }, bearer(TOKEN)), env);
    const relBody = await rel.json();
    t("a stuck claim can be handed back by the short id the log prints",
      rel.status === 200 && relBody.job.state === "queued", JSON.stringify(relBody.job || relBody));
    t("...and it keeps its place at the head rather than going to the back",
      relBody.queue[0].targetId === "m-a-stuck", JSON.stringify(relBody.queue.map(j => j.targetId)));
    const reclaim = await (await worker.fetch(post("/api/request/claim", {}, bearer(TOKEN)), env)).json();
    t("...so the next run claims it again", reclaim.ok && !reclaim.already &&
      reclaim.job.targetId === "m-a-stuck", JSON.stringify(reclaim.job));

    t("releasing needs the agent token, not the passphrase",
      (await worker.fetch(post("/api/request/release", { passphrase: PASS, id: shortId }), env)).status === 401);
    t("releasing something that is not there 404s",
      (await worker.fetch(post("/api/request/release", { id: "no-such-car" }, bearer(TOKEN)), env)).status === 404);

    // --- by itself, once the claim is older than any real pass -------------
    const key = "job:car:m-a-stuck";
    const held = JSON.parse(await env.JOBS.get(key));
    held.claimedAt = new Date(Date.now() - 1000 * 60 * 120).toISOString();
    await env.JOBS.put(key, JSON.stringify(held));
    const aged = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    t("a claim older than one very long pass is treated as abandoned",
      aged.job.targetId === "m-a-stuck" && aged.job.state === "queued", JSON.stringify(aged.job));
    t("...and that is written back, not decided afresh by each reader",
      JSON.parse(await env.JOBS.get(key)).state === "queued");

    // A claim that is merely long-running is NOT taken away underneath a live
    // run -- the whole point of one-at-a-time is that nothing else starts.
    await worker.fetch(post("/api/request/claim", { id: head.job.id }, bearer(TOKEN)), env);
    const busy = JSON.parse(await env.JOBS.get(key));
    busy.claimedAt = new Date(Date.now() - 1000 * 60 * 20).toISOString();
    await env.JOBS.put(key, JSON.stringify(busy));
    const still = await (await worker.fetch(req("/api/request/jobs", { headers: bearer(TOKEN) }), env)).json();
    t("a twenty-minute-old claim is left alone", still.job.state === "running", JSON.stringify(still.job));
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
