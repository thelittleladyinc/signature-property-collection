// A deploy doesn't make every page look edited (2026-09-29).
//
// The page date is decided by comparing each built page with its committed copy
// (build/postprocess_freshness.py, run by scripts/netlify-build.sh). Production builds carry the
// analytics tags -- GA, the Meta Pixel, Search Console verification -- because
// those IDs are Netlify environment variables, and the committed site/ is built
// without them. So on Netlify every page differed from its committed copy on
// every deploy: the live sitemap on 2026-09-29 dated 34 of 37 pages "today".
// (A production-like build with the variables set: the old comparison called
// 113 of 113 pages "genuinely changed"; with this fix, 0.) Tracking tags are
// infrastructure, not content.
//
// This builds the production-only tags exactly as build.py emits them with the
// variables set, adds them to real built pages, and checks the comparison can't
// see them -- while a real edit still counts.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const env = { ...process.env, GA_MEASUREMENT_ID: "G-TEST12345", META_PIXEL_ID: "785995940287531", GSC_VERIFICATION: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V" };
const tags = JSON.parse(execFileSync("python3", ["-c", [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('spc_build', 'build/build.py')",
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "sys.stdout.write(json.dumps({'gsc': m._gsc_verification_tag(), 'ga': m._analytics_tag(), 'pixel': m._meta_pixel_tag()}))",
].join("\n")], { cwd: ROOT, env, encoding: "utf8" }));
const hints = '<link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>\n' +
  '<link rel="dns-prefetch" href="https://connect.facebook.net">\n';

const normalize = (html) => execFileSync("python3", ["-c", [
  "import sys",
  "sys.path.insert(0, 'build')",
  "import postprocess_freshness as p",
  "sys.stdout.write(p._blank(sys.stdin.read()))",
].join("\n")], { cwd: ROOT, input: html, encoding: "utf8" });

console.log("\n1. The production-only tags are real (built with the variables set)");
check("GA tag built", /googletagmanager\.com\/gtag\/js\?id=G-TEST12345/.test(tags.ga));
check("Meta Pixel built", /fbq\('init','785995940287531'\)/.test(tags.pixel) && /<noscript>/.test(tags.pixel));
check("Search Console verification built", /google-site-verification/.test(tags.gsc));

console.log("\n2. They don't make a page look edited");
const blogDir = path.join(SITE, "blog");
const samples = ["index.html", "about.html", "luxury-market.html",
  path.join("blog", fs.readdirSync(blogDir).find((f) => f.endsWith(".html") && f !== "index.html"))];
for (const rel of samples) {
  const page = fs.readFileSync(path.join(SITE, rel), "utf8");
  // Added before </head>; the comparison drops the tags and blank lines, so
  // where they sit doesn't matter. (A full build with the variables set was
  // checked the same way on 2026-09-29: 113 "changed" before, 0 after.)
  const production = page.replace("</head>", `${hints}${tags.gsc}\n${tags.ga}\n${tags.pixel}\n</head>`);
  check(`${rel}: same page with the production analytics tags compares equal`, normalize(page) === normalize(production));
}

console.log("\n3. A real edit still counts");
const about = fs.readFileSync(path.join(SITE, "about.html"), "utf8");
const edited = about.replace(/<h1([^>]*)>/, "<h1$1>Edited ");
check("changed copy is still a change", edited !== about && normalize(about) !== normalize(edited));

// 2026-10-05: the scheduled town-market job, the geocode job and the retry in
// scripts/commit-generated.sh each ran `python3 build/build.py` on its own, with
// no freshness step after it, and committed the result. The deploy's freshness
// step restores the COMMITTED date, so the first scheduled run after PR #72
// (f883df8) put 2026-10-05 on 74 unchanged pages and all 34 sitemap entries, and
// that is what went live. Rule now: only scripts/netlify-build.sh (what the
// deploy runs) may run build.py; every other path goes through tests/run-all.sh,
// which runs that script and then every suite.
console.log("\n4. Every path that regenerates site/ builds the way the deploy does");
const commands = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").split("\n")
  .filter((l) => !/^\s*(#|echo\b)/.test(l)).join("\n");        // comments and log lines are not commands
const RUNS_BUILD_PY = /\bpython3?\s+(?:-\S+\s+)*["']?build\/build\.py\b/;
for (const file of [".github/workflows/town-market.yml", ".github/workflows/geocode-towns.yml", "scripts/commit-generated.sh"]) {
  check(`${file} rebuilds and verifies through tests/run-all.sh`, /bash tests\/run-all\.sh/.test(commands(file)));
}
const runAll = commands("tests/run-all.sh");
check("tests/run-all.sh builds with the deploy's own script", /bash scripts\/netlify-build\.sh/.test(runAll));
check("tests/run-all.sh runs the freshness step again after the suites (test-reviewspot rebuilds site/)",
  runAll.lastIndexOf("build/postprocess_freshness.py") > runAll.indexOf("for t in tests/test-*.js"));
check("tests/run-all.sh runs the node:test suites too (tests/test-*.cjs)", /for t in tests\/test-\*\.cjs/.test(runAll) && /node --test "\$t"/.test(runAll));
const sweep = [
  ...fs.readdirSync(path.join(ROOT, ".github/workflows")).map((f) => `.github/workflows/${f}`),
  ...fs.readdirSync(path.join(ROOT, "scripts")).map((f) => `scripts/${f}`),
  "tests/run-all.sh",
].filter((f) => f !== "scripts/netlify-build.sh");
for (const file of sweep) check(`${file} leaves build.py to scripts/netlify-build.sh`, !RUNS_BUILD_PY.test(commands(file)));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
