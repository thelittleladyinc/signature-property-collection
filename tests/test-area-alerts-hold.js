// Saved-area alert emails cannot reach a subscriber automatically (2026-10-15).
//
// Christine: one transactional sender, the Seller Intelligence hub. The runner
// (area-alerts-run.js) no longer calls Resend; an alert email is an email to a
// lead, so it may go only as the hub's kind "lead", and only once someone has
// approved automatic lead email by name (AREA_ALERTS_APPROVED_BY). Nobody has,
// so the runner holds -- nothing sent, no alert seeded or marked -- and says why.
// The hub itself is stubbed here: nothing in this suite reaches the network.
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const HUB_URL = "https://hub.example.test/functions/v1/hub-api";
const SUBSCRIBER = "buyer.person@example.com";
const ALERT_ID = "a-" + Buffer.from(SUBSCRIBER).toString("base64url"); // as area-alerts.js builds it
const FRESH_STATE = { lastRunAt: new Date(Date.now() - 3600e3).toISOString(), lastSuccessAt: new Date(Date.now() - 3600e3).toISOString() };
// 2026-10-18: a run needs the run key (tests/test-area-alerts-run-auth.js); a made-up one here.
const RUN_KEY = "test-area-alerts-run-key-0001";
const LISTING = { listingId: "IRE700001", address: "5 Test Ct", city: "Loveland", state: "CO", price: 1200000, status: "Active", beds: 4, baths: 3, sqft: 3000 };

function makeStore(alert) {
  const writes = [];
  return {
    writes,
    get: async (k) => {
      if (k === "sync-state.json") return FRESH_STATE;
      if (k === "listings.json") return { [LISTING.listingId]: LISTING };
      if (k === ALERT_ID) return alert;
      return null;
    },
    setJSON: async (k, v) => { writes.push([k, v]); },
    list: async () => ({ blobs: [{ key: ALERT_ID }] }),
  };
}

let calls = [];
function stubHub(reply) {
  calls = [];
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), headers: opts.headers || {}, redirect: opts.redirect, body });
    if (!String(url).startsWith(HUB_URL)) throw new Error(`unexpected request to ${url}`);
    const r = typeof reply === "function" ? reply(body) : reply;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
}

const logs = [];
async function run(env, alert, reply) {
  for (const k of ["LISTINGS_SOURCE", "IDX_DISPLAY", "AREA_ALERTS_APPROVED_BY", "HUB_API_URL", "HUB_API_KEY", "LEAD_ALERT_FROM"]) delete process.env[k];
  Object.assign(process.env, { BLOBS_SITE_ID: "s", BLOBS_TOKEN: "t", AREA_ALERTS_RUN_KEY: RUN_KEY }, env);
  const store = makeStore(alert);
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k];
  }
  stubHub(reply || { status: 200, body: { status: "sent", provider_id: "re_1" } });
  const orig = { log: console.log, warn: console.warn, error: console.error };
  logs.length = 0;
  const cap = (...a) => logs.push(a.map(String).join(" "));
  console.log = cap; console.warn = cap; console.error = cap;
  let res;
  try { res = await require(`${FN_DIR}/area-alerts-run.js`).handler({ headers: { "x-area-alerts-key": RUN_KEY } }); }
  finally { Object.assign(console, orig); }
  return { res, store };
}

const ON = { LISTINGS_SOURCE: "mlsgrid", IDX_DISPLAY: "on", HUB_API_URL: HUB_URL, HUB_API_KEY: "hub_test_key" };
const alert = () => ({ id: ALERT_ID, email: SUBSCRIBER, cities: ["Loveland"], label: "Loveland", knownIds: [] });
const newAlert = () => ({ id: ALERT_ID, email: SUBSCRIBER, cities: ["Loveland"], label: "Loveland" });

(async () => {
  const { AREA_ALERTS_HOLD_REASON } = require(`${FN_DIR}/area-alerts-run.js`);

  console.log("\n1. No approver (today): held, with the reason");
  let r = await run(ON, alert());
  check("nothing is sent: no request at all", calls.length === 0, JSON.stringify(calls.map((c) => c.url)));
  check("no alert is touched (resumes exactly where it was)", r.store.writes.length === 0);
  check("the run says it is held, and why", r.res.statusCode === 200 && r.res.body === `held: ${AREA_ALERTS_HOLD_REASON}`, r.res.body);
  check("the reason is Christine's decision on automatic lead email",
    AREA_ALERTS_HOLD_REASON === "area alerts need Christine's decision: automatic lead email");
  check("...and it is in the log", logs.some((l) => l.includes(AREA_ALERTS_HOLD_REASON)), logs.join(" | "));
  r = await run(ON, newAlert());
  check("a brand-new alert is not even seeded while held", calls.length === 0 && r.store.writes.length === 0);
  r = await run({ ...ON, AREA_ALERTS_APPROVED_BY: "   " }, alert());
  check("a blank approver is no approver", calls.length === 0 && r.store.writes.length === 0 && /^held: /.test(r.res.body), r.res.body);

  console.log("\n2. Still paused on Lofty listings, approver or not");
  r = await run({ ...ON, LISTINGS_SOURCE: "lofty", AREA_ALERTS_APPROVED_BY: "Christine" }, alert());
  check("no request, no alert touched", calls.length === 0 && r.store.writes.length === 0 && /paused/.test(r.res.body), r.res.body);

  console.log("\n3. With a named approver: one lead email, through the hub only");
  r = await run({ ...ON, AREA_ALERTS_APPROVED_BY: "Christine 2026-10-15" }, alert());
  check("exactly one request, to the hub's send route", calls.length === 1 && calls[0].url === `${HUB_URL}/v1/email/send`, JSON.stringify(calls.map((c) => c.url)));
  const b = calls[0] && calls[0].body;
  check("kind lead, to the one subscriber", b && b.kind === "lead" && JSON.stringify(b.to) === JSON.stringify([SUBSCRIBER]), JSON.stringify(b && { kind: b.kind, n: (b.to || []).length }));
  check("names who approved it", b && b.approved_by === "Christine 2026-10-15");
  check("an https unsubscribe link that appears in the message", b && /^https:\/\//.test(b.unsubscribe_url) && b.html.includes(b.unsubscribe_url), b && b.unsubscribe_url);
  check("no From unless LEAD_ALERT_FROM is set (the hub picks it)", b && !("from" in b));
  check("the hub key rides in x-hub-key; redirects refused", calls[0].headers["x-hub-key"] === "hub_test_key" && calls[0].redirect === "manual");
  check("the idempotency key carries no address (not even the base64 alert id)", b && /^area-alert:[0-9a-f]{24}:[0-9a-f]{24}$/.test(b.idempotency_key) &&
    !b.idempotency_key.includes(ALERT_ID.slice(2)), b && b.idempotency_key);
  check("sent: the new homes are marked seen", r.store.writes.length === 1 && r.store.writes[0][1].knownIds.includes(LISTING.listingId));
  const firstKey = b && b.idempotency_key;
  r = await run({ ...ON, AREA_ALERTS_APPROVED_BY: "Christine 2026-10-15" }, alert(), { status: 200, body: { status: "duplicate", previous: "sent" } });
  check("a repeated run asks under the same key (the hub sends a key once)", calls[0] && calls[0].body.idempotency_key === firstKey);

  console.log("\n4. The hub says no: nothing marked, nothing logged about the person");
  for (const [label, reply] of [
    ["lead email switch off", { status: 200, body: { status: "not_sent", reason: "lead_off" } }],
    ["already emailed today", { status: 200, body: { status: "not_sent", reason: "already_today" } }],
    ["on the opt-out list", { status: 200, body: { status: "not_sent", reason: "suppressed", suppressed: [{ email: SUBSCRIBER, reason: "unsubscribed" }] } }],
    ["hub down", { status: 503, body: { error: "hub unavailable; nothing sent" } }],
  ]) {
    r = await run({ ...ON, AREA_ALERTS_APPROVED_BY: "Christine" }, alert(), reply);
    check(`${label}: knownIds untouched, retried next run`, calls.length === 1 && r.store.writes.length === 0, r.res.body);
    check(`${label}: the log never names the subscriber`, !logs.some((l) => l.includes(SUBSCRIBER) || l.includes(ALERT_ID)), logs.join(" | "));
  }

  console.log("\n5. Approved but the hub is not configured: nothing sent, nothing lost");
  r = await run({ LISTINGS_SOURCE: "mlsgrid", IDX_DISPLAY: "on", AREA_ALERTS_APPROVED_BY: "Christine" }, alert());
  check("no request, no alert touched", calls.length === 0 && r.store.writes.length === 0, r.res.body);
  check("the log names the missing settings, not the subscriber",
    logs.some((l) => /HUB_API_URL and HUB_API_KEY not set/.test(l)) && !logs.some((l) => l.includes(SUBSCRIBER)), logs.join(" | "));

  console.log("\n6. No direct Resend path is left");
  const src = fs.readFileSync(`${FN_DIR}/area-alerts-run.js`, "utf8");
  check("no Resend endpoint, key or test sender in the runner", !/api\.resend\.com|RESEND_API_KEY|onboarding@resend\.dev/.test(src));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
