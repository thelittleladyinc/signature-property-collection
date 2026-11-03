// 2026-11-03: two /status rows that stayed red for days and made the hub's
// daily Connections check count the site as failing, although nothing on the
// site was broken:
//   - "Every listing Lofty reports is still on the MLS" is red whenever the
//     sync hides a Lofty record the MLS says is off the market. That is the
//     site doing the right thing; only Lofty support can correct the record.
//     Now noted (optional), never a failure.
//   - "Your Lofty notification will fire" reports the LAST push only, and the
//     record is rewritten only by the next lead, so one push that went wrong
//     stayed red indefinitely. After 48 hours a failed record is history: still
//     shown and dated, but optional. A fresh failure is red exactly as before.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

async function render(records) {
  require.cache[blobsPath] = {
    id: blobsPath, filename: blobsPath, loaded: true, exports: {
      getStore: () => ({
        get: async (k) => (Object.prototype.hasOwnProperty.call(records, k) ? records[k] : null),
        setJSON: async () => {},
        list: async () => ({ blobs: [] }),
      }),
    },
  };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath) delete require.cache[k];
  }
  process.env.LOFTY_API_KEY = "k";
  process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api"; process.env.HUB_API_KEY = "hub_test";
  global.fetch = async () => { throw new Error("no live calls in this test"); };
  // This repo serves /status itself (exports.handler); the main site's copy goes
  // through lib/_backend-mode.js and exposes the same code as localHandler.
  const mod = require(`${FN_DIR}/site-health.js`);
  const res = await (mod.localHandler || mod.handler)({ queryStringParameters: { format: "json" } });
  const parsed = JSON.parse(res.body);
  return (n) => parsed.checks.find((c) => c.name === n);
}

const failedPush = (at) => ({
  at, formName: "contact", leadEmail: "c@example.com",
  ok: true, httpStatus: 200, payloadShape: "full", leadId: 77,
  emailResult: { attempted: true, ok: true },
  noteResult: { attempted: true, ok: true },
  tagResult: { attempted: true, ok: false, step: "refired", tagRestored: false, httpStatus: 503 },
});
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const NOTIFY = "Your Lofty notification will fire";
const LISTED = "Every listing Lofty reports is still on the MLS";

(async () => {
  console.log("\n1. A push that went wrong an hour ago is red, as before");
  let row = (await render({ "lofty-last-push.json": failedPush(iso(3600e3)) }))(NOTIFY);
  check("row present", !!row);
  check("red", row && row.ok === false);
  check("not optional", row && !row.optional);
  check("tells her to add the tag by hand", row && /Add it by hand/.test(row.detail), row && row.detail);
  check("no stale note", row && !/From the last lead/.test(row.detail));

  console.log("\n2. The same record three days later is history: shown, dated, optional");
  row = (await render({ "lofty-last-push.json": failedPush(iso(3 * 86400e3 + 60e3)) }))(NOTIFY);
  check("still not ok", row && row.ok === false);
  check("optional now", row && row.optional === true);
  check("dated, in days", row && /^From the last lead, 3 day\(s\) ago \(\d{4}-\d{2}-\d{2}\)/.test(row.detail), row && row.detail);
  check("says the next lead rewrites it", row && /next lead rewrites this row/.test(row.detail));
  check("keeps the original advice", row && /Add it by hand/.test(row.detail));

  console.log("\n3. A function cut short (inProgress) three days ago is history too");
  const cut = { ...failedPush(iso(3 * 86400e3 + 60e3)), inProgress: true, tagResult: { attempted: false } };
  row = (await render({ "lofty-last-push.json": cut }))(NOTIFY);
  check("not ok", row && row.ok === false);
  check("optional", row && row.optional === true);
  check("says the function stopped early", row && /stopped before it finished/.test(row.detail), row && row.detail);

  console.log("\n4. Just under 48 hours is still a live fault");
  row = (await render({ "lofty-last-push.json": failedPush(iso(47 * 3600e3)) }))(NOTIFY);
  check("red and not optional", row && row.ok === false && !row.optional);

  console.log("\n5. A good push, however old, stays green and is never marked stale");
  const good = { ...failedPush(iso(30 * 86400e3)), tagResult: { attempted: true, ok: true, step: "refired", tagRestored: true } };
  row = (await render({ "lofty-last-push.json": good }))(NOTIFY);
  check("green", row && row.ok === true, row && row.detail);
  check("not optional", row && !row.optional);
  check("no stale note", row && !/From the last lead/.test(row.detail));

  console.log("\n6. A record with no date is judged as before (no aging)");
  const undated = { ...failedPush(iso(3 * 86400e3)) }; delete undated.at;
  row = (await render({ "lofty-last-push.json": undated }))(NOTIFY);
  check("red and not optional", row && row.ok === false && !row.optional);

  console.log("\n7. A listing the MLS says is off the market: hidden, named, optional");
  const state = { lastRunAt: iso(600e3), mlsCheck: "checked", hiddenOffMarket: [
    { listingId: "IRE1062804", address: "1 Example St", city: "Greeley", status: "Active", why: "the MLS has it as Expired" },
  ] };
  row = (await render({ "lofty-sync-state.json": state }))(LISTED);
  check("row present", !!row);
  check("not ok (the record is wrong at Lofty)", row && row.ok === false);
  check("optional (the site is right to hide it)", row && row.optional === true);
  check("names the listing and sends her to Lofty support", row && /IRE1062804/.test(row.detail) && /Ask Lofty support/.test(row.detail), row && row.detail);

  console.log("\n8. Nothing hidden: green and required, as before");
  row = (await render({ "lofty-sync-state.json": { ...state, hiddenOffMarket: [] } }))(LISTED);
  check("green", row && row.ok === true, row && row.detail);
  check("not optional", row && !row.optional);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
