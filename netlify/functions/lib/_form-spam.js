// How many form submissions Netlify marked as spam (2026-11-03, Christine: "do all 3").
//
// Netlify keeps a submission it judges spam (a filled hidden spam-trap field, or its own
// filter) in the form's Spam tab and never hands it to submission-created.js. A real
// person whose browser auto-filled the hidden field is lost without a trace: no Lofty
// lead, no alert. This counts those submissions, per form, for the last 7 days, so the
// /status page can say "N caught as spam: check the Spam tab".
//
// COUNTS ONLY. Netlify's answer carries the person's name, email, phone and message;
// none of it is kept, logged or returned. Only the form's name, how many, and when the
// newest came in.
//
// Netlify's REST API with the site's own Personal Access Token (NETLIFY_FORMS_TOKEN,
// else BLOBS_TOKEN, which both sites already hold for Blobs; never logged, only in the
// Authorization header, redirects refused):
//   GET /api/v1/sites/{site_id}/forms
//   GET /api/v1/forms/{form_id}/submissions?state=spam&per_page=100
// FAIL CLOSED. If Netlify ever ignored state=spam it would answer the form's REAL
// submissions, and this would call real leads spam. So for every form with any answer,
// the same form's verified submissions are read too, and if one id is in both lists
// the count is refused ("Netlify did not keep spam apart"). Any failed, refused or
// unreadable answer makes the result incomplete, never a zero.
//
// Shared byte for byte by thelittleladysellshomes and signature-property-collection
// (tests/test-form-spam.js on both).
"use strict";

const API = "https://api.netlify.com/api/v1";
const SPAM_DAYS = 7;
const PER_PAGE = 100;
const MAX_PAGES = 5;
const REQUEST_MS = 4000;
const BUDGET_MS = 9000;
const CONCURRENCY = 8;

function spamKey(siteId) {
  return `form-spam-count-${String(siteId || "unknown").replace(/[^A-Za-z0-9-]/g, "")}.json`;
}

function formsToken(env) {
  const e = env || process.env;
  const t = String(e.NETLIFY_FORMS_TOKEN || e.BLOBS_TOKEN || "").trim();
  return t || null;
}

async function getJson(fetchImpl, url, token, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return { ok: false, why: "out of time" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(REQUEST_MS, left));
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!res || !res.ok) return { ok: false, why: `HTTP ${res ? res.status : "no answer"}` };
    const body = await res.json().catch(() => undefined);
    if (body === undefined) return { ok: false, why: "unreadable answer" };
    return { ok: true, body };
  } catch (err) {
    return { ok: false, why: err && err.name === "AbortError" ? "timeout" : "no answer" };
  } finally {
    clearTimeout(timer);
  }
}

function timeOf(s) {
  const t = Date.parse(s && s.created_at);
  return Number.isFinite(t) ? t : null;
}

// Every submission of one form in one state since `since`, newest first, at most MAX_PAGES pages.
async function readState(fetchImpl, token, formId, state, since, deadline) {
  const ids = new Set();
  const times = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${API}/forms/${encodeURIComponent(formId)}/submissions?state=${state}&per_page=${PER_PAGE}&page=${page}`;
    const r = await getJson(fetchImpl, url, token, deadline);
    if (!r.ok) return { ok: false, why: r.why };
    if (!Array.isArray(r.body)) return { ok: false, why: "unreadable answer" };
    let older = false;
    for (const s of r.body) {
      const t = timeOf(s);
      if (t === null) return { ok: false, why: "a submission with no date" };
      if (t < since) { older = true; continue; }
      if (s && s.id != null) ids.add(String(s.id));
      times.push(t);
    }
    if (older || r.body.length < PER_PAGE) return { ok: true, ids, times };
  }
  return { ok: false, why: `more than ${MAX_PAGES * PER_PAGE} in ${SPAM_DAYS} days` };
}

async function countForm(fetchImpl, token, form, since, deadline) {
  const spam = await readState(fetchImpl, token, form.id, "spam", since, deadline);
  if (!spam.ok) return { name: form.name, ok: false, why: spam.why };
  if (spam.times.length === 0) return { name: form.name, ok: true, count: 0, latestAt: null };
  const verified = await readState(fetchImpl, token, form.id, "verified", since, deadline);
  if (!verified.ok) return { name: form.name, ok: false, why: `verified list: ${verified.why}` };
  for (const id of spam.ids) {
    if (verified.ids.has(id)) return { name: form.name, ok: false, why: "Netlify did not keep spam apart" };
  }
  return {
    name: form.name, ok: true, count: spam.times.length,
    latestAt: new Date(Math.max(...spam.times)).toISOString(),
  };
}

async function countSpam({ token, siteId, fetchImpl = fetch, now = Date.now(), budgetMs = BUDGET_MS } = {}) {
  const at = new Date(now).toISOString();
  const base = { at, days: SPAM_DAYS, siteId: siteId || null };
  if (!token) return { ...base, complete: false, problem: "NETLIFY_FORMS_TOKEN / BLOBS_TOKEN is not set" };
  if (!siteId) return { ...base, complete: false, problem: "the site id is not known" };
  const deadline = Date.now() + budgetMs;
  const since = now - SPAM_DAYS * 24 * 3600 * 1000;
  const list = await getJson(fetchImpl, `${API}/sites/${encodeURIComponent(siteId)}/forms`, token, deadline);
  if (!list.ok) return { ...base, complete: false, problem: `the form list: ${list.why}` };
  if (!Array.isArray(list.body)) return { ...base, complete: false, problem: "the form list: unreadable answer" };
  const forms = list.body
    .filter((f) => f && f.id != null && typeof f.name === "string")
    .map((f) => ({ id: String(f.id), name: f.name }));
  const results = [];
  let next = 0;
  async function worker() {
    while (next < forms.length) {
      const f = forms[next];
      next += 1;
      results.push(await countForm(fetchImpl, token, f, since, deadline));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, forms.length) }, worker));
  const failed = results.filter((r) => !r.ok);
  const byForm = results.filter((r) => r.ok && r.count > 0)
    .map((r) => ({ name: r.name, count: r.count, latestAt: r.latestAt }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    ...base,
    complete: failed.length === 0,
    formsTotal: forms.length,
    formsRead: results.length - failed.length,
    total: byForm.reduce((n, r) => n + r.count, 0),
    byForm,
    problem: failed.length
      ? `${failed.length} of ${forms.length} form(s) not read (${[...new Set(failed.map((r) => r.why))].join("; ")})`
      : null,
  };
}

// One scheduled run: count, then save the record where /status reads it (2026-11-04).
//
// The thelittleladysellshomes copy answered HTTP 500 on every scheduled run from Nov 3
// (00:25, 06:25, 12:25 UTC, three tries each, 0.1-0.7 s, no Netlify API call behind
// it), while Signature's answered 200. The Blobs store could not be opened: getStore()
// threw "The environment has not been configured to use Netlify Blobs" because that
// site's functions do not get BLOBS_SITE_ID + BLOBS_TOKEN, and a Lambda-style
// scheduled function gets no Blobs context unless it calls connectLambda(event). The
// throw happened after the count, so the count (incomplete for want of a token, or
// complete) was lost and the run said only "failed".
//
// Now: the store is the one getBlobStore() opens (BLOBS_SITE_ID + BLOBS_TOKEN, exactly
// what /status reads), else this site's own store through the Blobs context Netlify
// sends with the run (connectLambda); the count and the save each fail on their own;
// every run answers JSON with what happened (complete, saved, the problem), 200 only
// when the count is complete AND saved, else 503. Never a bare 500. The problem text is
// this file's own words and an error's NAME only (no Netlify text, no token).
function openSpamStore(event, { getStore, getBlobStore, connectLambda } = {}) {
  const tries = [];
  try {
    return { store: getBlobStore(getStore), via: "settings", why: null };
  } catch (err) {
    tries.push(`BLOBS_SITE_ID + BLOBS_TOKEN: ${(err && err.name) || "error"}`);
  }
  if (event && event.blobs && typeof connectLambda === "function") {
    try {
      connectLambda(event);
      return { store: getBlobStore(getStore), via: "netlify", why: null };
    } catch (err) {
      tries.push(`Netlify's run context: ${(err && err.name) || "error"}`);
    }
  } else {
    tries.push("Netlify sent no Blobs context with the run");
  }
  return { store: null, via: null, why: `the Blobs store could not be opened (${tries.join("; ")})` };
}

async function runSpamCount({ event, siteId, token, deps = {}, now = Date.now(), log = console } = {}) {
  let record;
  try {
    record = await countSpam({ token, siteId, now, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  } catch (err) {
    record = { at: new Date(now).toISOString(), days: SPAM_DAYS, siteId: siteId || null, complete: false,
      problem: `the count stopped (${(err && err.name) || "error"})` };
  }
  const opened = openSpamStore(event, deps);
  let saved = false;
  let saveProblem = opened.why;
  if (opened.store) {
    try {
      await opened.store.setJSON(spamKey(siteId), record);
      saved = true;
    } catch (err) {
      saveProblem = `the count could not be saved (${(err && err.name) || "error"})`;
    }
  }
  const problem = [record.complete ? null : record.problem, saved ? null : saveProblem].filter(Boolean).join("; ") || null;
  const line = `form-spam-count: ${record.complete
    ? `${record.total} in ${record.days} days, ${record.formsRead} form(s) read`
    : `could not count: ${record.problem}`}; ${saved ? `saved (${opened.via})` : `NOT saved: ${saveProblem}`}`;
  (record.complete && saved ? log.log : log.error).call(log, line);
  return {
    statusCode: record.complete && saved ? 200 : 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ complete: !!record.complete, total: record.complete ? record.total : null, saved, problem }),
  };
}

// The /status row. Optional: a spam count is never the site failing.
function spamRow(record, { now = Date.now(), formsUrl } = {}) {
  const where = formsUrl ? ` Netlify's form pages: ${formsUrl} (each form's Spam tab).` : "";
  if (!record) {
    return {
      name: "Form submissions Netlify marked as spam", ok: true, optional: true,
      detail: "Not counted yet: the count runs every 6 hours (form-spam-count) and needs BLOBS_TOKEN or NETLIFY_FORMS_TOKEN.",
    };
  }
  const ageH = Math.round((now - Date.parse(record.at)) / 3600000);
  const old = !Number.isFinite(ageH) || ageH > 13;
  const age = Number.isFinite(ageH) ? ` Counted ${ageH} hour(s) ago.` : "";
  if (!record.complete) {
    return {
      name: "Form submissions Netlify marked as spam", ok: false, optional: true,
      detail: `Could not count: ${record.problem || "unknown"}.${age}${where}`,
    };
  }
  if (!record.total) {
    return {
      name: "Form submissions Netlify marked as spam", ok: !old, optional: true,
      detail: `None in the last ${record.days} days (${record.formsRead} form(s) read).${age}` +
        (old ? " This count is old: the scheduled count may have stopped." : ""),
    };
  }
  return {
    name: "Form submissions Netlify marked as spam", ok: false, optional: true,
    detail: `${record.total} submission(s) in the last ${record.days} days: ` +
      record.byForm.map((f) => `${f.name} ${f.count} (newest ${f.latestAt})`).join(", ") +
      ". Netlify never passed these to Lofty. Most are bots, but a real person whose browser filled the hidden " +
      `spam field lands here too: open the Spam tab and add anyone real to Lofty by hand.${age}${where}`,
  };
}

module.exports = { countSpam, spamRow, spamKey, formsToken, openSpamStore, runSpamCount, SPAM_DAYS };
