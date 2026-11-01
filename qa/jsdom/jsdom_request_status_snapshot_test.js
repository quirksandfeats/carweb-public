// The public status route must not spend list operations: the free plan allows
// 1,000 a day, the agent uses most of them, and anyone can ask for the status.
const fs = require("fs"), path = require("path");
const WORKER = path.resolve(__dirname, "..", "..", "src", "worker.js");
const worker = new Function(fs.readFileSync(WORKER, "utf-8").replace(/^export default/m, "return"))();
let fails = 0;
const t = (n, c, e) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + n + (e !== undefined ? "  -- " + e : "")); };
const PASS = "correct horse", TOKEN = "agent-token-abc";
function fakeKv() {
  const m = new Map(); const n = { list: 0, put: 0, broken: false };
  return { _m: m, n,
    async get(k, type) { const v = m.get(k); return v == null ? null : (type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { n.put++; m.set(k, v); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { n.list++; if (n.broken) throw new Error("KV list limit exceeded");
      return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; } };
}
const e = { JOBS: fakeKv(), REQUEST_SECRET: PASS, AGENT_TOKEN: TOKEN, ASSETS: { fetch: async () => new Response("") } };
const req = (p, opts) => new Request("https://carweb.example" + p, opts);
const post = (p, body, headers) => req(p, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers), body: JSON.stringify(body) });
const bearer = { authorization: "Bearer " + TOKEN };
const send = async r => (await worker.fetch(r, e)).json();
const status = () => send(req("/api/request/status"));
const age = ms => { const s = JSON.parse(e.JOBS._m.get("status:view")); s.at -= ms; e.JOBS._m.set("status:view", JSON.stringify(s)); };
const HOUR = 3600e3;

(async () => {
  await status();
  const first = e.JOBS.n.list;
  for (let i = 0; i < 1000; i++) await status();
  t("a thousand status reads cost no further list operations", e.JOBS.n.list === first, e.JOBS.n.list);

  const q = await send(post("/api/request/queue", { passphrase: PASS, targetId: "m-a", targetLabel: "Car A" }));
  t("a new request shows at once", q.ok && (await status()).queue.length === 1, JSON.stringify(q).slice(0, 80));
  const claimed = await send(post("/api/request/claim", {}, bearer));
  t("a claim shows", (await status()).queue[0].state === "running");
  await send(post("/api/request/release", { id: claimed.job.id }, bearer));
  t("a release shows", (await status()).queue[0].state === "queued");
  const puts = e.JOBS.n.put;
  for (let i = 0; i < 50; i++) await send(req("/api/request/jobs", { headers: bearer }));
  t("polling writes nothing while nothing changes", e.JOBS.n.put === puts, e.JOBS.n.put - puts);

  const job = JSON.parse(e.JOBS._m.get("job:car:m-a"));
  await send(post("/api/request/done", { id: job.id, state: "done", summary: "finished" }, bearer));
  const after = await status();
  t("a finished request leaves the queue and shows as the last one", after.queue.length === 0 && after.last && after.last.summary === "finished");

  const before = e.JOBS.n.list;
  age(HOUR + 1000);
  await status(); await status();
  t("an hour-old copy is rebuilt once", e.JOBS.n.list === before + 1, e.JOBS.n.list - before);

  age(HOUR + 1000);
  e.JOBS.n.broken = true;
  const stale = await status();
  t("out of list operations, the old copy is still answered", stale.ok && stale.stale === true, JSON.stringify(stale).slice(0, 80));
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
})();
