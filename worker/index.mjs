// skrim.app -- the website worker.
//
// It does three things and deliberately nothing else: canonicalise the host,
// accept a waitlist address, and hand everything else to the static assets.
//
// NOTE FOR ANYONE ADDING TO THIS FILE: this worker lives OUTSIDE extension/ on
// purpose. tools/check-listing.mjs greps extension/ for fetch/XHR/sendBeacon/
// WebSocket and all nine "Not collected" data disclosures in the Chrome Web
// Store listing rest on that grep coming back empty. Network code belongs here;
// it must never migrate into the extension without the listing changing too.

const APEX = "skrim.app";

/** RFC 5321's practical ceiling. Anything longer is not a typo, it is a probe. */
const EMAIL_MAX = 254;

/** A form body has no business being larger than this. Read before parsing. */
const BODY_MAX = 2048;

/**
 * Pragmatic rather than exhaustive. A stricter pattern rejects real addresses
 * (apostrophes, plus tags, long new TLDs) and the cost of letting a malformed
 * one through is a row nobody can email -- while the cost of rejecting a valid
 * one is a signup silently lost, which is the failure that actually matters.
 */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // One canonical origin. The store listing points at skrim.app/privacy and
    // receipt.js will eventually hard-code skrim.app/restore into bookmarks
    // that sync and outlive an uninstall -- so www must resolve to the same
    // place forever rather than becoming a second origin with its own history.
    if (url.hostname === `www.${APEX}`) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/api/waitlist") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, {
          allow: "POST",
        });
      }
      return join(request, env);
    }

    return harden(await env.ASSETS.fetch(request));
  },
};

/**
 * Adds the response headers worth having on a site made entirely of
 * self-contained pages.
 *
 * `no-referrer` is the one that earns its place rather than being boilerplate:
 * the uninstall URL arrives at /restore carrying ?n=<count>&at=<timestamp>,
 * and without this any link a reader then clicks would carry that querystring
 * to a third party in the Referer header. The receipt payload itself rides in
 * the fragment and was never at risk, but the count is still nobody's business.
 *
 * No CSP: every page here inlines its own <style> and <script> by design, so a
 * policy permissive enough to run them would have to allow 'unsafe-inline',
 * and a CSP that allows unsafe-inline is decoration. Hashes were the other
 * option and were rejected -- they go stale on every content edit, and the
 * failure mode is a privacy policy that renders blank for a Chrome reviewer.
 */
function harden(response) {
  const out = new Response(response.body, response);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "no-referrer");
  out.headers.set("x-frame-options", "DENY");
  return out;
}

/**
 * Accepts an address. Answers identically whether it was new, already present,
 * or rejected by the honeypot.
 *
 * That uniformity is the point: an endpoint that says "already subscribed" is
 * an endpoint that answers "is this person on the list", which is a question
 * about a real individual that no visitor should be able to ask. The count is
 * available to us over the CLI, where it belongs.
 */
async function join(request, env) {
  const fields = await readFields(request);
  if (!fields) return ok(request); // unparseable or oversized -- say nothing

  // Honeypot. A field positioned off-screen and marked aria-hidden, which a
  // person never sees and a form-filling bot cannot resist. Answer success so
  // the bot has no signal to tune against.
  if (fields.company) return ok(request);

  const email = String(fields.email ?? "").trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    return request.headers.get("accept")?.includes("application/json")
      ? json({ ok: false, error: "invalid_email" }, 400)
      : redirectHome(request, "invalid");
  }

  const source = String(fields.source ?? "apex").slice(0, 32);

  try {
    await env.DB.prepare(
      `INSERT INTO waitlist (email, created_at, source)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO NOTHING`
    )
      .bind(email, Math.floor(Date.now() / 1000), source)
      .run();
  } catch (err) {
    // A write that fails is ours to fix, not the visitor's to debug. Log it and
    // still answer success -- a stranger who typed their address correctly has
    // done nothing wrong and an error page teaches them nothing they can act on.
    console.error("waitlist insert failed", err);
  }

  return ok(request);
}

/**
 * Reads either a JSON body (the fetch path) or a urlencoded one (a native form
 * POST, which is what happens with JavaScript disabled). Both are supported
 * because the page is built to work without JS, and a signup form that silently
 * does nothing is worse than no form.
 */
async function readFields(request) {
  const type = request.headers.get("content-type") ?? "";
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > BODY_MAX) return null;

  let body;
  try {
    body = await request.text();
  } catch {
    return null;
  }
  if (body.length > BODY_MAX) return null;

  try {
    if (type.includes("application/json")) return JSON.parse(body);
    return Object.fromEntries(new URLSearchParams(body));
  } catch {
    return null;
  }
}

function ok(request) {
  return request.headers.get("accept")?.includes("application/json")
    ? json({ ok: true })
    : redirectHome(request, "joined");
}

/** The no-JS path lands back on the page with a state the markup can render. */
function redirectHome(request, state) {
  const url = new URL(request.url);
  url.pathname = "/";
  url.search = `?${state}=1`;
  return Response.redirect(url.toString(), 303);
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}
