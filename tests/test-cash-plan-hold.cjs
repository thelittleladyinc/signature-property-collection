// 2026-11-22: the cash-offer form's S2 tag waits for the hub's cash check (lib/_hub-intake.js cashPlanHold).
const test = require("node:test");
const assert = require("node:assert/strict");
const { cashPlanHold, S2_PLAN_TAG } = require("../netlify/functions/lib/_hub-intake");
const ON = { WEBSITE_TO_HUB_INTAKE: "on", WEBSITE_TO_HUB_INTAKE_ALL_FORMS: "on" };
const s2 = { planTags: [S2_PLAN_TAG] };

test("a form without S2 is never held, nor read", async () => {
  let read = false;
  const p = { then(f) { read = true; return Promise.resolve(null).then(f); } };
  assert.deepEqual(await cashPlanHold({ planTags: ["TOF – Website Buyer"] }, p, ON), { hold: false });
  assert.equal(read, false);
});
test("intake switched off: the form works as before", async () => {
  assert.deepEqual(await cashPlanHold(s2, Promise.resolve(null), {}), { hold: false });
  assert.deepEqual(await cashPlanHold(s2, Promise.resolve(null), { WEBSITE_TO_HUB_INTAKE: "on" }), { hold: false });
});
test("the hub held the cash request: no S2", async () => {
  const r = await cashPlanHold(s2, Promise.resolve({ attempted: true, ok: true, cashOffer: "held" }), ON);
  assert.equal(r.hold, true); assert.match(r.reason, /S2 not started/);
});
test("the hub took it: S2 goes on", async () => {
  for (const c of ["created", "existing", undefined]) {
    assert.deepEqual(await cashPlanHold(s2, Promise.resolve({ attempted: true, ok: true, cashOffer: c }), ON), { hold: false });
  }
});
test("intake on but no answer: held, never guessed", async () => {
  for (const r of [{ attempted: true, ok: false, error: "hub answered 503" }, { attempted: false, reason: "no time left" }, null]) {
    const g = await cashPlanHold(s2, Promise.resolve(r), ON);
    assert.equal(g.hold, true); assert.match(g.reason, /could not check/);
  }
  assert.equal((await cashPlanHold(s2, Promise.reject(new Error("x")), ON)).hold, true);
});
