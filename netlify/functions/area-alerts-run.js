// Scheduled runner for the saved-area alerts (see area-alerts.js).
//
// Every 6 hours: for each saved alert, find Active listings in its towns
// (matchesQuery -- the exact filter the site's own search uses, so an alert
// can never disagree with the search page), diff against the ids this alert
// has already seen, and email the new ones. First pass for a new alert seeds
// knownIds and sends nothing -- subscribers get homes that appear AFTER they
// subscribed, not a dump of the backlog.
//
// Every email carries a one-click unsubscribe link (GET ?unsub=<id> on
// area-alerts.js). If the hub is not configured the runner logs and moves on
// without touching knownIds, so no listing is ever silently marked as seen
// but never sent.
//
// 2026-10-15 (Christine: one transactional sender, the Seller Intelligence
// hub). This runner no longer calls Resend. An area alert is an email to a lead,
// sent automatically with no one looking at it, so it may only go out as the
// hub's kind "lead" (one recipient, an unsubscribe link, at most one lead email
// per address per day across every app) AND only when someone has approved
// automatic lead email by name in AREA_ALERTS_APPROVED_BY. Nobody has: that is
// Christine's decision, not this code's. Until she makes it the runner HOLDS --
// it sends nothing, touches no alert, and logs AREA_ALERTS_HOLD_REASON.
const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");
const { getBlobStore, LISTINGS_KEY, SYNC_STATE_KEY, matchesQuery, LISTINGS_SOURCE } = require("./lib/_mls-shared");
const { idxGate } = require("./lib/_idx-display");
const { hubEndpoint, postToHub, readHubAnswer } = require("./lib/_notify");

const STORE_NAME = "area-alerts";
const AREA_ALERTS_HOLD_REASON = "area alerts need Christine's decision: automatic lead email";
const MAX_LISTINGS_PER_EMAIL = 10;
const SITE = "https://signaturepropertycollection.com";

function fmtPrice(p) {
  return typeof p === "number" ? "$" + p.toLocaleString() : "Price on request";
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function unsubscribeUrl(alert) {
  return `${SITE}/.netlify/functions/area-alerts?unsub=${encodeURIComponent(alert.id)}`;
}

// Who approved automatic area-alert emails (the hub's approved_by), or null.
// Unset -- as it is -- means nobody has, and nothing is sent.
function areaAlertApprover(env) {
  const v = String((env || process.env).AREA_ALERTS_APPROVED_BY || "").trim();
  return v && v.length <= 100 ? v : null;
}

// Once per alert and set of new homes: the hub sends a key once, so a run that
// is repeated (or overlaps) can never email the same homes twice. Hashes only:
// the alert id is built from the subscriber's address.
function areaAlertKey(alert, fresh) {
  const h = (v) => crypto.createHash("sha256").update(v).digest("hex").slice(0, 24);
  const ids = fresh.map((l) => String(l.listingId)).sort().join(",");
  return `area-alert:${h(String(alert.id))}:${h(ids)}`;
}

// Who sent it, on every alert: Colorado wants the brokerage on advertising,
// and Christine asked for her phone and site on everything. No street
// address (she does not publish one); ALERT_MAILING_ADDRESS, when set, adds
// the postal line CAN-SPAM asks of commercial email.
function footerHtml(alert) {
  const postal = String(process.env.ALERT_MAILING_ADDRESS || "").trim();
  return `<p style="color:#999;font-size:12px;margin-top:28px;line-height:1.5">` +
    `You asked for these alerts on my website.<br>` +
    `Christine Gwinnup · LPT Realty · <a href="tel:+13037094262" style="color:#999">303-709-4262</a> · ` +
    `<a href="${SITE}" style="color:#999">signaturepropertycollection.com</a><br>` +
    (postal ? `${esc(postal)}<br>` : "") +
    `Listing information from IRES MLS, deemed reliable but not guaranteed. Equal Housing Opportunity.<br>` +
    `<a href="${unsubscribeUrl(alert)}" ` +
    `style="color:#999">Unsubscribe</a></p>`;
}

function emailHtml(alert, listings) {
  const rows = listings.slice(0, MAX_LISTINGS_PER_EMAIL).map((l) =>
    `<p style="margin:0 0 14px"><a href="${SITE}/listing/${encodeURIComponent(l.listingId)}" ` +
    `style="color:#B86F7A;font-weight:bold;text-decoration:none">${fmtPrice(l.price)} — ` +
    `${esc(l.address)}, ${esc(l.city)}</a><br>` +
    `<span style="color:#555;font-size:13px">${l.beds ?? "?"} bd · ${l.baths ?? "?"} ba` +
    (l.sqft ? ` · ${Number(l.sqft).toLocaleString()} sqft` : "") + `</span>` +
    // IDX: the listing brokerage/agent per listing, same line as the listing pages.
    (l.agentName ? `<br><span style="color:#888;font-size:11px">Listing courtesy of ${esc(l.agentName)}` +
      `${l.officeName ? `, ${esc(l.officeName)}` : ""}.</span>` : "") +
    `</p>`
  ).join("");
  const more = listings.length > MAX_LISTINGS_PER_EMAIL
    ? `<p>…and ${listings.length - MAX_LISTINGS_PER_EMAIL} more.</p>` : "";
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px">
<h2 style="font-weight:normal">New in ${esc(alert.label)}</h2>
<p style="color:#555">Homes that just listed in the area you drew on my map
(${esc(alert.cities.join(", "))}):</p>
${rows}${more}
<p><a href="${SITE}/explore.html" style="color:#B86F7A">See them on the map</a></p>
${footerHtml(alert)}</div>`;
}

// Who may start a run (2026-10-18, endpoint audit security flag 10). A
// scheduled function cannot be called by URL -- Netlify only runs it on its
// schedule -- but since the schedule was removed (2026-10-13) this is an
// ordinary function anyone can call at /.netlify/functions/area-alerts-run.
// Today every run stops at the Lofty pause or the approver hold, but once
// AREA_ALERTS_APPROVED_BY is set an outsider could start runs at will. So a run
// now needs one of:
//   1. the header x-area-alerts-key = AREA_ALERTS_RUN_KEY, for a run started by
//      hand. Compared in constant time (SHA-256 of both sides, timingSafeEqual).
//      Unset, or shorter than 16 characters: 503, nobody can start a run.
//      Missing or wrong: 401. The key's value is never logged or answered.
//   2. Netlify's scheduled-run marker (a JSON body with next_run), and only
//      while RUNS_ON_SCHEDULE is true. The marker proves nothing by itself --
//      anyone can send that body to a public URL -- so it counts only while
//      netlify.toml schedules this function, which is exactly when Netlify
//      refuses URL calls to it. tests/test-area-alerts-run-auth.js fails when
//      this constant and netlify.toml disagree. False: there is no schedule.
// Same rules as the shared toolkit's checkKey (lib/suite-kit/auth.js), with
// Node's own crypto so it does not depend on the Node version's Web Crypto.
const RUN_KEY_HEADER = "x-area-alerts-key";
const MIN_RUN_KEY_LENGTH = 16;
const RUNS_ON_SCHEDULE = false;

function headerValue(event, name) {
  const headers = (event && event.headers) || {};
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function isScheduledRun(event) {
  if (!event || typeof event.body !== "string" || !event.body) return false;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const body = JSON.parse(raw);
    return !!body && typeof body === "object" && typeof body.next_run === "string";
  } catch (e) {
    return false;
  }
}

// null = may run; otherwise the answer to send (nothing else has been read).
// onSchedule is RUNS_ON_SCHEDULE; a parameter only so the test can try both.
function runRefusal(event, env, onSchedule = RUNS_ON_SCHEDULE) {
  if (onSchedule && isScheduledRun(event)) return null;
  const want = String(env.AREA_ALERTS_RUN_KEY || "").trim();
  if (want.length < MIN_RUN_KEY_LENGTH) {
    return { statusCode: 503, body: "AREA_ALERTS_RUN_KEY is not set on this site, so this run is off" };
  }
  const got = String(headerValue(event, RUN_KEY_HEADER) || "").trim();
  const digest = (v) => crypto.createHash("sha256").update(v, "utf8").digest();
  if (got && crypto.timingSafeEqual(digest(got), digest(want))) return null;
  return { statusCode: 401, body: "unauthorized" };
}

exports.emailHtml = emailHtml; // for tests
exports.AREA_ALERTS_HOLD_REASON = AREA_ALERTS_HOLD_REASON;
exports.areaAlertKey = areaAlertKey;
exports.RUN_KEY_HEADER = RUN_KEY_HEADER;
exports.RUNS_ON_SCHEDULE = RUNS_ON_SCHEDULE;
exports.runRefusal = runRefusal; // for tests

exports.handler = async (event) => {
  const refused = runRefusal(event, process.env);
  if (refused) {
    console.warn(`area-alerts-run: refused (${refused.statusCode}) — a run needs the ${RUN_KEY_HEADER} header. Nothing read or sent.`);
    return refused;
  }
  try {
    // 2026-09-28: IDX display kill switch + 12-hour freshness guard
    // (lib/_idx-display.js). An alert email is IDX display too, so when display
    // is off, or the listing copy is older than 12 hours (or its age cannot be
    // read), NOTHING is sent and no alert is touched -- not even a first-pass
    // seed -- so each alert resumes exactly where it stopped once data is
    // current again.
    // 2026-09-28: on Lofty the stored listings are Christine's own and nobody
    // else's, so "new homes in your area" can't be answered from them -- an email
    // built from that would present her listings as the whole market. Paused, with
    // every alert left exactly as it was (see area-alerts.js).
    if (LISTINGS_SOURCE === "lofty") {
      console.warn("area-alerts-run: listings come from Lofty (her own only) — area alerts paused, none sent.");
      return { statusCode: 200, body: "skipped: area alerts paused (Lofty)" };
    }
    const switchGate = idxGate({ skipFreshness: true });
    if (!switchGate.allowed) {
      console.warn("area-alerts-run: IDX display is off (IDX_DISPLAY) — no alerts sent.");
      return { statusCode: 200, body: "skipped: idx display off" };
    }
    const from = String(process.env.LEAD_ALERT_FROM || "").trim();
    const alertStore = getBlobStore(getStore, STORE_NAME);
    const listingStore = getBlobStore(getStore);

    const state = await listingStore.get(SYNC_STATE_KEY, { type: "json" }).catch(() => null);
    const freshGate = idxGate({ state });
    if (!freshGate.allowed) {
      console.warn(`area-alerts-run: listing data not current (${freshGate.reason}` +
        `${freshGate.lastSuccessAt ? `, last successful sync ${freshGate.lastSuccessAt}` : ""}) — no alerts sent.`);
      return { statusCode: 200, body: `skipped: listing data ${freshGate.reason}` };
    }

    // The hold. Automatic email to subscribers needs a named approver; without
    // one nothing below runs, so no alert is seeded, sent or marked.
    const approvedBy = areaAlertApprover(process.env);
    if (!approvedBy) {
      console.warn(`area-alerts-run: held — ${AREA_ALERTS_HOLD_REASON} (AREA_ALERTS_APPROVED_BY is not set). None sent.`);
      return { statusCode: 200, body: `held: ${AREA_ALERTS_HOLD_REASON}` };
    }
    const hub = hubEndpoint(process.env);

    const index = await alertStore.list().catch(() => null);
    const keys = ((index && index.blobs) || []).map((b) => b.key);
    if (!keys.length) return { statusCode: 200, body: "no alerts" };

    const listingsById = await listingStore.get(LISTINGS_KEY, { type: "json" }).catch(() => null);
    const all = listingsById ? Object.values(listingsById) : [];
    if (!all.length) return { statusCode: 200, body: "no listings" };

    let sent = 0;
    let notSent = 0;
    for (const key of keys) {
      const alert = await alertStore.get(key, { type: "json" }).catch(() => null);
      if (!alert || !alert.email || !Array.isArray(alert.cities)) continue;

      const params = { cities: alert.cities.join(",") };
      if (alert.minPrice) params.minPrice = String(alert.minPrice);
      if (alert.maxPrice) params.maxPrice = String(alert.maxPrice);
      const matched = all.filter(
        (l) => l && l.listingId && String(l.status || "") === "Active" && matchesQuery(l, params)
      );
      const matchedIds = matched.map((l) => l.listingId);

      if (!Array.isArray(alert.knownIds)) {
        // First pass: seed and stay silent.
        await alertStore.setJSON(key, { ...alert, knownIds: matchedIds, seededAt: Date.now() });
        continue;
      }

      const known = new Set(alert.knownIds);
      const fresh = matched.filter((l) => !known.has(l.listingId));
      if (!fresh.length) continue;

      if (!hub.url) {
        console.error(`area-alerts-run: ${hub.reason} — ${fresh.length} new listing(s) for one alert ` +
          "NOT sent, will retry next run.");
        notSent += 1;
        continue; // knownIds untouched, so nothing is lost
      }

      let answer;
      try {
        answer = readHubAnswer(await postToHub(hub, {
          kind: "lead",
          to: [alert.email],
          subject: `${fresh.length} new home${fresh.length > 1 ? "s" : ""} in ${alert.label}`.replace(/[\r\n]+/g, " ").slice(0, 200),
          html: emailHtml(alert, fresh),
          ...(from ? { from: `Christine Gwinnup <${from}>` } : {}),
          approved_by: approvedBy,
          unsubscribe_url: unsubscribeUrl(alert),
          idempotency_key: areaAlertKey(alert, fresh),
        }));
      } catch (e) {
        answer = { ok: false, hubStatus: "no_answer" };
      }
      // Sent, or already handled under this key (the hub never sends a key twice,
      // and an unknown delivery is never re-sent): these homes are done.
      const done = answer.ok || answer.hubStatus === "held";
      if (!done) {
        // Counts and the hub's words only -- never the subscriber's address.
        console.error(`area-alerts-run: hub ${answer.hubStatus}${answer.reason ? ` (${answer.reason})` : ""}` +
          `${answer.httpStatus && answer.httpStatus !== 200 ? ` HTTP ${answer.httpStatus}` : ""} for one alert — will retry next run.`);
        notSent += 1;
        continue; // don't mark as seen if the send failed
      }
      if (answer.hubStatus === "sent") sent += 1;
      await alertStore.setJSON(key, { ...alert, knownIds: matchedIds, lastSentAt: Date.now() });
    }
    return { statusCode: 200, body: `ok: ${keys.length} alerts, ${sent} emails, ${notSent} not sent` };
  } catch (err) {
    console.error("area-alerts-run error:", err);
    return { statusCode: 200, body: "error: " + (err && err.message) };
  }
};
