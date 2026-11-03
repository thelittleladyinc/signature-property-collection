"use strict";
// The status key: who may see the DETAILS of /status (site-health), /mls-usage and
// run refresh-my-listings.
//
// 2026-11-03 (endpoint audit). /status was open to anyone: every row's detail
// text (listing street addresses, including a Lofty record the MLS says is off
// the market, the last lead's form and time, the retry queue, which settings are
// on), ?format=json's raw records, and ?probe=1, which ran live Google and Lofty
// checks for whoever asked. /mls-usage published MLS Grid usage, and
// refresh-my-listings took a POST from anyone.
//
// The rule, with STATUS_KEY set in Netlify: the row NAMES and LIGHTS stay public
// (the hub's daily Connections check reads /status?format=json for exactly
// those: allOk, and each check's name / ok / optional), and everything else
// (the detail text, raw data, live probes, /mls-usage, the refresh) needs the
// key, as ?key=<STATUS_KEY> or the header x-status-key. The key is compared in
// constant time and never echoed. With STATUS_KEY unset nothing changes: the
// pages answer exactly as before, so setting the variable is the switch.
//
// Shared byte for byte by both websites (like lib/_lofty.js).
const crypto = require("crypto");

const STATUS_KEY_NAME = "STATUS_KEY";

function configuredKey() {
  return String(process.env.STATUS_KEY || "").trim();
}

function presentedKey(event) {
  const q = (event && event.queryStringParameters) || {};
  const h = (event && event.headers) || {};
  const header = h["x-status-key"] !== undefined ? h["x-status-key"] : h["X-Status-Key"];
  return String(q.key !== undefined ? q.key : header || "").trim();
}

function sameKey(a, b) {
  if (!a || !b) return false;
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// { configured, ok, why }: ok is true when no key is set (today's behaviour) or
// the right key was presented. `why` never carries the key.
function statusAccess(event) {
  const key = configuredKey();
  if (!key) return { configured: false, ok: true, why: `${STATUS_KEY_NAME} is not set, so details are shown to everyone, as before` };
  const ok = sameKey(key, presentedKey(event));
  return { configured: true, ok, why: ok ? "the status key was presented" : `details need the status key (?key=, or the x-status-key header; the value of ${STATUS_KEY_NAME} in Netlify)` };
}

module.exports = { statusAccess, STATUS_KEY_NAME };
