// What the lead note records about the two consent boxes, and that the second box
// (the Terms/Privacy one) can never cost anyone a lead.
//
// 2026-11-03 (10DLC, ported from The Little Lady site). Every lead form now has two checkboxes in Lofty's exact
// wording (tests/test-consent-boxes.js checks the pages). This is the server half,
// run through the real submission-created handler against a fake Lofty:
//
//   - a yes to texts is written into the Lofty note with the NEW exact sentence,
//     not the old "marketing communication" one, so the note shows what was
//     actually agreed to;
//   - every note also says whether the Terms/Privacy box (`terms_agree`) was
//     ticked: "Terms/Privacy box: ticked", or "...NOT ticked on this submission";
//   - a submission with NO terms_agree at all (a bot, a direct POST, a page cached
//     from before the box existed) is still created, noted, emailed and routed
//     exactly like one with it -- the field is a record, never a gate;
//   - the texting decision did not change: only an explicit sms_consent yes can
//     turn texting on, and terms_agree neither grants nor withholds it;
//   - `terms_agree` is not forwarded to Lofty as a field, tag or note field.
//
// Nothing here calls Lofty or Resend: fetch is a fake that records every request.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Lofty's sentence, character for character (spelled out, not imported).
const SMS = "By checking this box, I agree to receive transactional and informational SMS communications, " +
  "including appointment reminders, property updates, and account notifications from Little Lady. " +
  "Message frequency varies. Message and data rates may apply. Reply HELP for help or STOP to opt out.";
const TERMS_TICKED = "Terms/Privacy box: ticked";
const TERMS_NOT = "Terms/Privacy box: NOT ticked on this submission";
const NEWID = "1149000000000001";
const HOT = "Hot Lead - Website";

function resp(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

// A trimmed fake Lofty (the same shape as tests/test-sms-consent.js's): a brand-new
// contact, every call recorded, the create's body and the alert email kept whole.
function fakeLofty() {
  const f = { calls: [], posts: [], puts: [], emails: [], notes: [], leads: { [NEWID]: { phones: ["+1 970-555-0100"], emails: ["pat@example.com"], tags: [HOT, "Website Lead", "contact"] } } };
  f.fetch = async (url, init = {}) => {
    const s = String(url); const m = init.method || "GET";
    const p = s.replace(/^https:\/\/(api\.lofty\.com|hub\.example\.test\/functions\/v1\/hub-api)/, "").split("?")[0];
    f.calls.push(`${m} ${p}`);
    if (/hub\.example\.test/.test(s)) { f.emails.push(JSON.parse(init.body)); return resp(200, { status: "sent", provider_id: "e1" }); }
    if (m === "GET" && /\/v1\.0\/leads\?/.test(s)) return resp(200, { leads: [] });
    if (m === "POST" && /\/v1\.0\/leads$/.test(s)) { f.posts.push(JSON.parse(init.body)); return resp(200, `{"data":{"leadId": ${NEWID}}}`); }
    if (/\/notes$/.test(s)) { f.notes.push(JSON.parse(init.body)); return resp(200, "{}"); }
    if (/\/v2\.0\/tasks$/.test(s)) return resp(200, `{"taskId": 77}`);
    if (/send-task-reminder$/.test(s)) return resp(200, { message: "ok" });
    if (/listCustomField/.test(s)) return resp(200, { data: [] });
    if (/custom-field$/.test(s)) return resp(200, "{}");
    if (/\/inquiry$/.test(s)) return resp(200, "{}");
    const one = s.match(/\/v1\.0\/leads\/(\d+)$/);
    if (one && m === "GET") { const l = f.leads[one[1]]; return l ? resp(200, { data: { leadId: Number(one[1]), ...l } }) : resp(404, { message: "Lead not exist" }); }
    if (one && m === "PUT") { const b = JSON.parse(init.body); f.puts.push({ id: one[1], body: b }); if (f.leads[one[1]]) Object.assign(f.leads[one[1]], b); return resp(200, "{}"); }
    return resp(404, `unexpected ${m} ${s}`);
  };
  return f;
}

const mem = {};
const pushes = [];
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
  getStore: () => ({
    get: async (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : null),
    setJSON: async (k, v) => { if (k === "lofty-last-push.json") pushes.push(v); mem[k] = JSON.parse(JSON.stringify(v)); return { modified: true }; },
    delete: async (k) => { delete mem[k]; },
    list: async () => ({ blobs: [] }),
  }),
} };
for (const k of Object.keys(require.cache)) if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
process.env.LOFTY_API_KEY = "k";
process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api"; process.env.HUB_API_KEY = "hub_test";
delete process.env.FLODESK_API_KEY;
const handler = require(`${FN_DIR}/submission-created.js`).handler;

const quiet = async (fn) => { const w = console.warn; const lg = console.log; const e = console.error; console.warn = console.log = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.log = lg; console.error = e; } };
const person = (extra) => ({ name: "Pat Buyer", email: "pat@example.com", phone: "(970) 555-0100", message: "Hi", ...extra });
async function submit(data, form = "contact") {
  const f = fakeLofty();
  global.fetch = f.fetch;
  const before = pushes.length;
  const out = await quiet(() => handler({ body: JSON.stringify({ payload: { form_name: form, data } }) }));
  return { f, out, rec: pushes.length > before ? pushes[pushes.length - 1] : {}, note: (f.posts[0] && f.posts[0].notes) || "" };
}
const textingOn = (f) => f.puts.filter((p) => p.body.cannotText === false);
const emailText = (f) => f.emails.map((e) => String(e.html || "") + String(e.text || "")).join("\n");

(async () => {
  console.log("\n1. A yes to texts records the NEW sentence, and the Terms box");
  let r = await submit(person({ terms_agree: "yes", sms_consent: "yes" }));
  check("the lead is created", r.f.posts.length === 1, JSON.stringify(r.f.calls));
  check("the note carries the exact new SMS sentence, quoted", r.note.includes(`Agreed to: "${SMS}"`), r.note.slice(r.note.indexOf("CONSENT")));
  check("the note no longer carries the old marketing wording", !/marketing communication|Msg\/data|Consent is not a condition/i.test(r.note), r.note);
  check("the note says the Terms/Privacy box was ticked", r.note.includes(TERMS_TICKED) && !r.note.includes(TERMS_NOT));
  check("the note says SMS consent: YES", /SMS consent: YES/.test(r.note));
  check("the same note is what gets written to the lead", r.f.notes.length === 1 && r.f.notes[0].content === r.note, JSON.stringify(r.f.notes).slice(0, 300));
  check("and what Christine's alert email shows", emailText(r.f).includes(TERMS_TICKED) && emailText(r.f).includes("By checking this box, I agree to receive transactional"));
  check("texting turned on after the create, as before (explicit yes, only phone)", r.f.posts[0].cannotText === true && textingOn(r.f).length === 1, JSON.stringify(r.f.puts));
  const withTerms = JSON.stringify(r.f.puts);

  console.log("\n2. No terms_agree at all: the lead is still taken, noted and emailed");
  r = await submit(person({ sms_consent: "yes" }));
  check("the lead is created in Lofty", r.f.posts.length === 1 && r.f.calls.includes("POST /v1.0/leads"), JSON.stringify(r.f.calls));
  check("the alert email still goes out", r.f.emails.length === 1, JSON.stringify(r.f.calls));
  check("the lead's note is still written", r.f.notes.length === 1);
  check("the note says the Terms/Privacy box was NOT ticked", r.note.includes(TERMS_NOT) && !r.note.includes(TERMS_TICKED), r.note.slice(r.note.indexOf("CONSENT")));
  check("the handler answers 200 and ok (nothing held or dropped)", r.out && r.out.statusCode === 200 && r.out.body === "ok", JSON.stringify(r.out));
  check("it is not held for review or queued", !r.rec.manualReview && !(r.rec.ok === false), JSON.stringify({ manualReview: r.rec.manualReview, ok: r.rec.ok }));
  check("the texting writes are exactly what they are with the box ticked (terms_agree decides nothing)", JSON.stringify(r.f.puts) === withTerms, JSON.stringify(r.f.puts));

  console.log("\n3. Texting stays off without an explicit sms_consent yes, whatever terms_agree says");
  for (const [label, data] of [
    ["terms ticked, SMS box left unticked (field absent)", person({ terms_agree: "yes" })],
    ["neither box", person()],
    ["terms ticked, sms_consent blank", person({ terms_agree: "yes", sms_consent: "" })],
    ["terms ticked, sms_consent \"no\"", person({ terms_agree: "yes", sms_consent: "no" })],
    ["terms ticked, sms_consent nonsense", person({ terms_agree: "yes", sms_consent: "maybe" })],
    ["only terms_agree=yes sent as the consent (not a yes to texts)", person({ terms_agree: "yes", consent: "yes" })],
  ]) {
    r = await submit(data);
    check(`${label}: created with cannotText:true`, r.f.posts.length === 1 && r.f.posts[0].cannotText === true);
    check(`${label}: texting never turned on, no consent tag`, !textingOn(r.f).length && !JSON.stringify(r.f.puts).includes("Consent"), JSON.stringify(r.f.puts));
    check(`${label}: the note records no SMS agreement`, !/Agreed to:/.test(r.note) && /Do NOT text/.test(r.note), r.note.slice(r.note.indexOf("CONSENT")));
    check(`${label}: ...and still says whether the Terms box was ticked`, r.note.includes(data.terms_agree ? TERMS_TICKED : TERMS_NOT));
  }

  console.log("\n4. Only a real tick counts as the Terms box");
  for (const v of ["", "no", "off", "false", "0", "maybe", "   "]) {
    r = await submit(person({ terms_agree: v }));
    check(`terms_agree=${JSON.stringify(v)}: recorded as NOT ticked, lead still created`, r.note.includes(TERMS_NOT) && r.f.posts.length === 1);
  }
  for (const v of ["yes", "on", "YES", "true"]) {
    r = await submit(person({ terms_agree: v }));
    check(`terms_agree=${JSON.stringify(v)}: recorded as ticked`, r.note.includes(TERMS_TICKED) && !r.note.includes(TERMS_NOT));
  }

  console.log("\n5. terms_agree is a record only: never a field, tag or custom value in Lofty");
  r = await submit(person({ terms_agree: "yes", sms_consent: "yes" }));
  check("the create call has no terms_agree key, tag or value", !/terms_agree/i.test(JSON.stringify(r.f.posts[0])) && !(r.f.posts[0].tags || []).concat(r.f.posts[0].tagsAdd || []).some((t) => /terms/i.test(t)), JSON.stringify(r.f.posts[0].tags));
  check("no write to the lead carries it", !/terms_agree/i.test(JSON.stringify(r.f.puts)) && !/terms_agree/i.test(JSON.stringify(r.f.notes)));
  check("the push record kept for /status does not carry it", !/terms_agree/i.test(JSON.stringify(r.rec)));
  r = await submit(person({ terms_agree: "yes", sms_consent: "yes" }), "buyers-guide");
  check("a different form behaves the same", r.f.posts.length === 1 && r.note.includes(TERMS_TICKED) && r.note.includes(`Agreed to: "${SMS}"`));

  console.log("\n6. The wording in the page and the wording in the note are one sentence");
  const fs = require("fs");
  const buildPy = fs.readFileSync(`${ROOT}/build/build.py`, "utf8");
  const py = require("child_process").spawnSync("python3", ["-I", "-c", [
    "import importlib.util, json",
    "spec = importlib.util.spec_from_file_location('spc_build', 'build/build.py')",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "print(json.dumps(m.CONSENT_SMS_TEXT))",
  ].join("\n")], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let pageText = null; try { pageText = JSON.parse(py.stdout.split("\n").filter(Boolean).pop()); } catch (e) { pageText = null; }
  check("build.py's SMS sentence is the one submission-created.js records", pageText === SMS && /build\.py/.test(buildPy), String(py.stderr).slice(-300));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
