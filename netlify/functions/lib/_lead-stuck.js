// Telling Christine when a website lead is stuck in the Lofty retry queue.
//
// 2026-10-31. A Contact form lead came in at 6:00 AM while Lofty was refusing the
// old API key. submission-created.js queued it (lofty-failed-pushes.json in the
// "mls-listings" Blobs store) and lofty-queue-drain.js retries the queue every 30
// minutes -- but nothing told her when a lead STAYED there. Christine: "do them all".
//
// OFF unless LEAD_STUCK_ALERT is exactly "on" (spaces around it are ignored). With
// it on, after every scheduled drain run (each site's lofty-queue-drain.js):
//   - a queued lead older than LEAD_STUCK_ALERT_MINUTES (default 60) that Lofty
//     has still not accepted gets ONE email to her, through the same hub path and
//     to the same people as the new-lead alert (lib/_notify.js sendInternalAlert:
//     kind "alert", LEAD_ALERT_TO, else her own inbox). Which leads were alerted is
//     kept in the same Blobs store (STUCK_ALERT_KEY), and each email carries its
//     own idempotency key at the hub, so it is never sent twice;
//   - a lead she was alerted about that later goes through gets one short
//     "now delivered" note. One that left the queue without the drain seeing Lofty
//     accept it (moved to the leads held for review, or the other site's drain
//     took it) gets a plain "no longer in the retry queue" note instead, never a
//     guess that it is in Lofty.
// The email says the form, when it came in, how many retries, the last answer code
// (HTTP status and the hub's status word only -- never Lofty's answer text, which
// can repeat what the person typed) and what to do. No name, email, phone, address
// or message from the form: the new-lead alert already carried those.
//
// Nothing here talks to Lofty, retries a lead, or changes the queue. It reads the
// queue and writes only its own record. It never throws: the drain's own result
// must never depend on it.
//
// Shared byte for byte by both sites (thelittleladysellshomes and
// signature-property-collection), like lib/_lofty.js; each site's tests check it.
"use strict";
const crypto = require("crypto");
const { FAILED_PUSH_KEY, queuedLeadKey } = require("./_lofty");
const { sendInternalAlert, BRAND_DOMAIN } = require("./_notify");

const STUCK_ALERT_KEY = "lofty-stuck-alerts.json";
const DEFAULT_MINUTES = 60;
// At most this many emails a run: the drain runs inside the scheduler's 15 s.
const MAX_EMAILS_PER_RUN = 3;
// An email starts only with this much of the run's time left.
const MIN_SEND_MS = 1500;
// Records of alerted leads are forgotten after this long (the lead is long gone).
const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 100;

function leadStuckAlertOn(env = process.env) {
  return String((env && env.LEAD_STUCK_ALERT) || "").trim() === "on";
}

// A whole number of minutes, 5 to 10080 (a week); anything else is the default.
function stuckMinutes(env = process.env) {
  const raw = String((env && env.LEAD_STUCK_ALERT_MINUTES) || "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MINUTES;
  const n = Number(raw);
  return n >= 5 && n <= 10080 ? n : DEFAULT_MINUTES;
}

// A queued lead Lofty has not accepted yet: not one the drain already got in with
// follow-up steps left (loftyId), not one waiting to move to the held-for-review list.
function isWaiting(e) {
  return !!(e && !e.loftyId && !e.manualReview);
}

function queuedAtMs(e) {
  const t = Date.parse(e && e.at);
  return Number.isFinite(t) ? t : null;
}

// The last answer, as a code only: "HTTP 401", "HTTP 0 (no_time)", ...
function answerCode(e) {
  if (!e) return "unknown";
  const word = (v) => String(v).replace(/[^A-Za-z0-9_ -]/g, "").slice(0, 40);
  const http = e.httpStatus === undefined || e.httpStatus === null || e.httpStatus === "" ? null : word(e.httpStatus);
  const hub = e.hubStatus ? word(e.hubStatus) : null;
  if (http && hub) return `HTTP ${http} (hub: ${hub})`;
  if (http) return /^\d+$/.test(http) ? (http === "0" ? "no answer (HTTP 0)" : `HTTP ${http}`) : http;
  if (hub) return `hub: ${hub}`;
  return "unknown";
}

// What the queue looks like right now. Pure: the status page reads it too.
function queueSummary(queue, nowMs, minutes) {
  const list = Array.isArray(queue) ? queue.filter(Boolean) : [];
  const waiting = list.filter(isWaiting);
  const limitMs = minutes * 60 * 1000;
  let oldestMs = null;
  for (const e of waiting) {
    const t = queuedAtMs(e);
    if (t !== null && (oldestMs === null || t < oldestMs)) oldestMs = t;
  }
  const stuck = waiting.filter((e) => {
    const t = queuedAtMs(e);
    return t !== null && nowMs - t >= limitMs;
  });
  return {
    total: list.length,
    waiting: waiting.length,
    acceptedStepsLeft: list.filter((e) => e.loftyId).length,
    oldestAt: oldestMs === null ? null : new Date(oldestMs).toISOString(),
    oldestMinutes: oldestMs === null ? null : Math.max(0, Math.floor((nowMs - oldestMs) / 60000)),
    stuck,
    minutes,
  };
}

// Mountain time, the way she reads it: "6:02 AM" today, "Oct 30, 6:02 AM" before.
function denverTime(ms, nowMs) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" });
  const day = (x) => new Date(x).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "short", day: "numeric" });
  return day(ms) === day(nowMs) ? time : `${day(ms)}, ${time}`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 32);
}

function formOf(e) {
  return String((e && e.formName) || "website form").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 60) || "website form";
}

function stuckEmail(e, nowMs) {
  const queued = queuedAtMs(e);
  const since = denverTime(queued, nowMs);
  const retries = Number.isFinite(Number(e.retries)) && Number(e.retries) > 0
    ? `${Number(e.retries)} (after the first try when the form came in)`
    : "none counted yet (the first try failed when the form came in)";
  const rows = [
    ["Form", formOf(e)],
    ["Came in", `${since} (Mountain time)`],
    ["Retries", retries],
    ["Last answer", answerCode(e)],
    ["Website", BRAND_DOMAIN],
  ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap">${k}</td>` +
    `<td style="padding:4px 0"><strong>${escapeHtml(v)}</strong></td></tr>`).join("");
  return {
    subject: `Website lead still not in Lofty (queued since ${since})`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#222;max-width:560px">
<p style="font-size:18px;margin:0 0 4px"><strong>A website lead is still waiting to get into Lofty</strong></p>
<table style="border-collapse:collapse;margin:8px 0 16px">${rows}</table>
<p style="margin:0 0 8px">The lead is safe: it is kept and tried again automatically every 30 minutes. It is also in the Netlify Forms inbox, and you got the new-lead email when it came in, with their name and how to reach them.</p>
<p style="margin:0 0 4px"><strong>What to do</strong></p>
<ul style="margin:0 0 8px;padding-left:20px">
<li>An answer of HTTP 401 or 403 means Lofty refused the key: check LOFTY_API_KEY in Netlify (or, if this site sends leads through the Seller Intelligence hub, the hub's Lofty key and this site's HUB_API_KEY), then redeploy.</li>
<li>Any other answer is usually Lofty or the hub having a bad moment; it normally clears on its own.</li>
<li>If it is urgent, add the person to Lofty by hand from the new-lead email.</li>
</ul>
<p style="margin:16px 0 0;font-size:12px;color:#888">Sent once for this lead by ${escapeHtml(BRAND_DOMAIN)}. You will get one short note when it goes through.</p>
</div>`,
  };
}

function resolvedEmail(rec, delivered, nowMs = Date.now()) {
  const since = rec.queuedAt && Number.isFinite(Date.parse(rec.queuedAt)) ? denverTime(Date.parse(rec.queuedAt), nowMs) : "earlier";
  const form = formOf({ formName: rec.formName });
  return {
    subject: delivered
      ? `Website lead now delivered to Lofty (queued since ${since})`
      : `Website lead no longer in the Lofty retry queue (queued since ${since})`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#222;max-width:560px">
<p style="margin:0 0 8px">${delivered
      ? `The ${escapeHtml(form)} lead from ${escapeHtml(since)} (Mountain time) is now in Lofty. Nothing to do.`
      : `The ${escapeHtml(form)} lead from ${escapeHtml(since)} (Mountain time) is no longer waiting in the retry queue, but this site did not see Lofty take it. It may have been held for your review (see the site's status page) or delivered by the other website's retry. Please check Lofty that it is there.`}</p>
<p style="margin:16px 0 0;font-size:12px;color:#888">Sent by ${escapeHtml(BRAND_DOMAIN)}.</p>
</div>`,
  };
}

async function readJson(store, key) {
  try { return await store.get(key, { type: "json" }); } catch (err) { return undefined; }
}

// Runs after a drain. opts: { deadline (epoch ms), now (epoch ms, tests),
// recoveredKeys (from drainFailedPushes' result) }. Returns counts and reasons only.
async function checkStuckLeads(store, opts = {}) {
  if (!leadStuckAlertOn()) return { enabled: false };
  const out = { enabled: true, stuck: 0, alerted: 0, delivered: 0, leftQueue: 0, notSent: 0 };
  try {
    const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
    const deadline = Number.isFinite(opts.deadline) ? opts.deadline : Infinity;
    const minutes = stuckMinutes();
    const queue = await readJson(store, FAILED_PUSH_KEY);
    if (queue === undefined) return { ...out, error: "the retry queue could not be read" };
    const state = await readJson(store, STUCK_ALERT_KEY);
    if (state === undefined) return { ...out, error: "the alert record could not be read" };
    const records = { ...((state && state.alerted) || {}) };
    const list = Array.isArray(queue) ? queue.filter(Boolean) : [];
    const byKey = new Map(list.map((e) => [queuedLeadKey(e), e]));
    const recovered = new Set(Array.isArray(opts.recoveredKeys) ? opts.recoveredKeys : []);
    const summary = queueSummary(list, nowMs, minutes);
    out.stuck = summary.stuck.length;
    let emails = 0;
    let changed = false;
    const timeLeft = () => deadline - Date.now();
    const send = async (msg, key) => {
      emails += 1;
      const r = await sendInternalAlert({ ...msg, idempotencyKey: key },
        { timeoutMs: Number.isFinite(timeLeft()) ? Math.max(500, timeLeft() - 500) : undefined });
      if (!r.ok) {
        out.notSent += 1;
        out.reason = r.reason || r.error || r.hubStatus || "not sent";
      }
      return r.ok;
    };
    const canSend = () => emails < MAX_EMAILS_PER_RUN && timeLeft() >= MIN_SEND_MS;

    // 1. Leads alerted earlier that are no longer waiting: one short note each.
    for (const [key, rec] of Object.entries(records)) {
      if (!rec || rec.resolvedAt) continue;
      const e = byKey.get(key);
      if (e && isWaiting(e)) continue;
      // Delivered only when this drain saw Lofty accept it (or the entry now
      // carries the accepted contact). Anything else is said plainly, never guessed.
      const delivered = !!rec.deliveredSeen || recovered.has(key) || !!(e && e.loftyId);
      if (!canSend()) {
        // Remembered, so a note sent on a later run still says "delivered".
        if (delivered && !rec.deliveredSeen) { records[key] = { ...rec, deliveredSeen: true }; changed = true; }
        continue;
      }
      const ok = await send(resolvedEmail(rec, delivered, nowMs), `lead-stuck-done:${hashKey(key)}`);
      if (ok) {
        records[key] = { ...rec, resolvedAt: new Date(nowMs).toISOString(), delivered };
        changed = true;
        if (delivered) out.delivered += 1; else out.leftQueue += 1;
      } else if (delivered && !rec.deliveredSeen) {
        records[key] = { ...rec, deliveredSeen: true };
        changed = true;
      }
    }

    // 2. Leads stuck past the limit and not alerted yet: one email each, oldest first.
    const fresh = summary.stuck
      .filter((e) => !records[queuedLeadKey(e)])
      .sort((a, b) => queuedAtMs(a) - queuedAtMs(b));
    for (const e of fresh) {
      if (!canSend()) break;
      const key = queuedLeadKey(e);
      const ok = await send(stuckEmail(e, nowMs), `lead-stuck:${hashKey(key)}`);
      if (ok) {
        records[key] = { alertedAt: new Date(nowMs).toISOString(), queuedAt: e.at || null, formName: formOf(e) };
        changed = true;
        out.alerted += 1;
      }
    }

    // Forget old records; keep the newest MAX_RECORDS.
    const keep = Object.entries(records)
      .filter(([, r]) => r && nowMs - Date.parse(r.resolvedAt || r.alertedAt) < FORGET_AFTER_MS)
      .sort((a, b) => Date.parse(b[1].alertedAt) - Date.parse(a[1].alertedAt))
      .slice(0, MAX_RECORDS);
    if (keep.length !== Object.keys(records).length) changed = true;
    // Why an email could not go out (a setting's name, never its value), for /status:
    // with LOFTY_VIA_HUB on, a missing HUB_API_URL / HUB_API_KEY stops the Lofty push,
    // the new-lead alert AND this email, so the status page is then the only place
    // that says so. Cleared by the next run that sends what it needed to.
    const problem = out.notSent ? { at: new Date(nowMs).toISOString(), reason: String(out.reason || "not sent").slice(0, 160) } : null;
    const hadProblem = !!(state && state.lastProblem);
    if (changed || problem || hadProblem) {
      await store.setJSON(STUCK_ALERT_KEY, { updatedAt: new Date(nowMs).toISOString(),
        alerted: Object.fromEntries(keep), ...(problem ? { lastProblem: problem } : {}) });
    }
    out.waitingToAlert = fresh.length - out.alerted;
    return out;
  } catch (err) {
    return { ...out, error: String((err && err.message) || err).slice(0, 200) };
  }
}

module.exports = {
  STUCK_ALERT_KEY,
  DEFAULT_MINUTES,
  MAX_EMAILS_PER_RUN,
  leadStuckAlertOn,
  stuckMinutes,
  isWaiting,
  answerCode,
  queueSummary,
  denverTime,
  stuckEmail,
  resolvedEmail,
  checkStuckLeads,
};
