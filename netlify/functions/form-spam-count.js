// Counts the form submissions Netlify marked as spam in the last 7 days (2026-11-03).
// Scheduled every 6 hours (netlify.toml). Saves counts only (form name, how many, when
// the newest came in) to Blobs for the /status row "Form submissions Netlify marked as
// spam". Never a name, email, phone or message. The rules and the fail-closed check live
// in lib/_form-spam.js (shared byte for byte with the other site).
"use strict";

// This site's Netlify project id (not secret: Project configuration > General).
const THIS_SITE_ID = "97baf0fc-c899-4fb1-8163-06c401ae020e";

// 2026-11-04: the run's work is lib/_form-spam.js runSpamCount (shared): a store that
// cannot be opened, a save that fails or a count that stops is an answer that says so
// (503 + JSON), never Netlify's bare 500. The event is passed on so the Blobs context
// Netlify sends with a scheduled run can open this site's own store (connectLambda)
// when BLOBS_SITE_ID / BLOBS_TOKEN are not available to functions here.
exports.handler = async (event) => {
  let deps;
  let lib;
  try {
    const { getStore, connectLambda } = require("@netlify/blobs");
    const { getBlobStore } = require("./lib/_mls-shared");
    lib = require("./lib/_form-spam");
    deps = { getStore, getBlobStore, connectLambda };
  } catch (err) {
    console.error("form-spam-count: its code did not load:", err && err.name);
    return { statusCode: 503, headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ complete: false, saved: false, problem: `the code did not load (${(err && err.name) || "error"})` }) };
  }
  const siteId = String(process.env.SITE_ID || "").trim() || THIS_SITE_ID;
  return lib.runSpamCount({ event, siteId, token: lib.formsToken(), deps });
};

exports.THIS_SITE_ID = THIS_SITE_ID;
exports.FORMS_URL = "https://app.netlify.com/projects/signaturepropertycollection/forms";
