// The description-lines doc is a deliverable Christine pastes into YouTube, so every
// URL in it must resolve to a page that exists and every view count must match the
// data. A wrong link here sends her real audience to a 404.
const ROOT = require("path").resolve(__dirname, "..");
const fs = require("fs");
const doc = fs.readFileSync(`${ROOT}/docs/YOUTUBE-DESCRIPTION-LINES.md`, "utf8");
const spots = require(`${ROOT}/netlify/functions/lib/_local-spots.json`).spots;
let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const SITE = "https://signaturepropertycollection.com";
const urls = [...new Set([...doc.matchAll(/https:\/\/signaturepropertycollection\.com(\/[^\s`)]*)/g)].map(m => m[1]))];
console.log(`       ${urls.length} distinct site URLs referenced`);

const missing = urls.filter((u) => {
  if (u === "/communities") return !fs.existsSync(`${ROOT}/site/communities/index.html`);
  if (u === "/seller-local-proof") return !fs.existsSync(`${ROOT}/site/seller-local-proof.html`);
  return !fs.existsSync(`${ROOT}/site${u}`);
});
check("every referenced page actually exists on disk", missing.length === 0, missing.join(", "));

// Every video-backed spot's town page must appear, or a video is left unlinked.
const videoHrefs = [...new Set(spots.filter(s => s.videoId).map(s => s.cityHref))];
const absent = videoHrefs.filter(h => !doc.includes(h));
check("every town with a video is covered", absent.length === 0, absent.join(", "));

// Totals must match the data, not a stale hand-typed figure.
// Deduped per VIDEO, because one film can back several spots and its views must
// not be counted twice — the same rule the generator uses.
const byVid = new Map();
for (const s of spots) if (s.videoId && !byVid.has(s.videoId)) byVid.set(s.videoId, s.views || 0);
const videoTotal = [...byVid.values()].reduce((a, b) => a + b, 0);
const reviewTotal = spots.filter(s => !s.videoId).reduce((n, s) => n + (s.reviewViews || 0), 0);
check("video view total matches the data", doc.includes(videoTotal.toLocaleString("en-US")),
  videoTotal.toLocaleString("en-US"));
check("review view total matches the data", doc.includes(reviewTotal.toLocaleString("en-US")),
  reviewTotal.toLocaleString("en-US"));
check("videos are listed most-watched first", (() => {
  const nums = [...doc.matchAll(/^### ([\d,]+) views/gm)].map(m => Number(m[1].replace(/,/g, "")));
  return nums.length >= 10 && nums.every((n, i) => i === 0 || nums[i - 1] >= n);
})());
check("no placeholder or TODO left in a paste-ready doc", !/TODO|FIXME|\bXXX\b|\[insert/i.test(doc));
check("tells her the top five cover most of the reach", /top five/.test(doc));
check("does not promise Google reviews can carry a link",
  /can't carry a clickable link/.test(doc));
console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
