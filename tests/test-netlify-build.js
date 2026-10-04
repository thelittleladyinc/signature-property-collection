// scripts/netlify-build.sh: what gets published when a step fails.
//
// 2026-10-03: when the freshness step (build/postprocess_freshness.py) failed,
// the script used to publish anyway, so every page told Google it was edited
// today. Now a freshness failure is treated like a build failure: the committed
// site/ is restored and the deploy fails, so the last good deploy keeps serving.
//
// Runs the real script in a throwaway git repo with stub build/freshness
// scripts (PYTHON_BIN, BUILD_SCRIPT and FRESHNESS_SCRIPT are overridable for
// exactly this), so nothing in this checkout is touched.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const COMMITTED = "<p>committed page, dated 2026-09-29</p>\n";
const BUILT = "<p>fresh build, every page dated today</p>\n";

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spc-netlify-build-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  fs.mkdirSync(path.join(dir, "site"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "site", "index.html"), COMMITTED);
  fs.copyFileSync(path.join(ROOT, "scripts", "netlify-build.sh"), path.join(dir, "scripts", "netlify-build.sh"));
  // The build stub writes the "fresh" page; the freshness stub exits with FRESH_RC.
  fs.writeFileSync(path.join(dir, "build_stub.py"),
    `import os, sys\nopen("site/index.html", "w").write(${JSON.stringify(BUILT)})\nsys.exit(int(os.environ.get("BUILD_RC", "0")))\n`);
  fs.writeFileSync(path.join(dir, "fresh_stub.py"),
    `import os, sys\nsys.exit(int(os.environ.get("FRESH_RC", "0")))\n`);
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed");
  return dir;
}

function run(dir, extra) {
  return spawnSync("bash", ["scripts/netlify-build.sh"], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, PYTHON_BIN: "python3", BUILD_SCRIPT: "build_stub.py",
      FRESHNESS_SCRIPT: "fresh_stub.py", REQS_FILE: "no-such-requirements.txt", ...extra },
  });
}

const page = (dir) => fs.readFileSync(path.join(dir, "site", "index.html"), "utf8");

console.log("\n1. Build and freshness both succeed");
let dir = sandbox();
let r = run(dir, { BUILD_RC: "0", FRESH_RC: "0" });
check("the deploy succeeds", r.status === 0, `exit ${r.status}\n${r.stdout}${r.stderr}`);
check("the freshly built site/ is what gets published", page(dir) === BUILT);

console.log("\n2. The freshness step fails");
dir = sandbox();
r = run(dir, { BUILD_RC: "0", FRESH_RC: "1" });
check("the deploy fails, so the last good deploy keeps serving", r.status === 1, `exit ${r.status}`);
check("site/ is restored to the committed copy (no page re-dated today)", page(dir) === COMMITTED, page(dir));
check("the log says why", /FAILED/.test(r.stdout) && /Not publishing/.test(r.stdout), r.stdout);

console.log("\n3. The build itself fails (unchanged behaviour)");
dir = sandbox();
r = run(dir, { BUILD_RC: "1", FRESH_RC: "0" });
check("the deploy fails", r.status === 1, `exit ${r.status}`);
check("site/ is restored to the committed copy", page(dir) === COMMITTED, page(dir));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
