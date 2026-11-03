// Counts the form submissions Netlify marked as spam in the last 7 days (2026-11-03).
// Scheduled every 6 hours (netlify.toml). Saves counts only (form name, how many, when
// the newest came in) to Blobs for the /status row "Form submissions Netlify marked as
// spam". Never a name, email, phone or message. The rules and the fail-closed check live
// in lib/_form-spam.js (shared byte for byte with the other site).
"use strict";

// This site's Netlify project id (not secret: Project configuration > General).
const THIS_SITE_ID = "97baf0fc-c899-4fb1-8163-06c401ae020e";

exports.handler = async () => {
  try {
    const { getStore } = require("@netlify/blobs");
    const { getBlobStore } = require("./lib/_mls-shared");
    const { countSpam, spamKey, formsToken } = require("./lib/_form-spam");
    const siteId = String(process.env.SITE_ID || "").trim() || THIS_SITE_ID;
    const record = await countSpam({ token: formsToken(), siteId });
    await getBlobStore(getStore).setJSON(spamKey(siteId), record);
    console.log(`form-spam-count: ${record.complete ? `${record.total} in ${record.days} days, ${record.formsRead} form(s) read` : `incomplete: ${record.problem}`}`);
    return { statusCode: record.complete ? 200 : 503, body: JSON.stringify({ complete: record.complete, total: record.total ?? null }) };
  } catch (err) {
    console.error("form-spam-count failed:", err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "form-spam-count failed" }) };
  }
};

exports.THIS_SITE_ID = THIS_SITE_ID;
exports.FORMS_URL = "https://app.netlify.com/projects/signaturepropertycollection/forms";
