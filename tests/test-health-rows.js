// Renders /site-health against a stored push record shaped exactly like the one
// submission-created.js now writes, so the three new rows are proven to render
// (and to say the right thing) before Christine loads the page.
const FN_DIR = "/home/user/signature-property-collection/netlify/functions";
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
};

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

(async () => {
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

    // The HTML path is what she actually opens.
    const html = await handler({ queryStringParameters: {} });
    check("HTML renders", html.statusCode === 200 && /New-lead email reaching you/.test(html.body));
  }
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
