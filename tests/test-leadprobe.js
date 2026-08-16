// The read-back probe must give a straight answer for each of the four outcomes
// that actually matter, without needing a screenshot relayed by hand.
const FN_DIR = "/home/user/signature-property-collection/netlify/functions";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const cases = [
  ["tag IS on the lead (string tags)", 200,
    { data: { tags: ["Hot Lead - Website", "Website Lead"] } },
    (r) => {
      check("row is green", r.ok === true);
      check("confirms the read worked", /Read lead 1147334685108095 back from Lofty/.test(r.detail));
      check("names the shape", /array of 2 item\(s\) of type string/.test(r.detail), r.detail);
      check("says the tag IS there", /IS on the lead/.test(r.detail));
      check("points at the Smart Plan trigger as the remaining suspect", /trigger inside the plan/.test(r.detail));
    }],
  ["tag MISSING from the lead", 200,
    { data: { tags: ["Website Lead"] } },
    (r) => {
      check("row is red", r.ok === false);
      check("says the tag is NOT there", /is NOT on the lead/.test(r.detail), r.detail);
      check("explains why the plan wouldn't fire", /wouldn't fire/.test(r.detail));
    }],
  ["tags come back as OBJECTS (the data-loss shape)", 200,
    { data: { tags: [{ id: 7, name: "Hot Lead - Website" }] } },
    (r) => {
      check("row is red", r.ok === false);
      check("names the object shape", /type object/.test(r.detail), r.detail);
      check("says tags are left alone", /leaves them alone/.test(r.detail));
      check("includes a sample to fix the reader with", /"name":"Hot Lead - Website"/.test(r.detail), r.detail);
    }],
  ["Lofty won't return the lead at all", 404, "not found",
    (r) => {
      check("row is red", r.ok === false);
      check("shows Lofty's status", /404/.test(r.detail), r.detail);
      check("explains what a 404 would mean", /can never be re-fired/.test(r.detail));
    }],
];

(async () => {
  for (const [label, status, body, assert] of cases) {
    console.log(`\n${label}`);
    const written = {};
    require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
      getStore: () => ({
        get: async (k) => (k === "lofty-last-push.json"
          ? { at: "2026-08-15T18:51:40.000Z", formName: "contact", ok: true, httpStatus: 200,
              leadId: 1147334685108095, payloadShape: "full",
              noteResult: { attempted: true, ok: true }, tagResult: { attempted: true, ok: true, step: "added" } }
          : null),
        setJSON: async (k, v) => { written[k] = v; },
        list: async () => ({ blobs: [] }),
      }),
    } };
    for (const k of Object.keys(require.cache)) {
      if (k.startsWith(FN_DIR) && k !== blobsPath) delete require.cache[k];
    }
    process.env.LOFTY_API_KEY = "k";
    process.env.GOOGLE_MAPS_API_KEY = "g";
    delete process.env.RESEND_API_KEY;

    const seen = [];
    global.fetch = async (url, opts = {}) => {
      seen.push({ url: String(url), method: opts.method || "GET" });
      if (String(url).includes("/leads/")) {
        return { ok: status >= 200 && status < 300, status,
          text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
          headers: { get: () => null } };
      }
      // Every other probe (Google, /me, photos) — keep them out of the way.
      return { ok: false, status: 503, text: async () => "{}", json: async () => ({}), headers: { get: () => null } };
    };

    const res = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json", probe: "1" } });
    const p = JSON.parse(res.body);
    const row = p.checks.find((c) => c.name === "What Lofty says about your last lead");
    check("row exists", !!row);
    if (!row) continue;
    console.log(`       ${row.ok ? "✓" : "✗"} ${row.detail}`);
    assert(row);

    const leadCalls = seen.filter((s) => s.url.includes("/leads/"));
    check("the probe is READ-ONLY — only a GET touched the lead",
      leadCalls.length === 1 && leadCalls[0].method === "GET", JSON.stringify(leadCalls));
    check("result cached so refreshes don't hammer Lofty", !!written["lofty-lead-check.json"]);
  }

  console.log("\nno probe requested => no Lofty call at all");
  const seen2 = [];
  global.fetch = async (url) => { seen2.push(String(url)); return { ok: false, status: 503, text: async () => "{}", headers: { get: () => null } }; };
  for (const k of Object.keys(require.cache)) { if (k.startsWith(FN_DIR) && k !== blobsPath) delete require.cache[k]; }
  const res2 = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } });
  check("nothing was fetched", seen2.length === 0, JSON.stringify(seen2));
  const row2 = JSON.parse(res2.body).checks.find((c) => c.name === "What Lofty says about your last lead");
  check("row tells her how to run it", /add \?probe=1/.test(row2.detail), row2.detail);
  check("not-yet-run does not read as broken", row2.ok === true);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
