// Renders /site-health against a stored push record shaped exactly like the one
// submission-created.js now writes, so the three new rows are proven to render
// (and to say the right thing) before Christine loads the page.
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

const scenarios = {
  "everything worked (merged lead, tag re-fired)": {
    at: "2026-08-15T19:40:00.000Z", formName: "contact", leadEmail: "thelittleladyinc@gmail.com",
    ok: true, httpStatus: 200, payloadShape: "full", leadId: 1147334685108095,
    emailResult: { attempted: true, ok: true, httpStatus: 200 },
    noteResult: { attempted: true, ok: true, httpStatus: 200 },
    tagResult: { attempted: true, ok: true, step: "refired", tagRestored: true },
  },
  "email failed, lead fine": {
    at: "2026-08-15T19:41:00.000Z", formName: "buyers-page-inquiry", leadEmail: "b@example.com",
    ok: true, httpStatus: 200, payloadShape: "full", leadId: 42,
    emailResult: { attempted: true, ok: false, httpStatus: 403, response: "domain not verified" },
    noteResult: { attempted: true, ok: true },
    tagResult: { attempted: true, ok: true, step: "added", tagRestored: true },
  },
  "tag left off the lead (the dangerous case)": {
    at: "2026-08-15T19:42:00.000Z", formName: "contact", leadEmail: "c@example.com",
    ok: true, httpStatus: 200, payloadShape: "full", leadId: 77,
    emailResult: { attempted: true, ok: true },
    noteResult: { attempted: true, ok: true },
    tagResult: { attempted: true, ok: false, step: "refired", tagRestored: false, httpStatus: 503 },
  },
  // 2026-10-06 (safety review): the nurture plan result is shown on this page too.
  "plan tag added to a new lead": {
    at: "2026-10-06T21:10:00.000Z", formName: "buyers-page-inquiry", leadEmail: "p1@example.com",
    ok: true, httpStatus: 200, payloadShape: "full", leadId: 301,
    emailResult: { attempted: true, ok: true },
    noteResult: { attempted: true, ok: true },
    tagResult: { attempted: true, ok: true, step: "refired", tagRestored: true },
    planResult: { attempted: true, ok: true, step: "added", planTags: ["TOF \u2013 Website Buyer"], added: ["TOF \u2013 Website Buyer"], alreadyPresent: [], tagsSeen: 3 },
  },
  "plan tag refused by Lofty (lead not in its plan)": {
    at: "2026-10-06T21:11:00.000Z", formName: "sellers-guide", leadEmail: "p2@example.com",
    ok: true, httpStatus: 200, payloadShape: "full", leadId: 302,
    emailResult: { attempted: true, ok: true },
    noteResult: { attempted: true, ok: true },
    tagResult: { attempted: true, ok: true, step: "refired", tagRestored: true },
    planResult: { attempted: true, ok: false, step: "added", httpStatus: 503, planTags: ["TOF \u2013 Seller Ready to List"], added: [], response: "upstream busy for p2@example.com" },
  },
  "plan skipped on purpose (returning contact)": {
    at: "2026-10-06T21:12:00.000Z", formName: "listing-inquiry", leadEmail: "p3@example.com",
    ok: true, httpStatus: 200, payloadShape: "full", leadId: 303, inProgress: true,
    emailResult: { attempted: true, ok: true },
    noteResult: { attempted: true, ok: true },
    tagResult: { attempted: false, skipped: "returning-lead-task", tagRestored: true },
    planResult: { attempted: false, skipped: "returning contact: keeps its own plans and lead type (gets the Call task instead)", planTags: ["TOF \u2013 Website Buyer"] },
  },
};

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

(async () => {
  // 2026-10-06: a re-add cut short by a timeout. The stored record is what the
  // REAL refireLoftyTag hands back when the removal went out and the re-add threw,
  // not a hand-typed guess, so this row can't drift from the function. Before the
  // fix that result had no tagRestored flag and the row said "The tag from the
  // original push is still there" about a lead whose tag had just been taken off.
  {
    const { refireLoftyTag } = require(`${FN_DIR}/lib/_notify.js`);
    const quiet = console.error;
    console.error = () => {};
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    let puts = 0;
    global.fetch = async (url, opts = {}) => {
      if ((opts.method || "GET") === "GET") return ok({ lead: { leadId: 88, tags: [{ tagName: "Buyer Lead" }, { tagName: "Hot Lead - Website" }] } });
      if (++puts === 1) return ok({});
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const tagResult = await refireLoftyTag(88, "Hot Lead - Website", "k");
    console.error = quiet;
    scenarios["re-add cut short by a timeout (tag may be off the lead)"] = {
      at: "2026-10-06T19:43:00.000Z", formName: "contact", leadEmail: "d@example.com",
      ok: true, httpStatus: 200, payloadShape: "full", leadId: 88,
      emailResult: { attempted: true, ok: true },
      noteResult: { attempted: true, ok: true },
      tagResult,
    };
  }

  for (const [label, record] of Object.entries(scenarios)) {
    console.log(`\n${label}`);
    require.cache[blobsPath] = {
      id: blobsPath, filename: blobsPath, loaded: true, exports: {
        getStore: () => ({
          get: async (k) => (k === "lofty-last-push.json" ? record : null),
          setJSON: async () => {},
          list: async () => ({ blobs: [] }),
        }),
      },
    };
    for (const k of Object.keys(require.cache)) {
      if (k.startsWith(FN_DIR) && k !== blobsPath) delete require.cache[k];
    }
    process.env.LOFTY_API_KEY = "k";
    process.env.RESEND_API_KEY = "k";
    global.fetch = async () => { throw new Error("no live calls in this test"); };

    const handler = require(`${FN_DIR}/site-health.js`).handler;
    const json = await handler({ queryStringParameters: { format: "json" } });
    check("returns 200", json.statusCode === 200, String(json.statusCode));
    let parsed = null;
    try { parsed = JSON.parse(json.body); } catch (e) {}
    check("body is JSON", !!parsed);
    if (!parsed) continue;

    const row = (n) => parsed.checks.find((c) => c.name === n);
    const email = row("New-lead email reaching you");
    const enrich = row("Your Lofty notification will fire");
    check("email row present", !!email);
    check("enrichment row present", !!enrich);
    if (email) console.log(`       email row: ${email.ok ? "✓" : "✗"} ${email.detail.slice(0, 110)}…`);
    if (enrich) console.log(`       enrich row: ${enrich.ok ? "✓" : "✗"} ${enrich.detail.slice(0, 130)}…`);

    if (label.startsWith("everything")) {
      check("email row green", email.ok === true);
      check("enrich row green", enrich.ok === true);
      check("says the tag was re-added so a repeat enquiry triggers", /removed and re-added/.test(enrich.detail));
    }
    if (label.startsWith("email failed")) {
      check("email row red", email.ok === false);
      check("shows Lofty/Resend's own reason", /domain not verified/.test(email.detail), email.detail);
      check("reassures the lead is safe", /lead itself is safe/.test(email.detail));
    }
    if (label.startsWith("tag left off")) {
      check("enrich row red", enrich.ok === false);
      check("tells her to add the tag by hand", /Add it by hand/.test(enrich.detail), enrich.detail);
    }

    // The nurture plan row: shown only when the record carries a planResult.
    {
      const plan = row("Nurture plan on your last lead");
      if (label.startsWith("plan tag added")) {
        check("plan row present and green", !!plan && plan.ok === true, plan && plan.detail);
        check("plan row names the tag that was added", !!plan && /TOF \u2013 Website Buyer/.test(plan.detail) && /added/.test(plan.detail), plan && plan.detail);
      } else if (label.startsWith("plan tag refused")) {
        check("plan row present and RED", !!plan && plan.ok === false, plan && plan.detail);
        check("plan row says NOT added and tells her which tag to add by hand",
          !!plan && /NOT added/.test(plan.detail) && /add "TOF \u2013 Seller Ready to List" by hand/.test(plan.detail), plan && plan.detail);
        check("plan row carries no personal text", !!plan && !/p2@example\.com/.test(plan.detail), plan && plan.detail);
        const pr = parsed.raw && parsed.raw.loftyLast && parsed.raw.loftyLast.planResult;
        check("the JSON carries the plan result", !!pr && pr.ok === false && pr.step === "added", JSON.stringify(pr));
        check("the JSON plan result has no personal text", !!pr && !/p2@example\.com/.test(JSON.stringify(pr)), JSON.stringify(pr));
      } else if (label.startsWith("plan skipped")) {
        check("plan row present and green (skipped on purpose)", !!plan && plan.ok === true, plan && plan.detail);
        check("plan row says none started", !!plan && /none started/.test(plan.detail), plan && plan.detail);
      } else {
        check("no plan row on a record that carries no plan result", !plan);
      }
    }

    if (label.startsWith("re-add cut short")) {
      check("the record is the real function's output: unconfirmed and not restored",
        record.tagResult.step === "refired-unconfirmed" && record.tagResult.tagRestored === false && record.tagResult.ok === false, JSON.stringify(record.tagResult));
      check("enrich row red", enrich.ok === false);
      check("says the re-add did not finish", /re-add did not finish/.test(enrich.detail), enrich.detail);
      check("tells her to check the lead and add the tag by hand if it is missing",
        /Check that lead in Lofty and add "Hot Lead - Website" by hand if it is missing/.test(enrich.detail), enrich.detail);
      check("does NOT say the tag is still there", !/still there/.test(enrich.detail) && !/unchanged/.test(enrich.detail), enrich.detail);
      check("does not claim the lead IS missing the tag (it may not be)", !/currently missing/.test(enrich.detail) && !/FAILED/.test(enrich.detail), enrich.detail);
      const tr = parsed.raw && parsed.raw.loftyLast && parsed.raw.loftyLast.tagResult;
      check("the JSON carries the step and tagRestored:false",
        !!tr && tr.step === "refired-unconfirmed" && tr.tagRestored === false && tr.ok === false, JSON.stringify(tr));
    }

    // The HTML path is what she actually opens.
    const html = await handler({ queryStringParameters: {} });
    check("HTML renders", html.statusCode === 200 && /New-lead email reaching you/.test(html.body));
  }
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
