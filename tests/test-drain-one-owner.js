// The retry queue has ONE drain at a time, provably (2026-10-17, Wave 1b).
//
// Both sites run lofty-queue-drain.js on their own schedule (this one, and the other site's), and when this site's
// Blobs settings point at the other's store both read the SAME queue. Signature's 30-minute sync stopped draining
// on 2026-10-04, so each site's lofty-queue-drain.js is the only caller left. The lease every drain takes
// (lib/_lofty.js takeDrainLease) is what keeps two of them off the same queued lead -- two replays of one lead are
// a duplicate create, a second note, or a lost tag. This pins what was added to make that hold:
//
//   1. two drains that find the same dead lease at the same moment: only one takes it over (a write that lands
//      only if the lease is still the dead one it read -- Blobs onlyIfMatch on its etag), so each lead is
//      replayed once;
//   2. "made" is not proof: Netlify Blobs answers any status but 412 to a conditional write as modified:true, so
//      the winner reads the lease back and stands aside unless its own token is there (and when the read fails);
//   3. a drain releases only its own lease;
//   4. a lead the OTHER site queued through the hub (its LOFTY_VIA_HUB on) is never replayed with this site's own
//      key; one this site queued through the hub before turning the switch off again is (the rollback); with the
//      switch on, every queued lead goes through the hub;
//   5. lofty-queue-drain.js is the one place that drains.
//
// The same file runs in both repos; only SITE below differs. Nothing here touches the network.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const SITE = "signature";
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

for (const k of ["LOFTY_VIA_HUB", "LEADS_TO_ROUTER", "LOFTY_QUEUE_DRAIN", "HUB_API_URL", "HUB_API_KEY"]) delete process.env[k];
const L = require(`${FN_DIR}/lib/_lofty.js`);

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const lead = (n, extra) => ({ at: `2026-10-17T1${n}:00:00.000Z`, formName: "contact", lead: { emails: [`q${n}@example.com`], tags: ["Hot Lead - Website"] }, ...(extra || {}) });
const stale = () => ({ at: new Date(Date.now() - 10 * 60000).toISOString(), token: "dead-run" });

// A store with Netlify Blobs' conditional writes: onlyIfNew, onlyIfMatch (etags), getWithMetadata. `barrier`
// holds every lease read until both drains have read it, so they meet exactly at the takeover.
function etagStore(seed, opts) {
  const o = opts || {};
  const data = JSON.parse(JSON.stringify(seed || {}));
  const etags = {};
  let n = 0;
  for (const k of Object.keys(data)) etags[k] = `e${++n}`;
  let waiting = [];
  const hold = async () => {
    if (!o.barrier) return;
    await new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= 2) { waiting.forEach((r) => r()); waiting = []; } else setTimeout(resolve, 300);
    });
  };
  const copy = (v) => JSON.parse(JSON.stringify(v));
  return {
    data,
    get: async (k) => (k in data ? copy(data[k]) : null),
    getWithMetadata: async (k) => {
      const out = k in data ? { data: copy(data[k]), etag: etags[k], metadata: {} } : null;
      if (k === L.DRAIN_LOCK_KEY) await hold();
      return out;
    },
    setJSON: async (k, v, w) => {
      if (w && w.onlyIfNew && k in data) return { modified: false };
      if (w && w.onlyIfMatch && etags[k] !== w.onlyIfMatch) return { modified: false };
      data[k] = copy(v);
      etags[k] = `e${++n}`;
      return { modified: true, etag: etags[k] };
    },
    // The second delete is slow (o.slowSecondDelete): the timing in which the old delete-then-create takeover let
    // the slower drain delete the faster one's fresh lease and both replay the same lead.
    delete: async (k) => {
      const d = (o.deletes = (o.deletes || 0) + 1);
      if (o.slowSecondDelete && d === 2) await new Promise((r) => setTimeout(r, 50));
      delete data[k]; delete etags[k];
    },
  };
}

(async () => {
  const quiet = async (fn) => {
    const keep = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    try { return await fn(); } finally { [console.log, console.warn, console.error] = keep; }
  };
  const posted = [];
  let createMs = 20;
  global.fetch = async (url, init) => {
    const i = init || {};
    if (i.method === "POST" && /\/v1\.0\/leads$/.test(String(url))) {
      posted.push(JSON.parse(i.body).emails[0]);
      await new Promise((r) => setTimeout(r, createMs));
      return resp(200, { data: { leadId: 5 } });
    }
    return resp(200, {});
  };

  console.log("\n1. Two drains find the same dead lease at the same moment");
  // Both read the dead lease together, a replay takes a while, and the second drain is slower: the old
  // delete-then-create takeover replayed the lead twice in exactly this timing.
  createMs = 300;
  let store = etagStore({ [L.FAILED_PUSH_KEY]: [lead(1), lead(2)], [L.DRAIN_LOCK_KEY]: stale() }, { barrier: true, slowSecondDelete: true });
  const [a, b] = await quiet(() => Promise.all([L.drainFailedPushes(store, "k"), L.drainFailedPushes(store, "k")]));
  createMs = 20;
  check("each queued lead is replayed exactly once", posted.slice().sort().join() === "q1@example.com,q2@example.com", posted.join());
  check("one drain took the lease over, the other stood aside", (a.locked === true) !== (b.locked === true), JSON.stringify([a, b]));
  check("the queue is empty and the lease released", store.data[L.FAILED_PUSH_KEY].length === 0 && !(L.DRAIN_LOCK_KEY in store.data));

  console.log("\n2. A write the store calls \"made\" is not proof of the lease");
  posted.length = 0;
  store = etagStore({ [L.FAILED_PUSH_KEY]: [lead(3)] });
  // The library's quirk, plus a competitor: the create-only write reports success, but another drain's lease is
  // what is stored.
  const realSet = store.setJSON;
  store.setJSON = async (k, v, w) => (k === L.DRAIN_LOCK_KEY && w && w.onlyIfNew
    ? (store.data[k] = { at: new Date().toISOString(), token: "someone-else" }, { modified: true, etag: "x" })
    : realSet(k, v, w));
  let r = await quiet(() => L.drainFailedPushes(store, "k"));
  check("the drain reads its lease back, sees another token, and replays nothing", r.locked === true && posted.length === 0 &&
    store.data[L.FAILED_PUSH_KEY].length === 1);
  check("...and leaves the other drain's lease where it is", store.data[L.DRAIN_LOCK_KEY].token === "someone-else");
  store = etagStore({ [L.FAILED_PUSH_KEY]: [lead(3)] });
  const realGet = store.get;
  store.get = async (k, o) => { if (k === L.DRAIN_LOCK_KEY) throw new Error("blobs read failed"); return realGet(k, o); };
  r = await quiet(() => L.drainFailedPushes(store, "k"));
  check("a lease that can't be read back: stand aside (fail closed)", r.locked === true && posted.length === 0);

  console.log("\n3. A drain releases only its own lease");
  store = etagStore({ [L.DRAIN_LOCK_KEY]: { at: new Date().toISOString(), token: "theirs" } });
  await L.releaseDrainLease(store, { token: "mine" });
  check("another drain's lease is left alone", store.data[L.DRAIN_LOCK_KEY].token === "theirs");
  await L.releaseDrainLease(store, { token: "theirs" });
  check("its own is removed", !(L.DRAIN_LOCK_KEY in store.data));
  const taken = await L.takeDrainLease(etagStore({}));
  check("a lease carries a token and the site that took it", !!taken && typeof taken.token === "string" && taken.token.length >= 16 && taken.by === SITE);

  console.log("\n4. Leads queued through the hub, with the switch off here");
  posted.length = 0;
  store = etagStore({ [L.FAILED_PUSH_KEY]: [
    lead(4, { viaHub: true, site: "the-other-site" }),
    lead(5, { viaHub: true, site: SITE }),
    lead(6),
  ] });
  r = await quiet(() => L.drainFailedPushes(store, "k"));
  check("the other site's hub-path lead is never replayed with this site's own key", !posted.includes("q4@example.com") &&
    store.data[L.FAILED_PUSH_KEY].length === 1 && store.data[L.FAILED_PUSH_KEY][0].lead.emails[0] === "q4@example.com", posted.join());
  check("...this site's own (the switch was turned off again: the rollback) and an ordinary one are replayed",
    posted.slice().sort().join() === "q5@example.com,q6@example.com" && r.leftForHub === 1, JSON.stringify(r));
  check("...and /status says why one is still waiting", /left for its own drain/.test(store.data[L.LAST_PUSH_KEY].responseBody));

  console.log("\n   ...and with the switch on here: every queued lead goes through the hub");
  process.env.LOFTY_VIA_HUB = "on";
  process.env.HUB_API_URL = "https://hub.example.test/functions/v1/hub-api";
  process.env.HUB_API_KEY = `hub_${"0".repeat(64)}`; // the shape of a hub key; not a real one
  posted.length = 0;
  const hubPushes = [];
  global.fetch = async (url, init) => {
    const s = String(url);
    const i = init || {};
    if (s.startsWith("https://api.lofty.com/")) { posted.push(`${i.method || "GET"} ${new URL(s).pathname}`); return resp(500, {}); }
    const route = new URL(s).pathname.replace(/^\/functions\/v1\/hub-api/, "");
    const b = i.body ? JSON.parse(i.body) : {};
    if (route === "/v1/lofty/lead") {
      hubPushes.push(b.email);
      return resp(200, { status: "updated", ok: true, lead_id: String(100 + hubPushes.length), action: "existing", merged: false,
        note_added: false, tags_added: b.tags || [] });
    }
    if (route === "/v1/lofty/consent") return resp(200, { status: "found", may_email: true, may_call: false, do_not_contact: false });
    return resp(404, { error: "unknown route" });
  };
  store = etagStore({ [L.FAILED_PUSH_KEY]: [lead(7, { viaHub: true, site: "the-other-site" }), lead(8), lead(9, { viaHub: true, site: SITE })] });
  r = await quiet(() => L.drainFailedPushes(store, "k", { deadline: Date.now() + 20000 }));
  check("all three are replayed through the hub, none with this site's own key",
    hubPushes.slice().sort().join() === "q7@example.com,q8@example.com,q9@example.com" && posted.length === 0 &&
    store.data[L.FAILED_PUSH_KEY].length === 0 && r.viaHub === true, JSON.stringify({ hubPushes, posted, r }));
  for (const k of ["LOFTY_VIA_HUB", "HUB_API_URL", "HUB_API_KEY"]) delete process.env[k];

  console.log("\n5. One place drains");
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "suite-kit") walk(p); }
      else if (e.name.endsWith(".js") && /drainFailedPushes\s*\(/.test(fs.readFileSync(p, "utf8").replace(/\/\/.*$/gm, ""))) callers.push(path.relative(FN_DIR, p));
    }
  };
  walk(FN_DIR);
  check("only lofty-queue-drain.js calls drainFailedPushes (lib/_lofty.js defines it)",
    callers.sort().join() === "lib/_lofty.js,lofty-queue-drain.js", callers.join(", "));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
