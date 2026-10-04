// A lead that needed a retry gets everything a first-try lead gets.
//
// 2026-10-03 (lead-source audit: "queue replay restores a lead and SMS
// preference, not all separate notes, inquiry, custom fields, alert/task").
// drainFailedPushes now runs the same follow-up steps as submission-created.js:
// the note on the surviving contact, the "Hot Lead - Website" re-add on a brand
// new contact (so the SPC Website Smart Plan fires), and a Call task for a
// returning contact. The trigger tag must match submission-created.js.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };
const L = require(`${FN_DIR}/lib/_lofty.js`);

function blobStore(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  return {
    data,
    get: async (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : null),
    setJSON: async (k, v, o) => { if (o && o.onlyIfNew && k in data) return { modified: false }; data[k] = JSON.parse(JSON.stringify(v)); return { modified: true }; },
    delete: async (k) => { delete data[k]; },
  };
}
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
const queued = { at: "2026-10-03T20:00:00.000Z", formName: "contact",
  lead: { firstName: "Pat", emails: ["pat@example.com"], source: "The Little Lady Sells Homes - Contact Form", notes: "NEW WEBSITE LEAD — hi", tags: ["Hot Lead - Website", "Website Lead", "contact"] } };

function fakeLofty({ existingId = null } = {}) {
  const calls = [];
  const leads = { "777": { leadId: 777, tags: [{ tagName: "Hot Lead - Website" }, { tagName: "Website Lead" }, { tagName: "contact" }] } };
  if (existingId) leads[existingId] = { leadId: Number(existingId), emails: ["pat@example.com"], tags: [{ tagName: "Past Client" }] };
  global.fetch = async (url, init = {}) => {
    const m = init.method || "GET"; const u = String(url);
    calls.push(`${m} ${u.replace(/^https:\/\/api\.lofty\.com/, "").split("?")[0]}`);
    if (m === "GET" && /\/v1\.0\/leads\?/.test(u)) {
      return resp(200, { leads: existingId && /pat%40example\.com|pat@example\.com/.test(decodeURIComponent(u)) ? [leads[existingId]] : [] , _metadata: { total: existingId ? 1 : 0 } });
    }
    if (m === "POST" && /\/v1\.0\/leads$/.test(u)) return resp(200, { leadId: existingId ? Number(existingId) : 777 });
    const one = u.match(/\/v1\.0\/leads\/(\d+)$/);
    if (one && m === "GET") return leads[one[1]] ? resp(200, { lead: leads[one[1]] }) : resp(404, { message: "errorCode=20006" });
    if (one && m === "PUT") return resp(200, {});
    if (/\/v1\.0\/notes$/.test(u)) return resp(200, { id: 1 });
    if (/\/v2\.0\/tasks$/.test(u)) return resp(200, { taskId: 9 });
    return resp(200, {});
  };
  return calls;
}

(async () => {
  const src = fs.readFileSync(`${FN_DIR}/submission-created.js`, "utf8");
  check("trigger tag matches submission-created.js", src.includes(`const TRIGGER_TAG = "${L.REPLAY_TRIGGER_TAG}";`));
  check("a failed live create queues the form data and the submission id for the replay", /recordPush\(store, \{ \.\.\.result, emailResult, submissionId(, smsConsent: consent\.given)?, formData: data \}/.test(src));

  console.log("\n1. Brand-new contact");
  let calls = fakeLofty();
  let store = blobStore({ [L.FAILED_PUSH_KEY]: [queued] });
  let r = await L.drainFailedPushes(store, "k");
  check("recovered", r.recovered === 1, JSON.stringify(r));
  check("note posted on the new contact", calls.includes("POST /v1.0/notes"), calls.join(" | "));
  const puts = calls.filter((c) => c === "PUT /v1.0/leads/777").length;
  check("trigger tag removed and re-added (Smart Plan fires)", puts >= 2, calls.join(" | "));
  check("no returning-lead task for a new contact", !calls.includes("POST /v2.0/tasks"));

  console.log("\n2. Returning contact");
  calls = fakeLofty({ existingId: "4242" });
  store = blobStore({ [L.FAILED_PUSH_KEY]: [queued] });
  r = await L.drainFailedPushes(store, "k");
  check("recovered", r.recovered === 1, JSON.stringify(r));
  check("a Call task for the returning contact", calls.includes("POST /v2.0/tasks"), calls.join(" | "));
  check("status record carries no form data", !("formData" in (store.data[L.LAST_PUSH_KEY] || {})));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
