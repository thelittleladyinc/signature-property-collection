// Exercises submission-created.js end to end with fetch and Blobs stubbed, so
// the three new notification steps are proven before Christine tests a form.
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const path = require("path");
const FN_DIR = `${ROOT}/netlify/functions`;

// --- stub @netlify/blobs -----------------------------------------------------
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
const stored = {};
require.cache[blobsPath] = {
  id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({
      get: async (k) => (k in stored ? stored[k] : null),
      setJSON: async (k, v) => { stored[k] = v; },
    }),
  },
};

let calls = [];
function stubFetch(handler) {
  calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch (e) {}
    calls.push({ url: u, method, body, headers: opts.headers || {}, redirect: opts.redirect });
    const r = handler({ url: u, method, body });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body || {})),
      json: async () => r.body,
      headers: { get: () => null },
    };
  };
}

function loadHandler() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath) delete require.cache[k];
  }
  return require(path.join(FN_DIR, "submission-created.js")).handler;
}

// Netlify gives every submission an id; the hub's idempotency key is built from it.
const SUB_ID = "6710a1b2c3d4e5f6a7b8c9d0";
function submission(data, formName = "contact", id = SUB_ID) {
  return { body: JSON.stringify({ payload: { form_name: formName, ...(id ? { id } : {}), data } }) };
}
const HUB = "hub.example.test";
const SENT = (id) => ({ status: 200, body: { status: "sent", provider_id: id } });

let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`); }
}
const of = (m, p) => calls.filter((c) => c.method === m && c.url.includes(p));

process.env.LOFTY_API_KEY = "lofty-test-key";
process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api";
process.env.HUB_API_KEY = "hub_test_key";
delete process.env.LEAD_ALERT_FROM;
delete process.env.LEAD_ALERT_TO;

// === 1. Brand-new lead: tag absent after create → single PUT adds it =========
(async () => {
  console.log("\n1. Brand-new lead (trigger tag not on the lead yet)");
  stubFetch(({ url, method }) => {
    if (url.includes(HUB)) return SENT("email_1");
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 555001 } } };
    if (url.includes("/notes") && method === "POST") return { status: 200, body: { data: { noteId: 9 } } };
    if (url.includes("/leads/555001") && method === "GET") return { status: 200, body: { data: { tags: ["Buyer"] } } };
    if (url.includes("/leads/555001") && method === "PUT") return { status: 200, body: {} };
    return { status: 404, body: { error: "unexpected " + method + " " + url } };
  });
  const res = await loadHandler()(submission({ name: "Dana Reyes", email: "dana@example.com", phone: "970-555-0100", message: "Looking in Fort Morgan" }));
  check("returns 200 ok", res.statusCode === 200 && res.body === "ok", res.body);

  const emails = of("POST", HUB);
  check("emailed her exactly once, through the hub", emails.length === 1, `${emails.length} calls`);
  if (emails.length) {
    const e = emails[0];
    check("email subject names the lead and source",
      /New website lead: Dana Reyes — Contact Form/.test(e.body.subject), e.body.subject);
    check("email goes to her inbox", JSON.stringify(e.body.to) === '["thelittleladyinc@gmail.com"]', JSON.stringify(e.body.to));
    check("reply_to is the buyer", e.body.reply_to === "dana@example.com", e.body.reply_to);
    check("email body carries the message", e.body.html.includes("Looking in Fort Morgan"));
    check("email body links the Lofty lead", e.body.html.includes("555001"));
    check("to the hub's send route", e.url === "https://hub.example.test/functions/v1/hub-api/v1/email/send", e.url);
    check("the hub key rides in x-hub-key, never in the URL", e.headers["x-hub-key"] === "hub_test_key" && !e.url.includes("hub_test_key"));
    check("kind alert", e.body.kind === "alert", e.body.kind);
    check("no From unless LEAD_ALERT_FROM is set (the hub picks it)", !("from" in e.body), e.body.from);
    check("idempotency key from the form name and Netlify's submission id",
      new RegExp(`^lead-alert:[a-z]+:contact:${SUB_ID}$`).test(e.body.idempotency_key), e.body.idempotency_key);
    check("redirects are refused", e.redirect === "manual", e.redirect);
  }

  const notes = of("POST", "/notes");
  check("wrote one timeline note", notes.length === 1, `${notes.length} calls`);
  if (notes.length) {
    check("note uses a NUMERIC leadId", notes[0].body.leadId === 555001, typeof notes[0].body.leadId);
    check("note content is the banner + message", /NEW WEBSITE LEAD/.test(notes[0].body.content));
    check("note endpoint is /notes, not /leads/{id}/notes", /\/v1\.0\/notes$/.test(notes[0].url), notes[0].url);
    check("Lofty uses token auth", /^token /.test(notes[0].headers.Authorization));
  }

  const puts = of("PUT", "/leads/555001");
  check("one PUT only (tag was missing, so just add it)", puts.length === 1, `${puts.length} PUTs`);
  if (puts.length) {
    check("PUT keeps existing tags and adds the trigger tag",
      JSON.stringify(puts[0].body.tags) === '["Buyer","Hot Lead - Website"]', JSON.stringify(puts[0].body.tags));
  }
  const last = stored["lofty-last-push.json"];
  check("health record shows email ok", last && last.emailResult && last.emailResult.ok === true);
  check("...and what the hub said", last && last.emailResult.hubStatus === "sent" && last.emailResult.via === "hub", JSON.stringify(last && last.emailResult));
  check("nothing goes to Resend directly", calls.every((c) => !c.url.includes("resend")));
  check("health record shows note ok", last && last.noteResult && last.noteResult.ok === true);
  check("health record shows tag added", last && last.tagResult && last.tagResult.step === "added");
})()

// === 2. MERGED lead: tag already present → remove then re-add ===============
.then(async () => {
  console.log("\n2. Merged lead (already carries the trigger tag — her own test case)");
  stubFetch(({ url, method }) => {
    if (url.includes(HUB)) return SENT("email_2");
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 1147334685108095 } } };
    if (url.includes("/notes") && method === "POST") return { status: 200, body: {} };
    if (url.includes("/leads/1147334685108095") && method === "GET") {
      return { status: 200, body: { data: { tags: ["Hot Lead - Website", "Website Lead", "contact"] } } };
    }
    if (url.includes("/leads/1147334685108095") && method === "PUT") return { status: 200, body: {} };
    return { status: 404, body: { error: "unexpected" } };
  });
  await loadHandler()(submission({ name: "Christine Gwinnup", email: "thelittleladyinc@gmail.com", message: "test 4" }));

  const puts = of("PUT", "/leads/1147334685108095");
  check("two PUTs: remove then re-add", puts.length === 2, `${puts.length} PUTs`);
  if (puts.length === 2) {
    check("first PUT drops the trigger tag",
      !puts[0].body.tags.includes("Hot Lead - Website"), JSON.stringify(puts[0].body.tags));
    check("first PUT keeps the other tags",
      JSON.stringify(puts[0].body.tags) === '["Website Lead","contact"]', JSON.stringify(puts[0].body.tags));
    check("second PUT restores the full original tag set",
      JSON.stringify(puts[1].body.tags) === '["Hot Lead - Website","Website Lead","contact"]', JSON.stringify(puts[1].body.tags));
  }
  const last = stored["lofty-last-push.json"];
  check("recorded as a genuine re-fire", last.tagResult.step === "refired" && last.tagResult.ok === true);
  check("tag confirmed restored", last.tagResult.tagRestored === true);
  check("still emailed her on a merge", last.emailResult.ok === true);
  check("still wrote a note on a merge", of("POST", "/notes").length === 1);
})

// === 3. Lofty push fails outright → she must STILL be emailed ================
.then(async () => {
  console.log("\n3. Lofty rejects the lead (email must still go out)");
  stubFetch(({ url, method }) => {
    if (url.includes(HUB)) return SENT("email_3");
    if (url.includes("/leads") && method === "POST") return { status: 500, body: { error: "lofty is down" } };
    return { status: 404, body: {} };
  });
  const res = await loadHandler()(submission({ name: "Sam Ortiz", email: "sam@example.com", message: "help" }));
  check("returns 200 to the visitor", res.statusCode === 200);
  check("emailed her anyway", of("POST", HUB).length === 1);
  check("no note/tag attempted without a lead id",
    of("POST", "/notes").length === 0 && of("PUT", "/leads").length === 0);
  const queue = stored["lofty-failed-pushes.json"];
  check("failed push queued for retry", Array.isArray(queue) && queue.length >= 1, JSON.stringify(queue && queue.length));
  check("health record shows the email succeeded while the push failed",
    stored["lofty-last-push.json"].ok === false && stored["lofty-last-push.json"].emailResult.ok === true);
})

// === 4. Re-add fails → tag must be reported as MISSING, loudly ===============
.then(async () => {
  console.log("\n4. Tag removed but re-add fails (the one dangerous case)");
  let putCount = 0;
  stubFetch(({ url, method }) => {
    if (url.includes(HUB)) return SENT("email_x");
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 777 } } };
    if (url.includes("/notes")) return { status: 200, body: {} };
    if (url.includes("/leads/777") && method === "GET") return { status: 200, body: { data: { tags: ["Hot Lead - Website"] } } };
    if (url.includes("/leads/777") && method === "PUT") {
      putCount++;
      return putCount === 1 ? { status: 200, body: {} } : { status: 503, body: "lofty unavailable" };
    }
    return { status: 404, body: {} };
  });
  await loadHandler()(submission({ name: "Kim Lee", email: "kim@example.com" }));
  const t = stored["lofty-last-push.json"].tagResult;
  check("re-add retried once before giving up", putCount === 3, `${putCount} PUTs`);
  check("reported as not ok", t.ok === false);
  check("flags the tag as NOT restored", t.tagRestored === false, JSON.stringify(t));
})

// === 5. Removal itself fails → nothing changed, tag still safe ===============
.then(async () => {
  console.log("\n5. Lofty refuses the tag edit entirely (nothing lost)");
  stubFetch(({ url, method }) => {
    if (url.includes(HUB)) return SENT("email_x");
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 888 } } };
    if (url.includes("/notes")) return { status: 200, body: {} };
    if (url.includes("/leads/888") && method === "GET") return { status: 200, body: { data: { tags: ["Hot Lead - Website"] } } };
    if (url.includes("/leads/888") && method === "PUT") return { status: 403, body: "forbidden" };
    return { status: 404, body: {} };
  });
  await loadHandler()(submission({ name: "Pat Doe", email: "pat@example.com" }));
  const t = stored["lofty-last-push.json"].tagResult;
  check("only one PUT attempted", of("PUT", "/leads/888").length === 1);
  check("tag reported as still present", t.tagRestored === true && t.step === "remove", JSON.stringify(t));
})

// === 6. Hub not configured → degrades quietly, Lofty path untouched =========
.then(async () => {
  console.log("\n6. HUB_API_URL / HUB_API_KEY missing (must not break the lead push)");
  delete process.env.HUB_API_KEY;
  const lofty = ({ url, method }) => {
    if (url.includes(HUB)) return { status: 500, body: "should never be called" };
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 999 } } };
    if (url.includes("/notes")) return { status: 200, body: {} };
    if (url.includes("/leads/999") && method === "GET") return { status: 200, body: { data: { tags: [] } } };
    if (url.includes("/leads/999") && method === "PUT") return { status: 200, body: {} };
    return { status: 404, body: {} };
  };
  stubFetch(lofty);
  const res = await loadHandler()(submission({ name: "No Email", email: "n@example.com" }));
  check("still returns ok", res.statusCode === 200 && res.body === "ok");
  check("no hub call attempted", of("POST", HUB).length === 0);
  check("recorded as not attempted, naming the missing setting",
    stored["lofty-last-push.json"].emailResult.attempted === false &&
    stored["lofty-last-push.json"].emailResult.reason === "HUB_API_KEY not set", JSON.stringify(stored["lofty-last-push.json"].emailResult));
  check("Lofty note + tag still ran", of("POST", "/notes").length === 1 && of("PUT", "/leads/999").length === 1);

  process.env.HUB_API_KEY = "hub_test_key";
  process.env.HUB_API_URL = "http://hub.example.test/functions/v1/hub-api";
  stubFetch(lofty);
  await loadHandler()(submission({ name: "No Email", email: "n@example.com" }));
  check("a plain-http HUB_API_URL is refused before any call (the key would travel in the clear)",
    of("POST", HUB).length === 0 && /https/.test(stored["lofty-last-push.json"].emailResult.reason),
    JSON.stringify(stored["lofty-last-push.json"].emailResult));
  process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api";
})

// === 7. LEAD_ALERT_FROM: passed to the hub only when set ======================
// The hub accepts it only if it is its email_from or in email_from_allowed. A
// refused From must not cost her the alert: asked once more without it.
.then(async () => {
  console.log("\n7. LEAD_ALERT_FROM (a sender the hub may or may not allow)");
  process.env.LEAD_ALERT_FROM = "Christine <leads@example.com>";
  const lofty = ({ url, method }) => {
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 777 } } };
    if (url.includes("/notes")) return { status: 200, body: {} };
    if (url.includes("/leads/777") && method === "GET") return { status: 200, body: { data: { tags: [] } } };
    if (url.includes("/leads/777") && method === "PUT") return { status: 200, body: {} };
    return { status: 404, body: {} };
  };
  stubFetch((r) => (r.url.includes(HUB) ? SENT("email_7") : lofty(r)));
  await loadHandler()(submission({ name: "Sender Test", email: "s@example.com" }));
  let emails = of("POST", HUB);
  check("one email, naming her sender", emails.length === 1 && emails[0].body.from === process.env.LEAD_ALERT_FROM,
    JSON.stringify(emails.map((e) => e.body.from)));
  check("recorded as her own sender", stored["lofty-last-push.json"].emailResult.sender === "custom");

  stubFetch((r) => {
    if (r.url.includes(HUB)) {
      return r.body.from
        ? { status: 400, body: { error: "from is not an address the hub allows (flags email_from / email_from_allowed)" } }
        : SENT("email_8");
    }
    return lofty(r);
  });
  await loadHandler()(submission({ name: "Sender Test", email: "s@example.com" }));
  emails = of("POST", HUB);
  const er = stored["lofty-last-push.json"].emailResult;
  check("a refused sender is asked once more without a From", emails.length === 2 &&
    !("from" in emails[1].body), JSON.stringify(emails.map((e) => e.body.from)));
  check("...under the same idempotency key", emails.length === 2 && emails[0].body.idempotency_key === emails[1].body.idempotency_key);
  check("...the alert still counts as sent, and says why", er.ok === true && er.fromFallback === true &&
    er.customFromRefused.httpStatus === 400 && er.sender === "hub", JSON.stringify(er));
  delete process.env.LEAD_ALERT_FROM;
})

// === 8. What the hub can answer, and a retried function ======================
.then(async () => {
  console.log("\n8. Hub answers (a retry never sends twice; a failure never fails the form)");
  const lofty = ({ url, method }) => {
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 4242 } } };
    if (url.includes("/notes")) return { status: 200, body: {} };
    if (url.includes("/leads/4242") && method === "GET") return { status: 200, body: { data: { tags: [] } } };
    if (url.includes("/leads/4242") && method === "PUT") return { status: 200, body: {} };
    return { status: 404, body: {} };
  };
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const capture = (...a) => logs.push(a.map(String).join(" "));
  const lead = { name: "Robin Vale", email: "robin.vale@example.com", phone: "970-555-0142", message: "two acres" };
  const runWith = async (hubReply, data = lead, id = "sub-retry-0001") => {
    stubFetch((r) => {
      if (!r.url.includes(HUB)) return lofty(r);
      if (typeof hubReply === "function") return hubReply(r);
      return hubReply;
    });
    console.log = capture; console.error = capture; console.warn = capture;
    try { return await loadHandler()(submission(data, "contact", id)); }
    finally { Object.assign(console, orig); }
  };

  let res = await runWith(SENT("email_9"));
  const firstKey = of("POST", HUB)[0].body.idempotency_key;
  res = await runWith({ status: 200, body: { status: "duplicate", previous: "sent", provider_id: "email_9" } });
  let er = stored["lofty-last-push.json"].emailResult;
  check("a retried function asks under the same key", of("POST", HUB)[0].body.idempotency_key === firstKey, firstKey);
  check("...and the hub's duplicate counts as already sent", er.ok === true && er.hubStatus === "duplicate" && er.previous === "sent", JSON.stringify(er));

  const answers = [
    ["switch off", { status: 200, body: { status: "not_sent", reason: "off" } }, "not_sent"],
    ["on the opt-out list", { status: 200, body: { status: "not_sent", reason: "suppressed", suppressed: [{ email: "thelittleladyinc@gmail.com", reason: "manual" }] } }, "not_sent"],
    ["Resend refused it", { status: 200, body: { status: "failed", reason: "auth_or_domain" } }, "failed"],
    ["sent, no answer", { status: 200, body: { status: "held", reason: "unknown_delivery" } }, "held"],
    ["hub down", { status: 503, body: { error: "hub unavailable; nothing sent" } }, "http_error"],
    ["wrong key", { status: 401, body: { error: "unauthorized" } }, "http_error"],
    ["a redirect", { status: 302, body: "" }, "redirect_refused"],
  ];
  for (const [label, reply, want] of answers) {
    res = await runWith(reply);
    er = stored["lofty-last-push.json"].emailResult;
    check(`${label}: the form still succeeds, the lead still reaches Lofty`, res.statusCode === 200 && res.body === "ok" && of("POST", "/notes").length === 1, res.body);
    check(`${label}: recorded as not confirmed (${want})`, er.ok === false && er.hubStatus === want, JSON.stringify(er));
    check(`${label}: no address kept in the record`, !/@/.test(JSON.stringify(er)), JSON.stringify(er));
  }
  res = await runWith(() => { throw new Error("network down"); });
  er = stored["lofty-last-push.json"].emailResult;
  check("the hub unreachable: the form still succeeds", res.statusCode === 200 && res.body === "ok" && er.ok === false && er.hubStatus === "no_answer", JSON.stringify(er));
  const alertLogs = logs.filter((l) => /lead alert/i.test(l));
  check("the alert's log lines name statuses only: no name, email or phone", alertLogs.length > 0 &&
    !alertLogs.some((l) => /robin|vale|@|970-555-0142|9705550142/i.test(l)), alertLogs.join(" | "));

  // No submission id (never seen from Netlify): still one key per submission, with no personal data in it.
  await runWith(SENT("email_10"), lead, null);
  const k = of("POST", HUB)[0].body.idempotency_key;
  check("without a submission id the key is a hash, never the lead's details",
    /^lead-alert:[a-z]+:contact:h[0-9a-f]{32}$/.test(k) && !/robin|example|970/i.test(k), k);
  await runWith(SENT("email_11"), { ...lead, email: "robin at example dot com" }, "sub-bad-email-01");
  const e = of("POST", HUB);
  check("a malformed lead email is left off reply_to rather than costing the alert", e.length === 1 && !("reply_to" in e[0].body),
    JSON.stringify(e.map((x) => x.body.reply_to)));
})

.then(() => {
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})
.catch((e) => { console.error("\nharness error:", e); process.exit(1); });
