// Resolve a built asset whose filename now carries a content hash.
//
// 2026-08-17. build.py fingerprints CSS/JS (site/assets/js/map.js becomes
// map.2d7380ea.js) so a deploy reaches returning visitors immediately instead of
// up to an hour later — see fingerprint_assets(). Four suites opened those files by
// their old fixed names and broke the moment that shipped.
//
// Resolving by STEM rather than hardcoding a hash keeps them honest: the tests
// still read the real built file, and they do not have to be edited every time its
// contents change (which is every time the hash changes, i.e. constantly).
const fs = require("fs");
const path = require("path");

function builtAsset(root, sub, stem, ext) {
  const dir = path.join(root, "site", "assets", sub);
  const exact = path.join(dir, `${stem}${ext}`);
  if (fs.existsSync(exact)) return exact;            // pre-fingerprint, or source tree
  const re = new RegExp(`^${stem}\\.[0-9a-f]{8}\\${ext}$`);
  const hit = fs.readdirSync(dir).find((n) => re.test(n));
  if (!hit) throw new Error(`no built asset for ${sub}/${stem}${ext} in ${dir}`);
  return path.join(dir, hit);
}

const readBuiltAsset = (root, sub, stem, ext) =>
  fs.readFileSync(builtAsset(root, sub, stem, ext), "utf8");

module.exports = { builtAsset, readBuiltAsset };
