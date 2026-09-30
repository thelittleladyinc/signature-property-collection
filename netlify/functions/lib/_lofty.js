// Pushing website leads into Lofty, and never losing one.
//
// 2026-08-15 (Christine: "submitted - but still didnt come into lofty"). Netlify's
// API confirms her submission landed -- the contact form went from 1 submission to
// 2, timestamped 16:48:21Z -- so the lead is captured and the failure is on this
// side of the handoff. Her /site-health page also confirms the API key itself is
// good (Lofty answered /v1.0/me with HTTP 200), so this is not authentication.
//
// That leaves the request body, and I can't read Lofty's schema from this
// environment (developer.lofty.com is unreachable behind the egress proxy). So
// rather than guess at field names in the dark, this module does three things
// that are useful whatever the answer turns out to be:
//
//   1. TWO PAYLOAD SHAPES. The lead is sent in the shape inherited from
//      Christine's sellerintelligence project (emails/phones as arrays, plus
//      source, tags and notes). If Lofty rejects that as malformed -- a 400 or
//      422, NOT an auth error -- it is retried once in the most conservative
//      shape possible: singular email/phone, no tags, no notes, no source. Those
//      are the two plausible readings of a CRM lead API, and a 400 means the
//      first reading was refused anyway. Whichever shape worked is recorded, so
//      this gets pinned to one instead of guessing forever -- and if the
//      minimal shape is what works, the lead is saved rather than lost while we
//      figure out why.
//
//   2. A DRAINABLE QUEUE. Every failed push is stored with its full payload and
//      retried by the next sync run (see drainFailedPushes, called from
//      sync-listings.js). A lead that fails during a Lofty outage now arrives
//      late instead of never, without Christine re-typing anything.
//
//   3. A VISIBLE RECORD. The last push result -- Lofty's own status code and the
//      first part of its response -- is written where /site-health can show it.
//      This whole class of bug was invisible before: the function caught the
//      error, logged it where nobody looks, and returned success.
const LOFTY_BASE_URL = "https://api.lofty.com/v1.0";
const LAST_PUSH_KEY = "lofty-last-push.json";
const FAILED_PUSH_KEY = "lofty-failed-pushes.json";
const MAX_QUEUED_FAILURES = 25;
// Small: this runs inside the listing sync's time budget, which has real work to
// do. A backlog drains over consecutive runs rather than all at once.
const MAX_DRAIN_PER_RUN = 3;
// 2026-09-30 (API audit): the Little Lady site now drains its own copy of this
// queue on a schedule (its netlify/functions/lofty-queue-drain.js), and if its
// Blobs settings point at this site's store, two schedules read the SAME key. A
// drain therefore holds a short lease first -- a create-only write, which only
// one caller can win -- so a queued lead is never replayed twice at once, and it
// writes the queue back merged with anything queued while it ran instead of
// overwriting it. A lease older than any function can run is taken over.
const DRAIN_LOCK_KEY = "lofty-drain-lock.json";
const DRAIN_LOCK_TTL_MS = 5 * 60 * 1000;
// 2026-09-30 (consent fix): every lead this file creates goes to Lofty with
// texting OFF (cannotText:true) -- the full shape, the minimal retry and the
// queue replay alike, including leads queued before this change. Texting goes
// on only afterwards, and only through lib/_lofty-consent.js's rule (an explicit
// yes, and every phone on the lead is the number the yes came with).
const { applyTextingConsent } = require("./_lofty-consent");
const { leadIdFromResponse } = require("./_lofty-returning");

// Strips the full payload down to the least a CRM could possibly need. Used only
// after Lofty has already refused the full one.
function minimalLead(body) {
  // Texting stays off even in the most conservative shape.
  const out = { cannotText: true };
  if (body.firstName) out.firstName = body.firstName;
  if (body.lastName) out.lastName = body.lastName;
  if (Array.isArray(body.emails) && body.emails[0]) out.email = body.emails[0];
  if (Array.isArray(body.phones) && body.phones[0]) out.phone = body.phones[0];
  if (body.email) out.email = body.email;
  if (body.phone) out.phone = body.phone;
  return out;
}

// 2026-09-29 (independent review): this call had no timeout, so a hung Lofty ran
// the whole function out of time before the backup email and the retry queue --
// the one outcome this file exists to prevent. Now it gives up after 6 seconds
// and reports a failure like any other, which the caller emails and queues.
const POST_TIMEOUT_MS = 6000;
// 2026-09-29 (second review): the two attempts in postLead could still add up to
// 12 seconds on top of the 2-second contact lookup, past the function's time
// limit and in front of the backup email. A caller can now pass a deadline; no
// attempt runs past it, and the minimal-shape retry is skipped when less than
// this much time is left (the lead is then emailed and queued like any failure).
const MIN_RETRY_MS = 1500;

async function postOnce(body, apiKey, timeoutMs = POST_TIMEOUT_MS) {
  let res;
  try {
    res = await fetch(`${LOFTY_BASE_URL}/leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Verbatim from Lofty's own usage example on its API settings page:
        // Authorization: token <your apiKey>. Lowercase "token", not "Bearer".
        "Authorization": `token ${apiKey}`,
      },
      // Whatever the caller built or the queue held: a create never turns texting on.
      body: JSON.stringify({ ...body, cannotText: true }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(POST_TIMEOUT_MS, timeoutMs))),
    });
  } catch (err) {
    return { ok: false, httpStatus: 0, responseBody: `no answer from Lofty: ${String((err && err.message) || err).slice(0, 200)}` };
  }
  const text = await res.text().catch(() => "");
  return { ok: res.ok, httpStatus: res.status, responseBody: text.slice(0, 500) };
}

// Posts a lead, falling back to the minimal payload shape if Lofty rejects the
// full one as malformed. Returns what happened, including which shape was used.
// opts.deadline (epoch ms): see MIN_RETRY_MS. Without it, behaves as before.
async function postLead(body, apiKey, opts = {}) {
  const deadline = opts.deadline || Infinity;
  const left = () => deadline - Date.now();
  const full = await postOnce(body, apiKey, Math.min(POST_TIMEOUT_MS, left()));
  if (full.ok) return { ...full, payloadShape: "full" };

  // 401/403 is a key problem and 5xx is Lofty's problem -- neither is fixed by
  // sending different fields, and retrying would only muddy the diagnosis.
  if (full.httpStatus !== 400 && full.httpStatus !== 422) {
    return { ...full, payloadShape: "full" };
  }

  const minimal = minimalLead(body);
  if (!minimal.email && !minimal.phone) return { ...full, payloadShape: "full" };
  if (left() < MIN_RETRY_MS) return { ...full, payloadShape: "full (no time left for the minimal retry; queued)" };
  const retry = await postOnce(minimal, apiKey, Math.min(POST_TIMEOUT_MS, left()));
  return {
    ...retry,
    payloadShape: retry.ok ? "minimal" : "full+minimal both rejected",
    // Kept so the failure record shows BOTH refusals, not just the second.
    firstAttempt: full,
  };
}

async function recordPush(store, result, formName, lead) {
  try {
    // The lead's email is recorded because it identifies WHICH submission a
    // result belongs to -- and because it matters here: Christine's two test
    // submissions both used thelittleladyinc@gmail.com, which is the Lofty
    // account owner's own address. A CRM refusing to create a lead that
    // duplicates an existing contact (let alone the account owner) is ordinary
    // behaviour, and would look exactly like "the push is broken".
    const leadEmail = (lead && (lead.email || (Array.isArray(lead.emails) && lead.emails[0]))) || null;
    await store.setJSON(LAST_PUSH_KEY, { at: new Date().toISOString(), formName, leadEmail, ...result });
    if (!result.ok) {
      const queue = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
      queue.unshift({ at: new Date().toISOString(), formName, lead, ...result });
      await store.setJSON(FAILED_PUSH_KEY, queue.slice(0, MAX_QUEUED_FAILURES));
    }
  } catch (err) {
    // Diagnostics must never be the reason a lead push fails.
    console.error("could not record Lofty push result:", err && err.message);
  }
}

// Retries queued leads. Called by sync-listings.js, so a lead that failed during
// an outage arrives on a later run instead of waiting on someone noticing.
// Bounded, wrapped, and never allowed to affect the sync: any throw is caught by
// the caller and the queue is simply left for next time.
async function takeDrainLease(store) {
  const lease = { at: new Date().toISOString() };
  try {
    const first = await store.setJSON(DRAIN_LOCK_KEY, lease, { onlyIfNew: true });
    if (!first || first.modified !== false) return true;
    const held = await store.get(DRAIN_LOCK_KEY, { type: "json" }).catch(() => null);
    const age = held && Date.parse(held.at);
    if (Number.isFinite(age) && Date.now() - age < DRAIN_LOCK_TTL_MS) return false;
    await store.delete(DRAIN_LOCK_KEY);
    const again = await store.setJSON(DRAIN_LOCK_KEY, lease, { onlyIfNew: true });
    return !again || again.modified !== false;
  } catch (err) {
    console.error("Lofty queue drain: could not take the lease (skipping this run):", err && err.message);
    return false;
  }
}

async function releaseDrainLease(store) {
  try {
    if (typeof store.delete === "function") await store.delete(DRAIN_LOCK_KEY);
  } catch (err) {
    // Expires on its own after DRAIN_LOCK_TTL_MS.
  }
}

// opts.deadline (epoch ms, optional): no replay starts, and none runs, past it --
// so a caller with a hard time limit finishes and writes the queue back.
async function drainFailedPushes(store, apiKey, opts) {
  if (!apiKey) return { attempted: 0, recovered: 0 };
  const peek = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
  if (!peek.length) return { attempted: 0, recovered: 0 };
  if (!(await takeDrainLease(store))) return { attempted: 0, recovered: 0, locked: true };
  try {
    return await drainWithLease(store, apiKey, opts || {});
  } finally {
    await releaseDrainLease(store);
  }
}

async function drainWithLease(store, apiKey, opts) {
  const deadline = opts.deadline || Infinity;
  // Read again under the lease: another drain may have finished in between.
  const queue = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
  if (!queue.length) return { attempted: 0, recovered: 0 };

  const remaining = [];
  let attempted = 0;
  let recovered = 0;
  let consentHeld = 0;
  for (const entry of queue) {
    if (!entry || !entry.lead || attempted >= MAX_DRAIN_PER_RUN || deadline - Date.now() < MIN_RETRY_MS) {
      if (entry) remaining.push(entry);
      continue;
    }
    attempted += 1;
    // 2026-09-29: a replay never REPLACES tags. By the time it runs the contact
    // may exist -- a create that timed out on our side can still have landed in
    // Lofty -- and `tags` would wipe anything added since. `tagsAdd` only adds.
    const lead = { ...entry.lead };
    if (Array.isArray(lead.tags)) {
      lead.tagsAdd = [...new Set([...(lead.tagsAdd || []), ...lead.tags])];
      delete lead.tags;
    }
    const result = await postLead(lead, apiKey, { deadline });
    if (result.ok) {
      recovered += 1;
      console.log(`Recovered a queued Lofty lead from "${entry.formName}" (${result.payloadShape} shape).`);
      // The replay was created with texting off. The same consent rule as the
      // live form: only a recorded yes, and only if every phone on the lead the
      // create landed on is the consented number (that lead may be a client's
      // by now, so its tags are read and merged, never replaced).
      if (entry.smsConsent === true) {
        const consent = await applyTextingConsent(leadIdFromResponse(result.responseBody), consentPhoneOf(entry.lead), apiKey, { deadline });
        if (!consent.textingEnabled) {
          consentHeld += 1;
          console.warn(`Queued Lofty lead from "${entry.formName}": texting not turned on -- ${consent.textingNotEnabled || consent.reason || consent.error || "not applied"}.`);
        }
      }
    } else {
      remaining.push({ ...entry, lastRetryAt: new Date().toISOString(), ...result });
    }
  }
  // Anything a form queued while this ran (recordPush puts it first) is kept.
  const entryKey = (e) => `${e && e.at}|${e && e.formName}`;
  const taken = new Set(queue.map(entryKey));
  const latest = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
  const arrived = (Array.isArray(latest) ? latest : []).filter((e) => e && !taken.has(entryKey(e)));
  await store.setJSON(FAILED_PUSH_KEY, arrived.concat(remaining).slice(0, MAX_QUEUED_FAILURES)).catch(() => {});
  if (attempted) {
    await store.setJSON(LAST_PUSH_KEY, {
      at: new Date().toISOString(),
      formName: "(queued retry)",
      ok: recovered > 0,
      httpStatus: recovered > 0 ? 200 : "retry failed",
      responseBody: `${recovered} of ${attempted} queued lead(s) recovered; ${remaining.length} still queued.` +
        (consentHeld ? ` Texting left off on ${consentHeld} that said yes to texts (see the function log).` : ""),
      payloadShape: "queued retry",
    }).catch(() => {});
  }
  return { attempted, recovered, stillQueued: remaining.length, ...(consentHeld ? { consentHeld } : {}) };
}

// The number a queued lead's texting yes came with: the one the form sent.
function consentPhoneOf(lead) {
  if (!lead) return null;
  if (Array.isArray(lead.phones) && lead.phones.length) return lead.phones[0];
  return lead.phone || null;
}

module.exports = {
  LOFTY_BASE_URL,
  POST_TIMEOUT_MS,
  MIN_RETRY_MS,
  LAST_PUSH_KEY,
  FAILED_PUSH_KEY,
  DRAIN_LOCK_KEY,
  minimalLead,
  postLead,
  recordPush,
  drainFailedPushes,
};
