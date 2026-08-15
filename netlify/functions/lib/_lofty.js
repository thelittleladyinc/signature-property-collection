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

// Strips the full payload down to the least a CRM could possibly need. Used only
// after Lofty has already refused the full one.
function minimalLead(body) {
  const out = {};
  if (body.firstName) out.firstName = body.firstName;
  if (body.lastName) out.lastName = body.lastName;
  if (Array.isArray(body.emails) && body.emails[0]) out.email = body.emails[0];
  if (Array.isArray(body.phones) && body.phones[0]) out.phone = body.phones[0];
  if (body.email) out.email = body.email;
  if (body.phone) out.phone = body.phone;
  return out;
}

async function postOnce(body, apiKey) {
  const res = await fetch(`${LOFTY_BASE_URL}/leads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Verbatim from Lofty's own usage example on its API settings page:
      // Authorization: token <your apiKey>. Lowercase "token", not "Bearer".
      "Authorization": `token ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, httpStatus: res.status, responseBody: text.slice(0, 500) };
}

// Posts a lead, falling back to the minimal payload shape if Lofty rejects the
// full one as malformed. Returns what happened, including which shape was used.
async function postLead(body, apiKey) {
  const full = await postOnce(body, apiKey);
  if (full.ok) return { ...full, payloadShape: "full" };

  // 401/403 is a key problem and 5xx is Lofty's problem -- neither is fixed by
  // sending different fields, and retrying would only muddy the diagnosis.
  if (full.httpStatus !== 400 && full.httpStatus !== 422) {
    return { ...full, payloadShape: "full" };
  }

  const minimal = minimalLead(body);
  if (!minimal.email && !minimal.phone) return { ...full, payloadShape: "full" };
  const retry = await postOnce(minimal, apiKey);
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
async function drainFailedPushes(store, apiKey) {
  if (!apiKey) return { attempted: 0, recovered: 0 };
  const queue = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
  if (!queue.length) return { attempted: 0, recovered: 0 };

  const remaining = [];
  let attempted = 0;
  let recovered = 0;
  for (const entry of queue) {
    if (!entry || !entry.lead || attempted >= MAX_DRAIN_PER_RUN) {
      if (entry) remaining.push(entry);
      continue;
    }
    attempted += 1;
    const result = await postLead(entry.lead, apiKey);
    if (result.ok) {
      recovered += 1;
      console.log(`Recovered a queued Lofty lead from "${entry.formName}" (${result.payloadShape} shape).`);
    } else {
      remaining.push({ ...entry, lastRetryAt: new Date().toISOString(), ...result });
    }
  }
  await store.setJSON(FAILED_PUSH_KEY, remaining.slice(0, MAX_QUEUED_FAILURES)).catch(() => {});
  if (attempted) {
    await store.setJSON(LAST_PUSH_KEY, {
      at: new Date().toISOString(),
      formName: "(queued retry)",
      ok: recovered > 0,
      httpStatus: recovered > 0 ? 200 : "retry failed",
      responseBody: `${recovered} of ${attempted} queued lead(s) recovered; ${remaining.length} still queued.`,
      payloadShape: "queued retry",
    }).catch(() => {});
  }
  return { attempted, recovered, stillQueued: remaining.length };
}

module.exports = {
  LOFTY_BASE_URL,
  LAST_PUSH_KEY,
  FAILED_PUSH_KEY,
  minimalLead,
  postLead,
  recordPush,
  drainFailedPushes,
};
