// "What have you updated?" -- the little form a value review email links to
// (Build E, 2026-10-17; lib/_home-updates.js, switch VALUE_REVIEW_UPDATES_FORM).
// This pins:
//
//   - off by default: every request gets "not available" and nothing is sent
//     unless the switch is exactly "on";
//   - the form asks for no name, email or phone, loads nothing from anywhere
//     else, is never indexed, sends no analytics and shows no home address;
//   - a link without both the review id and its token gets "not complete";
//   - the answers go to the hub's /v1/value-reviews/updates with the website's
//     intake-only key (HUB_INTAKE_KEY), https only, no redirect, a time limit;
//     only the listed items are sent, each once, the words trimmed to 1,000;
//   - every hub answer becomes a plain page; nothing in the log but status words;
//   - lib/_home-updates.js and lib/_hub-intake.js are byte-identical to the
//     other site's copies.
//
// The same file runs in both repos; only SITE, BRAND and SIBLING below differ.
// Nothing here calls the hub: fetch is a fake that records every request.
"use strict";
process.exitCode = 1;
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = `${ROOT}/netlify/functions`;
const SITE = "signature";
const BRAND = "Signature Property Collection";
const SIBLING = "thelittleladysellshomes";
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const U = require(`${FN_DIR}/lib/_home-updates.js`);
const HUB = "https://hub.example.test/functions/v1/hub-api";
const INTAKE_KEY = "hub_" + "intake".padEnd(64, "0");
const TOKEN = "A".repeat(42) + "z";
const ON = { VALUE_REVIEW_UPDATES_FORM: "on", HUB_API_URL: HUB, HUB_INTAKE_KEY: INTAKE_KEY };

function fakeHub(status = 200, throws = false) {
  const h = { calls: [], logs: [] };
  h.fetch = async (url, init) => {
    h.calls.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    if (throws) throw Object.assign(new Error(`down ${INTAKE_KEY}`), { name: "TimeoutError" });
    return { status, ok: status >= 200 && status < 300, text: async () => "{}" };
  };
  h.log = (line) => h.logs.push(line);
  return h;
}
const get = (q) => ({ httpMethod: "GET", queryStringParameters: q });
const post = (pairs, b64) => {
  const body = new URLSearchParams(pairs).toString();
  return { httpMethod: "POST", body: b64 ? Buffer.from(body).toString("base64") : body, isBase64Encoded: !!b64 };
};
const run = async (event, env, h) => {
  const res = await U.handleHomeUpdates(event, { site: SITE, brand: BRAND, env, fetchImpl: h.fetch, log: h.log });
  return { ...res, text: res.body.replace(/&#39;/g, "'") }; // the page escapes apostrophes
};

(async () => {
  console.log("1. Off unless VALUE_REVIEW_UPDATES_FORM is exactly \"on\"");
  for (const v of [undefined, "", "off", "true", "yes", "1"]) {
    const h = fakeHub();
    const env = { ...ON, VALUE_REVIEW_UPDATES_FORM: v };
    if (v === undefined) delete env.VALUE_REVIEW_UPDATES_FORM;
    const a = await run(get({ r: "12", t: TOKEN }), env, h);
    const b = await run(post([["r", "12"], ["t", TOKEN], ["items", "Roof"]]), env, h);
    check(`${JSON.stringify(v)}: not available, no form, nothing sent`, a.statusCode === 404 && b.statusCode === 404 &&
      !/<form/.test(a.body) && h.calls.length === 0);
  }
  check("\" On \" (trimmed, any case) counts as on", U.homeUpdatesOn({ VALUE_REVIEW_UPDATES_FORM: " On " }));

  console.log("\n2. The form");
  let h = fakeHub();
  const page = await run(get({ r: "12", t: TOKEN }), ON, h);
  check("a full link shows the form", page.statusCode === 200 && /<form method="post" action="\/\.netlify\/functions\/home-updates">/.test(page.body));
  check("every listed item is a checkbox", U.UPDATE_ITEMS.every((x) => page.body.includes(`name="items" value="${x.replace(/\//g, "/")}"`)) && U.UPDATE_ITEMS.length === 13);
  check("the review id and token ride as hidden fields", page.body.includes('name="r" value="12"') && page.body.includes(`name="t" value="${TOKEN}"`));
  check("a box for their own words, up to 1,000 characters", /<textarea id="other" name="other" rows="5" maxlength="1000">/.test(page.body));
  check("asks for no name, email or phone", !/type="(email|tel)"|name="(name|email|phone|first_name|last_name)"/.test(page.body));
  check("not a lead form (no lead-form class, no Netlify form)", !/lead-form|data-netlify|netlify-honeypot/.test(page.body));
  check("loads nothing from anywhere else (no script, link, img or font)", !/<script|<link|<img|https?:\/\//.test(page.body));
  check("never indexed, never cached, no referrer", page.headers["X-Robots-Tag"] === "noindex, nofollow" && /noindex/.test(page.body) &&
    page.headers["Cache-Control"] === "no-store" && page.headers["Referrer-Policy"] === "no-referrer");
  check("a strict content policy: nothing loads, posts only to this site, never framed",
    page.headers["Content-Security-Policy"] === "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  check(`this site's brand in the footer, no street address, only Christine`, page.body.includes(`Christine Gwinnup, REALTOR® · ${BRAND} · LPT Realty`) &&
    !/Glade|80538|Greenwood|\d{3}-\d{3}-\d{4}/.test(page.body));
  check("no analytics", !/gtag|fbq|googletagmanager|dataLayer/.test(page.body));
  const bad = [{}, { r: "12" }, { t: TOKEN }, { r: "x1", t: TOKEN }, { r: "12", t: TOKEN.slice(1) }, { r: "12", t: `${TOKEN}A` },
    { r: "12", t: TOKEN.replace("z", "=") }, { r: "1".repeat(19), t: TOKEN }];
  let allBad = true;
  for (const q of bad) { const p = await run(get(q), ON, h); if (p.statusCode !== 400 || /<form/.test(p.body) || !/isn't complete/.test(p.text)) allBad = false; }
  check("a link without a valid id and token: \"not complete\", no form", allBad);
  const xss = await run(get({ r: "12", t: TOKEN }), ON, h);
  check("nothing from the address is written into the page unescaped", !/<script/.test(xss.body));
  check("a GET sends nothing to the hub", h.calls.length === 0);

  console.log("\n3. Sending the answers");
  h = fakeHub(200);
  let r = await run(post([["r", "12"], ["t", TOKEN], ["items", "Roof"], ["items", "Kitchen"], ["items", "Roof"], ["items", "Hot tub"],
    ["other", "  New windows in 2023 \r\n and a fence  "]]), ON, h);
  const c = h.calls[0] || { init: {} };
  check("one call to the hub's updates route", h.calls.length === 1 && c.url === `${HUB}/v1/value-reviews/updates`);
  check("the website's intake-only key, as x-hub-key", c.init.headers && c.init.headers["x-hub-key"] === INTAKE_KEY && c.init.method === "POST");
  check("no redirect followed, a time limit", c.init.redirect === "manual" && !!c.init.signal);
  check("the body: review id, token, known items once in the form's order, their words, this site",
    JSON.stringify(c.body) === JSON.stringify({ review_id: 12, token: TOKEN, items: ["Kitchen", "Roof"], other: "New windows in 2023 \n and a fence", site: SITE }),
    JSON.stringify(c.body));
  check("thank-you page", r.statusCode === 200 && /Thank you/.test(r.body) && /factor them into your number/.test(r.body));
  check("the log carries status words only", h.logs.join("|") === "home-updates: hub answered 200");
  h = fakeHub(200);
  await run(post([["r", "12"], ["t", TOKEN], ["other", "x".repeat(1500)]], true), ON, h);
  check("a base64 body is read; their words are cut to 1,000", h.calls.length === 1 && h.calls[0].body.other.length === 1000 && h.calls[0].body.items.length === 0);
  h = fakeHub(200);
  r = await run(post([["r", "12"], ["t", TOKEN], ["other", "   "]]), ON, h);
  check("nothing ticked and nothing written: the form again, nothing sent", r.statusCode === 200 && /<form/.test(r.body) && h.calls.length === 0);
  h = fakeHub(200);
  r = await run(post([["r", "12"], ["t", "short"], ["items", "Roof"]]), ON, h);
  check("a posted form with a bad token: \"not complete\", nothing sent", r.statusCode === 400 && h.calls.length === 0);
  h = fakeHub(200);
  r = await run({ httpMethod: "PUT" }, ON, h);
  check("any other method: 405, nothing sent", r.statusCode === 405 && h.calls.length === 0);

  console.log("\n4. Every hub answer is a plain page");
  const cases = [[429, 200, /already has your answers/], [410, 410, /expired/], [404, 404, /isn't valid/], [503, 503, /weren't saved/],
    [500, 503, /weren't saved/], [302, 503, /weren't saved/], [401, 503, /weren't saved/]];
  for (const [hub, want, text] of cases) {
    h = fakeHub(hub);
    r = await run(post([["r", "12"], ["t", TOKEN], ["items", "Roof"]]), ON, h);
    check(`hub ${hub} -> ${want}`, r.statusCode === want && text.test(r.text) && h.calls.length === 1);
  }
  h = fakeHub(200, true);
  r = await run(post([["r", "12"], ["t", TOKEN], ["items", "Roof"]]), ON, h);
  check("the hub unreachable: \"reply to her email\", logged by error name only (never the key)", r.statusCode === 503 &&
    h.logs.join("|") === "home-updates: the hub did not answer (TimeoutError)" && !h.logs.join("|").includes(INTAKE_KEY));
  for (const [env, why] of [[{ ...ON, HUB_INTAKE_KEY: "" }, "HUB_INTAKE_KEY not set"], [{ ...ON, HUB_API_URL: "http://hub.example.test" }, "HUB_API_URL must start with https://"]]) {
    h = fakeHub(200);
    r = await run(post([["r", "12"], ["t", TOKEN], ["items", "Roof"]]), env, h);
    check(`not sent when ${why}`, r.statusCode === 503 && h.calls.length === 0 && h.logs.join("|") === `home-updates: not sent (${why})`);
  }
  check("the key is never in a page", !JSON.stringify(r).includes(INTAKE_KEY));

  console.log(`\n5. Same modules as the other site (${SIBLING}); this site's handler`);
  for (const f of ["_home-updates.js", "_hub-intake.js"]) {
    const other = path.join(ROOT, "..", SIBLING, "netlify", "functions", "lib", f);
    if (fs.existsSync(other)) check(`lib/${f} is byte-identical to ${SIBLING}'s copy`, fs.readFileSync(other, "utf8") === fs.readFileSync(`${FN_DIR}/lib/${f}`, "utf8"));
    else console.log(`  --   ${SIBLING} checkout not present; skipping the drift check for ${f}`);
  }
  const fn = fs.readFileSync(`${FN_DIR}/home-updates.js`, "utf8");
  check(`home-updates.js names this site ("${SITE}") and its brand`, fn.includes(`const SITE = "${SITE}";`) && fn.includes(`const BRAND = "${BRAND}";`));
  check("the hub link in a value review points here (christine-hq builds /.netlify/functions/home-updates)", U.FORM_ACTION === "/.netlify/functions/home-updates");
  const ex = fs.readFileSync(`${ROOT}/.env.example`, "utf8");
  check(".env.example lists VALUE_REVIEW_UPDATES_FORM, empty (off)", /^VALUE_REVIEW_UPDATES_FORM=$/m.test(ex));

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
