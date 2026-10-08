"""Signature -> The Little Lady Sells Homes: the page-by-page cutover (2026-10-08).

Why this is its own module
--------------------------
Moving a Signature page to the main site is a decision that has to be made in
small steps (docs/CUTOVER-RUNBOOK.md), and every step has the same shape: some
Signature addresses start forwarding, in ONE hop, to a final address on
https://www.thelittleladysellshomes.com. build.py already forwards 46 community
pages that way (PRUNED_TO_TLLSH). This module is the same idea for the rest, with
two differences that matter:

  * Nothing happens until a group number is added to "active_groups" in
    build/data/cutover_to_tllsh.json. With that list empty, apply() hands back
    exactly the lines it was given, so merging the map changes no file in site/.
  * The forwarding is a pass over the FINISHED list of redirect lines rather than
    a new rule here and another there. That is what keeps it to one hop: any
    existing rule whose destination is a page that is now forwarding (the old
    /expiredlisting printed-book address, the extensionless /about, the blog
    index that old WordPress paths point at) is pointed straight at the final
    address instead of at the page that now redirects.

Rules written here are forced (301!). The Signature pages still ship as files and
Netlify serves a file before it reads a plain rule, so an unforced 301 would never
fire (the same reason PRUNED_TO_TLLSH is forced; see build.py).

Command line (nothing is written):

    python3 build/cutover.py check [--groups all|1,2,...] [--redirects site/_redirects]
    python3 build/cutover.py verify-targets --tllsh /path/to/main-site-checkout
    python3 build/cutover.py list --groups 1,2      # source <TAB> final address <TAB> group

`check` applies the chosen groups to the redirect file the build just wrote and
looks for chains, loops, unforced rules, duplicate sources and uncovered pages.
`verify-targets` confirms every target exists in a built copy of the main site.
"""
import argparse
import json
import os
import re
import sys

TLLSH_URL = "https://www.thelittleladysellshomes.com"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(HERE, "data", "cutover_to_tllsh.json")


def load(path=DATA):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _groups(data, groups=None):
    """The group numbers to apply: the file's active list, or the ones asked for."""
    if groups is None:
        groups = data.get("active_groups") or []
    if groups == "all":
        groups = sorted(int(g) for g in data.get("groups", {}))
    return [int(g) for g in groups]


def active_pages(data, groups=None):
    """{Signature path: path on the main site} for the groups in play."""
    pages = {}
    for g in _groups(data, groups):
        pages.update(data["groups"][str(g)].get("pages", {}))
    return pages


def active_extra(data, groups=None):
    """[(source pattern, target path)] for the groups in play (not pages)."""
    out = []
    for g in _groups(data, groups):
        for r in data["groups"][str(g)].get("extra_rules", []):
            out.append((r["from"], r["to"]))
    return out


def _variants(path):
    """The other spellings of a page address that the site answers: /x/ and /x."""
    if path == "/index.html":
        return ["/"]
    slug = path[: -len(".html")] if path.endswith(".html") else path
    if slug.endswith("/index"):
        slug = slug[: -len("/index")]
    return [slug + "/", slug]


def _destination(target):
    return TLLSH_URL + target


def new_rules(data, groups=None):
    """The forced rules the groups add, in a stable order."""
    rules = []
    for path, target in sorted(active_pages(data, groups).items()):
        for src in [path] + _variants(path):
            rules.append(f"{src}  {_destination(target)}  301!")
    for src, target in active_extra(data, groups):
        rules.append(f"{src}  {_destination(target)}  301!")
    return rules


def apply(lines, data, groups=None):
    """Turn the build's redirect lines into the cutover version. Pure.

    With no group in play this returns the lines unchanged, so an empty
    "active_groups" cannot alter any file the build writes.
    """
    pages = active_pages(data, groups)
    extras = active_extra(data, groups)
    if not pages and not extras:
        return list(lines)

    rules = new_rules(data, groups)
    taken = {r.split()[0] for r in rules}

    kept = []
    for line in lines:
        parts = line.split()
        if len(parts) >= 2 and parts[0] in taken:
            continue  # replaced by a forced rule above
        if len(parts) >= 3:
            dst = parts[1]
            base = re.split(r"[?#]", dst, maxsplit=1)[0]
            if base in pages:
                suffix = dst[len(base):]
                line = f"{parts[0]}  {_destination(pages[base])}{suffix}  {' '.join(parts[2:])}"
        kept.append(line)
    return rules + kept


# --------------------------------------------------------------------------
# Checks (used by tests/test-cutover-map.js and by hand)
# --------------------------------------------------------------------------

def shape_problems(data):
    problems = []
    groups = data.get("groups", {})
    nums = sorted(int(g) for g in groups)
    if nums != list(range(1, len(nums) + 1)):
        problems.append(f"group numbers must run 1..N with no gaps, got {nums}")
    for a in data.get("active_groups", []):
        if str(a) not in groups:
            problems.append(f"active group {a} does not exist")
    seen = {}
    for g in nums:
        for path, target in groups[str(g)].get("pages", {}).items():
            if not path.startswith("/") or not (path.endswith(".html") or path == "/"):
                problems.append(f"group {g}: source {path!r} is not an absolute .html path")
            if not target.startswith("/") or target.startswith("//") or "://" in target:
                problems.append(f"group {g}: target {target!r} must be a path on the main site")
            if path in seen:
                problems.append(f"{path} is in groups {seen[path]} and {g}")
            seen[path] = g
        for r in groups[str(g)].get("extra_rules", []):
            if not r.get("from", "").startswith("/") or not r.get("to", "").startswith("/"):
                problems.append(f"group {g}: extra rule {r!r} needs from/to paths")
    last = nums[-1] if nums else None
    if last is not None:
        if seen.get("/index.html") != last:
            problems.append(f"/index.html must be in the LAST group ({last}), it is in {seen.get('/index.html')}")
        if seen.get("/thank-you.html") not in (last,):
            problems.append("/thank-you.html must be in the last group with the home page "
                            "(forms on pages that have not moved still end there)")
    if "/404.html" in seen:
        problems.append("/404.html is never forwarded")
    return problems


def coverage_problems(data, site_dir, redirect_lines):
    """Every built page is forwarded already, or is in exactly one group."""
    in_groups = set(active_pages(data, "all"))
    forced_to_tllsh = {
        ln.split()[0] for ln in redirect_lines
        if len(ln.split()) >= 3 and ln.split()[1].startswith(TLLSH_URL) and ln.split()[2] == "301!"
    }
    on_disk = set()
    for d, _, files in os.walk(site_dir):
        for f in files:
            if f.endswith(".html"):
                on_disk.add("/" + os.path.relpath(os.path.join(d, f), site_dir).replace(os.sep, "/"))
    problems = []
    for p in sorted(on_disk - {"/404.html"}):
        if p not in in_groups and p not in forced_to_tllsh:
            problems.append(f"{p} is neither forwarded already nor in any cutover group")
    for p in sorted(in_groups - on_disk):
        problems.append(f"{p} is in a cutover group but is not a built page")
    return problems


def rule_problems(lines):
    """Chains, loops, unforced forwards and duplicate sources in a finished rule list."""
    problems = []
    rules = []
    for ln in lines:
        s = ln.strip()
        if s and not s.startswith("#"):
            parts = s.split()
            if len(parts) >= 3:
                rules.append((parts[0], parts[1], parts[2]))
    first = {}
    for src, dst, status in rules:
        if src in first and first[src] != (dst, status):
            problems.append(f"duplicate source with a different answer: {src}")
        first.setdefault(src, (dst, status))
    for src, (dst, status) in first.items():
        if not status.startswith("301"):
            continue
        if dst.startswith(TLLSH_URL):
            continue  # final: leaves this site
        base = re.split(r"[?#]", dst, maxsplit=1)[0]
        nxt = first.get(base)
        if nxt and nxt[1].startswith("301") and base != src:
            problems.append(f"chain: {src} -> {dst} -> {nxt[0]} (point {src} straight at the final address)")
        if base == src:
            problems.append(f"loop: {src} forwards to itself")
    return problems


def forwarded_without_force(lines, pages):
    """Rules for a forwarding page that are not forced (they would never fire)."""
    out = []
    want = set(pages)
    for ln in lines:
        parts = ln.split()
        if len(parts) >= 3 and parts[0] in want and parts[2] != "301!":
            out.append(ln.strip())
    return out


def printed_book_problems(data, applied):
    """The QR code in the printed books: /expiredlisting, with and without the slash."""
    pages = active_pages(data, "all")
    dest = pages.get("/expired-listings.html")
    problems = []
    if not dest:
        return ["/expired-listings.html is not in any group"]
    want = _destination(dest)
    got = {}
    for ln in applied:
        parts = ln.split()
        if len(parts) >= 3:
            got.setdefault(parts[0], (parts[1], parts[2]))
    for src in ("/expiredlisting/", "/expiredlisting"):
        if got.get(src) != (want, "301"):
            problems.append(f"{src} must be a permanent one-hop 301 to {want}, got {got.get(src)}")
    return problems


def run_check(groups, redirects_path, site_dir):
    data = load()
    with open(redirects_path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    problems = shape_problems(data)
    problems += coverage_problems(data, site_dir, lines if not _groups(data, groups) else apply(lines, data, groups))
    applied = apply(lines, data, "all" if groups == "all" else groups)
    problems += rule_problems(applied)
    pages = active_pages(data, "all" if groups == "all" else groups)
    problems += [f"not forced: {x}" for x in forwarded_without_force(applied, pages)]
    if groups == "all":
        problems += printed_book_problems(data, applied)
    return problems


def verify_targets(tllsh):
    """Every target exists in a built main site (a file, or a rule that answers it)."""
    data = load()
    site = os.path.join(tllsh, "site")
    answered = set()
    rp = os.path.join(site, "_redirects")
    if os.path.exists(rp):
        with open(rp, encoding="utf-8") as f:
            for ln in f:
                parts = ln.split()
                if parts and not parts[0].startswith("#"):
                    answered.add(parts[0])
    toml = ""
    tp = os.path.join(tllsh, "netlify.toml")
    if os.path.exists(tp):
        with open(tp, encoding="utf-8") as f:
            toml = f.read()
    problems = []
    for g in sorted(int(x) for x in data["groups"]):
        entry = data["groups"][str(g)]
        for path, target in entry["pages"].items():
            f = target.lstrip("/") + ("index.html" if target.endswith("/") else "")
            if not os.path.exists(os.path.join(site, f)) and target not in answered:
                problems.append(f"group {g}: {path} -> {target} does not exist on the main site")
        for r in entry.get("extra_rules", []):
            if f'from = "{r["to"]}"' not in toml and r["to"] not in answered:
                problems.append(f"group {g}: extra rule {r['from']} -> {r['to']} is not answered on the main site")
    # The other direction matters more: every page the main site still canonicals to
    # Signature (COLLECTION_CANONICAL_TO_SIGNATURE) must be in the map with the SAME
    # target, so no canonical flip is forgotten when its group goes live.
    bsrc = os.path.join(tllsh, "build", "build.py")
    if os.path.exists(bsrc):
        text = open(bsrc, encoding="utf-8").read()
        m = re.search(r"COLLECTION_CANONICAL_TO_SIGNATURE\s*=\s*\{(.*?)\n\}", text, re.S)
        if not m:
            problems.append("COLLECTION_CANONICAL_TO_SIGNATURE was not found in the main site's build/build.py")
        else:
            body = m.group(1)
            pairs = {}
            for rel, blog, sig in re.findall(
                    r'(?:f"\{COLLECTION_DIR\}(/[^"]+)"|COLLECTION_HUB|"(/blog/[^"]+)")\s*:\s*\n?\s*"(/[^"]+)"', body):
                key = "/signature-property-collection" + rel if rel else (blog or "/signature-property-collection/index.html")
                pairs[sig] = key
            pairs["/index.html"] = "/signature-property-collection/index.html"  # the hub entry has no quoted key
            mapped = {}
            for g in data["groups"]:
                mapped.update(data["groups"][g]["pages"])
            for sig, key in sorted(pairs.items()):
                if sig not in mapped:
                    problems.append(f"the main site canonicals {key} to Signature's {sig}, which is in no cutover group")
                elif mapped[sig] != key:
                    problems.append(f"{sig} forwards to {mapped[sig]} but the main site's Collection page is {key}")
    return problems


def listing(groups):
    """Source, final address and group for every page and pattern rule in the groups."""
    data = load()
    rows = []
    for g in _groups(data, groups):
        entry = data["groups"][str(g)]
        for path, target in sorted(entry.get("pages", {}).items()):
            rows.append((path, _destination(target), g))
        for r in entry.get("extra_rules", []):
            rows.append((r["from"], _destination(r["to"]), g))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--groups", default="active", help="all, active (the file's list), or 1,2,...")
    c.add_argument("--redirects", default=os.path.join(ROOT, "site", "_redirects"))
    c.add_argument("--site", default=os.path.join(ROOT, "site"))
    v = sub.add_parser("verify-targets")
    v.add_argument("--tllsh", required=True)
    li = sub.add_parser("list")
    li.add_argument("--groups", required=True, help="all, or 1,2,...")
    args = ap.parse_args(argv)
    if args.cmd == "list":
        groups = "all" if args.groups == "all" else [int(x) for x in args.groups.split(",") if x]
        for src, dst, g in listing(groups):
            print(f"{src}\t{dst}\t{g}")
        return 0
    if args.cmd == "check":
        groups = "all" if args.groups == "all" else (None if args.groups == "active"
                                                      else [int(x) for x in args.groups.split(",") if x])
        problems = run_check(groups, args.redirects, args.site)
    else:
        problems = verify_targets(args.tllsh)
    for p in problems:
        print("FAIL " + p)
    print("All checks passed" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
