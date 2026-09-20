/* The Car Web — request queue.
 *
 * Until now this deploy had no Worker script at all: wrangler.jsonc pointed
 * at app/ and Cloudflare served those files as-is. Everything below is added
 * for one feature -- a button on the hosted site that asks Andy's Mac to run
 * the local LLM generation pass -- and every path it does not recognise is
 * handed straight back to the static assets, so the site behaves exactly as
 * it did before.
 *
 * Why a queue and not a call. The Mac has no public address and is usually
 * asleep, so nothing on the internet can reach it. The button therefore does
 * not contact the Mac; it leaves a job in KV, and the agent on the Mac polls
 * for jobs when it is awake, claims one, runs the pass, pushes, and exits.
 * That is also why every status this exposes is a record of what the agent
 * last said, never a live view of the machine.
 *
 * A job names ONE CAR. The button is used from inside the graph -- you focus
 * a nameplate or a model, ask for it to be looked at, and that is what gets
 * scanned. A request with no car would mean "go and do something", which is
 * not a thing anyone can act on or review afterwards.
 *
 * Why the routes are under /api/request/ rather than /api/. app/serve.py --
 * the local Python server -- owns /api/llm-families, /api/rebuild and a dozen
 * others, and llm_families.js decides whether the whole LLM layer is
 * available by asking /api/llm-families and seeing whether anything answers.
 * If this Worker answered any of those, the PUBLIC site would light up every
 * server-only control (LLM check, delete/restore, rebuild) and each one would
 * then fail. Keeping to our own prefix means those requests still 404 against
 * the asset handler, which is what tells the app it is running static.
 *
 * Secrets (wrangler secret put, or the dashboard under Settings → Variables):
 *   REQUEST_SECRET  the passphrase the button asks for. Without it a public
 *                   URL is a button anyone can use to wake someone's laptop.
 *   AGENT_TOKEN     bearer token the polling agent presents. Separate from
 *                   the passphrase on purpose: the passphrase is typed into a
 *                   browser and can only enqueue, the token lives on one
 *                   machine and can read and complete jobs.
 * Binding:
 *   JOBS            KV namespace. Absent until it is created, and every route
 *                   below says so plainly rather than throwing, so a deploy
 *                   made before the namespace exists still serves the site.
 */

// ONE KV KEY PER CAR, not one array holding them all.
//
// The array was a read-modify-write, and KV has no compare-and-swap: two
// people pressing the button at the same moment both read the list, both push
// their own job, and whichever writes second erases the other. With a key per
// car there is nothing to race over -- two different cars are two different
// keys, and the same car twice is the same key, which is exactly the dedupe
// this wants anyway. Order comes from queuedAt, not from array position.
//
// The cost is that listing is eventually consistent: a job written at one edge
// can take a moment to appear in a list read at another. It does not matter
// here -- the POST hands the request straight back to whoever made it, so they
// see it immediately, and the agent polls.
const JOB_PREFIX = "job:car:";
const LAST_KEY = "job:last";
const MAX_QUEUED = 25;
const jobKey = targetId => JOB_PREFIX + targetId;
// A job nobody claims should not sit in the queue forever -- the Mac may
// simply have been off all week. Applied to the whole list: anything older
// than this is dropped when the queue is next read.
const JOB_TTL_SECONDS = 60 * 60 * 24 * 2;
// A claim is not a lock for ever. The agent claims a job, runs the pass and
// posts /done -- but a run that is Ctrl-C'd, crashes, or loses the machine
// never posts anything, and the job it claimed would otherwise sit marked
// "running" until the TTL took it, blocking every later request behind it
// (the agent deliberately will not stampede a job someone else is on). So a
// claim that is older than one very long pass is treated as abandoned and the
// job goes back to waiting, to be claimed again by the next run.
const STALE_CLAIM_SECONDS = 60 * 90;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// Constant-time over the secret's own length. The length itself is not
// hidden, which is the usual and accepted trade -- what matters is that a
// wrong guess cannot be refined one character at a time by how fast it comes
// back. Empty is never equal to anything, so an unset secret cannot be
// satisfied by sending an empty string.
function timingSafeEqual(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

function fresh(queue) {
  const cutoff = Date.now() - JOB_TTL_SECONDS * 1000;
  return (Array.isArray(queue) ? queue : []).filter(j => {
    const t = Date.parse(j && j.queuedAt);
    return j && j.id && (!isFinite(t) || t >= cutoff);
  });
}

// What a visitor is allowed to see: which cars are waiting and where their own
// request got to. Never a secret, and never an internal node id they could
// not have seen in the graph anyway.
function jobView(j) {
  return j && {
    id: j.id, state: j.state, queuedAt: j.queuedAt, claimedAt: j.claimedAt || null,
    targetId: j.targetId || null, targetLabel: j.targetLabel || "",
  };
}
// The queue prints short ids (the first eight characters) in the agent's log
// and in the panel, so those are what someone types back at it. An eight-hex
// prefix of a UUID is unambiguous in a list capped at 25.
function matchJob(queue, id) {
  id = String(id == null ? "" : id).trim();
  if (!id) return null;
  const exact = queue.find(j => j.id === id || j.targetId === id);
  if (exact) return exact;
  if (id.length < 6) return null;
  const hits = queue.filter(j => String(j.id).startsWith(id));
  return hits.length === 1 ? hits[0] : null;
}

function publicView(queue, last) {
  const q = fresh(queue);
  return {
    queue: q.map(jobView),
    // Kept for the older shape: the head of the queue is what "pending" meant.
    pending: q.length ? jobView(q[0]) : null,
    last: last
      ? { id: last.id, state: last.state, queuedAt: last.queuedAt,
          finishedAt: last.finishedAt || null, summary: last.summary || "",
          targetLabel: last.targetLabel || "" }
      : null,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/request/")) return env.ASSETS.fetch(request);
    if (!env.JOBS) {
      return json({ ok: false, error: "queue-unconfigured",
                    message: "No KV namespace is bound to this Worker yet." }, 503);
    }

    // Oldest first. Two requests made in the same second are ordered by their
    // key, so the order is at least stable rather than arbitrary.
    const getQueue = async () => {
      const listed = await env.JOBS.list({ prefix: JOB_PREFIX, limit: 200 });
      const jobs = await Promise.all(listed.keys.map(k => env.JOBS.get(k.name, "json")));
      const queue = fresh(jobs.filter(Boolean)).sort((a, b) =>
        String(a.queuedAt).localeCompare(String(b.queuedAt)) ||
        String(a.targetId).localeCompare(String(b.targetId)));
      // Hand back an abandoned claim before anyone reads the list, so a dead
      // run cannot wedge the queue. Written back so the next reader sees the
      // same thing rather than each one deciding for itself.
      const cutoff = Date.now() - STALE_CLAIM_SECONDS * 1000;
      const stale = queue.filter(j => {
        if (j.state !== "running") return false;
        const t = Date.parse(j.claimedAt);
        return !isFinite(t) || t < cutoff;
      });
      if (stale.length) {
        await Promise.all(stale.map(j => {
          j.state = "queued";
          j.claimedAt = null;
          j.releasedAt = new Date().toISOString();
          return putJob(j);
        }));
      }
      return queue;
    };
    const putJob = async j => await env.JOBS.put(jobKey(j.targetId), JSON.stringify(j),
                                                 { expirationTtl: JOB_TTL_SECONDS });
    const dropJob = async j => await env.JOBS.delete(jobKey(j.targetId));
    const getLast = async () => await env.JOBS.get(LAST_KEY, "json");

    // ---- public: what is waiting, and where did my request get to? ----------
    if (path === "/api/request/status" && request.method === "GET") {
      const [queue, last] = await Promise.all([getQueue(), getLast()]);
      return json({ ok: true, ...publicView(queue, last) });
    }

    // ---- public (passphrase): ask for one car to be scanned -----------------
    if (path === "/api/request/queue" && request.method === "POST") {
      const body = await readJson(request);
      if (!body) return json({ ok: false, error: "bad-request" }, 400);
      if (!env.REQUEST_SECRET) {
        return json({ ok: false, error: "queue-unconfigured",
                      message: "No passphrase is configured for this Worker yet." }, 503);
      }
      if (!timingSafeEqual(body.passphrase, env.REQUEST_SECRET)) {
        return json({ ok: false, error: "bad-passphrase" }, 403);
      }
      // A request names a car. That is the whole point of the button: you
      // focus something in the graph, ask for it to be looked at, and get
      // that back. A request with no car would be "go and do something",
      // which is not a thing anyone can act on or review.
      const targetId = String(body.targetId || "").trim();
      if (!targetId || targetId.length > 200 || !/^[A-Za-z0-9._~:@+-]+$/.test(targetId)) {
        return json({ ok: false, error: "no-target",
                      message: "Pick a car on the graph first." }, 400);
      }
      // The same car asked for twice is one piece of work, whether the first
      // request is still waiting or is being scanned right now. Read the car's
      // own key rather than scanning the list: a key read is strongly
      // consistent where a list is not, so two people asking for the Jeep
      // Compass at the same moment cannot produce two Compass jobs.
      const existing = fresh([await env.JOBS.get(jobKey(targetId), "json")])[0];
      if (existing) {
        return json({ ok: true, already: true, ...publicView(await getQueue(), await getLast()) });
      }
      const queue = await getQueue();
      if (queue.length >= MAX_QUEUED) {
        return json({ ok: false, error: "queue-full",
                      message: `Already ${MAX_QUEUED} cars waiting.` }, 429);
      }
      const job = {
        id: crypto.randomUUID(),
        state: "queued",
        queuedAt: new Date().toISOString(),
        targetId,
        // Shown back to every visitor, so it never carries markup or control
        // characters. The panel escapes it as well; this is the other half.
        targetLabel: String(body.targetLabel || "")
          .replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 120),
      };
      await putJob(job);
      return json({ ok: true, already: false, ...publicView([...queue, job], await getLast()) });
    }

    // ---- passphrase OR agent token: take something back out ----------------
    // Anyone who could put a car in can take that car out again -- a request
    // is a suggestion, and being unable to withdraw one meant waiting two
    // days for the TTL or running a scan nobody wanted any more. Emptying the
    // WHOLE queue needs the agent token: if the passphrase ever leaks, one
    // bad actor should not be able to wipe everyone's requests in a click.
    if (path === "/api/request/cancel" && request.method === "POST") {
      const body = await readJson(request) || {};
      const authz = request.headers.get("authorization") || "";
      const tok = authz.startsWith("Bearer ") ? authz.slice(7) : "";
      const isAgent = !!env.AGENT_TOKEN && timingSafeEqual(tok, env.AGENT_TOKEN);
      const knowsPass = !!env.REQUEST_SECRET && timingSafeEqual(body.passphrase, env.REQUEST_SECRET);
      if (!isAgent && !knowsPass) return json({ ok: false, error: "bad-passphrase" }, 403);

      const queue = await getQueue();
      if (body.all) {
        if (!isAgent) {
          return json({ ok: false, error: "agent-only",
                        message: "Clearing the whole queue has to be done from the machine." }, 403);
        }
        // A job already RUNNING is not cancelled from here: the agent is
        // mid-pass on it and its /done is what closes it out. Dropping it
        // would leave that result with nowhere to land.
        const doomed = queue.filter(j => j.state !== "running");
        await Promise.all(doomed.map(dropJob));
        const keep = queue.filter(j => j.state === "running");
        return json({ ok: true, removed: doomed.length, ...publicView(keep, await getLast()) });
      }
      const job = matchJob(queue, body.id);
      if (!job) return json({ ok: false, error: "no-job" }, 404);
      if (job.state === "running") {
        return json({ ok: false, error: "running",
                      message: "That one is being scanned right now." }, 409);
      }
      await dropJob(job);
      return json({ ok: true, removed: 1,
                    ...publicView(queue.filter(j => j !== job), await getLast()) });
    }

    // ---- agent-only from here on -------------------------------------------
    const auth = request.headers.get("authorization") || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.AGENT_TOKEN || !timingSafeEqual(bearer, env.AGENT_TOKEN)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    if (path === "/api/request/jobs" && request.method === "GET") {
      const queue = await getQueue();
      // The head only. One job at a time is still how the agent works -- it
      // has one model and one browser -- but the rest of the list is returned
      // so it can log how much is waiting.
      return json({ ok: true, job: queue[0] || null, waiting: queue.length });
    }

    if (path === "/api/request/claim" && request.method === "POST") {
      const body = await readJson(request);
      const queue = await getQueue();
      const job = body && body.id ? queue.find(j => j.id === body.id) : queue[0];
      if (!job) return json({ ok: false, error: "no-job" }, 404);
      if (job.state === "running") return json({ ok: true, already: true, job });
      job.state = "running";
      job.claimedAt = new Date().toISOString();
      await putJob(job);
      return json({ ok: true, already: false, job });
    }

    // Let go of a claim without recording a result: the job goes back to
    // waiting so the next run picks it up. This is the by-hand version of the
    // stale-claim rule above, for when you know the run is dead and do not
    // want to wait the ninety minutes out.
    if (path === "/api/request/release" && request.method === "POST") {
      const body = await readJson(request) || {};
      const queue = await getQueue();
      const job = matchJob(queue, body.id) || (String(body.id || "").trim()
                    ? null : queue.find(j => j.state === "running"));
      if (!job) return json({ ok: false, error: "no-job" }, 404);
      job.state = "queued";
      job.claimedAt = null;
      job.releasedAt = new Date().toISOString();
      await putJob(job);
      return json({ ok: true, job: jobView(job), ...publicView(queue, await getLast()) });
    }

    if (path === "/api/request/done" && request.method === "POST") {
      const body = await readJson(request) || {};
      const queue = await getQueue();
      const job = body.id ? queue.find(j => j.id === body.id) : queue[0];
      if (!job) return json({ ok: false, error: "no-job" }, 404);
      const done = {
        ...job,
        state: body.state === "failed" ? "failed" : "done",
        finishedAt: new Date().toISOString(),
        summary: String(body.summary || "").slice(0, 400),
      };
      // LAST first, then remove the job: a crash between the two leaves a job
      // that can be re-claimed rather than a result nobody recorded.
      await env.JOBS.put(LAST_KEY, JSON.stringify(done));
      await dropJob(job);
      return json({ ok: true, job: done, waiting: Math.max(0, queue.length - 1) });
    }

    return json({ ok: false, error: "not-found" }, 404);
  },
};
