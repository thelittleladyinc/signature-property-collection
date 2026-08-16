// Tappable contact everywhere, and scheduling that never ships broken.
//
// 2026-08-16 (Christine: "I would like to have mroe tapable links for my phone
// number - whatever is the best roi - then we need a click to schedule with
// calendly - make it easy to get ahold of me through email or phone or text").
//
// Her number was plain text on all 144 pages. Readable, never tappable, and absent
// from the header entirely -- so on a phone the only route to calling her was
// select, copy, switch app, paste. The footer already appeared on every page, which
// made it the cheapest fix available, and the sticky mobile bar is the highest-
// converting pattern for a service business on a phone.
//
// What this suite protects, in order of how quietly it would break:
//   1. A tel:/sms: href containing punctuation. Some dialers cope, some do not, and
//      the ones that don't fail silently on the visitor's phone where nobody sees it.
//   2. The bar covering the last line of every page. This pattern almost always
//      ships that bug; the body padding is what prevents it.
//   3. A Schedule button pointing nowhere. Worse than no button, and it would only
//      be noticed by a lead who already tried to book.
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
const rel = (f) => path.relative(ROOT, f);

// --- present on every page ----------------------------------------------------
for (const [label, needle] of [
  ["sticky contact bar", 'class="contact-bar"'],
  ["a tappable phone number", 'href="tel:'],
  ["a text-message link", 'href="sms:'],
  ["a mailto link", 'href="mailto:'],
]) {
  const missing = pages.filter((f) => !fs.readFileSync(f, "utf8").includes(needle));
  check(`every page has ${label} (${pages.length} pages)`, missing.length === 0,
    `${missing.length} missing, e.g. ${missing.slice(0, 2).map(rel).join(", ")}`);
}

// --- the hrefs are actually dialable -----------------------------------------
const badHref = [];
for (const f of pages) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(/href="(tel|sms):([^"]*)"/g)) {
    // Digits, and optionally a leading +. Anything else (spaces, dashes, brackets)
    // is what dialers disagree about.
    if (!/^\+?\d{7,}$/.test(m[2])) badHref.push(`${rel(f)}: ${m[0]}`);
  }
}
check("every tel:/sms: href is digits only", badHref.length === 0,
  badHref.slice(0, 3).join(" | "));

// The visible text should still read the way she writes it, punctuation and all --
// stripping it in the href must not strip it on screen.
const home = fs.readFileSync(path.join(ROOT, "site/index.html"), "utf8");
check("the number is still displayed with her formatting", /303-709-4262/.test(home));

// --- the bar must not sit on top of the page ---------------------------------
const css = fs.readFileSync(path.join(ROOT, "build/assets/css/style.css"), "utf8");
const barBlock = css.slice(css.indexOf("Sticky contact bar"));
check("the bar is hidden by default and shown only on narrow screens",
  /\.contact-bar \{ display: none; \}/.test(barBlock)
  && /@media \(max-width: 760px\)/.test(barBlock));
check("body gets bottom padding so the bar never covers content",
  /body \{ padding-bottom: \d+px; \}/.test(barBlock));
check("respects the iPhone home indicator",
  /env\(safe-area-inset-bottom/.test(barBlock));
const minH = (barBlock.match(/min-height: (\d+)px/) || [])[1];
check(`touch targets clear the 44px minimum (found ${minH || "none"}px)`,
  Number(minH) >= 44, String(minH));

// --- scheduling: configured or absent, never broken --------------------------
const withSchedule = pages.filter((f) =>
  /data-contact="schedule"/.test(fs.readFileSync(f, "utf8")));
const buildPy = fs.readFileSync(path.join(ROOT, "build/build.py"), "utf8");
check("the schedule URL is read from config, with an env override",
  /SCHEDULE_URL = \(os\.environ\.get\("CALENDLY_URL"\)/.test(buildPy));
check("the button is omitted rather than rendered dead",
  /if not SCHEDULE_URL:\s*\n\s*return ""/.test(buildPy));

// 2026-08-16, second pass. This first read "no page carries a booking link while
// none is configured" -- true right up until Christine supplied her Calendly URL an
// hour later, at which point a correct build failed the suite.
//
// The invariant is not "absent"; it is "absent OR everywhere, matching the config".
// Asserted against what SITE actually holds so the test follows the site instead of
// a moment in its history -- the same mistake the Windsor-has-no-spots test made.
const configured = (buildPy.match(/"schedule_url":\s*"([^"]*)"/) || [])[1] || "";
if (configured) {
  check(`a booking link is configured, so every page carries it (${pages.length} pages)`,
    withSchedule.length === pages.length,
    `${withSchedule.length} of ${pages.length}`);
  // A booking URL that points at the wrong host is the failure a lead discovers,
  // not one a build does.
  const wrongHref = pages.filter((f) => {
    const html = fs.readFileSync(f, "utf8");
    return /data-contact="schedule"/.test(html) && !html.includes(`href="${configured}"`);
  });
  check("every booking link points at the configured URL", wrongHref.length === 0,
    wrongHref.slice(0, 2).map(rel).join(", "));
  check("it is an https link, not a bare domain",
    /^https:\/\//.test(configured), configured);
  check("the highest-intent pages offer it explicitly, not just in the mobile bar",
    /Book A Call With/.test(fs.readFileSync(path.join(ROOT, "site/contact.html"), "utf8"))
    && /Pick A Time That Suits You/.test(fs.readFileSync(path.join(ROOT, "site/thank-you.html"), "utf8")));
} else {
  check("no committed page carries a booking link while none is configured",
    withSchedule.length === 0,
    `${withSchedule.length} pages, e.g. ${withSchedule.slice(0, 2).map(rel).join(", ")}`);
}

// --- measurement, so "best ROI" becomes a number -----------------------------
check("contact clicks report which method was used",
  /"contact_click"[\s\S]{0,120}data-contact/.test(home)
  || /contact_click[\s\S]{0,160}method/.test(home));
check("click tracking is guarded on gtag, so links work with analytics off",
  /typeof window\.gtag !== "function"\) return/.test(home));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
