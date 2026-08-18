// The per-second gate on MLS Grid calls — born from the third suspension.
//
// 2026-08-18, from the account's own Usage Log: the hour that suspended the
// token held just 44 requests — but TEN landed in the same second (15:16:57),
// one per concurrent listing-photo lambda. Volume guards (hourly, daily)
// never saw it coming, and the browser-side pacer paces one browser: ten
// simultaneous viewers are ten browsers. paceMlsCall is the cross-invocation
// gate: jitter to de-synchronize, then a Blobs bucket allowing 2 starts per
// second. The jitter is load-bearing — without it, N lambdas born in the same
// instant all read count=0 before anyone writes (the first version released
// 10-of-10 in 1ms).
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const media = fs.readFileSync(path.join(ROOT, "netlify", "functions", "lib", "_media.js"), "utf8");
check("the resolve path paces before contacting MLS Grid",
  /await paceMlsCall\(store\);[\s\S]{0,400}?const res = await fetch\(`\$\{baseUrl\}/.test(media));
check("the media-download path paces before its mode loop",
  /await paceMlsCall\(store\);\n  for \(const mode of modes\)/.test(media));

const blobs = {};
const lat = (v) => new Promise((r) => setTimeout(() => r(v), 40)); // realistic Blobs latency
const fakeStore = {
  async get(k) { return lat(blobs[k] ? JSON.parse(blobs[k]) : null); },
  async setJSON(k, v) { blobs[k] = JSON.stringify(v); return lat(); },
  async delete() {}, async list() { return { blobs: [] }; },
};
const { paceMlsCall } = require(path.join(ROOT, "netlify", "functions", "lib", "_mls-usage"));

(async () => {
  const t0 = Date.now();
  const done = [];
  await Promise.all(Array.from({ length: 10 }, () =>
    paceMlsCall(fakeStore).then(() => done.push(Date.now() - t0))));
  const bySec = {};
  for (const ms of done) { const s = Math.floor(ms / 1000); bySec[s] = (bySec[s] || 0) + 1; }
  const worst = Math.max(...Object.values(bySec));
  check("10 simultaneous callers never exceed 4 starts in any one second (the burst ceiling)",
    worst <= 4, `worst second saw ${worst} — the suspension fired at 9`);
  check("the burst is spread across multiple seconds, not merely delayed together",
    Math.max(...done) >= 1200, `spread ${Math.max(...done)}ms`);
  check("every caller is eventually released (photos load, never hang)",
    done.length === 10);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
})();
