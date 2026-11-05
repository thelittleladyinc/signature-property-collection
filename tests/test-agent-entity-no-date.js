// The sitewide RealEstateAgent entity carries no dateModified (2026-11-05).
//
// build.py wrote "dateModified": BUILD_DATE into the agent entity on every page and
// into the listing-page shell. The freshness step put the committed date back on an
// unchanged page, so the entity read the day of the last build that changed anything
// (all 114 pages said 2026-11-04 after the cutover) -- a claim that the agent changed
// that day, renewed by every deploy that touched a page. The main site's rule: "Do
// not put a daily dateModified on the sitewide RealEstateAgent entity simply because
// the generator ran." The entity has no honest date, so it now carries none.
//
// What this pins:
//   1. the generator writes no date on the agent entity;
//   2. no built page and no listing-page shell carries one, while blog posts keep
//      their own real dateModified;
//   3. the freshness step (build/postprocess_freshness.py) fails the build when a
//      page or a shell carries one;
//   4. a committed page that still carries the old field is NOT an edit, so removing
//      the field re-dates no page, and restoring the committed dates never hands the
//      agent's old date to a blog post.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const LIB = path.join(ROOT, "netlify", "functions", "lib");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };
const py = (code, input) => execFileSync("python3", ["-c", code], { cwd: ROOT, input, encoding: "utf8" });
const fresh = (fn, input) => py(["import sys", "sys.path.insert(0, 'build')", "import postprocess_freshness as p", fn].join("\n"), input);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}
const blocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
function nodes(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => nodes(v, out));
  else if (value && typeof value === "object") { out.push(value); Object.values(value).forEach((v) => nodes(v, out)); }
  return out;
}
const OLD_FIELD = (html) => html.replace(/("knowsAbout"\s*:\s*\[[^\]]*\])/, '$1, "dateModified": "2026-09-29"');

console.log("\n1. The generator writes no date on the agent entity");
const agent = JSON.parse(py([
  "import importlib.util, sys",
  "spec = importlib.util.spec_from_file_location('spc_build', 'build/build.py')",
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "sys.stdout.write(m._real_estate_agent_schema())",
].join("\n")));
check("build.py's RealEstateAgent schema is the agent entity", agent["@type"] === "RealEstateAgent" && /Gwinnup/.test(agent.name || ""));
check("build.py's RealEstateAgent schema has no dateModified", !("dateModified" in agent), agent.dateModified);

console.log("\n2. No built page and no listing-page shell carries one; blog posts keep theirs");
let agentPages = 0, blogDates = 0;
const datedAgent = [], unreadable = [];
for (const file of walk(SITE)) {
  const html = fs.readFileSync(file, "utf8");
  for (const raw of blocks(html)) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { unreadable.push(path.relative(SITE, file)); continue; }
    for (const n of nodes(parsed)) {
      if (n["@type"] === "RealEstateAgent") { agentPages++; if ("dateModified" in n) datedAgent.push(path.relative(SITE, file)); }
      if (n["@type"] === "BlogPosting" && /^\d{4}-\d{2}-\d{2}/.test(String(n.dateModified || ""))) blogDates++;
    }
  }
}
check("site/ carries the agent entity", agentPages > 50, String(agentPages));
check("every JSON-LD block on every built page parses", unreadable.length === 0, unreadable.slice(0, 5).join(", "));
check("no built page's RealEstateAgent carries a dateModified", datedAgent.length === 0, `${datedAgent.length}: ${datedAgent.slice(0, 5).join(", ")}`);
check("blog posts still carry their own dateModified", blogDates >= 3, String(blogDates));
for (const name of fs.readdirSync(LIB).filter((f) => /^_listing-page-shell.*\.html$/.test(f))) {
  const shell = fs.readFileSync(path.join(LIB, name), "utf8");
  check(`${name}: the agent entity carries no dateModified`, !/"@type":\s*"RealEstateAgent"[^<]*?"dateModified"/.test(shell));
}

console.log("\n3. The freshness step fails the build when one comes back");
const sample = fs.readFileSync(path.join(SITE, "about.html"), "utf8");
const dated = OLD_FIELD(sample);
check("(the test page really carries the field)", dated !== sample && /"dateModified": "2026-09-29"/.test(dated));
const gate = JSON.parse(fresh([
  "import json, tempfile, pathlib, io, contextlib",
  "pages = json.loads(sys.stdin.read())",
  "out = {}",
  "for label, (page, shell) in pages.items():",
  "    tmp = pathlib.Path(tempfile.mkdtemp())",
  "    (tmp / 'site').mkdir(); (tmp / 'netlify' / 'functions' / 'lib').mkdir(parents=True)",
  "    (tmp / 'site' / 'about.html').write_text(page, encoding='utf-8')",
  "    (tmp / 'netlify' / 'functions' / 'lib' / '_listing-page-shell.html').write_text(shell, encoding='utf-8')",
  "    p.ROOT, p.SITE = tmp, tmp / 'site'",
  "    with contextlib.redirect_stdout(io.StringIO()):",
  "        rc = p.main()",
  "    out[label] = {'errors': p._agent_date_errors(), 'rc': rc}",
  "sys.stdout.write(json.dumps(out))",
].join("\n"), JSON.stringify({ clean: [sample, sample], page: [dated, sample], shell: [sample, dated] })));
check("a clean page and shell pass, and the step exits 0", gate.clean.errors.length === 0 && gate.clean.rc === 0, JSON.stringify(gate.clean));
check("a page whose agent entity carries a dateModified fails the step (exit 1)",
  gate.page.rc === 1 && gate.page.errors.length === 1 && /site\/about\.html/.test(gate.page.errors[0]), JSON.stringify(gate.page));
check("a listing-page shell whose agent entity carries one fails the step (exit 1)",
  gate.shell.rc === 1 && gate.shell.errors.length === 1 && /_listing-page-shell\.html/.test(gate.shell.errors[0]), JSON.stringify(gate.shell));
const hasDate = (html) => fresh("sys.stdout.write(str(p._agent_has_date(sys.stdin.read())))", html) === "True";
const blogFile = path.join(SITE, "blog", "psychology-of-pricing-luxury-homes-northern-colorado.html");
const blog = fs.readFileSync(blogFile, "utf8");
check("a blog post's own dateModified is not mistaken for the agent's", /"BlogPosting"/.test(blog) && !hasDate(blog));
check("a block that does not parse is judged by its text (fails closed)",
  hasDate('<script type="application/ld+json">{"@type": "RealEstateAgent", "dateModified": "2026-11-05",}</script>'));

console.log("\n4. The old field in a committed copy is not an edit");
const blank = (html) => fresh("sys.stdout.write(p._blank(sys.stdin.read()))", html);
check("a page with the old agent date compares equal to the same page without it", blank(dated) === blank(sample));
const blogDated = OLD_FIELD(blog);
check("(the blog test page really carries the field)", blogDated !== blog);
check("same on a blog post", blank(blogDated) === blank(blog));
const ownDate = (html) => (/"@type":\s*"BlogPosting"[^<]*?"dateModified":\s*"([^"]+)"/.exec(html) || [])[1];
check("(the blog post's own date is not the agent's old one)", !!ownDate(blog) && ownDate(blog) !== "2026-09-29", ownDate(blog));
const restored = fresh([
  "import json",
  "fresh_page, committed = json.loads(sys.stdin.read())",
  "sys.stdout.write(p._restore(fresh_page, committed))",
].join("\n"), JSON.stringify([blog, blogDated]));
check("restoring the committed dates keeps the blog post's own dateModified", ownDate(restored) === ownDate(blog), ownDate(restored));
check("and adds no date to the agent entity", !hasDate(restored));
const edited = sample.replace(/<h1([^>]*)>/, "<h1$1>Edited ");
check("a real edit still counts", edited !== sample && blank(edited) !== blank(sample));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures ? 1 : 0);
