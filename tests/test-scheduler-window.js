// A scheduled run ends inside the ~15 seconds Netlify's scheduler waits for it.
//
// 2026-10-26 (Netlify request log, Oct 25-26). Netlify documents 30 seconds for a
// scheduled function, but its scheduler (user agent "Netlify Functions Scheduler")
// stops waiting after about 15: every scheduled run that went past it ended HTTP
// 499 at 14.97 s -- sync-listings at 17:30 on Oct 25 and 12:00 on Oct 26,
// mls-hub-sync at 15:15 on Oct 25 -- and the same run was sent again within a
// second. No run that answered took longer than 14.94 s. Before this change the
// hub read could START a page at 11 s and wait 9 s for it, and her Lofty listings
// could wait 10 s after a rate limit on top of a 20-second read.
//
// Pinned here: the arithmetic of the window, her Lofty listings stopping cleanly
// (and saying so) when a rate limit leaves no time for the retry, the MLS check
// keeping its cached verdicts past the deadline, and a hub page that does not
// finish in the run's time being "cut short" (the pass kept, no error), not a
// hub fault. Without a deadline nothing changes: a 429 is still waited out.
"use strict";
process.exitCode = 1;
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const fs = require("fs");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function makeStore(initial) {
  const data = new Map(Object.entries(initial || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    data,
    get: async (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null),
    setJSON: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async (k) => { data.delete(k); },
  };
}
const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json),
  json: async () => json, headers: { get: () => "application/json" } });
// A request that never answers until its own timeout aborts it -- what a slow hub or Lofty looks like.
const hang = (init) => new Promise((resolve, reject) => {
  const s = init && init.signal;
  if (s) s.addEventListener("abort", () => reject(s.reason || new Error("aborted")), { once: true });
});

// AbortSignal.timeout's timer does not keep Node running on its own; a function's runtime does.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  const S = require(`${FN_DIR}/sync-listings.js`);
  const L = require(`${FN_DIR}/lib/_lofty-listings.js`);
  const src = fs.readFileSync(`${FN_DIR}/sync-listings.js`, "utf8");
  const hubSrc = fs.readFileSync(`${FN_DIR}/mls-hub-sync.js`, "utf8");
  const num = (name) => Number((src.match(new RegExp(`const ${name} = (\\d+);`)) || [])[1]);

  console.log("\n1. The window");
  const WAIT = num("SCHEDULER_WAIT_MS"), RUN = num("SCHEDULED_RUN_MS"), LOFTY = num("LOFTY_PART_MS");
  const MIN_PAGE = num("HUB_MIN_PAGE_MS"), SAVE = num("HUB_SAVE_MS");
  const COLD_START = 1000;   // the slowest cold start in the log was ~0.7 s
  console.log(`       scheduler waits ${WAIT} · run ends its work by ${RUN} · Lofty part ${LOFTY} · page min ${MIN_PAGE} · save ${SAVE}`);
  check("the scheduler's wait is the measured ~15 s", WAIT === 15000, String(WAIT));
  check("a run's work, a cold start and the last writes fit inside it", RUN + COLD_START + SAVE < WAIT, `${RUN + COLD_START + SAVE}`);
  check("her Lofty listings leave the hub read time for at least one page", LOFTY + MIN_PAGE <= RUN, `${LOFTY + MIN_PAGE}`);
  check("a hub page always has time to be saved after it", MIN_PAGE > SAVE);
  check("the hub read no longer starts pages on the MLS Grid path's 11 s budget",
    /const runEnd = startedAt \+ \(o\.runMs \|\| SCHEDULED_RUN_MS\)/.test(src) &&
    !/const outOfTime = \(\) => Date\.now\(\) - startedAt > TIME_BUDGET_MS;/.test(src));
  check("each hub page waits no longer than the run has left", /Math\.min\(mlsHub\.HUB_PAGE_TIMEOUT_MS, left\(\) - HUB_SAVE_MS\)/.test(src));
  check("her listings get a deadline from the run's start", /runMineSync\(\{ store, apiKey, confirmOnMarket, deadline \}\)/.test(src) &&
    /const deadline = \(startedAt \|\| Date\.now\(\)\) \+ LOFTY_PART_MS;/.test(src));
  check("mls-hub-sync measures from its own start", /hubMarketDataRun\(\{ startedAt \}\)/.test(hubSrc));

  console.log("\n2. Her Lofty listings: a rate limit with no time left for the retry");
  const prevSet = { IRE1000001: { listingId: "IRE1000001", agentName: "Christine Gwinnup", status: "Active", address: "1 Elm St" } };
  const seeded = () => makeStore({ "lofty-listings.json": prevSet, "lofty-sync-state.json": { lastSuccessAt: "2026-10-26T11:30:00.000Z" } });
  const slept = [];
  let calls = 0;
  const fetch429 = async () => { calls += 1; return reply(429, { message: "rate limited" }); };
  let store = seeded();
  const t0 = Date.now();
  let r = await L.runMineSync({ store, apiKey: "k", fetchImpl: fetch429, sleepImpl: async (ms) => { slept.push(ms); },
    log: () => {}, deadline: Date.now() + 5000 });
  let st = store.data.get("lofty-sync-state.json");
  check("no 10-second wait it has no time for", !slept.includes(10000) && Date.now() - t0 < 1000, JSON.stringify(slept));
  check("one request, not a second one past the deadline", calls === 1, String(calls));
  check("the last good set is kept", r.accepted === false && !!store.data.get("lofty-listings.json").IRE1000001);
  check("the run says it was cut short", Array.isArray(r.cutShort) && r.cutShort.includes("her listings") &&
    /out of time for her listings/.test(st.lastRunCutShort) && /not tried again this run \(out of time\)/.test(st.lastRunError),
    `${st.lastRunCutShort} / ${st.lastRunError}`);
  check("lastSuccessAt is not moved by a run that did not finish", st.lastSuccessAt === "2026-10-26T11:30:00.000Z");

  console.log("\n3. ...and with no deadline, exactly as before");
  slept.length = 0; calls = 0;
  store = seeded();
  r = await L.runMineSync({ store, apiKey: "k", fetchImpl: fetch429, sleepImpl: async (ms) => { slept.push(ms); }, log: () => {} });
  st = store.data.get("lofty-sync-state.json");
  check("a 429 is waited out (10 s) and asked once more", slept.includes(10000) && calls === 2, `${JSON.stringify(slept)} ${calls}`);
  check("nothing is called cut short", !r.cutShort && st.lastRunCutShort === null, String(st.lastRunCutShort));

  console.log("\n4. A Lofty read that hangs stops at the deadline, not after 20 s");
  calls = 0;
  store = seeded();
  const t1 = Date.now();
  r = await L.runMineSync({ store, apiKey: "k", fetchImpl: async (u, init) => { calls += 1; return hang(init); },
    sleepImpl: async () => {}, log: () => {}, deadline: Date.now() + 1700 });
  const took = Date.now() - t1;
  st = store.data.get("lofty-sync-state.json");
  check("the read was given only the time left (~1.7 s)", took >= 1400 && took < 3500, `${took} ms`);
  check("no retry it has no time for, and it says so", calls === 1 && /her listings/.test(st.lastRunCutShort || ""), `${calls} ${st.lastRunCutShort}`);

  console.log("\n5. The MLS check past the deadline");
  const confirmStore = makeStore({
    "lofty-mls-verdicts.json": { IRE1043314: { onMarket: false, status: "Expired", why: "the MLS has it as Expired", checkedAt: new Date().toISOString() } },
  });
  let hubAsked = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { hubAsked += 1; return reply(200, { status: "ok", copy: { ready: true }, rows: [] }); };
  process.env.MLS_SOURCE = "hub";
  process.env.HUB_API_URL = "https://hub.example.test";
  process.env.HUB_API_KEY = "hub_" + "a".repeat(64);
  const confirm = S.makeOnMarketConfirmer({ store: confirmStore, log: () => {}, sleepImpl: async () => {}, deadline: Date.now() - 1 });
  const cached = await confirm({ listingId: "IRE1043314", listDate: "2025-06-01" });
  const unknown = await confirm({ listingId: "IRE1099999", listDate: "2025-06-01" });
  check("a cached \"off the market\" still hides the listing (the deadline never shows it again)", cached.onMarket === false, JSON.stringify(cached));
  check("an unsettled listing is \"unknown\" (kept) and nothing is asked", unknown.onMarket === null && /out of time/.test(unknown.why) && hubAsked === 0,
    `${JSON.stringify(unknown)} asked ${hubAsked}`);

  console.log("\n6. A hub page that does not finish in the run's time");
  global.fetch = async (u, init) => hang(init);
  const hubStore = makeStore({});
  const t2 = Date.now();
  const res = await S.hubMarketDataRun({ store: hubStore, startedAt: Date.now(), runMs: 4500, log: () => {} });
  const took2 = Date.now() - t2;
  const hs = hubStore.data.get("sync-state.json") || {};
  check("the page waited only what the run had left minus the save (~3 s)", took2 >= 2700 && took2 < 4500, `${took2} ms`);
  check("not a hub error: the pass is kept for the next run", !hs.lastRunError && !!hs.hubPass, `${hs.lastRunError}`);
  check("the run says it was cut short", /cut short/.test(res.body) && /did not finish in the 3\.0 s this run had left/.test(hs.lastRunCutShort || ""),
    `${res.body} / ${hs.lastRunCutShort}`);
  // A run with no time left at all starts no page, and says so.
  global.fetch = async () => { hubAsked += 1; return reply(200, {}); };
  hubAsked = 0;
  const late = await S.hubMarketDataRun({ store: hubStore, startedAt: Date.now() - 60e3, log: () => {} });
  check("no time left: no hub request, paused, cut short named", hubAsked === 0 && /paused/.test(late.body) &&
    /out of this run's time after 0 page/.test((hubStore.data.get("sync-state.json") || {}).lastRunCutShort || ""), late.body);
  global.fetch = realFetch;

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exitCode = failures ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
