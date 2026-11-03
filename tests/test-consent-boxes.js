// The two consent checkboxes on every lead form, in Lofty's exact wording.
//
// 2026-10-07 (10DLC). Lofty is registering Christine's texting campaign, and its
// compliance team wrote that carriers will review the real sign-up form and that
// the form must carry exactly two checkboxes, in exactly this wording:
//
//   1. REQUIRED  -- "By checking this box, I agree to the Terms of Service and
//      Privacy Policy of this website."  (the two phrases are links)
//   2. OPTIONAL, UNCHECKED -- the SMS opt-in sentence below.
//
// A carrier reviewer reads the page, not the code, so this reads every form the
// way a reviewer would: tags stripped, compared with the literal sentences.
// "Character for character" is the point -- nobody gets to paraphrase,
// re-punctuate or "improve" either sentence without this suite failing.
//
// What is checked, and where:
//   - every lead form in the built site/ (in tests/run-all.sh that is the output
//     Netlify publishes);
//   - the copy of site/ that is COMMITTED to git. It is only the fallback --
//     Netlify regenerates site/ on every deploy -- but it must not keep serving
//     the old wording either, so the pages are read from the git index;
//   - the generator itself (build/build.py's consent_boxes_html()), and that the
//     old wording survives nowhere.
//
// 2026-11-03: ported from The Little Lady site. Until today every form here had
// ONE unnamed, required "marketing communication" box: it reached nobody (an
// unnamed input is never submitted) and could not be a free yes to texts.
//
// The server half (what the lead note records) is tests/test-consent-record.js.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Lofty's wording, character for character. Spelled out here (not imported) so
// this suite fails against code that drifts from it.
const TERMS = "By checking this box, I agree to the Terms of Service and Privacy Policy of this website.";
const SMS = "By checking this box, I agree to receive transactional and informational SMS communications, " +
  "including appointment reminders, property updates, and account notifications from Little Lady. " +
  "Message frequency varies. Message and data rates may apply. Reply HELP for help or STOP to opt out.";
const TERMS_HREF = "/terms-of-service.html";
const PRIVACY_HREF = "/privacy-policy.html";

function walk(dir, ok, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "__pycache__"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ok, out);
    else if (ok(p)) out.push(p);
  }
  return out;
}

// --- reading a form the way a reviewer would ---------------------------------
const stripScripts = (html) => html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
// ASCII whitespace only: a non-breaking space or zero-width character is a real
// difference in a sentence that has to match exactly.
const visibleText = (inner) => inner.replace(/<[^>]*>/g, "").replace(/[ \t\r\n\f]+/g, " ").trim();

function attrsOf(tag) {
  const out = {};
  const body = tag.replace(/^<\w+/, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : true;
  }
  return out;
}

// Every <form class="...lead-form..."> in a page, with its consent boxes.
function leadForms(html) {
  const forms = [];
  for (const fm of stripScripts(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const f = attrsOf(`<form ${fm[1]}>`);
    if (!/(^|\s)lead-form(\s|$)/.test(String(f.class || ""))) continue;
    const boxes = [];
    for (const lm of fm[2].matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
      const inputs = [...lm[2].matchAll(/<input\b[^>]*>/gi)].map((m) => attrsOf(m[0])).filter((a) => a.type === "checkbox");
      if (!inputs.length) continue;
      boxes.push({
        labelClass: attrsOf(`<label ${lm[1]}>`).class || "",
        input: inputs[0], inputCount: inputs.length,
        text: visibleText(lm[2]),
        links: [...lm[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: attrsOf(`<a ${m[1]}>`).href, text: visibleText(m[2]) })),
        start: lm.index, end: lm.index + lm[0].length,
      });
    }
    // Every control named terms_agree / sms_consent anywhere in the form, so a
    // stray duplicate outside a label cannot hide.
    const named = (n) => [...fm[2].matchAll(/<input\b[^>]*>/gi)].map((m) => attrsOf(m[0])).filter((a) => a.name === n);
    forms.push({ netlify: f["data-netlify"] === "true", name: f.name || "(unnamed)", boxes, body: fm[2],
      terms: named("terms_agree"), sms: named("sms_consent") });
  }
  return forms;
}

// Problems with one form; empty when it is right. Only called for a form that
// has either box (the pair rule) or any Netlify lead form (every one carries it).
function formProblems(form) {
  const bad = [];
  if (form.terms.length !== 1) bad.push(`${form.terms.length} terms_agree controls (want exactly 1)`);
  if (form.sms.length !== 1) bad.push(`${form.sms.length} sms_consent controls (want exactly 1)`);
  const terms = form.boxes.find((b) => b.input.name === "terms_agree");
  const sms = form.boxes.find((b) => b.input.name === "sms_consent");
  if (!terms) bad.push("no Terms/Privacy checkbox label");
  if (!sms) bad.push("no SMS checkbox label");
  if (terms) {
    if (terms.input.value !== "yes") bad.push(`terms_agree value is ${JSON.stringify(terms.input.value)}, want "yes"`);
    if (!terms.input.required) bad.push("the Terms/Privacy box is not required");
    if (terms.input.checked) bad.push("the Terms/Privacy box is pre-checked");
    if (terms.inputCount !== 1) bad.push("the Terms/Privacy label holds more than one checkbox");
    if (!/(^|\s)consent(\s|$)/.test(String(terms.labelClass))) bad.push('the Terms/Privacy label is not class="consent"');
    if (terms.text !== TERMS) bad.push(`Terms/Privacy wording differs: ${JSON.stringify(terms.text)}`);
    const want = [["Terms of Service", TERMS_HREF], ["Privacy Policy", PRIVACY_HREF]];
    if (terms.links.length !== 2 || want.some(([t, h], i) => !terms.links[i] || terms.links[i].text !== t || terms.links[i].href !== h)) {
      bad.push(`Terms/Privacy links wrong: ${JSON.stringify(terms.links)}`);
    }
  }
  if (sms) {
    if (sms.input.value !== "yes") bad.push(`sms_consent value is ${JSON.stringify(sms.input.value)}, want "yes"`);
    if (sms.input.required) bad.push("the SMS box is required");
    if (sms.input.checked) bad.push("the SMS box is pre-checked");
    if (sms.inputCount !== 1) bad.push("the SMS label holds more than one checkbox");
    if (!/(^|\s)consent(\s|$)/.test(String(sms.labelClass))) bad.push('the SMS label is not class="consent"');
    if (sms.text !== SMS) bad.push(`SMS wording differs: ${JSON.stringify(sms.text)}`);
  }
  if (terms && sms) {
    // A tidy pair: the required box first, the SMS box directly after it.
    if (terms.start > sms.start) bad.push("the SMS box comes before the Terms/Privacy box");
    else if (form.body.slice(terms.end, sms.start).trim() !== "") bad.push("something sits between the two boxes");
    if (form.boxes.filter((b) => b.input.name === "terms_agree" || b.input.name === "sms_consent").length !== 2) bad.push("not exactly two consent labels");
  }
  return bad;
}

// Runs every form in `pages` ([{ label, html }]) and reports. Returns the totals.
function auditPages(pages, what, floor) {
  let withBox = 0, ok = 0;
  const problems = [], lonely = [], uncovered = [];
  for (const { label, html } of pages) {
    for (const form of leadForms(html)) {
      const hasEither = form.terms.length > 0 || form.sms.length > 0;
      if (form.netlify && !hasEither) uncovered.push(`${label} (${form.name})`);
      if (!hasEither) continue;
      withBox++;
      if ((form.terms.length > 0) !== (form.sms.length > 0)) lonely.push(`${label} (${form.name}): has ${form.terms.length ? "terms_agree" : "sms_consent"} only`);
      const bad = formProblems(form);
      if (bad.length) problems.push(`${label} (${form.name}): ${bad.join("; ")}`); else ok++;
    }
  }
  check(`${what}: at least ${floor} lead forms carry the consent boxes (found ${withBox})`, withBox >= floor,
    "the scan found far fewer forms than the site has -- the check would pass for the wrong reason");
  check(`${what}: every form with the SMS box has the Terms box, and the other way round`, lonely.length === 0,
    `${lonely.length}: ${lonely.slice(0, 3).join(" | ")}`);
  check(`${what}: every Netlify lead form carries the pair`, uncovered.length === 0,
    `${uncovered.length}: ${uncovered.slice(0, 3).join(" | ")}`);
  check(`${what}: every form has the exact Terms/Privacy box (required) and the exact SMS box (unchecked, optional)`,
    problems.length === 0, `${problems.length} of ${withBox}: ${problems.slice(0, 3).join(" | ")}`);
  return { withBox, ok };
}

// --- 1. the built site/ -----------------------------------------------------
console.log("\n1. Every lead form in site/");
const SITE = path.join(ROOT, "site");
const htmlFiles = walk(SITE, (p) => p.endsWith(".html"));
check("site/ is built", htmlFiles.length > 50, `${htmlFiles.length} html files`);
const pages = htmlFiles.map((p) => ({ label: path.relative(ROOT, p), html: fs.readFileSync(p, "utf8") }));
auditPages(pages, "site/", 30);

console.log("\n2. The links point at pages that exist");
const hrefs = new Set();
for (const { html } of pages) for (const f of leadForms(html)) for (const b of f.boxes) if (b.input.name === "terms_agree") b.links.forEach((l) => hrefs.add(l.href));
check("the Terms/Privacy boxes link only to the two legal pages", [...hrefs].sort().join(",") === [PRIVACY_HREF, TERMS_HREF].sort().join(","), [...hrefs].join(","));
check("/terms-of-service.html exists in site/", fs.existsSync(path.join(SITE, "terms-of-service.html")));
check("/privacy-policy.html exists in site/", fs.existsSync(path.join(SITE, "privacy-policy.html")));

// --- 3. the old wording is gone, everywhere ---------------------------------
console.log("\n3. The old wording survives nowhere");
const OLD = /marketing communication/i;
const TEXT_EXT = /\.(html|js|cjs|mjs|py|json|css|md|sh|toml|yml|yaml|txt|xml)$/i;
const scan = (dirs, skip = () => false) => {
  const hits = [];
  for (const d of dirs) {
    for (const p of walk(path.join(ROOT, d), (f) => TEXT_EXT.test(f) && !skip(f))) {
      let s; try { if (fs.statSync(p).size > 8 * 1024 * 1024) continue; s = fs.readFileSync(p, "utf8"); } catch (e) { continue; }
      if (OLD.test(s)) hits.push(path.relative(ROOT, p));
    }
  }
  return hits;
};
let hits = scan(["site"]);
check('no page in site/ still says "marketing communication"', hits.length === 0, `${hits.length}: ${hits.slice(0, 3).join(", ")}`);
// The generators and everything that ships beside them. tests/ is left out: the
// assertions above have to name the old wording to forbid it.
hits = scan(["build", "netlify", "scripts", ".github"]);
check('no generator, function or script still says "marketing communication"', hits.length === 0, `${hits.length}: ${hits.slice(0, 3).join(", ")}`);
check('the old "Consent is not a condition of purchase" box text is gone from every form in site/',
  !pages.some(({ html }) => leadForms(html).some((f) => /Consent is not a condition of purchase/i.test(visibleText(f.body)))));

// --- 4. the generators ------------------------------------------------------
console.log("\n4. The generators produce exactly this");
function pyJson(code) {
  const r = spawnSync("python3", ["-I", "-c", code], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { error: (r.stderr || "").slice(-600) };
  try { return JSON.parse(r.stdout.split("\n").filter(Boolean).pop()); } catch (e) { return { error: `unparseable: ${r.stdout.slice(-200)}` }; }
}
const FORM_OPEN = '<form class="lead-form" name="t" data-netlify="true" method="POST">';
const gen = pyJson([
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('spc_build', 'build/build.py')",
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "print(json.dumps({'terms': m.CONSENT_TERMS_TEXT, 'sms': m.CONSENT_SMS_TEXT, 'html': m.consent_boxes_html()}))",
].join("\n"));
check("build.py loads and exposes the consent helper", !gen.error, gen.error);
if (!gen.error) {
  check("build.py CONSENT_TERMS_TEXT is Lofty's sentence", gen.terms === TERMS, JSON.stringify(gen.terms));
  check("build.py CONSENT_SMS_TEXT is Lofty's sentence", gen.sms === SMS, JSON.stringify(gen.sms));
  const forms = leadForms(`${FORM_OPEN}${gen.html}</form>`);
  check("consent_boxes_html() makes exactly one correct pair", forms.length === 1 && formProblems(forms[0]).length === 0,
    forms.length ? formProblems(forms[0]).join("; ") : "no form parsed");
}
// And the checker itself must be able to fail, or every check above is decoration.
if (!gen.error) {
  const good = gen.html;
  const mutate = (label, fn) => {
    const forms = leadForms(`${FORM_OPEN}${fn(good)}</form>`);
    check(`the checker rejects: ${label}`, forms.length === 1 && formProblems(forms[0]).length > 0);
  };
  mutate("a pre-checked SMS box", (h) => h.replace('name="sms_consent" value="yes"', 'name="sms_consent" value="yes" checked'));
  mutate("a required SMS box", (h) => h.replace('name="sms_consent" value="yes"', 'name="sms_consent" value="yes" required'));
  mutate("a Terms box that is not required", (h) => h.replace(' required>', '>'));
  mutate("a pre-checked Terms box", (h) => h.replace('name="terms_agree" value="yes"', 'name="terms_agree" value="yes" checked'));
  mutate("a re-punctuated SMS sentence", (h) => h.replace("Reply HELP for help or STOP to opt out.", "Reply HELP for help, or STOP to opt out."));
  mutate("a re-worded Terms sentence", (h) => h.replace("of this website.", "of this site."));
  mutate("a non-breaking space inside a sentence", (h) => h.replace("Message frequency varies.", "Message frequency varies."));
  mutate("a Terms link to the wrong page", (h) => h.replace('href="/terms-of-service.html"', 'href="/terms.html"'));
  mutate("a Privacy link to the wrong page", (h) => h.replace('href="/privacy-policy.html"', 'href="/privacy.html"'));
  mutate("the old marketing wording", (h) => h.replace(SMS, "I agree to receive marketing communication via call, text, or similar automated means from Signature Property Collection."));
  mutate("a form with the SMS box but no Terms box", (h) => h.slice(h.indexOf('<label class="consent">', 10)));
  mutate("a form with the Terms box but no SMS box", (h) => h.slice(0, h.indexOf('<label class="consent">', 10)));
  mutate("the SMS box before the Terms box", (h) => { const i = h.indexOf('<label class="consent">', 10); return h.slice(i) + "\n" + h.slice(0, i); });
  mutate("a renamed SMS field", (h) => h.replace('name="sms_consent"', 'name="sms_agree"'));
  mutate("a changed SMS value", (h) => h.replace('name="sms_consent" value="yes"', 'name="sms_consent" value="on"'));
}

// --- 5. the copy committed to git -------------------------------------------
// site/ is regenerated on every deploy, so the committed pages are only the
// fallback -- but they are what a checkout, a rollback or a failed generation
// serves, so they carry the new boxes too. Read from the git INDEX, not the
// working tree: tests/run-all.sh rewrites the working tree with a fresh build
// first, which would hide a stale committed page.
console.log("\n5. The pages committed to git");
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
let committed = null;
try {
  git(["rev-parse", "--git-dir"]);
  if (git(["ls-files", "--", "site"]).trim()) {
    // `git grep` exits 1 when nothing matches, which is a real answer here: an
    // index with no consent boxes at all must fail below, not be skipped.
    let listed = [];
    try { listed = git(["grep", "--cached", "-l", "-e", "sms_consent", "-e", "marketing communication", "--", "site"]).split("\n"); }
    catch (e) { if (e.status !== 1) throw e; }
    committed = listed.filter((f) => f.endsWith(".html")).map((f) => ({ label: `git:${f}`, html: git(["show", `:${f}`]) }));
  }
} catch (e) {
  committed = null;
}
if (!committed) {
  console.log("  --   site/ is not committed here (or this is not a git checkout); skipping the committed-pages check");
} else {
  auditPages(committed, "committed site/", 30);
  check('no committed page still says "marketing communication"', !committed.some((p) => OLD.test(p.html)));
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
