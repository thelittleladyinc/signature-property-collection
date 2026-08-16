// The coverage row has to rank towns by spot count AND name the empty ones —
// Christine's actual question was "how do i view the highest count", asked
// because Windsor's page describes local places while pinning none of them.
const FN_DIR = "/home/user/signature-property-collection/netlify/functions";
const blobsPath = require.resolve("@netlify/blobs", { paths: [FN_DIR] });
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true,
  exports: { getStore: () => ({ get: async () => null, setJSON: async () => {}, list: async () => ({ blobs: [] }) }) } };
process.env.LOFTY_API_KEY = "k"; process.env.GOOGLE_MAPS_API_KEY = "g";
global.fetch = async () => { throw new Error("no live calls"); };
(async () => {
  const res = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: { format: "json" } });
  const p = JSON.parse(res.body);
  const row = p.checks.find((c) => /Tour It With Me coverage/.test(c.name));
  check("the coverage row exists", !!row, p.checks.map(c => c.name).join(" | "));
  if (!row) { process.exit(1); }
  console.log(`       ${row.detail.slice(0, 300)}…`);

  const data = require(`${FN_DIR}/lib/_local-spots.json`);
  const pageCity = new Map((data.townPages || []).map(t => [t.href, t.city]));
  const counts = {};
  for (const s of data.spots) {
    if (!s.cityHref) continue;
    const label = pageCity.get(s.cityHref) || s.city;
    counts[label] = (counts[label] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  check("the highest-count town is listed FIRST",
    new RegExp("^Ranked by number of spots — " + top[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " " + top[1]).test(row.detail),
    row.detail.slice(0, 90));
  check("counts are shown per town", new RegExp(top[0] + " " + top[1]).test(row.detail));
  check("view totals are shown alongside", /\(\d[\d,]* views\)/.test(row.detail));
  check("Windsor is named as empty — the case she asked about", /Windsor/.test(row.detail), row.detail);
  check("it says how many towns are empty out of how many", /\d+ of \d+ town pages have NO spots/.test(row.detail));
  check("empty towns are work-to-do, not a failure", row.optional === true && row.ok === false);
  check("it says what to send to fix one", /business name and town/.test(row.detail));
  check("a town with no page of its own is never used as a label",
    !/\bBellvue\b/.test(row.detail), row.detail);
  check("its spots are counted under the page they live on (Fort Collins)",
    /Fort Collins \d/.test(row.detail), row.detail);
  const html = await require(`${FN_DIR}/site-health.js`).handler({ queryStringParameters: {} });
  check("renders on the HTML page too", /Tour It With Me coverage/.test(html.body));
  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
