# Handoff — every known gap, as of 2026-08-16

Written at the end of a long session, for whoever picks this up next. Nothing here
is speculation dressed as fact: where something is unverified it says so, and
where I was wrong earlier it says that too.

**Current state:** 142 pages, 30 local spots across 9 towns, 13 test suites green
(`bash tests/run-all.sh`),
all work pushed to `master` and `claude/non-human-sounding-listings-jhgxqk`.
Health check: `signaturepropertycollection.com/status?probe=1&format=json`

---

## 1. Blocked on Christine — cannot be done from a session

These need her dashboards. Do not spend time trying to work around them.

### 1.1 Cloudinary credentials — HIGHEST IMPACT
`/status` reports `cloud_name mismatch`. The three `CLOUDINARY_*` env vars are
from two different accounts: cloud name from one, API key/secret from another.

**Why it matters more than "photos":** it was starving the listing crawl. Because
no listing can ever finish caching, the photo priority pass had a permanently
non-empty queue and consumed the run's start-work window before the bootstrap
crawl got a page. Catalog stuck at 18,226 of ~19,000. Guards are now in place
(see §2.1) so the crawl proceeds regardless, but the photos still don't cache.

**Fix:** cloudinary.com → Dashboard → copy Cloud name, API Key, API Secret from
that ONE page → replace all three in Netlify.

### 1.2 `RESEND_API_KEY` — the only reliable lead notification
Code is written, tested and deployed (`lib/_notify.js`, `sendLeadAlertEmail`).
One env var away from working. See §3.1 for why this is not optional anymore.

### 1.3 Rotate the API keys, then mark them secret
`MLSGRID_API_TOKEN`, `LOFTY_API_KEY`, `BLOBS_TOKEN` and `CLOUDINARY_API_SECRET`
are all stored in Netlify with `is_secret: false` — readable in plaintext by
anyone with dashboard access, and they were readable in this session's transcript.
The MLS Grid token is shared with Listing-Engine and Expired-Luxury, so a leak
breaks three apps and creates a compliance problem.

Order matters: rotate at each provider → save new values in a password manager →
THEN tick "Contains secret value" in Netlify. Marking secret is one-way; the value
becomes unreadable afterwards. She has NOT confirmed doing this.

### 1.4 Small, cheap, still open
- **"Driven Steakhouse"** — real Loveland restaurant, she says she has a Facebook
  post about it. No YouTube video and no Gmail review notification mentions it, so
  it can't be pinned yet. NB: the Google AI Overview claiming she and the
  restaurant are "connected in local business circles" is AI confabulation — do
  not repeat it or build on it.
- **Bobcat Ridge** is pinned on her word alone, with no view count or review text.
- **Windsor** has zero local spots and it is NOT a data gap — every Windsor video
  on her channel is a listing tour. It needs one 30-second restaurant clip filmed.
- **Playlist URLs.** She has per-town YouTube playlists ("Things to Do in
  Loveland, Colorado"). A "watch the whole tour" button per town page is designed
  but needs the playlist IDs from her.

---

## 2. Known bugs, risks and rough edges in the code

### 2.1 The sync time budget — FIXED 2026-08-16, with a caveat
Was: `TIME_BUDGET_MS` 8000 with `LATE_WORK_TIME_MARGIN_MS` 6000, leaving a **2000ms
window** in which any loop could start new work. One throttle wait (1500ms) plus one
`$expand=Media` fetch nearly exhausted it, which is why the crawl reported
`lastRunPagesFetched: 0` and sat at 18,226 of ~19,000 listings.

**Now 11000.** Netlify's docs state a **30-second** limit for scheduled functions
(synchronous: 10s, background: 15min). The old comment inferred "~15s" from an
observed 499 and was never checked against the documentation. Start window is now
5000ms — 2.5x the throughput — with a worst case near 13s, well under 30s.

Deliberately NOT raised to the full 30s: the 499s were real, and there is no reason
to spend the whole limit to fix a 2000ms window. `tests/test-budget.js` now asserts
the worst case stays under 60% of the documented limit, so this cannot quietly creep.

**Caveat worth verifying:** this has not been observed on a live run yet. Check
`/status` after a deploy — `lastRunPagesFetched` should be greater than 0 and
`totalListingsStored` should climb past 18,226. If 499s reappear, lower it rather
than removing the guards.

### 2.2 Lofty tags cannot be read — settled, unfixable through the API
`GET /leads/{id}` returns **no `tags` field** on this account. Proven live:
`"Tags: response had no 'tags' field"`. Consequences:
- The tag sent on `POST /leads` still lands, so a NEW contact gets tagged.
- A RETURNING contact cannot have the tag re-added, so a "Tag Added" Smart Plan
  can never fire a second time for them.
- `refireLoftyTag` now refuses to write tags it couldn't read. **Do not remove
  that guard** — before it existed, one real lead (`1147802441137106`) had its tag
  list overwritten with a single tag, because the code read `[]` and believed it.
  Any other tags that lead carried were lost. Christine has not checked it.

Also proven: **every test submission merged.** Lofty's own response —
*"we identify it as a duplicated lead and the lead was merged into the existing
lead"* — even for an address I assumed was new. Merging is the normal case here,
not the exception.

### 2.3 Listings have no coordinates
The MLS Grid feed returns no latitude/longitude, so the "nearby spots" panel on
listing pages matches by **town**, not distance. `localSpotsBlock()` in
`listing-page.js` is the only place to change if that ever changes. Do not add
distance ranking without solving the geocoding cost (15,000 listings).

### 2.4 Sitemap guard is load-bearing
`build.py` fails the build if a generated page is missing from the sitemap. It
caught `/seller-local-proof.html` before it shipped. When adding a page, add it to
`paths` in `build_redirects_and_meta()` and to `llms.txt`.

### 2.5 Test hygiene, learned the hard way
- A test teardown that ran `git checkout -- <data file>` **silently deleted
  uncommitted work** and caused a commit that claimed to add a spot and didn't.
  Tests now restore from an in-memory copy. Never clean up with git.
- Several assertions hardcoded facts that then changed (which spot has the most
  views, how many spots exist). Assertions now derive expected values from the
  data. Keep doing that.

---

## 3. Corrections to earlier advice — read before repeating it

### 3.1 "Lofty should work, Resend is a backup" — WRONG
I said this repeatedly. Lofty's API cannot return tags, so the tag-triggered
Smart Plan cannot be made reliable for repeat buyers. The direct email is the only
notification path that can be. Reversed in the code comments and on `/status`.

### 3.2 "Cloudinary is optional, nothing a visitor can see" — HALF WRONG
True about photos rendering. False about the system: it was starving the crawl.
Marking that row `optional: true` on `/status` is what made a real problem look
cosmetic. **Lesson: an "optional" flag on a status page hides consequences that
aren't visible from the row's own name.**

### 3.3 "The photo pass consumed the entire 8-second budget" — WRONG
It gets ~2000ms, not 8000. The real cause is §2.1. The fix worked; the
explanation didn't. Corrected in the file so it doesn't become folklore.

### 3.4 "/site-health" — a URL I invented
The route is `/status`. The function is *named* site-health, which is why I kept
typing it. An alias now exists so both work, but she spent time diagnosing a real
problem against a 404 page because of it.

---

## 4. Unbuilt features, in the order I'd do them

**Layer 3 — proximity as a search filter.** "Near places I'd actually send you":
tick Restaurants / Trails / Wineries, and listings filter and rank by distance to
her 30 vetted spots. The most impressive and the most work; blocked by §2.3.

**Lead intent in Lofty.** The lead push already tags. Add which spots they opened
and which filters they used, so her first call opens with
*"I saw you were looking at Devil's Backbone"* instead of a cold hello.

**Point her audience at the site.** Not code — the highest-leverage marketing
action available. She has 20,815 video views and 15,550 Google review views. Most
video descriptions still link `thelittleladysellshomes.com` (the old site). One
line — `signaturepropertycollection.com/communities` — converts existing reach
into traffic she owns.

**Netlify Forms email notification** as a zero-signup backup:
Site configuration → Notifications → form submission email.

---

## 5. How to find her content — the method that works

Her YouTube titles are coy; her **descriptions name the places outright**. "Is
This the Best Steakhouse in Loveland?" says *"Dinner at The Loveland Chophouse"*
in the description. That single trick placed the Chophouse, Gnome Road, Route 85
Grill, The Olde Course, the Colorado Cherry Company, and all three Erie spots.

Use `vidiq_youtube_search` with `channelId: "@thelittleladysellshomes"` and read
descriptions. Do not guess from titles.

**Her Google reviews are in Gmail.** Google's milestone emails
(`google-maps-noreply@google.com`, subjects like "Your review reached 5,000
views") carry the **full review text, date, view count and a real Maps place
link**. That is how Dragon Inn (4,000+ views) and A&W were found. Her Takeout
export is 206 MB and cannot be pulled through the Drive connector — use Gmail
instead.

**Skip her reviews of other realtors** (Emily Sells Centennial, April Brandon,
Jeff Kurtz, Miranda Cantin, Alissa Rhoades) — colleagues, not local spots.

---

## 6. Environment facts that save time

- **Egress is heavily blocked.** `api.lofty.com`, `www.google.com`,
  `signaturepropertycollection.com`, `api.netlify.com` and Nominatim are all
  unreachable. WebSearch works. The Netlify, Gmail, Drive and vidIQ MCP tools work.
- **Netlify MCP returns intermittent 502s** — retry once, it usually succeeds.
- `python3 build/build.py` regenerates `site/`. Netlify runs it on every deploy via
  `scripts/netlify-build.sh`; the committed `site/` is the fallback.
- **Tests: `bash tests/run-all.sh`** — 13 suites, all green. They were in a session
  scratchpad and would have vanished with it; moved into the repo at the end of
  this session. **Wired to CI** in `.github/workflows/tests.yml`: runs on every push
  to master and claude/**, on PRs, and weekly. That workflow also fails if the
  committed `site/` drifts from what `build.py` generates, since that directory is
  the deploy fallback and going stale silently is this repo's signature failure.

---

## 7. Suggested opening prompt for the next session

> Read `NEXT-SESSION.md`. Then: (1) check `/status?probe=1&format=json` and confirm
> the raised time budget actually worked — `lastRunPagesFetched` > 0 and
> `totalListingsStored` climbing past 18,226 (see §2.1's caveat). (2) Then look at
> the `Listing-Engine` and `sellerintelligence` repos and tell me what's worth
> pulling into this one.

If she instead asks for more local spots, go straight to §5 — the method is
proven and needs nothing from her.
