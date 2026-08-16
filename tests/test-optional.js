// With no Resend key, the backup-email row must read as OPTIONAL (ℹ️) and must
// NOT drag the page's overall verdict to red -- the crying-wolf mistake the
// Cloudinary row already taught us.
const FN_DIR = "/home/user/signature-property-collection/netlify/functions";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
const record = {
  at: "2026-08-15T19:40:00.000Z", formName: "contact", leadEmail: "buyer@example.com",
  ok: true, httpStatus: 200, payloadShape: "full", leadId: 555,
  emailResult: { attempted: false, reason: "RESEND_API_KEY not set" },
  noteResult: { attempted: true, ok: true },
  tagResult: { attempted: true, ok: true, step: "refired", tagRestored: true },
};
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: {
  getStore: () => ({ get: async (k) => (k === "lofty-last-push.json" ? record : null), setJSON: async () => {}, list: async () => ({ blobs: [] }) }),
} };
process.env.LOFTY_API_KEY = "k";
process.env.GOOGLE_MAPS_API_KEY = "g";
process.env.MLSGRID_API_TOKEN = "m";
delete process.env.RESEND_API_KEY;
global.fetch = async () => { throw new Error("no live calls"); };
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };
(async () => {
  const res = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } });
  const p = JSON.parse(res.body);
  const backup = p.checks.find((c) => /Backup email alert/.test(c.name));
  check("row is renamed to the optional wording", !!backup, p.checks.map((c) => c.name).join(" | "));
  check("row is flagged optional", backup && backup.optional === true);
  check("row does NOT claim to be working", backup && backup.ok === false);
  check("says nothing is broken", backup && /nothing is broken by that/.test(backup.detail));
  check("points at the free no-signup alternative", backup && /Notifications/.test(backup.detail));
  // The stubbed store has no sync state, so unrelated rows are red here. What
  // matters is that the missing Resend key is NOT one of them.
  const reds = p.checks.filter((c) => !c.ok && !c.optional).map((c) => c.name);
  check("missing Resend key is not counted as a failure",
    !reds.some((n) => /email/i.test(n)), "red rows: " + reds.join(", "));
  check("only the empty-stub rows are red",
    reds.every((n) => /Sync running|own listings|Cloudinary configured/.test(n)), reds.join(", "));
  const lofty = p.checks.find((c) => c.name === "Your Lofty notification will fire");
  check("the Lofty route is the one reported green", lofty && lofty.ok === true);
  const html = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: {} });
  check("HTML renders the optional row", /Backup email alert/.test(html.body));
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
