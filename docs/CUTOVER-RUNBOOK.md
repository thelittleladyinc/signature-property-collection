# Signature -> The Little Lady Sells Homes: the page-by-page cutover

Written 2026-10-08. This is the runbook for the redirect step of the Signature move
(phase "e" in the main site's `docs/SIGNATURE-MOVE.md`). **Nothing in this change
forwards a single page.** `build/data/cutover_to_tllsh.json` has `"active_groups": []`,
and with that list empty `build/cutover.py` hands back exactly the redirect lines it
was given. A group goes live only when someone adds its number to that list in a
reviewed pull request that Christine has OK'd.

## What is already forwarding, and what this adds

* **46 community pages** already force-301 to the identical address on
  thelittleladysellshomes.com (`PRUNED_TO_TLLSH` in `build/build.py`). Not repeated here.
* **66 pages** are in the map, in six groups. `/404.html` is never forwarded.

| Group | Pages | What | Main-site canonical to flip first |
| --- | --- | --- | --- |
| 1 | 4 | The 3 moved luxury blog posts and the blog index | 3 blog posts |
| 2 | 7 | Resort buyer pages (Vail, Breckenridge, Steamboat Springs, Winter Park) and horse, riverfront, golf | 7 |
| 3 | 9 | Luxury town pages (Loveland, Fort Collins, Windsor, Estes Park), luxury market, concierge, home tours, the two luxury guides | 9 |
| 4 | 3 | Buyers, sellers, and **expired-listings (the printed books' landing page)** | 3 |
| 5 | 41 + `/listing/:id` | Every page that already has the same address on the main site (about, relocation, market report, tools, guides, the 11 Loveland neighbourhoods, ...), plus home search and listing links **11** (the Loveland neighbourhood pages: the main site's `CROSS_BRAND_CANONICAL_TO_SIGNATURE` still points their canonicals at Signature, and they must go back into the main sitemap), plus the listing page (see "Found on Oct 8" below). The Collection search is a rewrite and needs none |
| 6 | 2 | The thank-you page and the home page. **Last.** | 1 (the Collection hub) |

Order is proposed by page type, quietest first. Re-order it with Search Console click
data once the domain is verified (Cowork J22).

`python3 build/cutover.py list --groups 4` prints every source and its final address.

## What the code guarantees (and the tests pin)

* **One hop.** Each page gets a forced `301!` for `/page.html`, `/page/` and `/page`
  straight to the final address. Every older rule that ended on one of those pages
  (the printed-book `/expiredlisting`, old WordPress paths, the blog index, the
  `/about` style addresses) is re-pointed at the final address, so no old address goes
  through two redirects.
* **Forced.** The Signature pages still ship as files and Netlify serves a file before
  it reads a plain rule, so the rules are `301!` (same reason as `PRUNED_TO_TLLSH`).
* **No chains, loops or duplicates**, for each group on its own and for all six
  together. `tests/test-cutover-map.js` runs `python3 build/cutover.py check`.
* **The printed-book address.** With group 4 on, `/expiredlisting/` and
  `/expiredlisting` are permanent one-hop 301s to
  `.../signature-property-collection/expired-listings.html`.
* **Sitemap.** A page in an active group leaves `sitemap.xml` (the same rule as the 46).
* **Targets exist.** With `TLLSH_CHECKOUT=<built main-site checkout>`, the test also
  confirms every target exists there and that every page the main site still
  canonicals to Signature is in the map with the same target.
* **No canonical left pointing at a page that forwards back.** `python3 build/cutover.py verify-targets
  --tllsh <built main site> [--groups 5]` fails if the main site still canonicals a page (the 11
  neighbourhood pages, `CROSS_BRAND_CANONICAL_TO_SIGNATURE`) to Signature while a group in play forwards
  it. `--groups all` lists what is still owed. Run it in each activation pull request.

## Before any group (all of these are open today)

1. **Christine OKs the map and the order.** She is the only one who can.
2. **Search Console**: the Signature domain verified by a DNS record (Cowork J22). The
   home page's verification tag disappears when the home page forwards.
3. **Netlify facts read** (Cowork J23): pixel, form email alerts, email (MX) records.
4. **Scan one printed book's QR code** and say where it lands, and whether the book
   prints an email address, a short link or a second phone number.
5. **Lofty**: confirm no Smart Plan or filter looks for "Signature Property Collection -"
   in the lead source (the new labels keep the word "Signature").
6. **The query string.** The printed pieces carry `src`, `mid` and `gap`, and the book
   landing page records them. Whether Netlify keeps the query string through these
   redirects has **not** been tested (this environment cannot reach Netlify). On a
   deploy preview with group 4 on, run
   `curl -sI 'https://<preview>/expiredlisting/?src=book&mid=1&gap=2' | grep -i '^location'`.
   The `Location` must end with `?src=book&mid=1&gap=2`. If it does not, add explicit
   rules that carry those three parameters before group 4 goes live.
7. **Part 2 test leads**: one test lead per new Collection form reaches Lofty with the
   new label (Part 2 acceptance).

## For each group N (cumulative: group 2 means `[1, 2]`)

1. **Main site first.** A pull request on thelittleladysellshomes removes that group's
   Collection pages from `COLLECTION_CANONICAL_TO_SIGNATURE` (so each page's canonical
   becomes its own address). Merge, wait for the Netlify deploy, confirm the pages are
   live. Group 5 needs none.
2. **Then Signature, within the hour.** A pull request here changes
   `"active_groups"` in `build/data/cutover_to_tllsh.json` (for example `[1, 2]`).
   CI runs the whole suite with that group on. Merge; Netlify deploys.
3. **Check every address.** For each line of `python3 build/cutover.py list --groups N`:

   ```bash
   python3 build/cutover.py list --groups N | while IFS=$'\t' read -r src dst g; do
     case "$src" in *:*) continue;; esac          # pattern rules: test one real id by hand
     got=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://signaturepropertycollection.com$src")
     fin=$(curl -s -o /dev/null -w '%{http_code}' "$dst")
     echo "$got | final $fin | want 301 $dst"
   done
   ```

   Each source must answer `301` with the exact final address, and the final address
   must answer `200`. (Not run against the live sites from here: this environment
   cannot reach them.)
4. **Search Console**: check three addresses per group, then weekly. A two-to-six week
   wobble per group is normal.

## Rollback

Remove the group from `active_groups` and deploy (or publish the previous deploy in
Netlify). Revert the main-site pull request so the canonicals point back at Signature.
Be honest about the limit: a 301 is permanent as far as browsers and Google are
concerned, so rolling back restores the pages at once for anyone who has not cached the
redirect, but Google may take weeks to treat the old address as canonical again.

## Dry run with every group switched on (2026-10-08)

Not merged and not deployed: `active_groups` set to `[1, 2, 3, 4, 5, 6]` in a scratch copy, the
site rebuilt, and the whole suite run (81 suites), then compared with the same suite on
unchanged `master`.

* Rules: 66 pages and `/listing/:id` become 198 forced one-hop 301s (65 pages x 3 forms, the home page's
  2, and `/listing/:id`). They replace 132 older rules for the same addresses, and 17 older rules whose
  destination was a forwarding page (the printed-book `/expiredlisting`, old WordPress paths, the
  blog index) are re-pointed at the final address: 512 rules become 578. No chain, loop,
  duplicate or unforced rule (`build/cutover.py check --groups all`). Netlify counts the toml
  `/listing/:id` rewrite as one more rule: 513 today, 579 with every group on.
* **Two suites newly fail, and both are assertions about the pre-cutover behaviour of pages
  that are being forwarded**: `test-home-search` (`/search-homes` is a 200 rewrite; group 5) and
  `test-prettyurls` (`/` is a 200 rewrite to `/index.html`; group 6). The activation pull
  request for each of those groups updates its assertion.
* Everything else that passes on `master` still passes, including `test-internal-links`.
* Limit: 35 suites already fail on `master` in this sandbox because `npm` packages such as
  `@netlify/blobs` cannot be installed here. They fail identically with and without this
  change, so they say nothing either way. CI, which has the packages, is the real check.
* With the map as merged (`active_groups` empty), `site/_redirects`, `sitemap.xml` and
  `llms.txt` are byte-for-byte identical to a build of unchanged `master`.

## What this change does NOT do (do these in the activation pull requests)

* `llms.txt` and `sitemap-videos.xml` on Signature still list forwarding pages
  (`sitemap.xml` is handled). The video sitemap entries move to the main site when each
  Collection page's canonical flips.
* Internal links on Signature pages that still point at a forwarding page work (they hit
  the 301), but `tests/test-internal-links.js` has **no redirect awareness: it does not say**
  which ones to re-point. Counted on Oct 8, links from still-live Signature pages into pages that
  newly forward, cumulative by group 1/2/3/4/5: 63 / 84 / 232 / 346 / 71. `feed.xml` (4 group-1 URLs),
  `llms.txt` (27 of 28 forwarding pages) and `sitemap-videos.xml` (29 entries, 15 already forwarding)
  need the same attention. Re-point them in each activation pull request.
* The domain alias (phase f) waits until the main site's pass-through code is gone and
  seven calm days have passed. `/status`, `/site-health` and `/.netlify/functions/*` are
  deliberately never forwarded: callers (newsletter, Expired Elite, Command Center) still
  use them on this domain.
* The Signature Google Business Profile is removed only after the redirects are live.

## Found on Oct 8 (read-only check of the merged state), to settle before the group named

The merged map is correct and forwards nothing (a build of the merge commit is byte-identical to a
build of its parent). These are for the activation pull requests:

* **Before group 5, blocker:** the main site canonicals the 11 Loveland neighbourhood pages to
  Signature (`build/build.py`, `CROSS_BRAND_CANONICAL_TO_SIGNATURE`), and group 5 forwards those same
  addresses to the main copy, so each canonical would point at a URL that 301s straight back. Remove the
  11 from that set on the main site and put them back in its sitemap, first. `verify-targets --groups 5`
  now fails until that is done.
* **Before group 5, blocker (read from the code, not run):** Signature's listing page
  (`netlify/functions/listing-page.js`) always sets its canonical to
  `signaturepropertycollection.com/listing/<id>`, and the main site's `/listing/<id>` still passes
  through to it while `BACKEND_MODE` does not include `listing-page`. After group 5 that canonical would
  301 back. Put `listing-page` in `BACKEND_MODE` on the main site first, and confirm its canonical names
  the main domain.
* **Before group 1:** the main site sends the legacy `499000`-tag URL to Signature's psychology post
  (two hops once group 1 is live), and some main-site links hop once (`build/data/blog.json` lines 80,
  82, 94; two links in `legacy_content/wildfires-and-colorado-home-values.json`;
  `postprocess_audit_fixes.py` lines 329 to 331). Point them at the main-site address in the group's
  main-site pull request.
* **Before group 5:** three targets, `/guides/best-places-to-retire-in-northern-colorado.html`,
  `/guides/cost-to-develop-raw-land-colorado.html` and
  `/guides/multi-generational-homes-northern-colorado.html`, are in the main site's `DUPLICATE_MAP`
  (`postprocess_traffic_growth.py`), which sends them to other pages with unforced 301s. Pick the real
  target before forwarding to them.
* **Before the domain alias (phase f):** the main site sends `/expiredlisting` to its generic
  `/expired-listings.html`, not the Collection book page, so the printed book's QR would land there after
  the alias. Also still to move: `_sig-proxy.js` and the pass-through functions, `explore-map.js`,
  the `sameAs` line on 777 pages, the callouts on the home, buyers, sellers and market-report pages,
  18 town paragraphs, and the `llms.txt` text.
* **Not a blocker:** the 148 Signature lead forms carry one old unnamed marketing checkbox, not
  `terms_agree` plus `sms_consent`. `_lofty-consent.js` ignores it and every create stays `cannotText:true`, so
  it is safe, but it is the old consent wording and only matters while Signature's forms stay live.
* **Not verified from here (no network):** whether Netlify keeps the query string through a 301; the order
  Netlify applies `_redirects` and the toml; a form POST hitting a forced 301; `BACKEND_MODE` values on the
  live sites.
