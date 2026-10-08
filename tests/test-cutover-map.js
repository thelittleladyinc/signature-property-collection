// The Signature -> main-site cutover map (2026-10-08).
//
// build/data/cutover_to_tllsh.json says which Signature page forwards to which
// page on thelittleladysellshomes.com, in six groups, and build/cutover.py turns
// the groups that are switched on into one-hop forced 301s. This pins the parts
// that must not drift, whichever groups are on:
//
//   - the map's shape: groups 1..N, every page once, the home page and the
//     thank-you page in the LAST group, /404.html never forwarded;
//   - every built page is forwarded already (the 46 pruned community pages) or is
//     in exactly one group, so no page is forgotten;
//   - applied to the redirect file this build just wrote, each group (and all of
//     them together) leaves no chain, no loop, no unforced rule and no duplicate
//     source: every old address reaches its final page in ONE hop, and the printed
//     books' /expiredlisting QR address lands on the Collection's book page;
//   - the map in the repo switches nothing on by itself: "active_groups" is the
//     only thing that does, and the checks above run for it too.
//
// The targets themselves live in another repository. With TLLSH_CHECKOUT set to a
// built checkout of the main site, every target is also confirmed to exist there
// and every Collection target is confirmed to be one the main site still
// canonicals to Signature. Without it that part is skipped, and says so.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MAP = path.join(ROOT, "build", "data", "cutover_to_tllsh.json");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

function py(args) {
  const r = spawnSync("python3", ["build/cutover.py", ...args], { cwd: ROOT, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return { ok: r.status === 0, problems: out.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(5)), out };
}

console.log("\n1. The map file");
const map = JSON.parse(fs.readFileSync(MAP, "utf8"));
const groups = Object.keys(map.groups).map(Number).sort((a, b) => a - b);
check("groups are numbered 1..N", groups.every((g, i) => g === i + 1), groups.join(","));
check("active_groups is a list of existing groups", Array.isArray(map.active_groups) && map.active_groups.every((g) => String(g) in map.groups), JSON.stringify(map.active_groups));
const sources = groups.flatMap((g) => Object.keys(map.groups[g].pages));
check("every page is in exactly one group", new Set(sources).size === sources.length, `${sources.length} entries`);
check("the home page is in the last group", Object.keys(map.groups[groups[groups.length - 1]].pages).includes("/index.html"));
check("/404.html is never forwarded", !sources.includes("/404.html"));
check("every target is a path on the main site", groups.every((g) => Object.values(map.groups[g].pages).every((t) => t.startsWith("/") && !t.includes("://"))));

console.log("\n2. The groups that are switched on (none, until a group is added to active_groups)");
let r = py(["check"]);
check("redirect rules, coverage and shape are clean for the active groups", r.ok, r.problems.slice(0, 3).join(" | "));

console.log("\n3. Each group on its own, and all together");
for (const g of groups) {
  r = py(["check", "--groups", String(g)]);
  check(`group ${g} (${Object.keys(map.groups[g].pages).length} pages${map.groups[g].extra_rules ? " + pattern rules" : ""}) leaves every old address one hop from its final page`, r.ok, r.problems.slice(0, 3).join(" | "));
}
r = py(["check", "--groups", "all"]);
check("all groups together: no chain, loop, unforced rule or duplicate; printed-book address lands on the Collection book page", r.ok, r.problems.slice(0, 3).join(" | "));

console.log("\n4. The targets on the main site");
if (process.env.TLLSH_CHECKOUT) {
  r = py(["verify-targets", "--tllsh", process.env.TLLSH_CHECKOUT]);
  check("every target exists on the main site and every Collection target is one it still canonicals to Signature", r.ok, r.problems.slice(0, 3).join(" | "));
} else {
  console.log("  skip TLLSH_CHECKOUT is not set (point it at a built checkout of the main site to check the targets)");
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
