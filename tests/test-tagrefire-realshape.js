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

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
