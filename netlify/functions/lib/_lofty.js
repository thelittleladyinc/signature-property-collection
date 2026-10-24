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
//      retried on a schedule (see drainFailedPushes, run by each site's
//      lofty-queue-drain.js). A lead that fails during a Lofty outage now arrives
//      late instead of never, without Christine re-typing anything.
//
//   3. A VISIBLE RECORD. The last push result -- Lofty's own status code and the
//      first part of its response -- is written where /site-health can show it.
//      This whole class of bug was invisible before: the function caught the
//      error, logged it where nobody looks, and returned success.
//
//   4. A HELD-LEAD RECORD (2026-10-04, re-audit). A lead whose identity the Lofty
//      lookup could not settle -- several exact matches, or an email and a phone
//      naming different contacts -- is not created, not queued and never
//      replayed (a lookup Lofty could not answer is NOT held: that lead is
//      created with texting off and tagsAdd; see _lofty-returning.js): nothing in Lofty changes until Christine has
//      looked. Until now that lead lived only in the alert email. It is kept
//      under MANUAL_REVIEW_KEY, with the submission and the reason, where
//      /status counts it and names the submission ids (never the person).
//
//   5. THROUGH THE HUB (2026-10-17, Wave 1b; OFF unless LOFTY_VIA_HUB is exactly
//      "on"). postLead and the queue replay send the lead to the Seller
//      Intelligence hub (POST /v1/lofty/lead) instead of Lofty, and never fall
//      back to LOFTY_API_KEY for it: a hub that can't take it means the queue.
//      See lib/_lofty-hub.js.
//
//   6. ONE DRAIN AT A TIME (2026-10-17). Both sites' scheduled drains can read the
//      same queue (when this site's Blobs settings point at the other's store).
//      The lease each takes now carries its own token, a lease left by a dead run
//      is taken over by a write that only succeeds if nobody else took it first
//      (Blobs onlyIfMatch on the lease's etag), the winner reads the lease back
//      before it replays anything, and a drain releases only its own lease. A lead
//      queued through the hub by the OTHER site is left for that site's drain when
//      this one is on its own key.
const LOFTY_BASE_URL = "https://api.lofty.com/v1.0";
const LAST_PUSH_KEY = "lofty-last-push.json";
const FAILED_PUSH_KEY = "lofty-failed-pushes.json";
const MAX_QUEUED_FAILURES = 25;
// Held for identity review (4 above). Its own key, so the drain -- which reads
// FAILED_PUSH_KEY only -- can never replay one blindly. Newest kept.
const MANUAL_REVIEW_KEY = "lofty-manual-review.json";
const MAX_HELD_FOR_REVIEW = 50;
// Small: a run has a 20-second budget (each site's lofty-queue-drain.js) inside
// Netlify's 30-second limit. A backlog drains over consecutive runs rather than
// all at once.
const MAX_DRAIN_PER_RUN = 3;
// 2026-09-30 (API audit): both sites drain this queue on their own schedule (each
// site's netlify/functions/lofty-queue-drain.js), and if their Blobs settings
// point at the same store, two schedules read the SAME key. A
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
const { applyTextingPreference } = require("./_lofty-consent");
const {
  leadIdFromResponse, findExistingLead, alertReturningLead,
  ensureWebsiteFields, setWebsiteFields, websiteFieldValues, inquiryFromForm, placeInquiry,
} = require("./_lofty-returning");
const { addLoftyNote, refireLoftyTag, addPlanTags, BRAND_SITE } = require("./_notify");
const { loftyViaHub, pushLeadViaHub, confirmCreated, hubExtraResult } = require("./_lofty-hub");
const crypto = require("crypto");

// Must match submission-created.js TRIGGER_TAG (pinned by tests/test-queue-replay-steps.js).
const REPLAY_TRIGGER_TAG = "Hot Lead - Website";

// 2026-10-06: the nurture plan a queued lead's form starts (lib/_form-plans.js),
// as submission-created.js stored it on the queue entry (`plan`). An entry queued
// before plans existed has none, and starts none. A lead type on the queued body
// itself (an entry without `plan`) still counts.
function planOf(entry) {
  const p = (entry && entry.plan) || null;
  const lead = (entry && entry.lead) || {};
  const tags = p && Array.isArray(p.planTags) ? p.planTags.filter((t) => typeof t === "string" && t) : [];
  const typesFrom = p && Array.isArray(p.leadTypes) ? p.leadTypes : (Array.isArray(lead.leadTypes) ? lead.leadTypes : []);
  return { planTags: tags, leadTypes: typesFrom.filter((n) => Number.isInteger(n) && n > 0) };
}

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
  // 2026-10-06: the lead type a new contact's nurture plan needs (lib/_form-plans.js)
  // survives the retry: a plan only enrolls leads whose type is in its scope. It is
  // only ever on a body for a contact proven new (submission-created.js, and the
  // replay below re-decides it on its own lookup).
  if (Array.isArray(body.leadTypes) && body.leadTypes.length) out.leadTypes = body.leadTypes.slice();
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
// 2026-10-05 (re-audit): the steps after a replayed create (finishReplay) took
// no deadline, so a slow Lofty could carry a drain past its budget into
// Netlify's kill -- and a killed run never wrote the queue back, so a lead Lofty
// had already accepted was replayed again (a second note, a second trigger-tag
// re-fire). Now every follow-up call is capped at the deadline, and a step
// starts only with this much time left: otherwise it and the steps after it go
// back on the queue entry (followupsPending, with the accepted contact's id as
// loftyId) for the next run to finish on their own.
const FOLLOWUP_MIN_MS = 5000;

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
// With LOFTY_VIA_HUB=on the lead goes to the hub instead (lib/_lofty-hub.js), and
// this site's own key is not used for it, not even when the hub can't take it:
// the caller then queues it as it queues any failed push. `site` marks whose
// hub-path lead it is, so the other site's own-key drain leaves it alone.
async function postLead(body, apiKey, opts = {}) {
  if (loftyViaHub()) return { ...(await pushLeadViaHub(body, opts)), site: BRAND_SITE };
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
    // formData only rides on the retry queue (for the replay), not the status record.
    const { formData: _formData, ...shown } = result || {};
    await store.setJSON(LAST_PUSH_KEY, { at: new Date().toISOString(), formName, leadEmail, ...shown });
    if (!result.ok && result.manualReview) {
      // Held, not queued: the drain must never create a contact whose identity
      // is unsettled. The submission (the lead body, and the form data when the
      // caller passed it) and the reason go to their own record.
      await holdForManualReview(store, {
        at: new Date().toISOString(), formName, lead, ...result,
        reason: result.reason || result.responseBody || "identity needs manual review",
      });
    } else if (!result.ok) {
      const queue = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
      queue.unshift({ at: new Date().toISOString(), formName, lead, ...result });
      await store.setJSON(FAILED_PUSH_KEY, queue.slice(0, MAX_QUEUED_FAILURES));
    }
  } catch (err) {
    // Diagnostics must never be the reason a lead push fails.
    console.error("could not record Lofty push result:", err && err.message);
  }
}

// The held-lead record: the submission and why it was held, for Christine to
// settle by hand in Lofty. Read-then-write, newest first, one entry per
// submission (a lead held again replaces its earlier entry rather than adding
// one). Nothing in this file ever posts one of these to Lofty: the drain reads
// FAILED_PUSH_KEY only. Returns true when the record was written.
function heldKey(e) {
  return e && e.submissionId ? `id:${e.submissionId}` : `${e && e.at}|${e && e.formName}`;
}

async function holdForManualReview(store, held) {
  if (!store || !held) return false;
  try {
    const list = (await store.get(MANUAL_REVIEW_KEY, { type: "json" }).catch(() => null)) || [];
    const key = heldKey(held);
    const kept = (Array.isArray(list) ? list : []).filter((e) => e && heldKey(e) !== key);
    kept.unshift({ ...held, manualReview: true, heldAt: new Date().toISOString() });
    await store.setJSON(MANUAL_REVIEW_KEY, kept.slice(0, MAX_HELD_FOR_REVIEW));
    return true;
  } catch (err) {
    console.error("could not record a lead held for identity review:", err && err.message);
    return false;
  }
}

// Retries queued leads. Run by each site's lofty-queue-drain.js on a schedule, so
// a lead that failed during an outage arrives on a later run instead of waiting
// on someone noticing. Bounded and wrapped: any throw is caught by the caller
// and the queue is simply left for next time.
//
// 2026-10-17: the lease is one drain's, provably (6. in the header). Returns the
// lease taken, or null when another drain holds it or it can't be confirmed.
//   - Each lease carries a random token.
//   - A lease older than DRAIN_LOCK_TTL_MS is taken over with a write that only
//     lands if the lease is still the stale one this drain read (onlyIfMatch on
//     its etag): two drains that both find the same dead lease can no longer both
//     take it (the old delete-then-create let the second delete the first's
//     fresh lease). A store without etags (the tests' in-memory ones) keeps the
//     old delete-then-create.
//   - The winner reads the lease back and replays only if its own token is there:
//     Netlify Blobs reports any answer but 412 to a conditional write as "made",
//     so "made" alone is not proof. Unreadable means stand aside (fail closed).
async function readLease(store) {
  if (typeof store.getWithMetadata === "function") {
    const r = await store.getWithMetadata(DRAIN_LOCK_KEY, { type: "json" });
    return r ? { lease: r.data || null, etag: r.etag || null } : { lease: null, etag: null };
  }
  return { lease: await store.get(DRAIN_LOCK_KEY, { type: "json" }), etag: null };
}

async function confirmLease(store, lease) {
  const now = await store.get(DRAIN_LOCK_KEY, { type: "json" }).catch(() => null);
  return now && now.token === lease.token ? lease : null;
}

async function takeDrainLease(store) {
  const lease = { at: new Date().toISOString(), token: crypto.randomUUID(), by: BRAND_SITE };
  try {
    const first = await store.setJSON(DRAIN_LOCK_KEY, lease, { onlyIfNew: true });
    if (!first || first.modified !== false) return await confirmLease(store, lease);
    const held = await readLease(store);
    const age = held.lease && Date.parse(held.lease.at);
    if (Number.isFinite(age) && Date.now() - age < DRAIN_LOCK_TTL_MS) return null;
    if (held.etag) {
      const swap = await store.setJSON(DRAIN_LOCK_KEY, lease, { onlyIfMatch: held.etag });
      if (swap && swap.modified === false) return null;
    } else {
      await store.delete(DRAIN_LOCK_KEY);
      const again = await store.setJSON(DRAIN_LOCK_KEY, lease, { onlyIfNew: true });
      if (again && again.modified === false) return null;
    }
    return await confirmLease(store, lease);
  } catch (err) {
    console.error("Lofty queue drain: could not take the lease (skipping this run):", err && err.message);
    return null;
  }
}

// Releases this drain's own lease only: one another drain took over is left alone.
async function releaseDrainLease(store, lease) {
  try {
    if (typeof store.delete !== "function") return;
    // Unreadable: left to expire rather than risk deleting another drain's lease.
    const now = await store.get(DRAIN_LOCK_KEY, { type: "json" });
    if (now && (!lease || now.token !== lease.token)) return;
    await store.delete(DRAIN_LOCK_KEY);
  } catch (err) {
    // Expires on its own after DRAIN_LOCK_TTL_MS.
  }
}

// opts.deadline (epoch ms, optional): no replay starts, and none runs, past it --
// so a caller with a hard time limit finishes and writes the queue back.
// 2026-10-07: an off switch for the queue replay that does not mean taking the
// Lofty key away from the whole site. LOFTY_QUEUE_DRAIN=off (also false, 0, no,
// pause, paused) stops every replay: this site's scheduled drain (each site's
// lofty-queue-drain.js is the only caller; Signature's 30-minute sync stopped
// draining on 2026-10-04). Unset, or any other value, leaves it running exactly
// as before. The queue itself is left untouched, so turning it back on replays
// what waited.
function queueDrainOff() {
  return /^(off|false|0|no|pause|paused)$/i.test(String(process.env.LOFTY_QUEUE_DRAIN || "").trim());
}

async function drainFailedPushes(store, apiKey, opts) {
  if (!apiKey) return { attempted: 0, recovered: 0 };
  if (queueDrainOff()) return { attempted: 0, recovered: 0, paused: true };
  const peek = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
  if (!peek.length) return { attempted: 0, recovered: 0 };
  const lease = await takeDrainLease(store);
  if (!lease) return { attempted: 0, recovered: 0, locked: true };
  try {
    return await drainWithLease(store, apiKey, opts || {});
  } finally {
    await releaseDrainLease(store, lease);
  }
}

async function drainWithLease(store, apiKey, opts) {
  const deadline = opts.deadline || Infinity;
  // Read again under the lease: another drain may have finished in between.
  const queue = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
  if (!queue.length) return { attempted: 0, recovered: 0 };

  const remaining = [];
  const viaHub = loftyViaHub();
  let attempted = 0;
  let recovered = 0;
  let deferred = 0;
  let finished = 0;
  let consentHeld = 0;
  let heldForReview = 0;
  let leftForHub = 0;
  let i = 0;
  try {
    for (; i < queue.length; i++) {
      const entry = queue[i];
      if (!entry) continue;
      // 2026-10-04: an entry an earlier drain flagged for review used to stay here,
      // taking one of the 25 queue slots for ever. It moves to the held-lead record
      // (and stays here only if that record could not be written).
      if (entry.manualReview) {
        const moved = await holdForManualReview(store, { ...entry, reason: entry.reason || entry.heldReason || "identity needs manual review" });
        if (moved) heldForReview += 1; else remaining.push(entry);
        continue;
      }
      // 2026-10-17: a lead the OTHER site queued through the hub (its LOFTY_VIA_HUB
      // is on) is never replayed with this site's own key; its own drain sends it
      // through the hub. One this site queued through the hub before its switch was
      // turned off again is replayed here as before (that is the rollback).
      if (!viaHub && entry.viaHub === true && entry.site && entry.site !== BRAND_SITE) {
        leftForHub += 1;
        remaining.push(entry);
        continue;
      }
      // 2026-10-05: Lofty accepted this lead on a run that ran out of time before
      // its follow-up steps (finishReplay). Only the steps still owed run: no
      // lookup, no create, no second note.
      if (entry.loftyId) {
        if (deadline - Date.now() < FOLLOWUP_MIN_MS) { remaining.push(entry); continue; }
        const replay = entry.replay || {};
        const kept = await finishReplay(entry, entry.lead || {}, {
          identity: replay.identity || {}, newId: replay.newId || null, steps: replay.steps,
          pending: Array.isArray(entry.followupsPending) ? entry.followupsPending : [],
          target: entry.loftyId, apiKey, store, deadline,
        });
        if (kept) { deferred += 1; remaining.push(kept); } else finished += 1;
        continue;
      }
      if (!entry.lead || attempted >= MAX_DRAIN_PER_RUN || deadline - Date.now() < MIN_RETRY_MS) {
        remaining.push(entry);
        continue;
      }
      attempted += 1;
      if (viaHub) {
        const r = await replayViaHub(entry, { apiKey, store, deadline });
        recovered += r.recovered || 0;
        deferred += r.deferred || 0;
        consentHeld += r.consentHeld || 0;
        heldForReview += r.heldForReview || 0;
        if (r.keep) remaining.push(r.keep);
        continue;
      }
      // 2026-09-29: a replay never REPLACES tags. By the time it runs the contact
      // may exist -- a create that timed out on our side can still have landed in
      // Lofty -- and `tags` would wipe anything added since. `tagsAdd` only adds.
      const lead = { ...entry.lead };
      const email = lead.email || (Array.isArray(lead.emails) && lead.emails[0]);
      const identity = await findExistingLead(email, consentPhoneOf(lead), apiKey,
        { budgetMs: Math.max(1, Math.min(2000, deadline - Date.now())) });
      if (identity.manualReview) {
        // Held, not retried (holdForManualReview above). Kept in this queue only
        // if the held-lead record could not be written, so it is never lost.
        const flagged = { ...entry, manualReview: true, heldReason: identity.error, reason: identity.error };
        if (await holdForManualReview(store, flagged)) heldForReview += 1; else remaining.push(flagged);
        console.warn("Queued Lofty lead held: identity needs manual review.");
        continue;
      }
      if (Array.isArray(lead.tags)) {
        lead.tagsAdd = [...new Set([...(lead.tagsAdd || []), ...lead.tags])];
        delete lead.tags;
      }
      // 2026-10-06: the form's nurture plan, decided again on THIS lookup. The lead
      // type rides on the create only for a contact this lookup proves new (a
      // contact found -- or a lookup that couldn't answer -- keeps its own type,
      // as on the live path); the plan tag never rides on the create (Lofty does
      // not fire a "Tag Changed" plan for it) and is added after it, in finishReplay.
      const planned = planOf(entry);
      delete lead.leadTypes;
      if (planned.leadTypes.length && identity.ok && !identity.anyMatch) lead.leadTypes = planned.leadTypes.slice();
      if (Array.isArray(lead.tagsAdd) && planned.planTags.length) {
        lead.tagsAdd = lead.tagsAdd.filter((t) => !planned.planTags.includes(t));
      }
      const result = await postLead(lead, apiKey, { deadline });
      if (result.ok) {
        recovered += 1;
        console.log(`Recovered a queued Lofty lead from "${entry.formName}" (${result.payloadShape} shape).`);
        const newId = leadIdFromResponse(result.responseBody);
        // The surviving contact: the one the lookup found, else the create's id.
        const target = identity.leadId || newId;
        // A create can merge into an already-textable contact. Check no-yes
        // submissions too, so an unconsented new number turns texting off.
        {
          const consent = await applyTextingPreference(target, consentPhoneOf(entry.lead), entry.smsConsent === true, apiKey, { deadline });
          if (entry.smsConsent === true && !consent.textingEnabled) {
            consentHeld += 1;
            console.warn(`Queued Lofty lead from "${entry.formName}": texting not turned on -- ${consent.textingNotEnabled || consent.reason || consent.error || "not applied"}.`);
          }
        }
        // 2026-10-03: finish what the live form path does after a create, so a
        // lead that needed a retry is not a lesser lead. Each step is best-effort
        // and stops at the deadline; none can undo the recovery above. What the
        // budget cannot start goes back on the entry for the next run.
        const kept = await finishReplay(entry, lead, { identity, newId, target, apiKey, store, deadline, accepted: result });
        if (kept) { deferred += 1; remaining.push(kept); }
      } else {
        remaining.push({ ...entry, lastRetryAt: new Date().toISOString(), ...result });
      }
    }
  } finally {
    // Written back whatever happened above, so a throw mid-run cannot put a lead
    // Lofty already accepted in front of the next run. Entries this run never
    // reached stay as they were (queue.slice(i) is empty once the loop is done),
    // and anything a form queued while this ran (recordPush puts it first) is kept.
    const entryKey = (e) => `${e && e.at}|${e && e.formName}`;
    const taken = new Set(queue.map(entryKey));
    const latest = (await store.get(FAILED_PUSH_KEY, { type: "json" }).catch(() => null)) || [];
    const arrived = (Array.isArray(latest) ? latest : []).filter((e) => e && !taken.has(entryKey(e)));
    await store.setJSON(FAILED_PUSH_KEY, arrived.concat(remaining, queue.slice(i).filter(Boolean)).slice(0, MAX_QUEUED_FAILURES)).catch(() => {});
    if (attempted || deferred || finished) {
      await store.setJSON(LAST_PUSH_KEY, {
        at: new Date().toISOString(),
        formName: "(queued retry)",
        ok: recovered > 0 || !attempted,
        httpStatus: recovered > 0 || !attempted ? 200 : "retry failed",
        responseBody: `${recovered} of ${attempted} queued lead(s) recovered; ${remaining.length} still queued.` +
          (deferred ? ` ${deferred} accepted by Lofty with follow-up steps left for the next run.` : "") +
          (finished ? ` ${finished} finished the follow-up steps an earlier run ran out of time for.` : "") +
          (heldForReview ? ` ${heldForReview} held for identity review (see /status).` : "") +
          (consentHeld ? ` Texting left off on ${consentHeld} that said yes to texts (see the function log).` : "") +
          (leftForHub ? ` ${leftForHub} queued through the hub by the other site, left for its own drain.` : ""),
        payloadShape: viaHub ? "queued retry (hub)" : "queued retry",
      }).catch(() => {});
    }
  }
  return {
    attempted, recovered, stillQueued: remaining.length,
    ...(deferred ? { deferred } : {}), ...(finished ? { finished } : {}),
    ...(heldForReview ? { heldForReview } : {}), ...(consentHeld ? { consentHeld } : {}),
    ...(leftForHub ? { leftForHub } : {}), ...(viaHub ? { viaHub: true } : {}),
  };
}

// One queued lead replayed through the hub (LOFTY_VIA_HUB=on): the same push the
// live form path makes (lib/_lofty-hub.js), then the same follow-up steps
// (finishReplay), with what the hub answered standing in for this site's own
// lookup. Never this site's own key for the lead, its tags or its note. Returns
// what to count, and the entry to keep in the queue (keep) when it stays.
async function replayViaHub(entry, ctx) {
  const { apiKey, store, deadline } = ctx;
  const lead = { ...entry.lead };
  if (Array.isArray(lead.tags)) {
    lead.tagsAdd = [...new Set([...(lead.tagsAdd || []), ...lead.tags])];
    delete lead.tags;
  }
  const planned = planOf(entry);
  if (Array.isArray(lead.tagsAdd) && planned.planTags.length) {
    lead.tagsAdd = lead.tagsAdd.filter((t) => !planned.planTags.includes(t));
  }
  // The hub sends a lead type on a create only, so the plan's type rides on every
  // replay: a contact the hub finds keeps its own.
  delete lead.leadTypes;
  if (planned.leadTypes.length) lead.leadTypes = planned.leadTypes.slice();
  // An earlier hub attempt for this entry that got as far as making the contact.
  const prior = entry.hub && entry.hub.leadId ? entry.hub : null;
  // 2026-10-24: the same push the live form path makes, every option included: the
  // form's tags in the create body except the trigger tag (it goes on after the
  // create, so its plan starts), the home's address (on the queued body), the
  // website fields and the search wishes (the hub writes them only on a contact
  // this push created), and the yes to texts.
  const data = entry.formData || null;
  const label = String(lead.source || entry.formName || "website").replace("The Little Lady Sells Homes - ", "");
  const websiteFields = data ? websiteFieldValues(lead.source || label, data) : [];
  const inquiry = data ? inquiryFromForm(data) : null;
  const result = await postLead(lead, apiKey, { deadline, withoutNote: !!(prior && prior.noteAdded),
    triggerTag: REPLAY_TRIGGER_TAG, websiteFields, inquiry, smsYes: entry.smsConsent === true });
  if (!result.ok) {
    if (result.manualReview) {
      const flagged = { ...entry, ...result, manualReview: true, heldReason: result.reason, reason: result.reason };
      if (await holdForManualReview(store, flagged)) {
        console.warn(`Queued Lofty lead from "${entry.formName}" held by the hub: ${result.reason}.`);
        return { heldForReview: 1 };
      }
      return { keep: flagged };
    }
    return { keep: { ...entry, lastRetryAt: new Date().toISOString(), ...result, hub: result.hub || entry.hub } };
  }
  const h = result.hub;
  console.log(`Recovered a queued Lofty lead from "${entry.formName}" through the hub (${h.status}).`);
  const createdBefore = !!(prior && prior.created && !prior.merged && prior.leadId === h.leadId);
  if (createdBefore) confirmCreated(h.leadId);
  const newId = (h.created && !h.merged) || createdBefore ? h.leadId : null;
  const identity = { ok: true, anyMatch: !newId, leadId: newId ? null : h.leadId, via: "hub" };
  // The push carried the note (or an earlier attempt did), and on a contact the
  // hub created it added the tags after the create, so neither step runs again.
  const steps = { note: { attempted: true, ok: !!(h.noteAdded || (prior && prior.noteAdded)), viaHub: true, step: "with-push" } };
  if (newId) steps.tag = { attempted: false, ok: true, tagRestored: true, viaHub: true, step: "hub-tags-after-create" };
  // The website fields and the search wishes rode on the push: never this site's own key for them.
  if (websiteFields.length) steps.fields = hubExtraResult("fields", h, websiteFields);
  if (inquiry) steps.inquiry = hubExtraResult("inquiry", h, inquiry);
  let consentHeld = 0;
  const consent = await applyTextingPreference(h.leadId, consentPhoneOf(entry.lead), entry.smsConsent === true, apiKey, { deadline });
  if (entry.smsConsent === true && !consent.textingEnabled) consentHeld = 1;
  const kept = await finishReplay(entry, lead, { identity, newId, target: h.leadId, apiKey, store, deadline, accepted: result, steps });
  return { recovered: 1, consentHeld, ...(kept ? { deferred: 1, keep: kept } : {}) };
}

// The steps submission-created.js runs after a successful create, for a
// replayed lead: the note on the surviving contact, the trigger-tag re-add on
// a brand-new contact (so the Smart Plan fires), the form's nurture-plan tag on
// a contact proven new (2026-10-06, when the entry carries a plan), a Call task
// + push for a returning contact, and -- only for a contact proven new -- the
// website fields and inquiry, when the queued entry carried the form data.
//
// In this order, each only with FOLLOWUP_MIN_MS left and every call capped at
// the deadline. The first step the budget cannot start ends the run: it and
// the later steps still owed go back on the queue entry as followupsPending,
// with the accepted contact (loftyId) and what this run learned (replay), and
// the next run calls this again for those alone -- never a second create,
// lookup or note. Returns that entry, or null when nothing is owed.
const FOLLOWUP_STEPS = ["note", "tag", "planTags", "returning", "fields", "inquiry"];

async function finishReplay(entry, lead, ctx) {
  const { identity, newId, target, apiKey, store, deadline } = ctx;
  const o = { deadline };
  const steps = { ...(ctx.steps || {}) };
  const owed = Array.isArray(ctx.pending) ? ctx.pending : FOLLOWUP_STEPS;
  const data = entry.formData || null;
  const label = String(lead.source || entry.formName || "website").replace("The Little Lady Sells Homes - ", "");
  const newContact = !!(identity.ok && !identity.anyMatch && newId);
  const provenNew = () => newContact && !!(steps.note && steps.note.ok);
  // `owed`: what the step needs at all. `skip`: decided when its turn comes,
  // from the note's outcome (kept on the entry between runs). `run`: the calls.
  const plan = {
    note: { owed: () => !!(target && lead.notes),
      run: () => addLoftyNote(target, lead.notes, apiKey, o) },
    tag: { owed: () => !!(newId && !identity.leadId), skip: () => !!(steps.note && steps.note.leadMissing),
      run: () => refireLoftyTag(newId, REPLAY_TRIGGER_TAG, apiKey, o) },
    // Same rule as the live path: only a contact proven new (this lookup found
    // nobody and the create's own id took the note) gets its plan tag.
    planTags: { owed: () => !!(newContact && planOf(entry).planTags.length), skip: () => !provenNew(),
      run: async () => {
        // `person`: who the lead is, for the hub path (it finds a lead by email or
        // phone); today's path reads only the deadline from these options.
        const r = await addPlanTags(newId, planOf(entry).planTags, apiKey, { ...o, person: lead });
        console.log(`Queued Lofty lead from "${entry.formName}": nurture plan tag ` +
          (r.ok ? `${r.added && r.added.length ? `added (${r.added.join(", ")})` : "already on the lead"}`
            : `NOT added (${r.step || r.error || "failed"})`) + ` on lead ${newId}.`);
        return r;
      } },
    returning: { owed: () => !!identity.leadId,
      run: () => alertReturningLead(identity.leadId, {
        label: `${label} (queued retry)`,
        name: data ? data.name : [lead.firstName, lead.lastName].filter(Boolean).join(" "),
        phone: data ? data.phone : consentPhoneOf(lead),
        email: data ? data.email : (lead.email || (Array.isArray(lead.emails) && lead.emails[0])),
      }, apiKey, o) },
    fields: { owed: () => !!(newContact && data && store), skip: () => !provenNew(),
      run: async () => {
        const ensured = await ensureWebsiteFields(store, apiKey, o);
        if (!ensured.ok) return { attempted: false, reason: "website fields not ensured", ...ensured };
        return setWebsiteFields(newId, websiteFieldValues(lead.source || label, data), apiKey, o);
      } },
    inquiry: { owed: () => !!(newContact && data && store && inquiryFromForm(data)), skip: () => !provenNew(),
      run: () => placeInquiry(newId, inquiryFromForm(data), apiKey, o) },
  };
  const pending = [];
  try {
    for (const name of FOLLOWUP_STEPS) {
      if (!owed.includes(name) || name in steps || !plan[name].owed()) continue;
      if (pending.length || deadline - Date.now() < FOLLOWUP_MIN_MS) { pending.push(name); continue; }
      if (plan[name].skip && plan[name].skip()) continue;
      steps[name] = await plan[name].run();
    }
  } catch (err) {
    console.error(`Queued Lofty lead from "${entry.formName}": a follow-up step failed:`, err && err.message);
  }
  if (!pending.length) return null;
  console.warn(`Queued Lofty lead from "${entry.formName}": accepted by Lofty; out of time for ${pending.join(", ")} (finished next run).`);
  return {
    ...entry, lastRetryAt: new Date().toISOString(), ...(ctx.accepted || {}),
    loftyId: target, followupsPending: pending,
    replay: { newId: newId || null, identity, steps },
  };
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
  FOLLOWUP_MIN_MS,
  FOLLOWUP_STEPS,
  LAST_PUSH_KEY,
  FAILED_PUSH_KEY,
  DRAIN_LOCK_KEY,
  MANUAL_REVIEW_KEY,
  MAX_HELD_FOR_REVIEW,
  minimalLead,
  postLead,
  recordPush,
  holdForManualReview,
  drainFailedPushes,
  queueDrainOff,
  REPLAY_TRIGGER_TAG,
  DRAIN_LOCK_TTL_MS,
  takeDrainLease,
  releaseDrainLease,
};
