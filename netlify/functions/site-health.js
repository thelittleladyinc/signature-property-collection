// Human-readable "is everything actually working" status page — one URL
// Christine can bookmark and check herself instead of both of us running
// ad-hoc ?debug=true fetches back and forth every time something seems
// off. Read-only: this never talks to MLS Grid or Cloudinary itself, it
// only reads what sync-listings.js already wrote to Blobs on its last
// scheduled run — so loading this page is free and can never cost API
// quota, trigger a request, or interfere with the suspension breaker.
const { getStore } = require("@netlify/blobs");
const {
  SYNC_STATE_KEY, MINE_LISTINGS_KEY, getBlobStore,
} = require("./lib/_mls-shared");
const { isCloudinaryConfigured } = require("./lib/_cloudinary");

// Must match SUSPENSION_KEY in sync-listings.js — duplicated here rather
// than exported since it's a single literal string and this file should
// stay read-only / dependency-light.
const SUSPENSION_KEY = "mlsgrid-suspension.json";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

exports.handler = async (event) => {
  const store = getBlobStore(getStore);
  const params = (event && event.queryStringParameters) || {};
  const wantsJson = params.format === "json";

  const [state, mine, suspension] = await Promise.all([
    store.get(SYNC_STATE_KEY, { type: "json" }),
    store.get(MINE_LISTINGS_KEY, { type: "json" }),
    store.get(SUSPENSION_KEY, { type: "json" }),
  ]);

  const now = Date.now();
  const lastRunAt = state && state.lastRunAt ? Date.parse(state.lastRunAt) : null;
  const minutesSinceLastRun = lastRunAt ? Math.round((now - lastRunAt) / 60000) : null;
  const suspendedUntil = suspension && suspension.suspendedUntil;
  const isSuspended = !!(suspendedUntil && suspendedUntil > now);

  const mineListings = Array.isArray(mine) ? mine : [];
  const mineCount = mineListings.length;
  const mineCloudinaryCount = mineListings.filter((l) => {
    try { return !!(l.photo && new URL(l.photo).host.indexOf("cloudinary") !== -1); } catch (e) { return false; }
  }).length;

  const checks = [
    {
      name: "Sync running on schedule",
      ok: !isSuspended && minutesSinceLastRun !== null && minutesSinceLastRun < 20,
      detail: isSuspended
        ? `MLS Grid rate-limit circuit breaker is OPEN — paused until ${new Date(suspendedUntil).toLocaleString("en-US")}`
        : (lastRunAt != null
          ? `Last ran ${minutesSinceLastRun} minute(s) ago (should be every 15)`
          : "Has never run yet"),
    },
    {
      name: "No MLS Grid errors on last run",
      ok: !state || !state.lastRunError,
      detail: (state && state.lastRunError) || "none",
    },
    {
      name: "Initial catalog crawl",
      ok: !!(state && state.bootstrapped),
      detail: state
        ? `${state.bootstrapped ? "Complete" : "Still in progress"} — ${state.totalListingsStored ?? "?"} listing(s) stored so far this pass`
        : "Not started",
    },
    {
      name: "Christine's own listings found",
      ok: mineCount > 0,
      detail: `${mineCount} listing(s) currently known to the site`,
    },
    {
      name: "Cloudinary configured",
      ok: isCloudinaryConfigured(),
      detail: isCloudinaryConfigured()
        ? "All three env vars present"
        : "CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET — one or more isn't set",
    },
    {
      name: "Christine's own photos permanently cached",
      ok: mineCount > 0 && mineCloudinaryCount === mineCount,
      detail: `${mineCloudinaryCount} of ${mineCount} listing(s) on a permanent Cloudinary photo — the rest are still on raw, expiring MLS Grid links`,
    },
    {
      name: "No Cloudinary errors on last run",
      ok: !state || !state.lastCloudinaryError,
      detail: (state && state.lastCloudinaryError) || "none",
    },
  ];

  const allOk = checks.every((c) => c.ok);

  if (wantsJson) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ allOk, checks, raw: { state, suspension, mineCount, mineCloudinaryCount } }, null, 2),
    };
  }

  const rows = checks.map((c) => `
    <tr>
      <td style="padding:12px 16px;font-size:20px;text-align:center">${c.ok ? "✅" : "❌"}</td>
      <td style="padding:12px 16px;font-weight:600;white-space:nowrap">${esc(c.name)}</td>
      <td style="padding:12px 16px;color:#555">${esc(c.detail)}</td>
    </tr>`).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site Health — Signature Property Collection</title>
<meta name="robots" content="noindex">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f8f6f4; margin:0; padding:40px 20px; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom:4px; color:#141415; }
  .status-line { font-size:16px; margin-bottom:24px; font-weight:700; }
  .ok { color:#2f6b45; } .bad { color:#a33; }
  table { width:100%; border-collapse: collapse; background:#fff; border:1px solid #e4e4d8; border-radius:4px; overflow:hidden; }
  tr + tr td { border-top:1px solid #eee; }
  .refresh { font-size:12px; color:#888; margin-top:16px; }
  code { background:#eee; padding:1px 5px; border-radius:3px; }
</style>
</head><body><div class="wrap">
<h1>Signature Property Collection — Site Health</h1>
<p class="status-line ${allOk ? "ok" : "bad"}">${allOk ? "✅ Everything looks clean." : "⚠️ Something needs attention — see below."}</p>
<table>${rows}</table>
<p class="refresh">Checked live just now — reload anytime. This page only reads stored status; it never calls MLS Grid or Cloudinary itself, so checking it is always free. Add <code>?format=json</code> to the URL for raw data.</p>
</div></body></html>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: html,
  };
};
