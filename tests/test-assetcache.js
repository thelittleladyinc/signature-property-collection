// Every CSS/JS reference must be content-hashed, and every hash must resolve.
//
// 2026-08-17. Christine reported two bugs in one afternoon that were both already
// fixed: her map spots "disappearing when we zoom in" (map.js has no zoom handler
// at all) and the market-report stat block rendering as run-together text (that CSS
// is present, correct, and byte-identical to source). Both times her browser was
// serving an asset from before the deploy that fixed it. She was reading bugs that
// no longer existed, and had no way to tell.
//
// The general failure is worse than the confusion: /assets/{css,js}/* were cached
// for an hour under filenames that never changed, so for an hour after EVERY deploy
// a returning visitor ran the OLD JavaScript against the NEW HTML — a mismatch that
// produces behaviour nobody asked to fix can reproduce.
//
// build.py now content-hashes those files and rewrites the references. This pins
// the three ways that can silently break: a reference left unhashed (a visitor gets
// a stale file), a reference to a hash that does not exist (the page loses its CSS
// entirely, which is far worse than staleness), and the caching policy drifting
// away from the fingerprinting that justifies it.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js|xml|webmanifest)$/.test(e.name)) out.push(p);
  }
  return out;
}

const REF = /\/assets\/(?:css|js)\/[A-Za-z0-9._-]+\.(?:css|js)/g;
// A fingerprinted name carries an 8-hex-char segment before the extension.
const HASHED = /\/assets\/(?:css|js)\/[A-Za-z0-9_-]+\.[0-9a-f]{8}\.(?:css|js)$/;

// EVERYTHING this build generates that can name an asset — not just site/.
//
// 2026-08-17, an hour after fingerprinting shipped: the listing page shell is
// written into netlify/functions/lib/, because listing-page.js reads it at request
// time. The fingerprint pass walked site/ only, so the shell kept pointing at
// /assets/css/style.css after that file was renamed — and every /listing/<id> page,
// the feature Christine asked for so a buyer could text one address to a spouse,
// served with NO stylesheet at all.
//
// The dangerous part is that it was invisible from inside site/: every static page
// was correct, so checking the built output could never have found it. This suite
// therefore scans the generated files OUTSIDE site/ too, which is the only way a
// future one gets caught without someone remembering it exists.
const EXTRA_GENERATED = [
  path.join(ROOT, "netlify", "functions", "lib", "_listing-page-shell.html"),
];

const refs = new Map();           // reference -> first file that used it
for (const f of [...walk(SITE), ...EXTRA_GENERATED.filter(fs.existsSync)]) {
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.match(REF) || []) {
    if (!refs.has(m)) refs.set(m, path.relative(ROOT, f));
  }
}

// And nothing anywhere else in the repo may name an asset without being listed
// above — a served file that references one is a page with no stylesheet.
{
  const scanned = [];
  const stack = [path.join(ROOT, "netlify")];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(html|js)$/.test(e.name)) scanned.push(p);
    }
  }
  const known = new Set(EXTRA_GENERATED);
  const unlisted = [];
  for (const f of scanned) {
    if (known.has(f)) continue;
    const hits = (fs.readFileSync(f, "utf8").match(REF) || []);
    if (hits.length) unlisted.push(`${path.relative(ROOT, f)} → ${hits[0]}`);
  }
  check(
    "no served file outside site/ names an asset without being fingerprinted",
    unlisted.length === 0,
    unlisted.slice(0, 4).join(" · ") +
      " — add it to EXTRA_GENERATED here and to targets in fingerprint_assets()"
  );
}
check("the site references CSS/JS at all", refs.size > 0, `${refs.size} references`);

const unhashed = [...refs].filter(([r]) => !HASHED.test(r));
check(
  "every CSS/JS reference is content-hashed",
  unhashed.length === 0,
  unhashed.map(([r, f]) => `${r} (in ${f})`).slice(0, 4).join(" · ") +
    " — an unversioned asset is cached for a year under netlify.toml, so a change would never reach a returning visitor"
);

const missing = [...refs].filter(([r]) => !fs.existsSync(path.join(SITE, r)));
check(
  "every referenced asset exists on disk",
  missing.length === 0,
  missing.map(([r, f]) => `${r} (in ${f})`).slice(0, 4).join(" · ") +
    " — the page would load with NO stylesheet, which is worse than a stale one"
);

// Nothing may be left behind under the old, unhashed name: it would be cached
// immutably for a year by anything still pointing at it.
for (const sub of ["css", "js"]) {
  const dir = path.join(SITE, "assets", sub);
  if (!fs.existsSync(dir)) continue;
  const stray = fs.readdirSync(dir).filter((n) => /\.(css|js)$/.test(n) && !/\.[0-9a-f]{8}\.(css|js)$/.test(n));
  check(`no unhashed files left in assets/${sub}`, stray.length === 0, stray.join(", "));
}

// The caching policy and the fingerprinting have to stay in step. Immutable caching
// is only safe BECAUSE the names are hashed; if someone removes the hashing, this
// says so at the same moment.
const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
for (const sub of ["css", "js"]) {
  const block = new RegExp(`for = "/assets/${sub}/\\*"[\\s\\S]{0,200}?Cache-Control = "([^"]+)"`);
  const m = block.exec(toml);
  check(`assets/${sub} is cached immutably (safe only because names are hashed)`,
    !!m && /immutable/.test(m[1]), m ? m[1] : "no Cache-Control found");
}

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
