// A lead held for identity review is kept, counted, and never replayed.
//
// 2026-10-04 (re-audit). When the Lofty lookup could not settle who a lead is --
// several exact matches, an email and a phone naming different contacts, or a
// lookup that failed -- submission-created.js rightly created nothing and emailed
// Christine. But the lead itself then lived only in that email: recordPush
// skipped the retry queue for it, and a lead the drain held stayed in the queue,
// flagged, taking a retry slot for ever. lib/_lofty.js now keeps each held lead
// under its own key (MANUAL_REVIEW_KEY) with the submission and the reason,
// nothing replays it, and /status shows how many are waiting and which Netlify
// Forms submissions they are -- never a name, email or phone: /status is public.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const L = require(`${FN_DIR}/lib/_lofty.js`);

// A store with Netlify Blobs' create-only semantics ({ onlyIfNew } -> modified:false).
function blobStore(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  return {
    data,
    get: async (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : null),
    setJSON: async (k, v, o) => {
      if (o && o.onlyIfNew && k in data) return { modified: false };
      data[k] = JSON.parse(JSON.stringify(v));
      return { modified: true, etag: "e" };
    },
    delete: async (k) => { delete data[k]; },
    list: async () => ({ blobs: [] }),
  };
}
const resp = (status, body) => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body,
});

const PERSON = { name: "Janelle Quistgaard", email: "janelle.q@example.com", phone: "(970) 555-0142", message: "wants a 4 bed on acreage with a llama barn" };
const SECRETS = ["Janelle", "Quistgaard", "janelle.q@example.com", "555-0142", "llama barn"];
const SUBMISSION_ID = "5f1e2d3c4b5a69788796a5b4";
// Lofty, asked by email, answering with two contacts that both carry it exactly.
const twoMatches = { leads: [{ leadId: 101, emails: [PERSON.email] }, { leadId: 102, emails: [PERSON.email] }] };
const body = { firstName: "Janelle", lastName: "Quistgaard", emails: [PERSON.email], phones: [PERSON.phone], notes: `NEW WEBSITE LEAD — ${PERSON.message}` };
const heldResult = () => ({
  ok: false, attempted: false, manualReview: true, payloadShape: "held for identity review",
  responseBody: "multiple exact matches; identity needs manual review", submissionId: "sub-abc123", formData: PERSON,
});

(async () => {
  console.log("\n1. recordPush: a held lead is kept under its own key, not queued");
  let store = blobStore({});
  await L.recordPush(store, heldResult(), "contact", body);
  let held = store.data[L.MANUAL_REVIEW_KEY];
  check("one held lead recorded", Array.isArray(held) && held.length === 1, JSON.stringify(held));
  check("it carries the submission id, the reason, the lead and the form data",
    held && held[0].submissionId === "sub-abc123" && /multiple exact matches/.test(held[0].reason) &&
    held[0].lead.emails[0] === PERSON.email && held[0].formData.message === PERSON.message && !!held[0].heldAt, JSON.stringify(held));
  check("nothing went to the retry queue", !(L.FAILED_PUSH_KEY in store.data));
  check("the /status record says it was held, and carries no form data",
    store.data[L.LAST_PUSH_KEY].manualReview === true && !("formData" in store.data[L.LAST_PUSH_KEY]));
  await L.recordPush(store, heldResult(), "contact", body);
  check("the same submission held twice (a webhook retry) is one entry", store.data[L.MANUAL_REVIEW_KEY].length === 1);
  for (let i = 0; i < L.MAX_HELD_FOR_REVIEW + 5; i++) {
    await L.holdForManualReview(store, { at: `2026-10-04T00:00:${String(i).padStart(2, "0")}Z`, formName: "contact", submissionId: `s${i}`, reason: "r" });
  }
  check(`the record keeps the newest ${L.MAX_HELD_FOR_REVIEW}`,
    store.data[L.MANUAL_REVIEW_KEY].length === L.MAX_HELD_FOR_REVIEW &&
    store.data[L.MANUAL_REVIEW_KEY][0].submissionId === `s${L.MAX_HELD_FOR_REVIEW + 4}`);

  console.log("\n2. The drain: a queued lead Lofty now has two of is held, not created");
  const posted = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url); const m = init.method || "GET";
    if (m === "GET" && /\/v1\.0\/leads\?/.test(u)) return resp(200, /email=/.test(u) ? twoMatches : { leads: [] });
    if (m === "POST" && /\/v1\.0\/leads$/.test(u)) { posted.push(JSON.parse(init.body)); return resp(200, { leadId: 999 }); }
    return resp(200, {});
  };
  const queued = { at: "2026-10-04T10:00:00.000Z", formName: "contact", lead: { ...body, tags: ["Hot Lead - Website"] }, ok: false, httpStatus: 503 };
  // Written by the drain before this change: flagged, and left in the retry queue.
  const flaggedEarlier = { at: "2026-10-01T09:00:00.000Z", formName: "buyers-guide", lead: { emails: ["old@example.com"] },
    manualReview: true, heldReason: "email and phone identify different contacts; identity needs manual review" };
  store = blobStore({ [L.FAILED_PUSH_KEY]: [queued, flaggedEarlier] });
  let r = await L.drainFailedPushes(store, "k");
  check("no contact was created", posted.length === 0, JSON.stringify(posted));
  check("the drain reports both as held", r.heldForReview === 2 && r.recovered === 0, JSON.stringify(r));
  check("the retry queue is empty: nothing flagged lingers there", store.data[L.FAILED_PUSH_KEY].length === 0, JSON.stringify(store.data[L.FAILED_PUSH_KEY]));
  held = store.data[L.MANUAL_REVIEW_KEY];
  check("both are in the held-lead record, each with its reason", Array.isArray(held) && held.length === 2 &&
    held.some((e) => e.formName === "contact" && /multiple exact matches/.test(e.reason)) &&
    held.some((e) => e.formName === "buyers-guide" && /different contacts/.test(e.reason)), JSON.stringify(held));
  check("the held record keeps the whole submission for a replay by hand",
    held.find((e) => e.formName === "contact").lead.emails[0] === PERSON.email);
  check("the /status record counts the hold", /2 held for identity review/.test(store.data[L.LAST_PUSH_KEY].responseBody),
    JSON.stringify(store.data[L.LAST_PUSH_KEY]));

  console.log("\n3. The drain never replays a held lead");
  let calls = 0;
  global.fetch = async () => { calls += 1; return resp(200, { leads: [] }); };
  const before = JSON.stringify(store.data[L.MANUAL_REVIEW_KEY]);
  r = await L.drainFailedPushes(store, "k");
  check("an empty retry queue with held leads waiting: no Lofty call at all", calls === 0 && r.attempted === 0, JSON.stringify(r));
  check("and the held record is untouched", JSON.stringify(store.data[L.MANUAL_REVIEW_KEY]) === before);
  check("the drain reads the retry queue only", !/MANUAL_REVIEW_KEY/.test(
    String(L.drainFailedPushes) + require("fs").readFileSync(`${FN_DIR}/lib/_lofty.js`, "utf8").split("async function drainWithLease")[1].split("async function finishReplay")[0]
      .replace(/holdForManualReview\(/g, "")));

  console.log("\n4. submission-created: the live hold");
  store = blobStore({});
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  process.env.LOFTY_API_KEY = "k";
  process.env.RESEND_API_KEY = "r";
  delete process.env.FLODESK_API_KEY;
  const routes = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url); const m = init.method || "GET";
    routes.push(`${m} ${u.replace(/^https:\/\/api\.(lofty|resend)\.com/, "").split("?")[0]}`);
    if (/resend\.com/.test(u)) return resp(200, { id: "e1" });
    if (m === "GET" && /\/v1\.0\/leads\?/.test(u)) return resp(200, /email=/.test(u) ? twoMatches : { leads: [] });
    return resp(500, `unexpected ${m} ${u}`);
  };
  const handler = require(`${FN_DIR}/submission-created.js`).handler;
  const out = await handler({ body: JSON.stringify({ payload: { id: SUBMISSION_ID, number: 17, form_name: "contact", data: PERSON } }) });
  check("answers 200 and says the lead is held", out.statusCode === 200 && /manual review/.test(out.body), JSON.stringify(out));
  check("no create was attempted", !routes.includes("POST /v1.0/leads"), routes.join(" | "));
  check("the alert email still went out", routes.includes("POST /emails"), routes.join(" | "));
  held = store.data[L.MANUAL_REVIEW_KEY];
  check("the lead is in the held-lead record under Netlify's submission id",
    Array.isArray(held) && held.length === 1 && held[0].submissionId === SUBMISSION_ID && held[0].formName === "contact", JSON.stringify(held));
  check("...with the whole submission and the reason",
    held && held[0].formData && held[0].formData.email === PERSON.email && held[0].lead.emails[0] === PERSON.email &&
    /multiple exact matches/.test(held[0].reason));
  check("...and not in the retry queue", !(L.FAILED_PUSH_KEY in store.data));

  console.log("\n5. /status: the count and the submission ids, never the person");
  const render = async (params) => {
    for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
    global.fetch = async () => { throw new Error("no live calls in this test"); };
    const health = require(`${FN_DIR}/site-health.js`);
    return (health.localHandler || health.handler)({ queryStringParameters: params });
  };
  const html = (await render({})).body;
  const jsonBody = (await render({ format: "json" })).body;
  for (const s of SECRETS) {
    check(`HTML does not contain "${s}"`, !html.includes(s));
    check(`JSON does not contain "${s}"`, !jsonBody.includes(s));
  }
  let parsed = null;
  try { parsed = JSON.parse(jsonBody); } catch (e) { parsed = null; }
  check("JSON still parses", !!parsed);
  if (parsed) {
    const row = parsed.checks.find((c) => c.name === "Leads held for identity review") || {};
    check("the held-leads row counts one and names the submission id",
      /^1 lead\(s\)/.test(String(row.detail)) && String(row.detail).includes(SUBMISSION_ID), row.detail);
    check("...and is informational, not a breakage", row.ok === false && row.optional === true);
    const pub = parsed.raw.loftyHeld || {};
    check("the JSON carries the count, the ids and the reason only", pub.count === 1 && pub.entries[0].submissionId === SUBMISSION_ID &&
      /multiple exact matches/.test(pub.entries[0].reason) && !("lead" in pub.entries[0]) && !("formData" in pub.entries[0]), JSON.stringify(pub));
    const leadRow = parsed.checks.find((c) => c.name === "Website leads reaching Lofty") || {};
    check("the lead row says the last lead was held, not that the push failed",
      /HELD for identity review/.test(String(leadRow.detail)) && !/FAILED/.test(String(leadRow.detail)), leadRow.detail);
    check("the page has the row", html.includes("Leads held for identity review") && html.includes(SUBMISSION_ID));
  }
  store.data[L.MANUAL_REVIEW_KEY] = [];
  delete store.data[L.LAST_PUSH_KEY];
  const parsed2 = JSON.parse((await render({ format: "json" })).body);
  const row2 = parsed2.checks.find((c) => c.name === "Leads held for identity review") || {};
  check("none held: the row is green and says so", row2.ok === true && /None waiting/.test(String(row2.detail)) && parsed2.raw.loftyHeld.count === 0, row2.detail);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
