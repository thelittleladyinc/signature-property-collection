// Every file a function READS AT RUNTIME must be declared in included_files.
//
// 2026-08-17. /listing/<id> — the feature Christine asked for by name, so a buyer
// could text one address to a spouse — answered every request with Netlify's red
// "This function has crashed" page and a stack trace:
//
//   ENOENT: no such file or directory, open
//   '/var/task/netlify/functions/lib/_listing-page-shell.html'
//
// The file is committed, is not gitignored, is produced by the build, and the path
// in the code is correct. NONE of that puts it inside the deployed function.
// Netlify's bundler ships what it can TRACE, and it traces require(). Every other
// file in lib/ is .js or .json and is require()d, which is why they have always
// worked; the shell is the one file read with fs.readFileSync, which the bundler
// cannot see.
//
// This is the exact shape of defect that survives a thorough static audit: I had
// just checked that every function loads, every endpoint resolves, every internal
// link works and every asset reference exists — and all of that was true while the
// endpoint was down, because the file was present locally and absent in the bundle.
//
// So the rule is pinned at the only place it can be: any runtime read must have a
// matching included_files entry.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FN_DIR = path.join(ROOT, "netlify", "functions");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
const includedBlock = /included_files\s*=\s*\[([^\]]*)\]/.exec(toml);
const included = includedBlock
  ? [...includedBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// Find every fs read whose target is built from __dirname — i.e. a repo file the
// function expects to be shipped alongside it.
const reads = [];
for (const f of jsFiles(FN_DIR)) {
  const src = fs.readFileSync(f, "utf8");
  // The path is usually a const; resolve one level of indirection.
  for (const m of src.matchAll(/readFileSync\(\s*([A-Za-z_$][\w$]*)/g)) {
    const varName = m[1];
    const decl = new RegExp(`${varName}\\s*=\\s*path\\.join\\(\\s*__dirname\\s*,\\s*([^)]+)\\)`).exec(src);
    if (!decl) continue;
    const parts = [...decl[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (!parts.length) continue;
    reads.push({
      file: path.relative(ROOT, f),
      target: path.posix.join("netlify/functions", ...parts),
    });
  }
}

check("found the runtime file reads to check", reads.length > 0, `${reads.length} found`);

const covered = (target) =>
  included.some((pat) => pat === target ||
    (pat.endsWith("/**") && target.startsWith(pat.slice(0, -3))) ||
    (pat.includes("*") && new RegExp("^" + pat.replace(/\*\*/g, ".*").replace(/(?<!\.)\*/g, "[^/]*") + "$").test(target)));

for (const r of reads) {
  check(
    `${r.target} is declared in included_files`,
    covered(r.target),
    `${r.file} reads it at runtime, but Netlify's bundler only traces require() — ` +
      "the deployed function will crash with ENOENT"
  );
  check(
    `${r.target} actually exists in the repo`,
    fs.existsSync(path.join(ROOT, r.target)),
    "declared and read, but not present to ship"
  );
}

// And the endpoint must survive the file being absent anyway, because a visitor
// reaching a shared listing link must never be shown a stack trace.
const lp = fs.readFileSync(path.join(FN_DIR, "listing-page.js"), "utf8");
check(
  "listing-page guards its shell read so a missing file cannot crash the endpoint",
  /try\s*\{[\s\S]{0,200}readFileSync[\s\S]{0,400}catch/.test(lp),
  "an unguarded readFileSync here renders Netlify's crash page, stack trace and all, to a buyer"
);
check(
  "and has a self-contained fallback to serve instead",
  /FALLBACK_SHELL/.test(lp)
);

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
