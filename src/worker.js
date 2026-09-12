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

const PENDING_KEY = "job:pending";
const LAST_KEY = "job:last";
// A job nobody claims should not sit in the queue forever -- the Mac may
// simply have been off all week, and a week-old "scan everything" is not what
// anyone wants run when it finally wakes up.
const JOB_TTL_SECONDS = 60 * 60 * 24 * 2;

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

// What the button is allowed to see: enough to tell the user where their
// request got to, and nothing that would help someone guess a secret.
function publicView(pending, last) {
  return {
    pending: pending
      ? { id: pending.id, state: pending.state, queuedAt: pending.queuedAt,
          claimedAt: pending.claimedAt || null, note: pending.note || "" }
      : null,
    last: last
      ? { id: last.id, state: last.state, queuedAt: last.queuedAt,
          finishedAt: last.finishedAt || null, summary: last.summary || "",
          note: last.note || "" }
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

    const getPending = async () => await env.JOBS.get(PENDING_KEY, "json");
    const getLast = async () => await env.JOBS.get(LAST_KEY, "json");

    // ---- public: where did my request get to? --------------------------------
    if (path === "/api/request/status" && request.method === "GET") {
      const [pending, last] = await Promise.all([getPending(), getLast()]);
      return json({ ok: true, ...publicView(pending, last) });
    }

    // ---- public (passphrase): queue a scan ------------------------------------
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
      const existing = await getPending();
      // One job at a time. Two queued scans of the same graph is one scan and
      // one wasted wake-up, and a "running" job must never be replaced under
      // the agent's feet.
      if (existing) {
        return json({ ok: true, already: true, ...publicView(existing, await getLast()) });
      }
      const job = {
        id: crypto.randomUUID(),
        state: "queued",
        queuedAt: new Date().toISOString(),
        note: String(body.note || "").slice(0, 200),
      };
      await env.JOBS.put(PENDING_KEY, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
      return json({ ok: true, already: false, ...publicView(job, await getLast()) });
    }

    // ---- agent-only from here on ---------------------------------------------
    const auth = request.headers.get("authorization") || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.AGENT_TOKEN || !timingSafeEqual(bearer, env.AGENT_TOKEN)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    if (path === "/api/request/jobs" && request.method === "GET") {
      return json({ ok: true, job: await getPending() });
    }

    if (path === "/api/request/claim" && request.method === "POST") {
      const body = await readJson(request);
      const pending = await getPending();
      if (!pending) return json({ ok: false, error: "no-job" }, 404);
      if (body && body.id && body.id !== pending.id) {
        return json({ ok: false, error: "stale-job", job: pending }, 409);
      }
      if (pending.state === "running") return json({ ok: true, already: true, job: pending });
      pending.state = "running";
      pending.claimedAt = new Date().toISOString();
      await env.JOBS.put(PENDING_KEY, JSON.stringify(pending), { expirationTtl: JOB_TTL_SECONDS });
      return json({ ok: true, already: false, job: pending });
    }

    if (path === "/api/request/done" && request.method === "POST") {
      const body = await readJson(request) || {};
      const pending = await getPending();
      if (!pending) return json({ ok: false, error: "no-job" }, 404);
      if (body.id && body.id !== pending.id) {
        return json({ ok: false, error: "stale-job", job: pending }, 409);
      }
      const done = {
        ...pending,
        state: body.state === "failed" ? "failed" : "done",
        finishedAt: new Date().toISOString(),
        summary: String(body.summary || "").slice(0, 400),
      };
      // The finished job moves to LAST and the queue empties in that order, so
      // a crash between the two leaves a job that can be re-claimed rather
      // than a result that was never recorded.
      await env.JOBS.put(LAST_KEY, JSON.stringify(done));
      await env.JOBS.delete(PENDING_KEY);
      return json({ ok: true, job: done });
    }

    return json({ ok: false, error: "not-found" }, 404);
  },
};
