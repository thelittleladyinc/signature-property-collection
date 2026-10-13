// .env.example lists exactly the settings the code reads -- names only.
//
// 2026-10-13 (Duplication Audit E4). Nothing in the repository said which settings
// this site needs, so a fresh deploy could silently miss one. .env.example was
// generated from the names the code actually reads; this keeps it that way:
//   1. every setting the code reads is listed (a new one must be added);
//   2. every listed name is still read somewhere (a removed one must go);
//   3. no value is ever filled in, and each name has its own comment line;
//   4. git ignores a local .env but not .env.example.
// The same suite runs in both website repos.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Set by Netlify itself on every deploy; read by the code but never set by hand.
const PLATFORM = new Set(["URL", "DEPLOY_PRIME_URL", "CONTEXT", "NETLIFY", "DEPLOY_URL", "SITE_ID", "SITE_NAME", "PATH"]);

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const inScope = (f) => (f.startsWith("netlify/functions/") || /^build\/[^/]+\.py$/.test(f) || f.startsWith("build/tools/") ||
  f.startsWith("scripts/") || f.startsWith(".github/workflows/")) && fs.existsSync(path.join(ROOT, f));

const read = new Map(); // name -> first file that reads it
const add = (name, f) => { if (!PLATFORM.has(name) && !read.has(name)) read.set(name, f); };
for (const f of tracked.filter(inScope)) {
  const t = fs.readFileSync(path.join(ROOT, f), "utf8");
  const all = (re) => { for (const m of t.matchAll(re)) add(m[1], f); };
  if (/\.(c|m)?js$/.test(f)) {
    all(/process\.env\.([A-Z][A-Z0-9_]+)/g);
    all(/process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g);
    all(/\b(?:env|e)\)*\.([A-Z][A-Z0-9_]{2,})\b/g);          // env.X, e.X, (env || process.env).X
    all(/\b(?:env|e)\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g);
    // Names looked up through a variable (process.env[name], env[name]) are the
    // quoted setting-shaped names in that same file.
    if (/(?:process\.env|\benv)\[\s*[a-z]/.test(t)) all(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g);
  } else if (f.endsWith(".py")) {
    all(/os\.environ\.get\(\s*["']([A-Z][A-Z0-9_]+)["']/g);
    all(/os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g);
    all(/os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g);
  } else if (f.endsWith(".sh")) {
    all(/\$\{([A-Z][A-Z0-9_]+):?[-=]/g);                       // ${NAME:-default}: read from the environment
  } else if (/\.ya?ml$/.test(f)) {
    all(/\$\{\{\s*(?:secrets|vars)\.([A-Z][A-Z0-9_]+)\s*\}\}/g);
  }
}

const file = path.join(ROOT, ".env.example");
check(".env.example exists", fs.existsSync(file));
const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
const listed = new Map();
const valued = [];
const uncommented = [];
lines.forEach((l, i) => {
  const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (!m) return;
  listed.set(m[1], i);
  if (m[2] !== "") valued.push(m[1]);
  if (!/^# \S/.test(lines[i - 1] || "")) uncommented.push(m[1]);
});

console.log(`\n1. The code reads ${read.size} settings; .env.example lists ${listed.size}`);
const missing = [...read.keys()].filter((n) => !listed.has(n)).sort();
check("every setting the code reads is listed", missing.length === 0,
  missing.map((n) => `${n} (${read.get(n)})`).join(", "));
const stale = [...listed.keys()].filter((n) => !read.has(n)).sort();
check("every listed name is still read by the code", stale.length === 0, stale.join(", "));

console.log("\n2. Names only");
check("no value is filled in", valued.length === 0, valued.join(", "));
check("each name has its own comment line", uncommented.length === 0, uncommented.join(", "));
check("no name is listed twice", lines.filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).length === listed.size);

console.log("\n3. git ignores a local .env, not the example");
const ignored = (p) => { try { execFileSync("git", ["check-ignore", "-q", p], { cwd: ROOT }); return true; } catch (e) { return false; } };
check(".env is ignored", ignored(".env"));
check(".env.example is not", !ignored(".env.example"));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED\n`);
process.exit(failures ? 1 : 0);
