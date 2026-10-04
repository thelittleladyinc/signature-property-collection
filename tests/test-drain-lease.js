// The queue of leads Lofty refused is replayed once, and nothing queued is lost.
//
// 2026-09-30 (API audit). The Little Lady site now drains its own failed-lead
// queue on a schedule, and when its Blobs settings point at this site's store
// both schedules read the same key. drainFailedPushes (lib/_lofty.js, identical in
// both repos) therefore takes a create-only lease before replaying, and writes
// the queue back merged with anything a form queued while it ran.
//
// 2026-10-04 (re-audit). This site drained the queue FIRST inside its 30-minute
// listing sync, with no deadline, in the same 30 seconds Netlify allows -- so a
// slow Lofty could get the run killed before the queue was written back (an
// accepted lead replayed again: a duplicate note, a re-fired tag) and before her
// listings were refreshed. The drain is its own scheduled function now
// (netlify/functions/lofty-queue-drain.js), with a 20-second budget, exactly as
// on the Little Lady site; section 5 pins that.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const L = require(`${FN_DIR}/lib/_lofty.js`);

// A store with Netlify Blobs' create-only semantics ({ onlyIfNew } -> modified:false).
function blobStore(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  return {
    data,
    get: async (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : null),
    setJSON: async (k, v, o) => {
      if (o && o.onlyIfNew && k in data) return { modified: false };
      data[k] = JSON.parse(JSON.stringify(v));
      return { modified: true, etag: "e" };
    },
    delete: async (k) => { delete data[k]; },
  };
}
const lead = (n) => ({ at: `2026-09-30T1${n}:00:00.000Z`, formName: "contact", lead: { emails: [`q${n}@example.com`], tags: ["Hot Lead - Website"] } });
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

(async () => {
  console.log("\n1. Two schedules draining the same queue at once");
  let store = blobStore({ [L.FAILED_PUSH_KEY]: [lead(1), lead(2)] });
  const posted = [];
  global.fetch = async (url, init) => {
    posted.push(JSON.parse(init.body).emails[0]);
    await new Promise((r) => setTimeout(r, 20));
    return resp(200, { data: { leadId: 5 } });
  };
  const [a, b] = await Promise.all([L.drainFailedPushes(store, "k"), L.drainFailedPushes(store, "k")]);
  check("each queued lead is replayed exactly once", posted.sort().join() === "q1@example.com,q2@example.com", posted.join());
  check("one drain did the work, the other stood aside", (a.locked === true) !== (b.locked === true), JSON.stringify([a, b]));
  check("the queue is empty afterwards and the lease released",
    store.data[L.FAILED_PUSH_KEY].length === 0 && !(L.DRAIN_LOCK_KEY in store.data));

  console.log("\n2. A lead that fails while a drain is running is kept");
  store = blobStore({ [L.FAILED_PUSH_KEY]: [lead(1)] });
  let landed = false;
  global.fetch = async (url, init) => {
    // A form's recordPush lands mid-drain, exactly as the live handler writes it:
    // once, while the replay's create is in flight (the drain also reads Lofty
    // before and after the create; those reads are not submissions).
    if (init && init.method === "POST" && !landed) {
      landed = true;
      await L.recordPush(store, { ok: false, httpStatus: 503 }, "buyers-guide", { emails: ["new@example.com"] });
    }
    return resp(200, { data: { leadId: 6 } });
  };
  await L.drainFailedPushes(store, "k");
  const q = store.data[L.FAILED_PUSH_KEY];
  check("the replayed lead is gone and the new failure is still queued",
    q.length === 1 && q[0].formName === "buyers-guide" && q[0].lead.emails[0] === "new@example.com", JSON.stringify(q));

  console.log("\n3. Leases");
  store = blobStore({ [L.FAILED_PUSH_KEY]: [lead(1)], [L.DRAIN_LOCK_KEY]: { at: new Date().toISOString() } });
  posted.length = 0;
  // Count creates only: the drain's identity and texting reads are not replays.
  global.fetch = async (url, init) => { if (init && init.method === "POST") posted.push(1); return resp(200, {}); };
  let r = await L.drainFailedPushes(store, "k");
  check("a live lease held elsewhere: nothing replayed, queue untouched",
    r.locked === true && posted.length === 0 && store.data[L.FAILED_PUSH_KEY].length === 1);
  store = blobStore({ [L.FAILED_PUSH_KEY]: [lead(1)], [L.DRAIN_LOCK_KEY]: { at: new Date(Date.now() - 10 * 60000).toISOString() } });
  r = await L.drainFailedPushes(store, "k");
  check("a lease left by a run that died is taken over", r.recovered === 1 && store.data[L.FAILED_PUSH_KEY].length === 0);

  console.log("\n4. A caller's deadline");
  store = blobStore({ [L.FAILED_PUSH_KEY]: [lead(1), lead(2)] });
  posted.length = 0;
  r = await L.drainFailedPushes(store, "k", { deadline: Date.now() + 500 });
  check("no replay starts that can't finish in time; the queue is written back intact",
    posted.length === 0 && r.attempted === 0 && store.data[L.FAILED_PUSH_KEY].length === 2);

  console.log("\n5. This site's scheduled drain");
  const fs = require("fs");
  const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
  store = blobStore({ [L.FAILED_PUSH_KEY]: [lead(1)] });
  const storeNames = [];
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
    exports: { getStore: (name) => { storeNames.push(typeof name === "string" ? name : name && name.name); return store; } } };
  const toml = fs.readFileSync(`${ROOT}/netlify.toml`, "utf8");
  check("netlify.toml schedules it", /\[functions\."lofty-queue-drain"\]\s*\n\s*schedule = "[^"]+"/.test(toml));
  check("...offset from the listing sync's :00/:30 and the Little Lady's :15/:45",
    /\[functions\."lofty-queue-drain"\]\s*\n\s*schedule = "5,35 \* \* \* \*"/.test(toml));
  const drainSrc = fs.readFileSync(`${FN_DIR}/lofty-queue-drain.js`, "utf8");
  check("a run's budget is 20 seconds inside Netlify's 30", /DRAIN_BUDGET_MS = 20000/.test(drainSrc) &&
    /deadline: Date\.now\(\) \+ DRAIN_BUDGET_MS/.test(drainSrc));
  // The word may survive in a comment; a call or the import may not.
  const syncSrc = fs.readFileSync(`${FN_DIR}/sync-listings.js`, "utf8");
  check("the listing sync no longer drains the queue itself",
    !/drainFailedPushes\s*\(/.test(syncSrc) && !/require\("\.\/lib\/_lofty"\)/.test(syncSrc));
  delete process.env.LOFTY_API_KEY;
  const drain = require(`${FN_DIR}/lofty-queue-drain.js`).handler;
  posted.length = 0;
  global.fetch = async (url, init) => { if (init && init.method === "POST") posted.push(1); return resp(200, {}); };
  let out = await drain();
  check("with no Lofty key it does nothing", out.statusCode === 200 && posted.length === 0 && store.data[L.FAILED_PUSH_KEY].length === 1);
  process.env.LOFTY_API_KEY = "k";
  out = await drain();
  check("it replays the queued lead from the store submission-created writes to",
    out.statusCode === 200 && posted.length === 1 && store.data[L.FAILED_PUSH_KEY].length === 0 &&
    storeNames.includes("mls-listings"), JSON.stringify(storeNames));
  global.fetch = async () => resp(503, "down");
  store.data[L.FAILED_PUSH_KEY] = [lead(2)];
  out = await drain();
  check("Lofty still down: the lead stays queued with the retry noted",
    store.data[L.FAILED_PUSH_KEY].length === 1 && !!store.data[L.FAILED_PUSH_KEY][0].lastRetryAt);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
