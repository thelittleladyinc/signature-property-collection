// "Realtor" is gone from the site's copy (2026-11-24, Christine: "I have to remove
// realtor from everything and put real estate agent").
//
// What this pins, on the fully built site (tests/run-all.sh builds first):
//   1. no built page, listing-page shell, llms.txt, feed.xml or video sitemap calls
//      anyone a Realtor / REALTOR® -- outside URLs and file names, Realtor.com and
//      other domains, and an organisation named as a source ("Colorado Association
//      of REALTORS®");
//   2. no page claims NAR / CAR / LBAR membership;
//   3. URLs that contain the word are untouched (a URL change is a migration);
//   4. _no_realtor() keeps case with the words around it.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const LIB = path.join(ROOT, "netlify", "functions", "lib");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "assets") walk(p, out); }
    else if (/\.(html|xml|txt)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(SITE).concat(
  fs.readdirSync(LIB).filter((n) => /^_listing-page-shell.*\.html$/.test(n)).map((n) => path.join(LIB, n)));

const WORD = /(?<![\w/\-.%@#])realtors?(?:®|&reg;|&#174;)?(?!\w|[-/%]|\.(?:com|org|net|html?|svg|png|jpe?g|webp|gif)\b)/gi;
const ORG = /(?:associations? of|board of)\s+$/i;
const left = [];
for (const f of files) {
  const t = fs.readFileSync(f, "utf8");
  for (const m of t.matchAll(WORD)) {
    if (ORG.test(t.slice(Math.max(0, m.index - 60), m.index))) continue;
    left.push(`${path.relative(ROOT, f)}: …${t.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, " ")}…`);
  }
}
check(`no "Realtor" in ${files.length} built files`, left.length === 0, left.slice(0, 5).join(" | "));

const member = files.filter((f) => /member of the National Association|NAR, CAR &amp; LBAR|NAR, CAR & LBAR/i.test(fs.readFileSync(f, "utf8")));
check("no NAR / CAR / LBAR membership claim", member.length === 0, member.slice(0, 3).join(", "));

const redirects = fs.readFileSync(path.join(SITE, "_redirects"), "utf8");
check("URLs that contain the word are kept", /why-its-important-to-work-with-a-realtor/.test(redirects));

const cases = JSON.parse(execFileSync("python3", ["-c", [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('tll_build', 'build/build.py')",
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "xs = json.loads(sys.stdin.read())",
  "sys.stdout.write(json.dumps([m._no_realtor(x) for x in xs]))",
].join("\n")], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, input: JSON.stringify([
  "She is a great Realtor and all around person.",
  "Loveland &amp; NoCo Realtor | Christine Gwinnup",
  "the Top 0.5% of Realtors&reg; nationwide",
  "Top 0.5% of Realtors Nationwide",
  "Northern Colorado REALTOR.",
  "Why hire a realtor? A Realtor knows the market.",
  "Zillow, Realtor.com, Redfin",
  "the Colorado Association of REALTORS® reports",
  '<a href="/ault-realtor.html">Ault</a>',
]) }).trim().split("\n").pop());
const want = [
  "She is a great real estate agent and all around person.",
  "Loveland &amp; NoCo Real Estate Agent | Christine Gwinnup",
  "the Top 0.5% of real estate agents nationwide",
  "Top 0.5% of Real Estate Agents Nationwide",
  "Northern Colorado Real Estate Agent.",
  "Why hire a real estate agent? A real estate agent knows the market.",
  "Zillow, Realtor.com, Redfin",
  "the Colorado Association of REALTORS® reports",
  '<a href="/ault-realtor.html">Ault</a>',
];
want.forEach((w, i) => check(`_no_realtor: ${w}`, cases[i] === w, cases[i]));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
