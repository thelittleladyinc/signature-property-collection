// 2026-10-03. Lofty's GET /v1.0/leads/{id} really answers
// { lead: { ..., tags: [{ tagName, tagId, ... }] } } -- checked against a live
// lead. Reading only the top level made every new website lead look tagless, so
// the remove-then-re-add of "Hot Lead - Website" never ran and the SPC Website
// Smart Plan (agent notification + call task) applied to nobody. This pins the
// real shape: the trigger tag is taken off and put back, and every other tag
// survives both writes.
const ROOT = require("path").resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

(async () => {
  const { refireLoftyTag } = require(`${FN_DIR}/lib/_notify.js`);
  const TAG = "Hot Lead - Website";
  const tagObj = (tagName, tagId) => ({ leadId: 777, tagId, tagName, createTime: "2026-10-01T14:21:07GMT", visibleType: 0 });
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ method, path: String(url).split("/v1.0")[1], body: opts.body ? JSON.parse(opts.body) : null });
    const body = method === "GET"
      ? { lead: { leadId: 777, firstName: "Donna", tags: [tagObj("Buyer Lead", 1), tagObj("Website Lead", 2), tagObj(TAG, 3), tagObj("home-lead", 4)] } }
      : {};
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };

  const r = await refireLoftyTag(777, TAG, "key");
  check("re-add ran (step refired)", r.step === "refired", JSON.stringify(r));
  check("tag is back on the lead", r.tagRestored === true && r.ok === true);
  check("one read, then remove, then re-add", calls.map((c) => c.method).join(",") === "GET,PUT,PUT", calls.map((c) => c.method).join(","));
  const [, off, back] = calls;
  check("removal drops only the trigger tag",
    JSON.stringify(off.body) === JSON.stringify({ tags: ["Buyer Lead", "Website Lead", "home-lead"] }), JSON.stringify(off.body));
  check("re-add restores every tag, trigger included",
    JSON.stringify(back.body) === JSON.stringify({ tags: ["Buyer Lead", "Website Lead", TAG, "home-lead"] }), JSON.stringify(back.body));
  check("no permission fields are written", calls.every((c) => !c.body || !("cannotEmail" in c.body || "cannotCall" in c.body || "cannotText" in c.body)));

  // A lead whose read came back without the trigger tag gets it added in one write.
  calls.length = 0;
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ method, body: opts.body ? JSON.parse(opts.body) : null });
    const body = method === "GET" ? { lead: { leadId: 778, tags: [tagObj("Website Lead", 2)] } } : {};
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const r2 = await refireLoftyTag(778, TAG, "key");
  check("missing trigger tag is added", r2.step === "added" && calls.length === 2, JSON.stringify(r2));
  check("added write keeps the existing tag", JSON.stringify(calls[1].body) === JSON.stringify({ tags: ["Website Lead", TAG] }), JSON.stringify(calls[1].body));

  // ---- 2026-10-06: an exception AFTER the removal call went out ---------------
  // refireLoftyTag's own comment promises that a failed re-add reports
  // tagRestored:false. A re-add cut short by the 8s timeout or the queue drain's
  // deadline THROWS instead of returning not-ok, and the catch used to hand back
  // {ok:false, error} with no flag -- so /status said "the tag from the original
  // push is still there" for a lead whose tag had just been taken off. Every case
  // below pins the exact list of Lofty calls as well as the result, so this fix
  // can never add, drop or reorder a call.
  const realConsoleError = console.error;
  console.error = () => {};
  const abort = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const leadWithTrigger = (id) => ({ lead: { leadId: id, tags: [tagObj("Buyer Lead", 1), tagObj(TAG, 3), tagObj("home-lead", 4)] } });
  const FULL = ["Buyer Lead", TAG, "home-lead"], WITHOUT = ["Buyer Lead", "home-lead"];
  // `puts` scripts each PUT in turn: a status number answers, "abort" throws.
  async function scripted(id, readBody, puts) {
    const seen = [];
    let n = 0;
    global.fetch = async (url, opts = {}) => {
      const method = opts.method || "GET";
      seen.push(method === "GET" ? "GET" : `PUT ${JSON.stringify(JSON.parse(opts.body).tags)}`);
      if (method === "GET") {
        if (readBody === "abort") throw abort();
        return reply(200, readBody);
      }
      const outcome = puts[n++];
      if (outcome === "abort") throw abort();
      return reply(outcome === undefined ? 200 : outcome, {});
    };
    const result = await refireLoftyTag(id, TAG, "key");
    return { result, seen, putsUsed: n };
  }
  const listIs = (seen, want) => JSON.stringify(seen) === JSON.stringify(want);

  console.log("\nre-add throws an abort (both attempts would): the lead may be without its tag");
  let x = await scripted(801, leadWithTrigger(801), [200, "abort", "abort"]);
  check("tagRestored is false -- never absent -- and the step says it is unconfirmed",
    x.result.tagRestored === false && x.result.step === "refired-unconfirmed" && x.result.ok === false && x.result.attempted === true, JSON.stringify(x.result));
  check("the abort's message is kept for /status", /aborted/.test(String(x.result.error)), JSON.stringify(x.result));
  check("calls are exactly: read, remove, re-add (a throw is not retried, as before)",
    listIs(x.seen, ["GET", `PUT ${JSON.stringify(WITHOUT)}`, `PUT ${JSON.stringify(FULL)}`]) && x.putsUsed === 2, x.seen.join(" | "));

  console.log("\nre-add refused once, then throws");
  x = await scripted(802, leadWithTrigger(802), [200, 503, "abort"]);
  check("tagRestored false, unconfirmed", x.result.tagRestored === false && x.result.step === "refired-unconfirmed" && x.result.ok === false, JSON.stringify(x.result));
  check("calls are exactly: read, remove, re-add, retry",
    listIs(x.seen, ["GET", `PUT ${JSON.stringify(WITHOUT)}`, `PUT ${JSON.stringify(FULL)}`, `PUT ${JSON.stringify(FULL)}`]), x.seen.join(" | "));

  console.log("\nthe removal call itself throws (whether it landed is unknown)");
  x = await scripted(803, leadWithTrigger(803), ["abort"]);
  check("tagRestored false, unconfirmed", x.result.tagRestored === false && x.result.step === "refired-unconfirmed" && x.result.ok === false, JSON.stringify(x.result));
  check("calls are exactly: read, remove -- no re-add is attempted after a throw",
    listIs(x.seen, ["GET", `PUT ${JSON.stringify(WITHOUT)}`]), x.seen.join(" | "));

  console.log("\nunchanged: results that were already right");
  x = await scripted(804, leadWithTrigger(804), [200, 200]);
  check("happy path is byte-for-byte what it was (no new fields)",
    JSON.stringify(x.result) === JSON.stringify({ attempted: true, ok: true, step: "refired", tagRestored: true,
      tagShape: "'tags' was an array of 3 item(s) of type object", tagsSeen: 3, httpStatus: 200 }), JSON.stringify(x.result));
  check("happy path calls: read, remove, re-add", listIs(x.seen, ["GET", `PUT ${JSON.stringify(WITHOUT)}`, `PUT ${JSON.stringify(FULL)}`]), x.seen.join(" | "));
  x = await scripted(805, leadWithTrigger(805), [200, 503, 200]);
  check("re-add refused once, retry lands: restored, step refired, four calls",
    x.result.ok === true && x.result.tagRestored === true && x.result.step === "refired" && x.seen.length === 4, JSON.stringify(x.result));
  x = await scripted(806, leadWithTrigger(806), [200, 503, 503]);
  check("re-add refused twice: still the old not-restored result (step refired, HTTP 503), not 'unconfirmed'",
    x.result.ok === false && x.result.tagRestored === false && x.result.step === "refired" && x.result.httpStatus === 503 && x.seen.length === 4, JSON.stringify(x.result));
  x = await scripted(807, leadWithTrigger(807), [403]);
  check("removal refused: nothing changed, tag still there (step remove, tagRestored true)",
    x.result.ok === false && x.result.tagRestored === true && x.result.step === "remove" && x.seen.length === 2, JSON.stringify(x.result));
  x = await scripted(808, "abort", []);
  check("the read throws before anything was written: the old result, no tagRestored, one call",
    JSON.stringify(x.result) === JSON.stringify({ attempted: true, ok: false, error: x.result.error }) && !("tagRestored" in x.result) && x.seen.length === 1, JSON.stringify(x.result));
  x = await scripted(809, { lead: { leadId: 809, tags: [tagObj("Website Lead", 2)] } }, ["abort"]);
  check("the add-only write throws (nothing was taken off): the old result, no tagRestored, two calls",
    JSON.stringify(x.result) === JSON.stringify({ attempted: true, ok: false, error: x.result.error }) && !("tagRestored" in x.result) &&
    listIs(x.seen, ["GET", `PUT ${JSON.stringify(["Website Lead", TAG])}`]), JSON.stringify(x.result));
  console.error = realConsoleError;

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
