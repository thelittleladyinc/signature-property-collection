// Lofty's GET /leads/{id} returns NO tags field on this account (proven by her
// live probe). The site must say so as a settled fact and stop asking her to
// report it — and must still never write tags it couldn't read.
const FN_DIR = "/home/user/signature-property-collection/netlify/functions";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

(async () => {
  const { refireLoftyTag } = require(`${FN_DIR}/lib/_notify.js`);
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${String(url).split("/v1.0")[1]}`);
    // Exactly what Lofty really returns: a lead, with no tags key at all.
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ data: { leadId: 1147802441137106, firstName: "Carrie" } }) };
  };
  const r = await refireLoftyTag(1147802441137106, "Hot Lead - Website", "key");
  check("only the GET happened — no tags were written",
    JSON.stringify(calls) === '["GET /leads/1147802441137106"]', JSON.stringify(calls));
  check("step names the real cause", r.step === "tags-not-returned", r.step);
  check("the lead was left intact", r.tagRestored === true);

  // And the health row.
  const record = {
    at: "2026-08-15T18:51:38.901Z", formName: "contact", leadEmail: "tamateotb@yahoo.com",
    ok: true, httpStatus: 200, payloadShape: "full", leadId: 1147802441137106,
    noteResult: { attempted: true, ok: true }, tagResult: { attempted: true, ok: false, step: "tags-not-returned", tagRestored: true },
  };
  const leadCheck = { checkedAt: "2026-08-16T00:50:31.665Z", leadId: 1147802441137106, ok: true,
    httpStatus: 200, tagShape: "response had no 'tags' field", tagsReadable: false };
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
    getStore: () => ({
      get: async (k) => (k === "lofty-last-push.json" ? record
        : k === "lofty-lead-check.json" ? leadCheck : null),
      setJSON: async () => {}, list: async () => ({ blobs: [] }),
    }),
  } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  process.env.LOFTY_API_KEY = "k"; process.env.GOOGLE_MAPS_API_KEY = "g";
  global.fetch = async () => { throw new Error("no live calls"); };
  const res = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } });
  const p = JSON.parse(res.body);
  const row = p.checks.find((c) => /What Lofty says/.test(c.name));
  console.log(`       ${row.ok ? "✓" : "✗"} ${row.detail.slice(0, 150)}…`);
  check("row is no longer red — it's a Lofty limitation, not a fault", row.ok === true);
  check("states the limitation plainly", /does NOT return tags/.test(row.detail));
  check("explains the returning-buyer consequence", /RETURNING buyer/.test(row.detail));
  check("stops asking her to send the line", !/send me this line/.test(row.detail));
  check("points at the remedy that works", /backup email/.test(row.detail));

  const cov = p.checks.find((c) => /Tour It With Me coverage/.test(c.name));
  check("no bare duplicate town name", !/Windsor, Windsor/.test(cov.detail), cov.detail.slice(-160));
  check("Windsor is qualified by county", /Windsor \((larimer|weld)\)/.test(cov.detail), cov.detail.slice(-160));
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
