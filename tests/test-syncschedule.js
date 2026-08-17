// The health page's idea of the sync schedule must match the actual schedule.
//
// 2026-08-17. The sync cron moved from */15 to */30 at Christine's request, and
// the /status row that reports on it did not follow. Two consequences, and the
// second is the one that matters:
//
//   1. It told her the sync "should be every 15" — merely wrong.
//   2. It went RED once a run was 20 minutes old. On a 30-minute schedule that
//      is a HEALTHY sync, so the row would have spent a third of every cycle
//      claiming a failure that wasn't happening.
//
// The second is the real cost. This page exists so she can tell working from
// broken at a glance; a row that cries wolf on a normal cycle trains her to
// discount it, and the next genuine failure reads as the same noise. That is
// strictly worse than not having the row at all.
//
// Two independent files have to agree and nothing made them. This is that thing.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
const health = fs.readFileSync(path.join(ROOT, "netlify", "functions", "site-health.js"), "utf8");

// The deployed truth: whatever netlify.toml actually schedules.
const block = toml.slice(toml.indexOf('[functions."sync-listings"]'));
const cron = (block.match(/schedule\s*=\s*"([^"]+)"/) || [])[1];
check("netlify.toml still schedules sync-listings", !!cron, "no schedule found");

// Only the */N minute form is interpreted here. Anything else is a deliberate
// change big enough to deserve reading this file rather than a silent pass.
const everyN = cron && (cron.match(/^\*\/(\d+) \* \* \* \*$/) || [])[1];
check("the schedule is a plain every-N-minutes cron", !!everyN, `cron is "${cron}" — update this test with it`);

const declared = (health.match(/const SYNC_INTERVAL_MINUTES\s*=\s*(\d+)/) || [])[1];
check("site-health.js declares SYNC_INTERVAL_MINUTES", !!declared);

if (everyN && declared) {
  check(
    `site-health's interval (${declared}) matches the cron (every ${everyN} min)`,
    Number(declared) === Number(everyN),
    "the health page will report the wrong schedule to Christine"
  );
}

// The lateness threshold must be DERIVED, not typed — a literal here is exactly
// how the 20 got left behind when the interval changed.
check(
  "the lateness threshold is derived from the interval, not hardcoded",
  /const SYNC_LATE_AFTER_MINUTES\s*=\s*SYNC_INTERVAL_MINUTES\s*[*+]/.test(health),
  "a literal threshold will go stale the next time the schedule moves"
);

// And it must actually be later than one interval, or a healthy sync trips it.
const lateExpr = (health.match(/const SYNC_LATE_AFTER_MINUTES\s*=\s*([^;\n]+)/) || [])[1];
if (lateExpr && declared) {
  const late = new Function(`const SYNC_INTERVAL_MINUTES = ${declared}; return (${lateExpr});`)();
  check(
    `a sync that is merely one cycle late (${declared} min) is not reported as broken`,
    late > Number(declared),
    `threshold ${late} <= interval ${declared} — a healthy run would show red`
  );
}

// The old wording must not survive in the row itself. Comments are stripped
// first: the file explains this bug by QUOTING the wording it replaced, and a
// check that fails on its own documentation is a check people learn to ignore.
const code = health.replace(/^\s*\/\/.*$/gm, "");
check(
  "no hardcoded interval left in the schedule row's text",
  !/should be every \d/.test(code),
  "the detail string still names a fixed number instead of the constant"
);

console.log(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
