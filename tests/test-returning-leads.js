// Returning leads get a Lofty task + phone push; new leads get website fields.
//
// 2026-09-29 (Christine approved: "lets do 1-5"). Pins lib/_lofty-returning.js
// against the request shapes in Lofty's API reference (developer.lofty.com):
//   GET  /v1.0/leads?email=&preciseSearchFlag=true   -> { leads: [{ leadId, emails: [] }] }
//   POST /v2.0/tasks                                 -> { taskId }
//   POST /v2.0/sales-agent/notification/app-push/send-task-reminder  { taskId, type: "TASK" }
//   GET  /v1.0/teamFeatures/listCustomField, POST /v1.0/teamFeatures/custom-field
//   PUT  /v1.0/leads/{leadId}  { customAttributeList: [...] }
// and the handler's promises: nothing is ever sent to the client; a returning
// lead's note/task/push go to the contact that exists; fields only ever touch a
// brand-new contact; and any Lofty failure changes nothing that worked before.
"use strict";
// Fails unless the suite reaches its own verdict: a promise the event loop
// abandons would otherwise exit 0 halfway through and look like a pass.
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const R = require(`${FN_DIR}/lib/_lofty-returning.js`);
const EXISTING = "1148639689762408";
const NEWID = "1149000000000001";

function resp(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
}

(async () => {
  console.log("\n1. Looking a contact up by email (exact)");
  let seen = [];
  // Options object for the lookups: { fetchImpl } answering with these leads.
  const lookupFetch = (leads, status = 200) => ({ fetchImpl: async (url, init) => { seen.push({ url: String(url), init }); return resp(status, { _metadata: {}, leads }); } });
  let r = await R.findLeadByEmail("Buyer@Example.com", "k", lookupFetch([{ leadId: Number(EXISTING), emails: ["buyer@example.com"] }]));
  const u = new URL(seen[0].url);
  check("GET /v1.0/leads with the email and preciseSearchFlag=true",
    u.pathname === "/v1.0/leads" && u.searchParams.get("email") === "Buyer@Example.com" && u.searchParams.get("preciseSearchFlag") === "true");
  check("authorised with the key", seen[0].init.headers.Authorization === "token k");
  check("finds the contact, case-insensitively", r.ok === true && r.leadId === EXISTING, JSON.stringify(r));
  r = await R.findLeadByEmail("buyer@example.com", "k", lookupFetch([{ leadId: 5, emails: ["someone.else@example.com"] }]));
  check("a result that isn't an exact match makes the answer untrustworthy (can't tell, never 'new')", r.ok === false && !r.leadId);
  r = await R.findLeadByEmail("buyer@example.com", "k", lookupFetch([null, { leadId: Number(EXISTING), emails: ["buyer@example.com"] }]));
  check("a null entry in Lofty's answer doesn't throw", r.ok === true && r.leadId === EXISTING);
  const big = [{ leadId: Number(EXISTING), emails: ["buyer@example.com"], tags: Array.from({ length: 40 }, (_, i) => `tag ${i} ${"x".repeat(80)}`) }];
  r = await R.findLeadByEmail("buyer@example.com", "k", lookupFetch(big));
  check("a long record (over 4 KB) is parsed whole", r.ok === true && r.leadId === EXISTING, JSON.stringify(r));
  r = await R.findLeadByEmail("buyer@example.com", "k", lookupFetch([]));
  check("no contact: ok, and no id", r.ok === true && r.leadId === null && r.matches === 0);
  r = await R.findLeadByEmail("buyer@example.com", "k", { fetchImpl: async () => resp(500, "boom") });
  check("Lofty error: not ok (callers change nothing)", r.ok === false && r.httpStatus === 500);
  r = await R.findLeadByEmail("buyer@example.com", "k", { fetchImpl: async () => resp(200, { weird: true }) });
  check("unexpected shape: not ok", r.ok === false);
  r = await R.findLeadByEmail("buyer@example.com", "k", lookupFetch([{ leadId: 2 ** 60, emails: ["buyer@example.com"] }]));
  check("an id JavaScript can't hold exactly is refused, not rounded", r.ok === false);
  seen = [];
  r = await R.findLeadByEmail("not an email", "k", lookupFetch([]));
  check("no call without a real email address", r.attempted === false && seen.length === 0);

  console.log("\n1b. ...then by phone, because Lofty can merge on a phone number too");
  seen = [];
  r = await R.findLeadByPhone("(970) 555-0100", "k", lookupFetch([{ leadId: 42, phones: ["+19705550100"] }]));
  check("searches bare digits, preciseSearchFlag=true", new URL(seen[0].url).searchParams.get("phone") === "9705550100" &&
    new URL(seen[0].url).searchParams.get("preciseSearchFlag") === "true");
  check("matches however the number is formatted", r.ok === true && r.leadId === "42");
  seen = [];
  r = await R.findExistingLead("new@example.com", "970-555-0100", "k", { fetchImpl: async (url) => {
    seen.push(String(url));
    return /email=/.test(String(url)) ? resp(200, { leads: [] }) : resp(200, { leads: [{ leadId: 42, phones: ["9705550100"] }] });
  } });
  check("email and phone asked together", seen.length === 2);
  check("a phone-only match is 'someone' (blocks fields, keeps tags) but never redirects the note or task (could be a spouse)",
    r.ok === true && r.anyMatch === true && r.leadId === null && r.phoneLeadId === "42" && r.via === "phone", JSON.stringify(r));
  r = await R.findExistingLead("buyer@example.com", "970-555-0100", "k", { fetchImpl: async () => resp(200, { leads: [{ leadId: 7, emails: ["buyer@example.com"], phones: ["9705550100"] }] }) });
  check("an email match is the contact to use", r.ok === true && r.leadId === "7" && r.via === "email" && r.anyMatch === true);
  r = await R.findExistingLead("new@example.com", "970-555-0100", "k", { fetchImpl: async (url) =>
    (/email=/.test(String(url)) ? resp(200, { leads: [] }) : resp(500, "down")) });
  check("if the phone question fails, 'new' can't be trusted (ok false)", r.ok === false && r.anyMatch === false);
  r = await R.findExistingLead("new@example.com", "", "k", { fetchImpl: async () => resp(200, { leads: [] }) });
  check("no phone given: the email answer alone decides", r.ok === true && r.leadId === null && r.anyMatch === false);
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  // AbortSignal.timeout's timer doesn't hold Node's event loop open (a function
  // invocation does, in production), so the test holds it open itself.
  const keepAlive = setTimeout(() => {}, 5000);
  const t0 = Date.now();
  r = await R.findExistingLead("new@example.com", "970-555-0100", "k", { fetchImpl: hang, budgetMs: 300 });
  const took = Date.now() - t0;
  clearTimeout(keepAlive);
  check("a hung Lofty costs one budget in total, not one per question", r.ok === false && took < 900, `${took}ms`);
  check("the default budget is 2 seconds", R.LOOKUP_BUDGET_MS === 2000);

  console.log("\n2. Denver time, the shape Lofty's task API documents");
  check("summer is MDT (-06:00)", R.denverIso(new Date("2026-09-29T14:30:00Z")) === "2026-09-29T08:30:00-06:00", R.denverIso(new Date("2026-09-29T14:30:00Z")));
  check("winter is MST (-07:00)", R.denverIso(new Date("2026-01-15T20:05:09Z")) === "2026-01-15T13:05:09-07:00");

  console.log("\n3. A returning lead: a Call task, then a push to the AGENT");
  seen = [];
  const taskFetch = (taskStatus = 200, pushStatus = 200) => async (url, init) => {
    seen.push({ url: String(url), init });
    if (/\/v2\.0\/tasks$/.test(String(url))) return resp(taskStatus, taskStatus === 200 ? `{"taskId": 563172647619608}` : "nope");
    return resp(pushStatus, { message: "Operation successful" });
  };
  r = await R.alertReturningLead(EXISTING, { label: "Rent-to-Own Options", name: "Pat Buyer", phone: "970-555-0100", email: "pat@example.com" },
    "k", { fetchImpl: taskFetch(), now: "2026-09-29T14:00:00Z" });
  const taskCall = seen[0];
  const tb = taskCall && JSON.parse(taskCall.init.body);
  check("POST /v2.0/tasks", taskCall.init.method === "POST" && /\/v2\.0\/tasks$/.test(taskCall.url));
  check("on the existing contact, id written as exact digits", /"leadId":1148639689762408/.test(taskCall.init.body), taskCall.init.body);
  check("a Call task for the lead's Agent, due in 30 minutes Denver time",
    tb.type === "Call" && tb.assignedRole === "Agent" && tb.endAt === "2026-09-29T08:30:00-06:00" && tb.timeZoneCode === "America/Denver", JSON.stringify(tb));
  check("the task says who to call and why", /Returning website lead — Rent-to-Own Options/.test(tb.content) && /970-555-0100/.test(tb.content));
  const pushCall = seen[1];
  check("then the documented push endpoint, with the new taskId as exact digits",
    /\/v2\.0\/sales-agent\/notification\/app-push\/send-task-reminder$/.test(pushCall.url) &&
    /"taskId":563172647619608/.test(pushCall.init.body) && JSON.parse(pushCall.init.body).type === "TASK", pushCall.init.body);
  check("reported ok with the task id", r.ok === true && r.step === "pushed" && r.taskId === "563172647619608");
  check("nothing else is called -- no message, email or text to the client", seen.length === 2 &&
    !seen.some((c) => /\/(texts|emails|send-sms|send-email)/.test(c.url)));
  seen = [];
  r = await R.alertReturningLead(EXISTING, {}, "k", { fetchImpl: taskFetch(500) });
  check("a refused task stops there (no push for a task that doesn't exist)", r.ok === false && r.step === "task" && seen.length === 1);

  console.log("\n4. Website fields: created once, written only on a new contact");
  const vals = R.websiteFieldValues("The Little Lady Sells Homes - Rent-to-Own Options", {
    attribution_first_page: "/rent-to-own.html", attribution_form_page: "/rent-to-own.html",
    attribution_source: "google / organic", utm_source: "ignored-when-source-present",
  });
  check("four text fields from the form's own attribution values",
    JSON.stringify(vals.map((v) => v.attributeName)) === JSON.stringify(R.WEBSITE_FIELDS) && vals.every((v) => v.attributeType === "text"));
  check("empty values are left out", R.websiteFieldValues("Contact Form", {}).length === 1);
  const mem = {};
  const store = { get: async (k) => mem[k] || null, setJSON: async (k, v) => { mem[k] = v; } };
  seen = [];
  const fieldFetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (/listCustomField/.test(String(url))) return resp(200, { data: [{ attributeName: "Website Form" }, { attributeName: "Website First Page" }, { attributeName: "Buyer Budget" }] });
    return resp(200, "ok");
  };
  let e = await R.ensureWebsiteFields(store, "k", { fetchImpl: fieldFetch, now: Date.parse("2026-09-29T14:00:00Z") });
  const created = seen.filter((c) => /custom-field$/.test(c.url)).map((c) => JSON.parse(c.init.body));
  check("only the missing fields are created, as text", e.ok === true &&
    JSON.stringify(created.map((c) => c.attributeName)) === JSON.stringify(["Website Form Page", "Website Traffic Source"]) &&
    created.every((c) => c.attributeType === "text"), JSON.stringify(created));
  seen = [];
  e = await R.ensureWebsiteFields(store, "k", { fetchImpl: fieldFetch, now: Date.parse("2026-10-01T14:00:00Z") });
  check("remembered for a week: no calls the next time", e.cached === true && seen.length === 0);
  seen = [];
  const put = await R.setWebsiteFields(NEWID, vals, "k", { fetchImpl: fieldFetch });
  check("PUT /v1.0/leads/{id} with customAttributeList", put.ok === true && seen[0].init.method === "PUT" &&
    seen[0].url.endsWith(`/v1.0/leads/${NEWID}`) && JSON.parse(seen[0].init.body).customAttributeList.length === 4);
  const manyFields = { data: Array.from({ length: 60 }, (_, i) => ({ attributeName: `Other field ${i} ${"y".repeat(60)}` })).concat(R.WEBSITE_FIELDS.map((n) => ({ attributeName: n }))) };
  seen = [];
  e = await R.ensureWebsiteFields(null, "k", { fetchImpl: async (url, init) => { seen.push({ url: String(url), init }); return /listCustomField/.test(String(url)) ? resp(200, manyFields) : resp(200, "ok"); } });
  check("a team with many fields (a long answer) doesn't get duplicates", e.ok === true && e.created.length === 0 && seen.length === 1);

  console.log("\n5. The form handler, end to end");
  const pushes = [];
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({ get: async (k) => mem[k] || null, setJSON: async (k, v) => { if (k === "lofty-last-push.json") pushes.push(v); mem[k] = v; } }),
  } };
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  process.env.LOFTY_API_KEY = "k";
  process.env.RESEND_API_KEY = "r";
  const handler = require(`${FN_DIR}/submission-created.js`).handler;
  const event = (email) => ({ body: JSON.stringify({ payload: { form_name: "contact", data: { name: "Pat Buyer", email, phone: "970-555-0100", message: "Hi" } } }) });
  const route = (existingLeads, phoneLeads) => {
    const calls = [];
    const bodies = [];
    const f = async (url, init = {}) => {
      const s = String(url); const m = init.method || "GET";
      calls.push(`${m} ${s.replace(/^https:\/\/api\.(lofty|resend)\.com/, "")}`.split("?")[0]);
      if (m === "POST" && /\/v1\.0\/leads$/.test(s)) bodies.push(JSON.parse(init.body));
      if (m === "GET" && /\/v1\.0\/leads\?phone=/.test(s)) return resp(200, { leads: phoneLeads || existingLeads });
      if (/resend\.com/.test(s)) return resp(200, { id: "e1" });
      if (m === "GET" && /\/v1\.0\/leads\?/.test(s)) return resp(200, { leads: existingLeads });
      if (m === "POST" && /\/v1\.0\/leads$/.test(s)) return resp(200, `{"data":{"leadId": ${existingLeads.length ? EXISTING : NEWID}}}`);
      if (/\/notes$/.test(s)) return resp(200, "{}");
      if (/\/v2\.0\/tasks$/.test(s)) return resp(200, `{"taskId": 77}`);
      if (/send-task-reminder$/.test(s)) return resp(200, { message: "ok" });
      if (/listCustomField/.test(s)) return resp(200, { data: R.WEBSITE_FIELDS.map((n) => ({ attributeName: n })) });
      if (m === "GET" && /\/v1\.0\/leads\/\d+$/.test(s)) return resp(200, { leadId: 1 });
      if (m === "PUT") return resp(200, "{}");
      return resp(404, "unexpected " + s);
    };
    return { f, calls, bodies };
  };
  delete mem["lofty-website-fields.json"];

  let rt = route([{ leadId: Number(EXISTING), emails: ["pat@example.com"] }]);
  global.fetch = rt.f;
  await handler(event("pat@example.com"));
  let rec = pushes[pushes.length - 1];
  check("returning: looked up first, then the lead pushed as before",
    rt.calls.indexOf("GET /v1.0/leads") === 0 && rt.calls.includes("POST /v1.0/leads"), JSON.stringify(rt.calls));
  check("returning: backup email still sent", rt.calls.some((c) => /\/emails$/.test(c)));
  check("returning: the note goes to the existing contact", rec.noteResult && rec.noteResult.ok === true && rec.existing.found === true);
  check("returning: task + push, recorded", rt.calls.includes("POST /v2.0/tasks") &&
    rt.calls.includes("POST /v2.0/sales-agent/notification/app-push/send-task-reminder") && rec.returningResult.ok === true);
  check("returning: no tag re-fire (Lofty can't) and no field writes on a client's record",
    rec.tagResult.skipped === "returning-lead-task" && !rt.calls.includes(`PUT /v1.0/leads/${EXISTING}`) && rec.fieldsResult.attempted === false);
  check("returning: the create call ADDS its tags (tagsAdd) instead of replacing the client's (tags)",
    rt.bodies[0] && Array.isArray(rt.bodies[0].tagsAdd) && rt.bodies[0].tagsAdd.includes("Hot Lead - Website") && !("tags" in rt.bodies[0]), JSON.stringify(rt.bodies[0]));
  check("returning: /status got the lead before the optional steps, then the update", pushes.length >= 2 &&
    !pushes[pushes.length - 2].returningResult && pushes[pushes.length - 1].returningResult);

  rt = route([]);
  global.fetch = rt.f;
  await handler(event("new.person@example.com"));
  rec = pushes[pushes.length - 1];
  check("new contact: no task, no push", !rt.calls.includes("POST /v2.0/tasks") && rec.returningResult && rec.returningResult.attempted === false);
  check("new contact: fields ensured then written on the new lead",
    rt.calls.includes("GET /v1.0/teamFeatures/listCustomField") && rt.calls.includes(`PUT /v1.0/leads/${NEWID}`) && rec.fieldsResult.ok === true,
    JSON.stringify(rt.calls));
  check("new contact: created exactly as before (tags, not tagsAdd)", Array.isArray(rt.bodies[0].tags) && !("tagsAdd" in rt.bodies[0]));

  rt = route([], [{ leadId: 42, phones: ["9705550100"] }]);
  global.fetch = rt.f;
  await handler(event("spouse@example.com"));
  rec = pushes[pushes.length - 1];
  check("phone-only match: tags added not replaced, but no task, no fields, and the note goes to the create's own id",
    Array.isArray(rt.bodies[0].tagsAdd) && rec.returningResult === undefined && !rt.calls.includes("POST /v2.0/tasks") &&
    !rt.calls.some((c) => c.startsWith("PUT ")) && rec.existing.anyMatch === true, JSON.stringify(rt.calls));

  rt = route([]);
  rt.f = ((inner) => async (url, init = {}) => (/\/v1\.0\/leads\?/.test(String(url)) ? resp(503, "down") : inner(url, init)))(rt.f);
  global.fetch = rt.f;
  await handler(event("new.person@example.com"));
  rec = pushes[pushes.length - 1];
  check("lookup down: the lead still goes to Lofty and her inbox, and nothing new is attempted",
    rec.ok === true && rec.emailResult.ok === true && !rec.returningResult && !rec.fieldsResult &&
    Array.isArray(rt.bodies[0].tags) && !rt.calls.includes("POST /v2.0/tasks") && !rt.calls.some((c) => c.startsWith("PUT ")));

  console.log("\n6. /status explains a returning lead instead of a red tag failure");
  const record = {
    at: "2026-09-29T15:00:00Z", formName: "contact", ok: true, httpStatus: 200, payloadShape: "full", leadId: Number(EXISTING),
    noteResult: { attempted: true, ok: true, httpStatus: 200 },
    tagResult: { attempted: false, skipped: "returning-lead-task", tagRestored: true },
    existing: { ok: true, found: true, leadId: EXISTING },
    returningResult: { attempted: true, ok: true, step: "pushed", taskId: "77" },
    fieldsResult: { attempted: false },
  };
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({ get: async (k) => (k === "lofty-last-push.json" ? record : null), setJSON: async () => {}, list: async () => ({ blobs: [] }) }),
  } };
  for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  process.env.GOOGLE_MAPS_API_KEY = "g";
  global.fetch = async () => { throw new Error("no live calls"); };
  const res = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } });
  const row = JSON.parse(res.body).checks.find((c) => /Lofty notification will fire|merged/.test(c.name));
  check("the row is green and says what happened", row && row.ok === true && /call-back task was created/.test(row.detail), row && row.detail);
  check("and no longer blames the tag", row && !/refused the edit/.test(row.detail));
  record.returningResult = { attempted: true, ok: false, step: "push", httpStatus: 403 };
  const res2 = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } });
  const row2 = JSON.parse(res2.body).checks.find((c) => /Lofty notification will fire/.test(c.name));
  check("a failed push is red, names the step, and says the email still went", row2 && row2.ok === false &&
    /phone push FAILED \(403\)/.test(row2.detail) && /backup email still reached you/.test(row2.detail), row2 && row2.detail);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
