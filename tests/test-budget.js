// The audit's finding: a broken Cloudinary account was consuming 100% of every
// sync run's time budget, so the catalog crawl fetched 0 pages. These are the
// two properties that stop that recurring.
const fs = require("fs");
const src = fs.readFileSync("/home/user/signature-property-collection/netlify/functions/sync-listings.js", "utf8");
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

// Pull the detector out of the module text and exercise it for real.
const fn = new Function("return " + src.match(/function isCloudinaryConfigError[\s\S]*?\n\}/)[0])();
console.log("\nConfiguration errors (must NOT be retried)");
for (const m of ["cloud_name mismatch", "Invalid Signature abc", "invalid api_key",
                 "Unknown API key 123", "disabled account"]) {
  check(`"${m}"`, fn(m) === true);
}
console.log("\nTransient errors (must keep retrying)");
for (const m of ["Server returned unexpected status code - 500", "socket hang up",
                 "Request Timeout", "rate limit exceeded", "", null, undefined]) {
  check(`${JSON.stringify(m)}`, fn(m) === false);
}
console.log("\nBudget guard");
check("a fraction constant exists", /PRIORITY_PASS_BUDGET_FRACTION = 0\.\d+/.test(src));
check("it is less than the whole budget", /PRIORITY_PASS_BUDGET_FRACTION = 0\.[1-8]/.test(src));
check("the priority pass uses the capped cutoff, not the full budget",
  /priorityCutoff = Math\.floor\(\(TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS\) \* PRIORITY_PASS_BUDGET_FRACTION\)/.test(src));
check("the loop breaks on the capped cutoff",
  /Date\.now\(\) - startedAt > priorityCutoff/.test(src));
check("the pass is skipped entirely on a config error",
  /cloudConfigBroken \? \[\] : herPendingIds/.test(src));
check("the skip is logged loudly, not silently",
  /skipping the photo-caching priority pass/.test(src));
check("the log names the actual env vars to fix", /CLOUDINARY_\* env vars/.test(src));
check("the crawl's own cutoff is still the FULL budget",
  /Date\.now\(\) - startedAt > TIME_BUDGET_MS - LATE_WORK_TIME_MARGIN_MS/.test(src));
console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
