// Scheduled runner for the saved-area alerts (see area-alerts.js).
//
// Every 6 hours: for each saved alert, find Active listings in its towns
// (matchesQuery -- the exact filter the site's own search uses, so an alert
// can never disagree with the search page), diff against the ids this alert
// has already seen, and email the new ones via the same Resend account the
// lead alerts use. First pass for a new alert seeds knownIds and sends
// nothing -- subscribers get homes that appear AFTER they subscribed, not a
// dump of the backlog.
//
// Every email carries a one-click unsubscribe link (GET ?unsub=<id> on
// area-alerts.js). If RESEND_API_KEY is unset the runner logs and exits
// without touching knownIds, so no listing is ever silently marked as seen
// but never sent.
const { getStore } = require("@netlify/blobs");
const { getBlobStore, LISTINGS_KEY, matchesQuery } = require("./lib/_mls-shared");

const STORE_NAME = "area-alerts";
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_LISTINGS_PER_EMAIL = 10;
const SITE = "https://signaturepropertycollection.com";

function fmtPrice(p) {
  return typeof p === "number" ? "$" + p.toLocaleString() : "Price on request";
}

function emailHtml(alert, listings) {
  const rows = listings.slice(0, MAX_LISTINGS_PER_EMAIL).map((l) =>
    `<p style="margin:0 0 14px"><a href="${SITE}/listing/${encodeURIComponent(l.listingId)}" ` +
    `style="color:#B86F7A;font-weight:bold;text-decoration:none">${fmtPrice(l.price)} — ` +
    `${l.address || ""}, ${l.city || ""}</a><br>` +
    `<span style="color:#555;font-size:13px">${l.beds ?? "?"} bd · ${l.baths ?? "?"} ba` +
    (l.sqft ? ` · ${Number(l.sqft).toLocaleString()} sqft` : "") + `</span></p>`
  ).join("");
  const more = listings.length > MAX_LISTINGS_PER_EMAIL
    ? `<p>…and ${listings.length - MAX_LISTINGS_PER_EMAIL} more.</p>` : "";
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px">
<h2 style="font-weight:normal">New in ${alert.label}</h2>
<p style="color:#555">Homes that just listed in the area you drew on my map
(${alert.cities.join(", ")}):</p>
${rows}${more}
<p><a href="${SITE}/explore.html" style="color:#B86F7A">See them on the map</a></p>
<p style="color:#999;font-size:12px;margin-top:28px">You asked for these alerts on
signaturepropertycollection.com. — Christine Gwinnup, The Little Lady Sells Homes<br>
<a href="${SITE}/.netlify/functions/area-alerts?unsub=${encodeURIComponent(alert.id)}"
style="color:#999">Unsubscribe</a></p></div>`;
}

exports.handler = async () => {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.LEAD_ALERT_FROM || "onboarding@resend.dev";
    const alertStore = getBlobStore(getStore, STORE_NAME);
    const listingStore = getBlobStore(getStore);

    const index = await alertStore.list().catch(() => null);
    const keys = ((index && index.blobs) || []).map((b) => b.key);
    if (!keys.length) return { statusCode: 200, body: "no alerts" };

    const listingsById = await listingStore.get(LISTINGS_KEY, { type: "json" }).catch(() => null);
    const all = listingsById ? Object.values(listingsById) : [];
    if (!all.length) return { statusCode: 200, body: "no listings" };

    let sent = 0;
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

      if (!apiKey) {
        console.error("area-alerts-run: RESEND_API_KEY unset — " +
          `${fresh.length} new listing(s) for ${alert.email} NOT sent, will retry next run.`);
        continue; // knownIds untouched, so nothing is lost
      }

      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `Christine Gwinnup <${from}>`,
          to: [alert.email],
          subject: `${fresh.length} new home${fresh.length > 1 ? "s" : ""} in ${alert.label}`,
          html: emailHtml(alert, fresh),
        }),
      });
      if (!res.ok) {
        console.error(`area-alerts-run: Resend ${res.status} for ${alert.email} — will retry next run.`);
        continue; // don't mark as seen if the send failed
      }
      sent += 1;
      await alertStore.setJSON(key, { ...alert, knownIds: matchedIds, lastSentAt: Date.now() });
    }
    return { statusCode: 200, body: `ok: ${keys.length} alerts, ${sent} emails` };
  } catch (err) {
    console.error("area-alerts-run error:", err);
    return { statusCode: 200, body: "error: " + (err && err.message) };
  }
};
