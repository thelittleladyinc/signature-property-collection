// The thank-you page, and the form-name contract that three separate files depend on.
//
// 2026-08-16 (Christine, on making the site stronger: analytics so she can "know
// which blogs to write"). A thank-you URL is how any analytics tool identifies a
// completed lead. Before this, site/thank-you.html existed and NOTHING pointed at
// it -- all 65 forms showed Netlify's default inline message -- so there was no
// conversion event to count and "which page produces leads" was unanswerable.
//
// The same cross-check that added the redirect also found three forms
// (luxury-market, concierge-page-inquiry, testimonials-page-inquiry) with no Lofty
// source label, arriving in her CRM tagged with a raw slug. That is drift between
// build.py, submission-created.js and the thank-you copy, and drift is what tests
// are for -- so all three are pinned here rather than fixed once and left to rot.
//
// Repo root derived from this file's own location, never hardcoded: these suites
// run both locally and in GitHub Actions, where the checkout is at
// /home/runner/work/<repo>/<repo>. An absolute path would pass here and fail there.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

const pages = walk(path.join(ROOT, "site"));

// --- every form redirects, and to its OWN name -------------------------------
const forms = [];        // {file, name, action}
for (const f of pages) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(/<form[^>]*\bname="([a-z-]+)"[^>]*>/g)) {
    const tag = m[0];
    const action = (tag.match(/action="([^"]*)"/) || [])[1] || "";
    forms.push({ file: path.relative(ROOT, f), name: m[1], action });
  }
}
check("forms were found at all", forms.length > 0, String(forms.length));
const noAction = forms.filter((f) => !f.action);
check(`every form has a success destination (${forms.length} forms)`,
  noAction.length === 0, noAction.slice(0, 3).map((f) => `${f.file}:${f.name}`).join(", "));

// A form pointing at ANOTHER form's ?from= would silently mis-attribute every lead
// it ever captured -- the failure mode that looks like working analytics.
const mismatched = forms.filter((f) => f.action !== `/thank-you.html?from=${f.name}`);
check("each form's ?from= matches its own form-name",
  mismatched.length === 0,
  mismatched.slice(0, 3).map((f) => `${f.name} -> ${f.action}`).join(", "));

// --- the Lofty source-label contract ----------------------------------------
const submission = fs.readFileSync(
  path.join(ROOT, "netlify/functions/submission-created.js"), "utf8");
const labelBlock = submission.slice(
  submission.indexOf("const SOURCE_LABELS"), submission.indexOf("function splitName"));
const labels = new Set([...labelBlock.matchAll(/^\s*"([a-z-]+)":/gm)].map((m) => m[1]));
const formNames = [...new Set(forms.map((f) => f.name))].sort();
const unlabelled = formNames.filter((n) => !labels.has(n));
check(`every form on the site has a Lofty source label (${formNames.length} forms)`,
  unlabelled.length === 0, unlabelled.join(", "));
// The reverse is only a tidiness issue, not a lead-losing one, so it reports rather
// than fails -- a label for a form retired last week shouldn't break the build.
const orphans = [...labels].filter((l) => !formNames.includes(l));
if (orphans.length) console.log(`       note: labels with no form on the site: ${orphans.join(", ")}`);

// --- the page itself ---------------------------------------------------------
const ty = fs.readFileSync(path.join(ROOT, "site/thank-you.html"), "utf8");
check("thank-you page is noindexed", /name="robots"[^>]*noindex/.test(ty));
// Progressive enhancement: the page must be complete with JS blocked, because the
// tailored line is a nicety and "what happens next" is not.
check("default copy stands without JS", /id="ty-message"/.test(ty)
  && /always the same day/.test(ty));
check("gives a same-day commitment, not a vague 'shortly'", !/in touch shortly/.test(ty));
check("offers a tappable phone for the urgent case", /href="tel:\d/.test(ty));
check("keeps the visitor on the site instead of dead-ending",
  /href="\/communities\//.test(ty) && /href="\/search-homes\.html"/.test(ty));

// Every tailored message must key off a form that really exists, or it is dead code
// that reads like coverage.
const msgKeys = [...ty.matchAll(/^\s*"([a-z-]+)":\s*"/gm)].map((m) => m[1]);
const strayMsg = msgKeys.filter((k) => !formNames.includes(k));
check(`tailored messages all key off real forms (${msgKeys.length} messages)`,
  strayMsg.length === 0, strayMsg.join(", "));
const uncovered = formNames.filter((n) => !msgKeys.includes(n));
if (uncovered.length) {
  console.log(`       note: falling back to the default message: ${uncovered.join(", ")}`);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
