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
    calls.push({ url: u, method, body, headers: opts.headers || {} });
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

function submission(data, formName = "contact") {
  return { body: JSON.stringify({ payload: { form_name: formName, data } }) };
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`); }
}
const of = (m, p) => calls.filter((c) => c.method === m && c.url.includes(p));

process.env.LOFTY_API_KEY = "lofty-test-key";
process.env.RESEND_API_KEY = "resend-test-key";

// === 1. Brand-new lead: tag absent after create → single PUT adds it =========
(async () => {
  console.log("\n1. Brand-new lead (trigger tag not on the lead yet)");
  stubFetch(({ url, method }) => {
    if (url.includes("api.resend.com")) return { status: 200, body: { id: "email_1" } };
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 555001 } } };
    if (url.includes("/notes") && method === "POST") return { status: 200, body: { data: { noteId: 9 } } };
    if (url.includes("/leads/555001") && method === "GET") return { status: 200, body: { data: { tags: ["Buyer"] } } };
    if (url.includes("/leads/555001") && method === "PUT") return { status: 200, body: {} };
    return { status: 404, body: { error: "unexpected " + method + " " + url } };
  });
  const res = await loadHandler()(submission({ name: "Dana Reyes", email: "dana@example.com", phone: "970-555-0100", message: "Looking in Fort Morgan" }));
  check("returns 200 ok", res.statusCode === 200 && res.body === "ok", res.body);

  const emails = of("POST", "api.resend.com");
  check("emailed her exactly once", emails.length === 1, `${emails.length} calls`);
  if (emails.length) {
    const e = emails[0];
    check("email subject names the lead and source",
      /New website lead: Dana Reyes — Contact Form/.test(e.body.subject), e.body.subject);
    check("email goes to her inbox", JSON.stringify(e.body.to) === '["thelittleladyinc@gmail.com"]', JSON.stringify(e.body.to));
    check("reply_to is the buyer", e.body.reply_to === "dana@example.com", e.body.reply_to);
    check("email body carries the message", e.body.html.includes("Looking in Fort Morgan"));
    check("email body links the Lofty lead", e.body.html.includes("555001"));
    check("Resend uses Bearer auth", /^Bearer /.test(e.headers.Authorization));
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
  check("health record shows note ok", last && last.noteResult && last.noteResult.ok === true);
  check("health record shows tag added", last && last.tagResult && last.tagResult.step === "added");
})()

// === 2. MERGED lead: tag already present → remove then re-add ===============
.then(async () => {
  console.log("\n2. Merged lead (already carries the trigger tag — her own test case)");
  stubFetch(({ url, method }) => {
    if (url.includes("api.resend.com")) return { status: 200, body: { id: "email_2" } };
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
    if (url.includes("api.resend.com")) return { status: 200, body: { id: "email_3" } };
    if (url.includes("/leads") && method === "POST") return { status: 500, body: { error: "lofty is down" } };
    return { status: 404, body: {} };
  });
  const res = await loadHandler()(submission({ name: "Sam Ortiz", email: "sam@example.com", message: "help" }));
  check("returns 200 to the visitor", res.statusCode === 200);
  check("emailed her anyway", of("POST", "api.resend.com").length === 1);
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
    if (url.includes("api.resend.com")) return { status: 200, body: {} };
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
    if (url.includes("api.resend.com")) return { status: 200, body: {} };
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

// === 6. No Resend key → degrades quietly, Lofty path untouched ==============
.then(async () => {
  console.log("\n6. RESEND_API_KEY missing (must not break the lead push)");
  delete process.env.RESEND_API_KEY;
  stubFetch(({ url, method }) => {
    if (url.includes("api.resend.com")) return { status: 500, body: "should never be called" };
    if (url.includes("/leads") && method === "POST") return { status: 200, body: { data: { leadId: 999 } } };
    if (url.includes("/notes")) return { status: 200, body: {} };
    if (url.includes("/leads/999") && method === "GET") return { status: 200, body: { data: { tags: [] } } };
    if (url.includes("/leads/999") && method === "PUT") return { status: 200, body: {} };
    return { status: 404, body: {} };
  });
  const res = await loadHandler()(submission({ name: "No Email", email: "n@example.com" }));
  check("still returns ok", res.statusCode === 200 && res.body === "ok");
  check("no Resend call attempted", of("POST", "api.resend.com").length === 0);
  check("recorded as not attempted, with the reason",
    stored["lofty-last-push.json"].emailResult.attempted === false, JSON.stringify(stored["lofty-last-push.json"].emailResult));
  check("Lofty note + tag still ran", of("POST", "/notes").length === 1 && of("PUT", "/leads/999").length === 1);
  process.env.RESEND_API_KEY = "resend-test-key";
})

.then(() => {
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})
.catch((e) => { console.error("\nharness error:", e); process.exit(1); });
