// The stylesheet's structural invariants.
//
// 2026-08-18: .spot-proof was missing its closing brace. Under native CSS
// nesting that is NOT a syntax error — every rule after it (150+ lines: the
// mobile Call/Text/Email/Schedule bar, the keyboard skip-link, the town
// directory) silently became a nested child of .spot-proof, matching nothing.
// The mobile tap bar rendered as four 17px text links for who knows how long,
// and no build step, test, or console error said a word. Lighthouse's
// touch-target audit disagreeing with what the file plainly said was the only
// symptom. These checks make that class of failure loud.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (l, c, x) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${x ? ` — ${x}` : ""}`); } };

const src = fs.readFileSync(path.join(ROOT, "build", "assets", "css", "style.css"), "utf8");
const cssDir = path.join(ROOT, "site", "assets", "css");
const builtName = fs.readdirSync(cssDir).find((f) => f.endsWith(".css"));
const built = fs.readFileSync(path.join(cssDir, builtName), "utf8");

check("source braces balance exactly",
  src.split("{").length === src.split("}").length,
  `diff=${src.split("{").length - src.split("}").length} — an unclosed block nests everything after it into oblivion`);

check("no accidental nesting survives into the built css",
  !/&\s/.test(built.replace(/"[^"]*"/g, "")),
  "a '&' selector means some block swallowed its neighbours");

check("the mobile tap bar's rules are reachable (display:none at top level…)",
  built.includes(".contact-bar{display:none}"));
check("…and display:flex inside the mobile media query",
  /@media \(max-width:760px\)\{\.contact-bar\{display:flex/.test(built),
  "this exact rule was dead for days inside .spot-proof");

// WCAG contrast, asserted as MATH on the actual token values rather than as
// hex strings someone has to re-derive. If a future rebrand shifts a color,
// this recomputes and speaks up only when the ratio actually breaks.
function lum(hex) {
  const f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const token = (name) => ((src.match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`)) || [])[1] || "").toLowerCase();
const rose = token("rose"), deep = token("deep-mauve"), charcoal = token("charcoal");

check("tokens resolve to literal hex (rose, deep-mauve, charcoal)",
  !!(rose && deep && charcoal), `rose=${rose} deep=${deep} charcoal=${charcoal}`);
check("deep-mauve under WHITE text clears WCAG AA (buttons, tap-bar primary)",
  deep && ratio(deep, "ffffff") >= 4.5,
  deep ? `ratio=${ratio(deep, "ffffff").toFixed(2)}, needs 4.5 — this was 2.92 when deep-mauve aliased the LIGHT mauve` : "");
check("deep-mauve as TEXT on white clears WCAG AA (labels, media links, prices)",
  deep && ratio(deep, "ffffff") >= 4.5);
check("rose as TEXT on charcoal clears WCAG AA (hero eyebrow)",
  rose && charcoal && ratio(rose, charcoal) >= 4.5,
  rose && charcoal ? `ratio=${ratio(rose, charcoal).toFixed(2)}` : "");
check("charcoal as TEXT on rose clears WCAG AA (header tagline)",
  rose && charcoal && ratio(charcoal, rose) >= 4.5);
check("the primary button uses the deep token, not raw rose",
  /\.btn-primary\s*\{\s*background:\s*var\(--deep-mauve\)/.test(src),
  "white on raw rose is 3.75 — the exact fail PageSpeed flagged");

// The minifier's contract: smaller, and byte-for-byte the same parse.
check("built css is at least 30% smaller than source",
  built.length < src.length * 0.7,
  `${Math.round(built.length / 1024)}KB vs ${Math.round(src.length / 1024)}KB`);
check("minification strips every comment",
  !built.includes("/*"));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
