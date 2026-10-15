// The request queue: how long a request lives, and how deep it scans.
// Real report (14 Oct 2026): four requests queued together waited behind a
// long scan and all vanished two days after they were queued -- the one being
// scanned too, so its finish was never recorded. And the owner's request: the
// form asks for the cascade depth, 1 by default, at most 3 from the public
// site (7 only on the machine itself).
const fs = require("fs"), path = require("path");
const WORKER = path.resolve(__dirname, "..", "..", "src", "worker.js");
const worker = new Function(fs.readFileSync(WORKER, "utf-8").replace(/^export default/m, "return"))();
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const PASS = "correct horse", TOKEN = "agent-token-abc";
function fakeKv() {
  const m = new Map(); let writes = 0;
  return { _m: m, writes: () => writes,
    async get(k, type) { const v = m.get(k); return v == null ? null : (type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { writes++; m.set(k, v); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; } };
}
const env = () => ({ JOBS: fakeKv(), REQUEST_SECRET: PASS, AGENT_TOKEN: TOKEN, ASSETS: { fetch: async () => new Response("x") } });
const req = (p, opts) => new Request("https://carweb.example" + p, opts);
const post = (p, body, headers) => req(p, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers || {}), body: JSON.stringify(body || {}) });
const bearer = { authorization: "Bearer " + TOKEN };
const status = async e => (await (await worker.fetch(req("/api/request/status"), e)).json()).queue;
const old = new Date(Date.now() - 3 * 86400e3).toISOString();
const job = (id, state) => JSON.stringify({ id, state, queuedAt: old, targetId: id, targetLabel: id });

(async () => {
  {
    const e = env();
    e.JOBS._m.set("job:car:a", job("a", "queued"));
    t("a request three days old with no agent checking the queue is dropped", (await status(e)).length === 0);
  }
  {
    const e = env();
    e.JOBS._m.set("job:car:a", job("a", "queued"));
    e.JOBS._m.set("job:car:b", job("b", "running"));
    await worker.fetch(req("/api/request/jobs", { headers: bearer }), e);
    const q = await status(e);
    t("...but kept while an agent is checking the queue", q.some(j => j.id === "a"), JSON.stringify(q.map(j => j.id)));
    t("...and the one being scanned is kept", q.some(j => j.id === "b"));
  }
  {
    const e = env();
    e.JOBS._m.set("job:car:b", job("b", "running"));
    t("a request being scanned is never dropped for age", (await status(e)).some(j => j.id === "b"));
  }
  {
    const e = env();
    for (let i = 0; i < 5; i++) await worker.fetch(req("/api/request/jobs", { headers: bearer }), e);
    t("an agent asking five times in a row is written down once (the free plan's writes)", e.JOBS.writes() === 1, e.JOBS.writes());
  }
  {
    const e = env();
    const r1 = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-x", targetLabel: "X" }), e)).json();
    t("a request with no depth gets depth 1", r1.queue[0].depth === 1, JSON.stringify(r1.queue[0]));
    const r2 = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-y", targetLabel: "Y", depth: 7 }), e)).json();
    t("a public request asking for 7 is held to 3", r2.queue.find(j => j.targetId === "m-y").depth === 3);
    const r3 = await (await worker.fetch(post("/api/request/queue", { passphrase: PASS, targetId: "m-z", targetLabel: "Z", depth: 2 }), e)).json();
    t("...and one asking for 2 gets 2", r3.queue.find(j => j.targetId === "m-z").depth === 2);
  }
  {
    const e = env();
    e.JOBS._m.set("job:car:old", job("old", "queued"));
    const r = await worker.fetch(post("/api/request/cancel", { id: "old" }, bearer), e);
    t("the agent can remove a request hidden for age, before it counts again", r.status === 200 && !e.JOBS._m.has("job:car:old"), r.status);
    const r2 = await worker.fetch(post("/api/request/cancel", { id: "old", passphrase: PASS }), (() => { const x = env(); x.JOBS._m.set("job:car:old", job("old", "queued")); return x; })());
    t("...the site's passphrase cannot reach one", r2.status === 404, r2.status);
  }
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
