#!/usr/bin/env python3
"""Stop a deploy date from masquerading as a content-modified date.

WHY THIS EXISTS (2026-09-15). build/build.py sets BUILD_DATE to today and stamps
it into every page as `og:updated_time`, `last-modified`, and the JSON-LD
`dateModified` on the sitewide RealEstateAgent node. So a deploy that changed one
listing told Google that all 117 pages were edited today, and a deploy that
changed nothing at all did the same. Freshness is a ranking signal; spending it
on days when nothing happened devalues it for the days when something did.

It also broke CI. `.github/workflows/tests.yml` rebuilds the site and fails if
the committed `site/` no longer matches the generator:

    - name: Check committed site/ matches the generator
      run: if [ -n "$(git status --porcelain site/)" ]; then ... exit 1

Because the only difference was the date, that check could pass on exactly one
day -- the day someone last committed site/ -- and failed every day after, on
its own, with no code change involved. 752 of the 776 differing lines on the run
that prompted this were a single date going from 2026-09-14 to 2026-09-15.

WHAT THIS DOES. For every generated page it reads the version committed at HEAD,
blanks the date fields in both copies, and compares. If the page is otherwise
byte-identical, the committed dates are put back -- the page did not change, so
its modified date should not either. If anything else differs, today's date
stands, because then the page really did change.

WHY NOT JUST LOOSEN THE CI CHECK. That would silence the symptom and keep
shipping false dates to Google, which is the half that actually costs something.

The sister site (thelittleladysellshomes) solves the same problem in
build/postprocess_audit_fixes.py; this is the same idea, minus the parts that
are specific to that repo. Kept deliberately small: it only ever rewrites date
fields, never content, so it cannot alter a page's copy or markup.

NON-FATAL BY DESIGN. Outside a git work tree, or on a page with no committed
predecessor (a genuinely new page), there is nothing to compare against and
today's date is correct anyway. Those cases are skipped silently rather than
failing a deploy over a meta tag.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"

# Every place BUILD_DATE reaches the output. Each entry is (pattern, template);
# the pattern must capture the date in group 1 so it can be both blanked for
# comparison and substituted back for restoration.
DATE_FIELDS = [
    # <meta property="og:updated_time" content="2026-09-15">
    (re.compile(r'(<meta property="og:updated_time" content=")(\d{4}-\d{2}-\d{2})(">)'), 2),
    # <meta name="last-modified" content="2026-09-15">
    (re.compile(r'(<meta name="last-modified" content=")(\d{4}-\d{2}-\d{2})(">)'), 2),
    # JSON-LD "dateModified": "2026-09-15"  (RealEstateAgent and friends)
    (re.compile(r'("dateModified"\s*:\s*")(\d{4}-\d{2}-\d{2})(")'), 2),
    # feed.xml  <lastBuildDate>Mon, 15 Sep 2026 00:00:00 +0000</lastBuildDate>
    (re.compile(r'(<lastBuildDate>)([^<]+)(</lastBuildDate>)'), 2),
    # llms.txt carries the same stamp as prose, twice, in plain text
    (re.compile(r'(> Last updated: )(\d{4}-\d{2}-\d{2})(\.)'), 2),
    (re.compile(r'(accurate as of )(\d{4}-\d{2}-\d{2})( )'), 2),
]

PLACEHOLDER = "@@DATE@@"


# 2026-09-24: the lead-submit marker build.py puts on every page is measurement
# plumbing, not content. Without this, adding it would re-date every page.
_LEAD_MARKER = re.compile(r"<script>(?:(?!</script>)[\s\S])*?spc_lead_submit[\s\S]*?</script>\n?")


def _blank(text: str) -> str:
    """Replace every date field with a placeholder, leaving all else untouched
    (except the lead-submit marker, which is ignored -- see _LEAD_MARKER)."""
    for pattern, _ in DATE_FIELDS:
        text = pattern.sub(lambda m: m.group(1) + PLACEHOLDER + m.group(3), text)
    return _LEAD_MARKER.sub("", text)


def _restore(fresh: str, committed: str) -> str:
    """Put the committed dates back into the freshly built page, field by field.

    Positional: the Nth match of a given pattern in the fresh text takes the Nth
    match's date from the committed text. That is safe here only because the two
    texts are already known to be identical once dates are blanked -- so the
    matches line up one-for-one by construction. Never call this without that
    check first.
    """
    for pattern, _ in DATE_FIELDS:
        old_dates = [m.group(2) for m in pattern.finditer(committed)]
        if not old_dates:
            continue
        counter = {"i": 0}

        def swap(m, old=old_dates, c=counter):
            i = c["i"]
            c["i"] += 1
            if i >= len(old):
                return m.group(0)          # shouldn't happen; leave it alone
            return m.group(1) + old[i] + m.group(3)

        fresh = pattern.sub(swap, fresh)
    return fresh


def _committed_text(path: Path) -> str | None:
    """The version of this file at HEAD, even though build.py just overwrote it."""
    rel = path.relative_to(ROOT).as_posix()
    try:
        p = subprocess.run(
            ["git", "show", f"HEAD:{rel}"],
            cwd=ROOT, check=False,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
    except OSError:
        return None
    if p.returncode != 0:
        return None
    try:
        return p.stdout.decode("utf-8")
    except UnicodeDecodeError:
        return None


def main() -> int:
    if not SITE.is_dir():
        print("  ! postprocess_freshness: no site/ directory — nothing to do.")
        return 0

    in_git = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=ROOT, check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0
    if not in_git:
        print("  ! postprocess_freshness: not a git work tree, so there is no "
              "committed copy to compare against. Leaving today's dates in place.")
        return 0

    # sitemap.xml is handled separately, below: its <lastmod> values are not
    # this file's own dates, they are one date per OTHER page, so the
    # unchanged-content test that works for a page is meaningless for it.
    files = sorted(
        list(SITE.rglob("*.html"))
        + [p for p in SITE.rglob("*.xml") if p.name != "sitemap.xml"]
        + list(SITE.rglob("*.txt"))
    )
    reverted = changed = new = 0
    changed_pages: set[str] = set()        # site-relative paths that really changed

    for path in files:
        try:
            fresh = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        committed = _committed_text(path)
        if committed is None:
            new += 1                       # genuinely new page; today is right
            continue
        if _blank(fresh) != _blank(committed):
            changed += 1                   # real content change; today is right
            changed_pages.add(path.relative_to(SITE).as_posix())
            continue
        restored = _restore(fresh, committed)
        if restored != fresh:
            path.write_text(restored, encoding="utf-8")
            reverted += 1

    sitemap_fixed = _sync_sitemap(changed_pages)

    print(f"  freshness: {reverted} page(s) kept their previous date "
          f"(content unchanged), {changed} genuinely changed, {new} new"
          + (f", {sitemap_fixed} sitemap lastmod re-pointed" if sitemap_fixed else ""))
    return 0


# Every <lastmod> in the sitemap is a claim about a DIFFERENT file, so it cannot
# be compared against its own committed copy the way a page can.
#
# CORRECTED 2026-09-15, same day, before this ever shipped. The first version of
# this function derived each <lastmod> from its page's `last-modified` meta, on
# the reasoning that the two should agree. That was backwards and would have
# done real damage: build.py has stamped BUILD_DATE into every page's meta since
# forever, while the sitemap's lastmod values are the articles' REAL dates --
# 2025-08-04 for the pricing-psychology post, 2026-06-05 for the June market
# report (see the 2026-08-14 note in build.py, where exactly this was fixed once
# already). Deriving from the meta rewrote 35 honest dates to today's build
# stamp: the precise failure this whole file exists to prevent, introduced by
# the file itself.
#
# The right rule is the same one used for pages, applied per URL: if the page
# behind a <lastmod> did not change this build, that URL keeps the date it had.
# Only a page that genuinely changed advances, and it advances to the date that
# page itself now carries.
_SITEMAP_URL = re.compile(r"(<loc>)([^<]+)(</loc>\s*<lastmod>)(\d{4}-\d{2}-\d{2})(</lastmod>)")
_PAGE_DATE = re.compile(r'<meta name="last-modified" content="(\d{4}-\d{2}-\d{2})">')


def _sync_sitemap(changed_pages: set[str]) -> int:
    sitemap = SITE / "sitemap.xml"
    if not sitemap.is_file():
        return 0
    committed = _committed_text(sitemap)
    if committed is None:
        return 0
    try:
        text = sitemap.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return 0

    # The committed date for each URL, so an unchanged page can keep it.
    old = {m.group(2): m.group(4) for m in _SITEMAP_URL.finditer(committed)}
    fixed = {"n": 0}

    def repl(m):
        loc, current = m.group(2), m.group(4)
        rel = re.sub(r"^https?://[^/]+/", "", loc).split("?")[0].split("#")[0]
        if not rel or rel.endswith("/"):
            rel += "index.html"
        if rel in changed_pages:
            return m.group(0)               # really changed: today's date stands
        want = old.get(loc)
        if not want or want == current:
            return m.group(0)
        fixed["n"] += 1
        return m.group(1) + loc + m.group(3) + want + m.group(5)

    new_text = _SITEMAP_URL.sub(repl, text)
    if new_text != text:
        sitemap.write_text(new_text, encoding="utf-8")
    return fixed["n"]


if __name__ == "__main__":
    sys.exit(main())
