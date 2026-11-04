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
const { countSpam, spamRow, spamKey, formsToken, openSpamStore, runSpamCount } = require(`${ROOT}/netlify/functions/lib/_form-spam`);
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

  // 2026-11-04: thelittleladysellshomes answered HTTP 500 on every scheduled run: the
  // Blobs store could not be opened (no BLOBS_SITE_ID / BLOBS_TOKEN for its functions),
  // getStore() threw after the count, and the run said nothing more.
  console.log("one run (runSpamCount)");
  const memStore = () => { const m = new Map(); return { m, setJSON: async (k, v) => { m.set(k, v); } }; };
  const noBlobs = () => { const e = new Error("The environment has not been configured to use Netlify Blobs"); e.name = "MissingBlobsEnvironmentError"; throw e; };
  const quiet = { log() {}, error() {} };
  {
    const st = memStore();
    const o = openSpamStore({}, { getStore: () => st, getBlobStore: (g) => g("mls-listings") });
    check("store from the settings when they work", o.store === st && o.via === "settings");
  }
  {
    const st = memStore();
    let ctx = null;
    const o = openSpamStore({ blobs: "e30=" }, {
      getStore: () => { if (!ctx) noBlobs(); return st; },
      getBlobStore: (g) => g("mls-listings"),
      connectLambda: (ev) => { ctx = ev.blobs; },
    });
    check("no settings: this site's own store through Netlify's run context", o.store === st && o.via === "netlify" && ctx === "e30=");
  }
  {
    const o = openSpamStore({}, { getStore: noBlobs, getBlobStore: (g) => g("x"), connectLambda: () => {} });
    check("neither: no store, and says why (error names only)", o.store === null && /could not be opened/.test(o.why) &&
      /MissingBlobsEnvironmentError/.test(o.why) && /no Blobs context/.test(o.why) && !/configured to use/.test(o.why), o.why);
  }
  const okNet = fakeNetlify({ forms, spam: { f1: [sub("s1", 1)] }, verified: { f1: [] } });
  {
    const out = await runSpamCount({ event: {}, siteId: "site-1", token: "tok", now: NOW, log: quiet,
      deps: { fetchImpl: okNet.fetchImpl, getStore: noBlobs, getBlobStore: (g) => g("x") } });
    const body = JSON.parse(out.body);
    check("store cannot be opened: 503 with an answer, never a 500", out.statusCode === 503 && body.saved === false &&
      body.complete === true && /could not be opened/.test(body.problem), out.body);
  }
  {
    const st = memStore();
    const out = await runSpamCount({ event: {}, siteId: "site-1", token: "tok", now: NOW, log: quiet,
      deps: { fetchImpl: okNet.fetchImpl, getStore: () => st, getBlobStore: (g) => g("x") } });
    const saved = st.m.get(spamKey("site-1"));
    check("complete and saved: 200, the record under this site's key", out.statusCode === 200 && saved && saved.complete && saved.total === 1, out.body);
    check("the answer and the record carry no token or personal data", !out.body.includes("tok") && !JSON.stringify(saved).includes(PII));
  }
  {
    const st = memStore();
    const out = await runSpamCount({ event: {}, siteId: "site-1", token: null, now: NOW, log: quiet,
      deps: { getStore: () => st, getBlobStore: (g) => g("x") } });
    const saved = st.m.get(spamKey("site-1"));
    check("no token: 503, but 'Could not count' is saved for /status", out.statusCode === 503 && JSON.parse(out.body).saved === true &&
      saved && saved.complete === false && /Could not count/.test(spamRow(saved, { now: NOW }).detail));
  }
  {
    const out = await runSpamCount({ event: {}, siteId: "site-1", token: "tok", now: NOW, log: quiet,
      deps: { fetchImpl: okNet.fetchImpl, getStore: () => ({ setJSON: async () => { const e = new Error("boom 401"); e.name = "BlobsInternalError"; throw e; } }), getBlobStore: (g) => g("x") } });
    const body = JSON.parse(out.body);
    check("a failed save: 503, error name only", out.statusCode === 503 && body.saved === false && /BlobsInternalError/.test(body.problem) && !/boom/.test(body.problem), out.body);
  }
  {
    const st = memStore();
    const out = await runSpamCount({ event: {}, siteId: "site-1", token: "tok", now: NOW, log: quiet,
      deps: { fetchImpl: () => { throw new TypeError("x"); }, getStore: () => st, getBlobStore: (g) => g("x") } });
    check("a count that cannot reach Netlify is incomplete, still saved, still answered", out.statusCode === 503 &&
      st.m.get(spamKey("site-1")).complete === false, out.body);
  }
  {
    // The deployed handler, with no Blobs settings and no run context: an answer, not a 500.
    const keep = {};
    for (const k of ["BLOBS_SITE_ID", "BLOBS_TOKEN", "NETLIFY_FORMS_TOKEN", "NETLIFY_BLOBS_CONTEXT", "SITE_ID"]) { keep[k] = process.env[k]; delete process.env[k]; }
    const origErr = console.error;
    console.error = () => {};
    let out;
    try { out = await fn.handler({}); } finally {
      console.error = origErr;
      for (const [k, v] of Object.entries(keep)) if (v !== undefined) process.env[k] = v;
    }
    let body = null;
    try { body = JSON.parse(out.body); } catch (_) { /* checked below */ }
    check("the handler with no Blobs settings answers 503 + JSON, not 500", out.statusCode === 503 && body &&
      body.saved === false && /BLOBS_TOKEN/.test(body.problem) && /could not be opened/.test(body.problem), out && out.body);
  }

  // The hidden spam-trap field (2026-11-04): Signature's had no autocomplete="off", so a
  // browser could fill it and Netlify filed the real person as spam. Every trap on both
  // sites: hidden from screen readers and the keyboard, autofill off, and a name no
  // browser autofills.
  console.log("the hidden spam-trap field");
  const build = fs.readFileSync(`${ROOT}/build/build.py`, "utf8");
  const traps = (text) => text.match(/<p style="display:none"[^>]*><label>Don't fill this out: <input name="bot-field"[^>]*><\/label><\/p>/g) || [];
  const safe = (t) => /<p style="display:none" aria-hidden="true">/.test(t) && /autocomplete="off"/.test(t) && /tabindex="-1"/.test(t);
  const inBuild = traps(build);
  check("the generator's traps are all found", inBuild.length >= 3 && inBuild.length === (build.match(/name="bot-field"/g) || []).length, inBuild.length);
  check("every trap in the generator: autocomplete off, tabindex -1, aria-hidden", inBuild.every(safe), inBuild.find((t) => !safe(t)));
  const honeypots = [...new Set((build.match(/netlify-honeypot="([^"]+)"/g) || []))];
  check("one trap name, and not one a browser autofills", honeypots.length === 1 && honeypots[0] === 'netlify-honeypot="bot-field"' &&
    !/name|mail|phone|tel|addr|company|website|url|org|zip|city/i.test("bot-field".replace("field", "")), honeypots.join(","));
  const siteDir = `${ROOT}/site`;
  let pages = 0;
  let bad = null;
  if (fs.existsSync(siteDir)) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const f = `${d}/${e.name}`;
      if (e.isDirectory()) return walk(f);
      if (!e.name.endsWith(".html")) return;
      const html = fs.readFileSync(f, "utf8");
      if (!html.includes('name="bot-field"')) return;
      pages += 1;
      const t = traps(html);
      if (t.length !== (html.match(/name="bot-field"/g) || []).length || !t.every(safe)) bad = bad || f.slice(ROOT.length + 1);
    });
    walk(siteDir);
  }
  check("every trap in the built pages is the safe one", bad === null && pages > 0, bad || `${pages} page(s)`);

  if (failures) { console.log(`\n${failures} failure(s)`); return; }
  console.log("\nAll checks passed.");
  process.exitCode = 0;
})();
