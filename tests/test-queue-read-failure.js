// A failed read or write of the Lofty retry queue never loses a lead, and is never
// reported as "empty" or "ok".
//
// 2026-11-21 (silent-failure audit, H5 / M2 / H4). A Blobs read of the queue that
// threw was taken as an empty queue: recordPush then wrote back a queue holding only
// the new lead (every earlier queued lead gone), the drain said "nothing to do", its
// write-back failure was swallowed, its function answered 200 on a crash, and
// /status said "Empty". And /status?format=json called a live check nobody had run
// for weeks "ok", which is all the hub's daily check reads.
// lib/_lofty.js is shared byte for byte with the other site; this file is too.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

delete process.env.LOFTY_VIA_HUB;
delete process.env.LOFTY_QUEUE_DRAIN;
delete process.env.LEAD_STUCK_ALERT;
delete process.env.LEAD_STUCK_TO_HUB;
delete process.env.STATUS_KEY;
const L = require(`${FN_DIR}/lib/_lofty.js`);

// An in-memory Blobs store with list(); `fail` names keys (or "list") whose calls throw.
function blobStore(seed, fail = {}) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  const boom = (what) => { throw new Error(`blobs ${what} failed`); };
  return {
    data, fail,
    get: async (k) => { if (fail.get && fail.get(k)) boom("get"); return k in data ? JSON.parse(JSON.stringify(data[k])) : null; },
    setJSON: async (k, v, o) => {
      if (fail.set && fail.set(k)) boom("set");
      if (o && o.onlyIfNew && k in data) return { modified: false };
      data[k] = JSON.parse(JSON.stringify(v));
      return { modified: true, etag: "e" };
    },
    delete: async (k) => { if (fail.del && fail.del(k)) boom("delete"); delete data[k]; },
    list: async ({ prefix } = {}) => {
      if (fail.list) boom("list");
      return { blobs: Object.keys(data).filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key, etag: "e" })) };
    },
  };
}
const Q = L.FAILED_PUSH_KEY;
const lead = (n) => ({ at: `2026-11-21T1${n % 10}:0${Math.floor(n / 10)}:00.000Z`, formName: "contact", submissionId: `s${n}`,
  lead: { emails: [`q${n}@example.com`], tags: ["Hot Lead - Website"] } });
const spilledKeys = (s) => Object.keys(s.data).filter((k) => k.startsWith(L.SPILL_PREFIX));
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };

(async () => {
  console.log("\n1. A lead Lofty refused, while the queue cannot be read");
  {
    const s = blobStore({ [Q]: [lead(1), lead(2)] }, { get: (k) => k === Q });
    await quiet(() => L.recordPush(s, { ok: false, httpStatus: 503, submissionId: "s9" }, "buyers-guide", { emails: ["new@example.com"] }));
    check("the queue is not overwritten (both earlier leads still there)", s.data[Q].length === 2 && s.data[Q][0].submissionId === "s1", JSON.stringify(s.data[Q].map((e) => e.submissionId)));
    const ks = spilledKeys(s);
    check("the new lead is kept under its own retry key", ks.length === 1 && s.data[ks[0]].formName === "buyers-guide" && s.data[ks[0]].lead.emails[0] === "new@example.com", ks.join());
    check("the key names no one (a hash, not the email or the submission)", ks.length === 1 && /^lofty-failed\/[0-9a-f]{32}$/.test(ks[0]) && !ks[0].includes("example"), ks[0]);
  }
  {
    const s = blobStore({ [Q]: [lead(1)] }, { set: (k) => k === Q });
    await quiet(() => L.recordPush(s, { ok: false, httpStatus: 503, submissionId: "s9" }, "contact", { emails: ["new@example.com"] }));
    check("a queue write that fails: the lead is kept under its own key", s.data[Q].length === 1 && spilledKeys(s).length === 1);
  }
  {
    const s = blobStore({ [Q]: { not: "a list" } });
    await quiet(() => L.recordPush(s, { ok: false, httpStatus: 503, submissionId: "s9" }, "contact", { emails: ["new@example.com"] }));
    check("something stored that is not a list is left alone; the lead kept under its own key",
      !Array.isArray(s.data[Q]) && s.data[Q].not === "a list" && spilledKeys(s).length === 1);
  }
  {
    const s = blobStore({ [Q]: [lead(1)] }, { set: (k) => k === L.LAST_PUSH_KEY });
    await quiet(() => L.recordPush(s, { ok: false, httpStatus: 503, submissionId: "s9" }, "contact", { emails: ["new@example.com"] }));
    check("the status record failing to save no longer stops the lead being queued", s.data[Q].length === 2 && s.data[Q][0].submissionId === "s9");
  }
  {
    const s = blobStore({ [Q]: Array.from({ length: 25 }, (_, n) => lead(n + 1)) });
    await L.recordPush(s, { ok: false, httpStatus: 503, submissionId: "s99" }, "contact", { emails: ["new@example.com"] });
    const ks = spilledKeys(s);
    check("a full queue (25): the oldest lead is kept under its own key, not dropped",
      s.data[Q].length === 25 && s.data[Q][0].submissionId === "s99" && ks.length === 1 && s.data[ks[0]].submissionId === "s25", ks.join());
    const all = await L.readQueuedLeads(s);
    check("readQueuedLeads counts all 26", all.ok && all.list.length === 26);
  }

  console.log("\n2. The drain");
  {
    const s = blobStore({ [Q]: [lead(1)] }, { get: (k) => k === Q });
    const r = await L.drainFailedPushes(s, "k");
    check("a queue it cannot read is readFailed, never 'nothing to do'", r.readFailed === true && /could not be read/.test(r.error) && r.attempted === 0, JSON.stringify(r));
  }
  {
    const s = blobStore({ [Q]: [lead(1)] });
    s.data[L.spillKey(lead(2))] = lead(2);
    const posted = [];
    global.fetch = async (url, init) => { if (init && init.method === "POST" && /\/leads$/.test(String(url))) posted.push(JSON.parse(init.body).emails[0]); return resp(200, { data: { leadId: 7 } }); };
    const r = await L.drainFailedPushes(s, "k");
    check("a lead kept under its own key is replayed with the list", posted.sort().join() === "q1@example.com,q2@example.com" && r.recovered === 2, posted.join());
    check("...its key is deleted once the list was written", spilledKeys(s).length === 0 && Array.isArray(s.data[Q]) && s.data[Q].length === 0, JSON.stringify(s.data[Q]));
  }
  {
    const s = blobStore({ [Q]: [lead(1)] });
    s.data[L.spillKey(lead(2))] = lead(2);
    global.fetch = async () => resp(503, "down");
    s.fail.set = (k) => k === Q;
    const r = await quiet(() => L.drainFailedPushes(s, "k"));
    check("a write-back that fails is writeFailed (no longer swallowed)", r.writeFailed === true && /could not be written/.test(r.error), JSON.stringify(r));
    check("...and the lead under its own key is kept for the next run", spilledKeys(s).length === 1);
  }
  {
    const s = blobStore({ [Q]: [lead(1)] });
    let reads = 0;
    s.fail.get = (k) => k === Q && ++reads >= 3; // the peek and the read under the lease work; the re-read before writing fails
    global.fetch = async () => resp(503, "down");
    const r = await quiet(() => L.drainFailedPushes(s, "k"));
    check("a re-read that fails before the write-back: the queue is left as it was, writeFailed",
      r.writeFailed === true && s.data[Q].length === 1 && !s.data[Q][0].lastRetryAt, JSON.stringify(r));
  }

  console.log("\n3. The scheduled drain's answer");
  {
    const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
    let store = blobStore({ [Q]: [lead(1)] }, { get: (k) => k === Q });
    require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
    process.env.LOFTY_API_KEY = "k";
    const drain = require(`${FN_DIR}/lofty-queue-drain.js`).handler;
    let out = await quiet(() => drain({}));
    check("an unreadable queue answers 503", out.statusCode === 503 && /no queued lead was dropped/.test(out.body), `${out.statusCode} ${out.body}`);
    const loftyPath = require.resolve(`${FN_DIR}/lib/_lofty.js`);
    const real = require.cache[loftyPath];
    require.cache[loftyPath] = { id: loftyPath, filename: loftyPath, loaded: true,
      exports: { ...real.exports, drainFailedPushes: async () => { throw new Error("boom"); } } };
    try { out = await quiet(() => drain({})); } finally { require.cache[loftyPath] = real; }
    check("a crash answers 500 (it answered 200 'error logged')", out.statusCode === 500 && !/boom/.test(out.body), `${out.statusCode} ${out.body}`);
    delete process.env.LOFTY_API_KEY;
    store = blobStore({ [Q]: [lead(1)] });
    out = await quiet(() => drain({}));
    check("no key and the hub switch off answers 503", out.statusCode === 503 && /no Lofty key configured/.test(out.body), `${out.statusCode} ${out.body}`);
  }

  console.log("\n4. /status");
  {
    const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
    const old = new Date(Date.now() - 34 * 24 * 3600 * 1000).toISOString();
    const seed = { "lofty-last-push.json": { at: old, formName: "contact", ok: true },
      "lofty-key-check.json": { checkedAt: old, ok: false, httpStatus: 401 } };
    let failQueue = true;
    const store = blobStore(seed, { get: (k) => failQueue && k === Q });
    require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore: () => store } };
    for (const k of Object.keys(require.cache)) { if (k.startsWith(FN_DIR) && k !== blobsPath && !k.endsWith(".json")) delete require.cache[k]; }
    process.env.LOFTY_API_KEY = "k";
    global.fetch = async () => { throw new Error("no live calls"); };
    const shMod = require(`${FN_DIR}/site-health.js`);
    const sh = shMod.localHandler || shMod.handler; // the Little Lady copy also has a pass-through handler
    let j = JSON.parse((await sh({ queryStringParameters: { format: "json" } })).body);
    let row = j.checks.find((c) => c.name === "Lofty retry queue");
    check("an unreadable queue is a red, required row (with LEAD_STUCK_ALERT off too)", row && row.ok === false && !row.optional && /Could not read the retry queue/.test(row.detail), JSON.stringify(row));
    check("...and the page's overall light is red", j.allOk === false);
    check("...the raw summary says it was not readable", j.raw && j.raw.loftyFailed && j.raw.loftyFailed.readable === false);
    const key = j.checks.find((c) => c.name === "Lofty API key valid");
    check("a 34-day-old probe reading is ok:null + stale for machines, with when it was checked",
      key && key.ok === null && key.stale === true && key.checkedAt === old, JSON.stringify(key && { ok: key.ok, stale: key.stale, checkedAt: key.checkedAt }));
    const never = j.checks.find((c) => c.name === "What Lofty says about your last lead");
    check("a probe never run is ok:null + stale, checkedAt null", never && never.ok === null && never.stale === true && never.checkedAt === null);
    const html = (await sh({ queryStringParameters: {} })).body;
    const keyRow = (html.match(/<tr>[\s\S]*?<\/tr>/g) || []).find((t) => t.includes("Lofty API key valid")) || "";
    check("the human page keeps the old-reading rule: that row is not red there", /✅/.test(keyRow) && !/❌/.test(keyRow), keyRow.slice(0, 120));
    failQueue = false;
    store.data[L.spillKey(lead(3))] = lead(3);
    j = JSON.parse((await sh({ queryStringParameters: { format: "json" } })).body);
    check("readable again: no red queue row; a lead under its own key is counted", !j.checks.some((c) => c.name === "Lofty retry queue" && c.ok === false) &&
      j.raw.loftyFailed.count === 1 && j.raw.loftyFailed.readable === undefined, JSON.stringify(j.raw.loftyFailed));
    const pub = (await sh({ queryStringParameters: { format: "json" } }));
    process.env.STATUS_KEY = "status-key-for-test";
    const hidden = JSON.parse((await sh({ queryStringParameters: { format: "json" } })).body);
    delete process.env.STATUS_KEY;
    const hk = hidden.checks.find((c) => c.name === "Lofty API key valid");
    check("the public JSON (no key) carries stale and checkedAt too, nothing else new",
      hk && hk.ok === null && hk.stale === true && hk.checkedAt === old && Object.keys(hk).length === 5 && !("detail" in hk), JSON.stringify(hk));
    check("allOk keeps its meaning (no known failure): no stale row is ever ok:false",
      typeof JSON.parse(pub.body).allOk === "boolean" && JSON.parse(pub.body).checks.filter((c) => c.stale).every((c) => c.ok === null));
    delete process.env.LOFTY_API_KEY;
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
