// A replayed lead's follow-up steps stop at the drain's deadline, and a lead
// Lofty has already accepted is never created or noted twice.
//
// 2026-10-05 (re-audit). The scheduled drain (lofty-queue-drain.js) has a
// 20-second budget inside Netlify's 30, but the steps after a replayed create --
// the note, the trigger-tag re-fire, a returning contact's Call task, the
// website fields and inquiry -- took no deadline and could run up to ~30 seconds
// of Lofty calls. A run Netlify killed mid-step never wrote the queue back, so
// the next run replayed a lead Lofty already had: a second note, a second
// re-fire. Now (lib/_lofty.js finishReplay) every follow-up call is capped at
// the deadline, a step starts only with FOLLOWUP_MIN_MS left, and the steps a
// run cannot start go back on the entry (followupsPending, loftyId) for the next
// run to finish alone. The queue is written back in a finally, so a throw
// mid-run keeps what was done.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };
const L = require(`${FN_DIR}/lib/_lofty.js`);
const N = require(`${FN_DIR}/lib/_notify.js`);
const R = require(`${FN_DIR}/lib/_lofty-returning.js`);

function blobStore(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  return {
    data,
    get: async (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : null),
    setJSON: async (k, v, o) => { if (o && o.onlyIfNew && k in data) return { modified: false }; data[k] = JSON.parse(JSON.stringify(v)); return { modified: true }; },
    delete: async (k) => { delete data[k]; },
  };
}
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queued = (over) => ({ at: "2026-10-05T20:00:00.000Z", formName: "contact", ok: false, httpStatus: 503,
  lead: { firstName: "Pat", emails: ["pat@example.com"], source: "The Little Lady Sells Homes - Contact Form", notes: "NEW WEBSITE LEAD — hi", tags: ["Hot Lead - Website", "Website Lead", "contact"] },
  ...(over || {}) });

// Lofty answering a brand-new contact (no match, create -> 777). `delays` holds
// a wait per route key, so a run can be made to run out of time at a chosen
// step. Tag writes are keyed apart from any other PUT by their body.
function fakeLofty(delays) {
  const calls = [];
  const lead777 = { leadId: 777, tags: [{ tagName: "Hot Lead - Website" }, { tagName: "Website Lead" }, { tagName: "contact" }] };
  global.fetch = async (url, init = {}) => {
    const m = init.method || "GET"; const u = String(url);
    let key = `${m} ${u.replace(/^https:\/\/api\.lofty\.com/, "").split("?")[0]}`;
    if (m === "PUT" && init.body && /"tags"/.test(String(init.body))) key += " tags";
    calls.push(key);
    const wait = (delays && delays[key]) || 0;
    if (wait) await sleep(wait);
    if (m === "GET" && /\/v1\.0\/leads\?/.test(u)) return resp(200, { leads: [], _metadata: { total: 0 } });
    if (m === "POST" && /\/v1\.0\/leads$/.test(u)) return resp(200, { leadId: 777 });
    if (m === "GET" && /\/v1\.0\/leads\/777$/.test(u)) return resp(200, { lead: lead777 });
    if (/\/v1\.0\/notes$/.test(u)) return resp(200, { id: 1 });
    return resp(200, {});
  };
  return { calls, count: (k) => calls.filter((c) => c === k).length };
}
const CREATE = "POST /v1.0/leads", LOOKUP = "GET /v1.0/leads", NOTE = "POST /v1.0/notes", TAG = "PUT /v1.0/leads/777 tags";

(async () => {
  check("a follow-up step needs more time than a create does", L.FOLLOWUP_MIN_MS > L.MIN_RETRY_MS);

  console.log("\n1. A run with time for the create but not for a follow-up step");
  // Between the two thresholds: the create starts, no follow-up step may.
  const tight = Math.round((L.MIN_RETRY_MS + L.FOLLOWUP_MIN_MS) / 2);
  let lofty = fakeLofty();
  let store = blobStore({ [L.FAILED_PUSH_KEY]: [queued()] });
  let r = await L.drainFailedPushes(store, "k", { deadline: Date.now() + tight });
  check("the create happened and was accepted", r.recovered === 1 && lofty.count(CREATE) === 1, JSON.stringify(r));
  check("no follow-up step started: no note, no tag write", lofty.count(NOTE) === 0 && lofty.count(TAG) === 0, lofty.calls.join(" | "));
  let q = store.data[L.FAILED_PUSH_KEY];
  check("the entry is kept, marked accepted, with the contact's id and the steps still owed",
    q.length === 1 && String(q[0].loftyId) === "777" && JSON.stringify(q[0].followupsPending) === JSON.stringify(["note", "tag"]) && q[0].ok === true,
    JSON.stringify(q.map((e) => ({ loftyId: e.loftyId, followupsPending: e.followupsPending, ok: e.ok }))));
  check("and it still carries the submission for those steps", q[0].lead && q[0].lead.notes === queued().lead.notes);
  check("the lease is released", !(L.DRAIN_LOCK_KEY in store.data));
  check("the result and the /status record say so", r.deferred === 1 && r.stillQueued === 1 &&
    /accepted by Lofty with follow-up steps left/.test(store.data[L.LAST_PUSH_KEY].responseBody), JSON.stringify([r, store.data[L.LAST_PUSH_KEY]]));

  console.log("\n2. The next run finishes only what is owed");
  lofty = fakeLofty();
  r = await L.drainFailedPushes(store, "k", { deadline: Date.now() + 20000 });
  check("no second create and no lookup", lofty.count(CREATE) === 0 && lofty.count(LOOKUP) === 0, lofty.calls.join(" | "));
  check("the note is posted once and the trigger tag re-fired", lofty.count(NOTE) === 1 && lofty.count(TAG) >= 2, lofty.calls.join(" | "));
  check("the entry is gone; the run counts it as finished, not recovered",
    store.data[L.FAILED_PUSH_KEY].length === 0 && r.finished === 1 && r.recovered === 0 && r.attempted === 0, JSON.stringify(r));
  check("the /status record says so", /1 finished the follow-up steps/.test(store.data[L.LAST_PUSH_KEY].responseBody), store.data[L.LAST_PUSH_KEY].responseBody);

  console.log("\n3. A run that gets partway through the steps");
  // Enough to start the note; the note's own time pushes the tag past the line.
  lofty = fakeLofty({ [NOTE]: 600 });
  store = blobStore({ [L.FAILED_PUSH_KEY]: [queued()] });
  r = await L.drainFailedPushes(store, "k", { deadline: Date.now() + L.FOLLOWUP_MIN_MS + 300 });
  q = store.data[L.FAILED_PUSH_KEY];
  check("the note was posted, the tag was not", lofty.count(NOTE) === 1 && lofty.count(TAG) === 0, lofty.calls.join(" | "));
  check("only the tag is still owed, and the note's outcome rides along",
    q.length === 1 && JSON.stringify(q[0].followupsPending) === JSON.stringify(["tag"]) && q[0].replay && q[0].replay.steps.note.ok === true,
    JSON.stringify(q[0] && { followupsPending: q[0].followupsPending, replay: q[0].replay }));
  lofty = fakeLofty();
  r = await L.drainFailedPushes(store, "k", { deadline: Date.now() + 20000 });
  check("the next run re-fires the tag and does not note again",
    lofty.count(TAG) >= 2 && lofty.count(NOTE) === 0 && lofty.count(CREATE) === 0 && store.data[L.FAILED_PUSH_KEY].length === 0, lofty.calls.join(" | "));

  console.log("\n4. No time at all: the entry waits, untouched");
  lofty = fakeLofty();
  store = blobStore({ [L.FAILED_PUSH_KEY]: [queued({ loftyId: "777", followupsPending: ["note", "tag"], replay: { newId: "777", identity: { ok: true, anyMatch: false, leadId: null }, steps: {} } })] });
  r = await L.drainFailedPushes(store, "k", { deadline: Date.now() + 200 });
  check("nothing called, the entry kept as it was", lofty.calls.length === 0 && store.data[L.FAILED_PUSH_KEY].length === 1 &&
    JSON.stringify(store.data[L.FAILED_PUSH_KEY][0].followupsPending) === JSON.stringify(["note", "tag"]), lofty.calls.join(" | "));

  console.log("\n5. Every follow-up call is capped at the deadline");
  // Lofty hangs; only the abort signal ends a call.
  global.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    if (init.signal) init.signal.addEventListener("abort", () => reject(init.signal.reason || new Error("aborted")));
  });
  // AbortSignal.timeout's timer does not keep Node alive on its own; this does.
  const keepAlive = setTimeout(() => {}, 10000);
  const t0 = Date.now();
  const soon = () => ({ deadline: Date.now() + 100 });
  const [note, tag, task, fields] = await Promise.all([
    N.addLoftyNote("777", "hi", "k", soon()),
    N.refireLoftyTag("777", L.REPLAY_TRIGGER_TAG, "k", soon()),
    R.alertReturningLead("4242", { label: "x" }, "k", soon()),
    R.setWebsiteFields("777", [{ attributeName: "Website Form", value: "x" }], "k", soon()),
  ]);
  const took = Date.now() - t0;
  clearTimeout(keepAlive);
  check("a hung Lofty ends each step at the deadline, not at its own 8- or 5-second cap",
    took < 1500 && note.ok === false && tag.ok === false && task.ok === false && fields.ok === false, `${took}ms ${JSON.stringify([note, tag, task, fields])}`);

  console.log("\n6. A throw mid-run keeps what was done");
  lofty = fakeLofty();
  const inner = global.fetch;
  let creates = 0;
  // The second create comes back as nothing at all (a broken fetch), which throws.
  global.fetch = async (url, init = {}) => ((init.method || "GET") === "POST" && /\/v1\.0\/leads$/.test(String(url)) && ++creates === 2 ? undefined : inner(url, init));
  store = blobStore({ [L.FAILED_PUSH_KEY]: [queued(), queued({ at: "2026-10-05T21:00:00.000Z", formName: "buyers-guide" })] });
  const err = await L.drainFailedPushes(store, "k").then(() => null, (e) => e);
  q = store.data[L.FAILED_PUSH_KEY];
  check("the throw reaches the caller (the drain logs it) and the lease is released", err instanceof Error && !(L.DRAIN_LOCK_KEY in store.data), String(err));
  check("the lead Lofty accepted before the throw is out of the queue; the one not reached is kept",
    q.length === 1 && q[0].formName === "buyers-guide" && !q[0].loftyId, JSON.stringify(q.map((e) => e.formName)));

  console.log("\n7. A re-add cut short during a replay: the replay behaves exactly as it did");
  // 2026-10-06. refireLoftyTag now reports tagRestored:false (step
  // "refired-unconfirmed") when the removal went out and the re-add threw. The
  // replay (finishReplay) stores that result in its steps and reads nothing from it,
  // so a throwing re-add must leave the queue, the lease, the calls and the /status
  // line exactly as a re-add that lands does.
  const pendingTag = () => queued({ loftyId: "777", followupsPending: ["tag"],
    replay: { newId: "777", identity: { ok: true, anyMatch: false, leadId: null }, steps: { note: { ok: true } } } });
  lofty = fakeLofty();
  store = blobStore({ [L.FAILED_PUSH_KEY]: [pendingTag()] });
  const landed = await L.drainFailedPushes(store, "k", { deadline: Date.now() + 20000 });
  const landedLine = store.data[L.LAST_PUSH_KEY].responseBody;
  const landedCalls = lofty.calls.slice();
  lofty = fakeLofty();
  const plain = global.fetch;
  let tagPuts = 0;
  global.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "PUT" && /"tags"/.test(String(init.body)) && ++tagPuts === 2) {
      lofty.calls.push(TAG);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    return plain(url, init);
  };
  store = blobStore({ [L.FAILED_PUSH_KEY]: [pendingTag()] });
  const quiet = console.error;
  console.error = () => {};
  const cut = await L.drainFailedPushes(store, "k", { deadline: Date.now() + 20000 });
  console.error = quiet;
  check("the same calls in the same order: read, remove, re-add -- nothing added, nothing retried",
    JSON.stringify(lofty.calls) === JSON.stringify(landedCalls) && lofty.calls.join(",") === `GET /v1.0/leads/777,${TAG},${TAG}`, lofty.calls.join(" | "));
  check("the entry leaves the queue and the run counts it finished, as when the re-add lands",
    store.data[L.FAILED_PUSH_KEY].length === 0 && cut.finished === 1 && JSON.stringify(cut) === JSON.stringify(landed), JSON.stringify([cut, landed]));
  check("the /status line is the same, and the lease is released",
    store.data[L.LAST_PUSH_KEY].responseBody === landedLine && !(L.DRAIN_LOCK_KEY in store.data), store.data[L.LAST_PUSH_KEY].responseBody);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
