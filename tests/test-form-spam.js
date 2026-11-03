// The spam count (2026-11-03): Netlify keeps form submissions it judges spam in each
// form's Spam tab and never hands them to submission-created.js, so a real person whose
// browser filled the hidden spam field was lost without a trace. lib/_form-spam.js counts
// them (counts only), shared byte for byte by both websites; form-spam-count.js saves the
// count every 6 hours and /status shows it as an optional row.
"use strict";
process.exitCode = 1;
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const { countSpam, spamRow, spamKey, formsToken } = require(`${ROOT}/netlify/functions/lib/_form-spam`);
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${String(x).slice(0, 300)}` : ""}`); } };

const NOW = Date.parse("2026-11-03T22:00:00Z");
const day = (d) => new Date(NOW - d * 86400000).toISOString();
const PII = "jane@example.test";

function fakeNetlify({ forms, spam = {}, verified = {}, fail = {} }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init && init.headers && init.headers.Authorization, redirect: init && init.redirect });
    const u = new URL(url);
    const answer = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (fail[u.pathname]) return answer({}, fail[u.pathname]);
    if (/\/sites\/[^/]+\/forms$/.test(u.pathname)) return answer(forms);
    const m = /\/forms\/([^/]+)\/submissions$/.exec(u.pathname);
    if (m) {
      const list = (u.searchParams.get("state") === "spam" ? spam : verified)[m[1]] || [];
      const page = Number(u.searchParams.get("page") || 1);
      return answer(list.slice((page - 1) * 100, page * 100));
    }
    return answer({}, 404);
  };
  return { fetchImpl, calls };
}
const sub = (id, d) => ({ id, created_at: day(d), email: PII, name: "Jane", data: { phone: "970-555-0100" } });

(async () => {
  console.log("form spam count");
  const forms = [{ id: "f1", name: "home-lead" }, { id: "f2", name: "contact" }, { id: "f3", name: "rent-to-own-options" }];
  const net = fakeNetlify({
    forms,
    spam: { f1: [sub("s1", 1), sub("s2", 3), sub("s0", 9)], f3: [sub("s3", 2)] },
    verified: { f1: [sub("v1", 1)], f3: [sub("v3", 5)] },
  });
  const r = await countSpam({ token: "tok", siteId: "site-1", fetchImpl: net.fetchImpl, now: NOW });
  check("complete, every form read", r.complete === true && r.formsTotal === 3 && r.formsRead === 3, JSON.stringify(r));
  check("only the last 7 days count", r.total === 3, r.total);
  check("per form, most first", JSON.stringify(r.byForm.map((f) => [f.name, f.count])) === JSON.stringify([["home-lead", 2], ["rent-to-own-options", 1]]));
  check("newest time kept", r.byForm[0].latestAt === day(1));
  check("no name, email, phone or message kept", !JSON.stringify(r).includes(PII) && !JSON.stringify(r).includes("Jane") && !JSON.stringify(r).includes("970-555"));
  check("token only in the Authorization header", net.calls.every((c) => c.auth === "Bearer tok" && !c.url.includes("tok")));
  check("redirects refused", net.calls.every((c) => c.redirect === "error"));
  check("a form with no spam is not asked for its verified list", !net.calls.some((c) => c.url.includes("/forms/f2/submissions?state=verified")));

  const mixed = fakeNetlify({ forms, spam: { f1: [sub("same", 1)] }, verified: { f1: [sub("same", 1)] } });
  const rm = await countSpam({ token: "tok", siteId: "site-1", fetchImpl: mixed.fetchImpl, now: NOW });
  check("Netlify mixing real submissions into the spam answer refuses the count", rm.complete === false && /did not keep spam apart/.test(rm.problem), JSON.stringify(rm));

  const broken = fakeNetlify({ forms, fail: { "/api/v1/forms/f2/submissions": 500 } });
  const rb = await countSpam({ token: "tok", siteId: "site-1", fetchImpl: broken.fetchImpl, now: NOW });
  check("a failed form read is incomplete, never a zero", rb.complete === false && rb.formsRead === 2 && /1 of 3 form/.test(rb.problem), JSON.stringify(rb));

  const nolist = fakeNetlify({ forms, fail: { "/api/v1/sites/site-1/forms": 401 } });
  const rn = await countSpam({ token: "tok", siteId: "site-1", fetchImpl: nolist.fetchImpl, now: NOW });
  check("a refused form list is incomplete", rn.complete === false && /HTTP 401/.test(rn.problem));

  const many = fakeNetlify({ forms: [forms[0]], spam: { f1: Array.from({ length: 150 }, (_, i) => sub(`m${i}`, 1)) } });
  const rp = await countSpam({ token: "tok", siteId: "site-1", fetchImpl: many.fetchImpl, now: NOW });
  check("more than one page is read", rp.complete && rp.total === 150, JSON.stringify(rp).slice(0, 200));

  const rt = await countSpam({ token: null, siteId: "site-1", fetchImpl: net.fetchImpl, now: NOW });
  check("no token: incomplete, says which setting", rt.complete === false && /BLOBS_TOKEN/.test(rt.problem));
  check("token: NETLIFY_FORMS_TOKEN first, else BLOBS_TOKEN", formsToken({ NETLIFY_FORMS_TOKEN: "a", BLOBS_TOKEN: "b" }) === "a" && formsToken({ BLOBS_TOKEN: "b" }) === "b" && formsToken({}) === null);
  check("key per site", spamKey("abc-123") === "form-spam-count-abc-123.json" && spamKey("a/../b") === "form-spam-count-ab.json");

  console.log("status row");
  const rowNone = spamRow(null);
  check("not counted yet: optional, not red", rowNone.optional === true && rowNone.ok === true);
  const row = spamRow(r, { now: NOW, formsUrl: "https://app.netlify.com/projects/x/forms" });
  check("spam found: optional, flagged, names forms and the Spam tab", row.optional && row.ok === false && /home-lead 2/.test(row.detail) && /Spam tab/.test(row.detail) && /app\.netlify\.com/.test(row.detail));
  const clean = await countSpam({ token: "tok", siteId: "s", fetchImpl: fakeNetlify({ forms }).fetchImpl, now: NOW });
  check("none: green", spamRow(clean, { now: NOW }).ok === true && /None in the last 7 days/.test(spamRow(clean, { now: NOW }).detail));
  check("an old count is not green", spamRow(clean, { now: NOW + 20 * 3600000 }).ok === false);
  check("incomplete: says it could not count", /Could not count/.test(spamRow(rb, { now: NOW }).detail) && spamRow(rb, { now: NOW }).optional);

  console.log("wiring");
  const health = fs.readFileSync(`${ROOT}/netlify/functions/site-health.js`, "utf8");
  check("/status adds the row", /checks\.push\(spamRow\(spamRecord/.test(health));
  const toml = fs.readFileSync(`${ROOT}/netlify.toml`, "utf8");
  check("scheduled every 6 hours", /\[functions\."form-spam-count"\]\s*\n\s*schedule = "25 \*\/6 \* \* \*"/.test(toml));
  const fn = require(`${ROOT}/netlify/functions/form-spam-count`);
  check("the function knows this site's id", /^[0-9a-f-]{36}$/.test(fn.THIS_SITE_ID));

  if (failures) { console.log(`\n${failures} failure(s)`); return; }
  console.log("\nall ok");
  process.exitCode = 0;
})();
