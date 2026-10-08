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
| 5 | 41 + `/listing/:id` | Every page that already has the same address on the main site (about, relocation, market report, tools, guides, the 11 Loveland neighbourhoods, ...), plus home search and listing links | none (the main site's copy is already its own canonical; the Collection search is a rewrite) |
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

* Rules: 66 pages and `/listing/:id` become 198 forced one-hop 301s (each page's `.html`, `/page/`
  and `/page` forms). They replace 132 older rules for the same addresses, and 17 older rules whose
  destination was a forwarding page (the printed-book `/expiredlisting`, old WordPress paths, the
  blog index) are re-pointed at the final address: 512 rules become 578. No chain, loop,
  duplicate or unforced rule (`build/cutover.py check --groups all`).
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
  the 301), but `tests/test-internal-links.js` is the place that will say if any must be
  re-pointed. The dry run above shows what it said with every group on.
* The domain alias (phase f) waits until the main site's pass-through code is gone and
  seven calm days have passed. `/status`, `/site-health` and `/.netlify/functions/*` are
  deliberately never forwarded: callers (newsletter, Expired Elite, Command Center) still
  use them on this domain.
* The Signature Google Business Profile is removed only after the redirects are live.
