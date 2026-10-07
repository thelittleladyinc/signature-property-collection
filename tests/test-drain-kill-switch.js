// LOFTY_QUEUE_DRAIN=off stops every replay of a queued website lead.
//
// 2026-10-07 (safety review). The scheduled queue drain re-sends leads Lofty
// refused and, for a contact proven new, adds the nurture-plan tag, which starts
// Lofty's own emails. Its only off switch was removing LOFTY_API_KEY from the
// whole site. This is a proper one: set LOFTY_QUEUE_DRAIN to off and nothing is
// replayed or touched; unset it and the queue resumes where it waited.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const L = require(`${FN_DIR}/lib/_lofty.js`);

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
const lead = (n) => ({ at: `2026-10-07T1${n}:00:00.000Z`, formName: "contact", lead: { emails: [`q${n}@example.com`], tags: ["Hot Lead - Website"] } });
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

(async () => {
  console.log("\n1. The switch is read strictly");
  const saved = process.env.LOFTY_QUEUE_DRAIN;
  for (const v of ["off", "OFF", " off ", "false", "0", "no", "pause", "paused"]) {
    process.env.LOFTY_QUEUE_DRAIN = v;
    check(`"${v}" turns the drain off`, L.queueDrainOff() === true);
  }
  for (const v of [undefined, "", "on", "true", "1", "yes", "offf", "of", "disabled-not"]) {
    if (v === undefined) delete process.env.LOFTY_QUEUE_DRAIN; else process.env.LOFTY_QUEUE_DRAIN = v;
    check(`${JSON.stringify(v)} leaves the drain running`, L.queueDrainOff() === false);
  }

  console.log("\n2. Off: nothing is replayed, looked up, created or tagged, and the queue is untouched");
  process.env.LOFTY_QUEUE_DRAIN = "off";
  let store = blobStore({ [L.FAILED_PUSH_KEY]: [lead(1), lead(2)] });
  let calls = 0;
  global.fetch = async () => { calls++; return resp(200, { data: { leadId: 9 } }); };
  let r = await L.drainFailedPushes(store, "k");
  check("it reports paused and attempts nothing", r.paused === true && r.attempted === 0 && r.recovered === 0, JSON.stringify(r));
  check("no request of any kind went to Lofty", calls === 0, `calls=${calls}`);
  check("both queued leads are still there, no lease taken",
    store.data[L.FAILED_PUSH_KEY].length === 2 && !(L.DRAIN_LOCK_KEY in store.data));

  console.log("\n3. Back on: the queue resumes where it waited");
  delete process.env.LOFTY_QUEUE_DRAIN;
  const posted = [];
  global.fetch = async (url, init) => { if (init && init.method === "POST" && /\/leads$/.test(String(url))) posted.push(1); return resp(200, { data: { leadId: 9 } }); };
  r = await L.drainFailedPushes(store, "k");
  check("with the switch cleared the queued leads are replayed", r.paused !== true && posted.length >= 1 && r.recovered >= 1, JSON.stringify(r));

  console.log("\n4. The existing guard is unchanged: no key, nothing happens");
  process.env.LOFTY_QUEUE_DRAIN = "off";
  r = await L.drainFailedPushes(blobStore({ [L.FAILED_PUSH_KEY]: [lead(1)] }), "");
  check("no key returns the plain empty result", r.attempted === 0 && r.recovered === 0 && r.paused === undefined, JSON.stringify(r));

  if (saved === undefined) delete process.env.LOFTY_QUEUE_DRAIN; else process.env.LOFTY_QUEUE_DRAIN = saved;
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
