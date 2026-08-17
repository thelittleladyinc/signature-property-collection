# Handoff — every known gap, as of 2026-08-17

Written at the end of a long session, for whoever picks this up next. Nothing here
is speculation dressed as fact: where something is unverified it says so, and
where I was wrong earlier it says that too.

**Don't trust these numbers — print them.** `bash tests/run-all.sh` ends by
reporting the real current counts (pages, spots, towns, views, suites), because any
figure typed into a document goes stale. As of writing: 142 sitemap pages, 30 local
spots, 14 suites green.

All work pushed to `master` and `claude/potter-realty-comparison-fdq1lc`.
Health check: `signaturepropertycollection.com/status?probe=1&format=json`
— and NOTE the `?probe=1`: a plain `/status` load makes no outbound calls and can
therefore show readings hours or days old. Since 2026-08-17 every probe row prints
when it was checked and a summary row at the top names anything stale, but the habit
still matters. See §2.8.

## 0. What changed 2026-08-17 (read this before §1)

Thirteen PRs. The competitive work Christine originally asked for — beating Potter,
Kittle, Basner, Hawbaker, Big Dog, Lemmings, Hammonds, Hansen — is finished and
merged. Verified flat across every one of those merges: **155 pages, 160 video
embeds (59 unique), 37 local spots**. Nothing was lost at any point.

RESOLVED today:
- **town-market-stats.js read the listings blob wrong** and blamed MLS Grid for
  being empty while /status showed 26,445 stored. It expected an array;
  sync-listings writes an object keyed by listing id. Town prices are live now
  (Loveland 510 active / $499,500, cross-checked against the site's own search).
- **Both generator workflows destroyed each other's runs.** geocode-towns fetched
  36 real coordinates, rebuilt 37 pages, passed every suite, then lost a `git push`
  race by one second and threw it all away. `scripts/commit-generated.sh` now
  rebuilds onto the new master instead of rebasing generated HTML. All 37 town
  pages now carry real Google-geocoded `Place` coordinates.
- **`?debug=1` on listing-photo could not explain a failing photo** — it was handled
  after every failure return, so it only ever described photos that already worked.
- **Nothing backed off from a 429 on the MEDIA host.** See §2.6, rewritten.
- **The county map now drills into towns** instead of jumping to a county-wide price
  filter. See §2.7.

STILL OPEN and genuinely unresolved — do not report these as done:
- **Card photos are still served at full MLS resolution** (the SLOW problem, not the
  GREY one — §2.9 separates them). The fix wrecked her listing cards and was
  reverted: diagnosis good, execution wrong. §2.9b. Grey cards are fixed (§2.9a).
  NOTE: the Cloudinary switch (§1.1) would resolve the slowness on its own as
  listings re-host — check "photos permanently cached" on /status before rebuilding
  anything.
- The two land listings' photos (§2.7b).
- Whether the shared MLS Grid quota needs splitting (§2.6).
- Everything in §1, which is still hers.

---

## 1. Blocked on Christine — cannot be done from a session

These need her dashboards. Do not spend time trying to work around them.

### 1.1 Cloudinary — SOLVED 2026-08-17 evening. Christine has TWO accounts.

**The answer, so nobody re-derives it:**

| Account | Cloud name | Product | Uploads? |
|---|---|---|---|
| The little lady | `the-little-lady` | Media Optimization | **no upload API at all** |
| Listing Engine | `listingengine` | Programmable Media | yes — this is the one |

The site was pointed at `the-little-lady`, so every photo upload got a flat 403.
She switched the three `CLOUDINARY_*` vars to the `listingengine` account and
redeployed at 21:54. `/status` now prints the cloud name in use, so which account
is live is a fact on the page rather than something to work out.

**How to recognise them apart in the console:** the Programmable Media one has
Assets / Image / Video in the sidebar and a Product environment settings → Upload
section. The Media Optimization one has MediaFlows / Media Optimizer / Moderation
and none of those.

**I got this wrong twice, and both wrong answers cost her real time. Read these
before forming a theory about a Cloudinary 403:**

1. **"The three vars are from two different accounts — re-copy them from the
   Dashboard."** Wrong. The credentials were valid the whole time: the Admin API
   AUTHENTICATED them and only then said "Media Optimization Customer doesn't
   have sufficient permissions". A 403 that arrives *after* successful auth is
   about what the account can DO, not about who you are. Re-copying reproduces it
   exactly.
2. **"Product Environments says '1 product environment (limit 1)', so there is no
   other account — this is unfixable."** Wrong, and worse, because it closed the
   question. **That page counts environments in the account you are SIGNED INTO.**
   She said "i think it is another acct" before I checked, and she was right.

The pattern in both: I had a plausible story and stopped looking. She had the
console open the whole time and kept telling me. **When she says the thing works
somewhere else, go look at the somewhere else first.**

**Why this mattered more than "photos":** with no listing able to finish caching,
the photo priority pass had a permanently non-empty queue and ate the run's
start-work window before the bootstrap crawl got a page. Guards are in place
(§2.1) so the crawl proceeds regardless — VERIFIED live — but until this switch
nothing ever cached.

**What to expect now:** her 11 listings re-host over the next few sync runs (every
30 min; the priority pass does hers first). `/status` → "Christine's own photos
permanently cached" climbs off `0 of 11`. Once a listing has its Cloudinary copy,
`photoUrlFor()` in listings-search.js serves `res.cloudinary.com` directly and the
card never touches MLS Grid's media host — which is what ends the grey 429
placeholders **and** the full-resolution-photo slowness (§2.9) in one move.

### 1.2 Lead notification — and the keyless option, since she does not use Resend
Code is written, tested and deployed (`lib/_notify.js`, `sendLeadAlertEmail`).
One env var away from working. See §3.1 for why this is not optional anymore.

**2026-08-17, correction from Christine: "I dont use resend."** That contradicts
the note at the top of `_notify.js`, which says she already has it for
sellerintelligence's daily digest. Either way, the practical situation is the same:
`RESEND_API_KEY` is unset, so `sendLeadAlertEmail()` returns
`{attempted: false, reason: "RESEND_API_KEY not set"}` and no alert email is sent.
The function degrades cleanly — nothing is broken, she is simply not told.

There are two ways to fix it and **the second needs no key and no code**:

1. **Resend** — free tier covers this volume comfortably. Create a key, add
   `RESEND_API_KEY` in Netlify env vars, done. Also set `LEAD_ALERT_TO` /
   `LEAD_ALERT_FROM`; until a domain is verified, Resend only delivers to the
   account's own address, which is fine here since she is the only recipient.
2. **Netlify Forms' own email notification** — every form on this site is a
   Netlify form, and Netlify will email submissions directly with no API key and
   no code: Netlify → Forms → (form) → Settings & usage → Form notifications →
   Add notification → Email. It sends the raw field values rather than
   `_notify.js`'s formatted HTML, and it will not include the Lofty push result,
   but it does the one job that matters: she finds out a lead arrived.

Option 2 is the right answer if she wants this working today without signing up
for anything. Option 1 is better long-term because the email is formatted, names
the source page, and reports whether the Lofty push succeeded. **The Lofty push
itself is independent of both** — that already works via `LOFTY_API_KEY`.

### 1.3 Rotate the API keys, then mark them secret
`MLSGRID_API_TOKEN`, `LOFTY_API_KEY`, `BLOBS_TOKEN` and `CLOUDINARY_API_SECRET`
are all stored in Netlify with `is_secret: false` — readable in plaintext by
anyone with dashboard access, and they were readable in this session's transcript.
The MLS Grid token is shared with Listing-Engine and Expired-Luxury, so a leak
breaks three apps and creates a compliance problem.

Order matters: rotate at each provider → save new values in a password manager →
THEN tick "Contains secret value" in Netlify. Marking secret is one-way; the value
becomes unreadable afterwards. She has NOT confirmed doing this.

### 1.4 The Relocation Guide — DONE 2026-08-17, and how to regenerate it

The 22-page PDF now exists and is delivered. Superseded notes kept below for the
reasoning, because the "no PDF" state is what the Buyer's and Seller's Guide
landers are *still* in.

- **Generator:** `build/tools/relocation_guide_pdf.py` (reportlab). Reads
  `build/data/city_content.json` through `build.py`, so all 36 town profiles,
  school districts and commute figures come from the same source the town pages
  use. Regenerate after editing town content: `python3 build/tools/relocation_guide_pdf.py`
- **reportlab is deliberately NOT in `requirements.txt`** and not imported by
  `build.py`. The Netlify deploy must never depend on it. The PDF is a committed
  artifact.
- **Output goes to `build/assets/guides/`, not `site/assets/guides/`** —
  `copy_static_assets()` rmtree's `site/assets` on every build, so anything
  written straight there survives exactly one build and then vanishes.
- **Delivery:** `/thank-you.html` reveals the download only when
  `?from=relocation-guide`. The lander itself does not link the PDF — a magnet you
  can download without giving an email address captures nothing.
- **No market figures in it, on purpose.** A median inside a PDF cannot be
  refreshed after download; it points at the live town pages and the monthly
  report instead.

Still true for the *other* two guides: the Buyer's and Seller's Guide landers have
no document behind them. Same generator pattern would work if she wants them.

### 1.4b Original note (superseded) — what the gap used to be

`/guides/northern-colorado-relocation-guide.html` went live 2026-08-16 as the site's
single named lead magnet, linked from all 37 town pages, the homepage and
`/relocation.html`. It is built on the exact pattern the Buyer's and Seller's Guide
landers already use: **no PDF is attached, on any of the three.** The form captures the
lead, it lands in Lofty tagged "Relocation Guide Download", and `/thank-you.html`
promises Christine reads it personally and replies the same day. That is how the other
two have always worked, so this is not a new gap — but it is now a gap on the page the
whole relocation funnel points at.

The lander's "What's Inside" list is six specific promises (town-by-town comparison,
measured drive times, school districts, the out-of-state buying process, water/wells/
septic/metro districts, month-by-month market read). Every one is deliverable from
material already on this site — the drive times, school districts and town comparisons
are live data, not something to research. Someone needs to assemble it into a document
and either attach it or have Christine send it on reply. **Until then the promise is
only as good as her follow-up**, and the follow-up currently depends on §1.2
(`RESEND_API_KEY`) actually alerting her that the lead arrived.

### 1.5 Two GitHub secrets — DONE 2026-08-17, prices are live

`BLOBS_SITE_ID` / `BLOBS_TOKEN` and `GOOGLE_MAPS_API_KEY` are set, both workflows
have run successfully, and the numbers are on the pages. Nothing to do here. The
original rationale is kept below because it explains why the feature exists.

**Original note —** the town-page prices are off until these are set

Added 2026-08-16 after searching the queries the town pages were re-aimed at. Every
page outranking this site leads with numbers — "median list price $672,792 … 92 days
on market … median home value $485,976" — and ours led with a paragraph explaining
why we wouldn't print one. That argument was right about *their* method (hand-typed
into a blog post, then left to rot) and wrong as a conclusion, because this site is
the only one in that search result with a raw MLS feed in its own code rather than a
vendor IDX widget it cannot read from. Their numbers are stuck in a widget Google
doesn't index; ours can be baked into the HTML and into FAQPage schema, which is the
form an AI answer engine actually quotes.

So the town pages now say "there are 214 active listings in Loveland, at a median
asking price of $689,000", computed from the live IRES inventory
`sync-listings.js` already replicates into Netlify Blobs. Nothing is typed by hand,
and `tests/test-townmarket.js` fails the build if a figure on a page ever disagrees
with its source.

**What's needed:** add these two repo secrets (Settings → Secrets and variables →
Actions). They are the same values the Netlify functions already use — Netlify →
Site settings → Environment variables:

    BLOBS_SITE_ID
    BLOBS_TOKEN

Then `.github/workflows/town-market.yml` refreshes the figures Mondays and Thursdays
and commits them, which triggers the normal Netlify rebuild.

**Until they are set, no prices appear.** That is deliberate and safe — `build.py`
suppresses every figure once the data is missing or more than 21 days old, and the
pages fall back to their qualitative copy. Nothing breaks; the site just doesn't get
the win. The scheduled job skips itself with a notice rather than failing red every
week, and `python3 build/build.py` prints a one-line reminder every time it runs.

To generate the file once by hand from a machine with the credentials:

    BLOBS_SITE_ID=... BLOBS_TOKEN=... node build/tools/town-market-stats.js

### 1.6b Jefferson, Arapahoe and Adams have NO town pages — found 2026-08-17

Surfaced by building the county drill-down. Those three counties list **27 cities
between them** in `COUNTIES`, and not one has a town page behind it. They appear in
the Search Homes dropdown and on their county pages with nothing to land on.
Larimer/Weld/Boulder have 31 town pages; Morgan, Denver and Broomfield got theirs;
these three were missed.

The map handles it gracefully — an empty `towns` array falls through to the old
county-wide popup rather than opening an empty panel — so this is a content gap,
not a bug. But town pages are the ranking asset, and 27 of them are missing.
Needs `city_content.json` entries, which is real writing, not generation.

### 1.6 Small, cheap, still open
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

**VERIFIED LIVE 2026-08-16T01:45:51Z.** `lastRunPagesFetched: 1`,
`lastRunRecordsSeen: 50`, cursor advanced `$skip=12400` → `12500`. It was 0 and 0 on
every run before this. No 499s. The crawl is moving again.

(`totalListingsStored` reads 18,216 rather than climbing — that is `pruneAndSlimStore`
dropping listings that left the replicated statuses, which is correct behaviour, not
a regression.)

**New consequence to watch:** more crawl throughput means more MLS Grid requests per
run, on an account shared with Listing-Engine and Expired-Luxury. A 429 appeared on
the photo probe shortly after. See §2.6.

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

### 2.6 MLS Grid 429s — the real diagnosis, 2026-08-17

Supersedes the 2026-08-16 note, which blamed the crawl and the probe. Both were
contributors; neither was the main event.

**Measured, not guessed:** `sync-listings` is paced at `REQUEST_DELAY_MS` (1500ms)
inside `TIME_BUDGET_MS` (11s), so it makes **at most ~7 API calls per run** — ~670
a day at the old 15-minute cadence. That is small against MLS Grid's limits. This
job was never the glutton, and throttling it further is not the lever it looks like.

The 429s Christine hit were on **`media.mlsgrid.com`, not the API**, and persisted
across a 35-minute gap — a sustained condition, not a burst.

Three things were making it worse, all now fixed:

1. **Nothing backed off from a media-host 429.** `setPhotoCooldown()` had exactly
   one caller: `resolveMediaFor()`, for API 429s. A 429 on the image fetch returned
   a grey placeholder and changed nothing, so a page of cards kept requesting into
   a limit that therefore never cleared — the grey box was both the symptom and the
   cause of the next one. There is now a SEPARATE `MEDIA_COOLDOWN_KEY` (separate on
   purpose: an API cooldown must not blank photos whose URLs are already cached).
2. **Every failure placeholder was cached 300s regardless of reason**, so a photo
   that was never coming back re-asked MLS Grid every five minutes forever, from
   every CDN edge. Now per-reason: 60s for rate limits, an hour for a photo
   confirmed gone.
3. **A listing that resolved to no media was never negative-cached**, so it was
   re-resolved on every single page view.

**What is still open.** After all three, the account may simply not have the
headroom. The token is shared with Listing-Engine and Expired-Luxury and the limits
are per ACCOUNT, so nobody can currently attribute usage to an app. Christine has
been advised to ask MLS Grid two questions: what her actual limits and recent usage
are, and whether each application needs its own data access agreement and key —
which is likely a licensing requirement, not just a nice-to-have, and would also
fix the blast-radius problem in §1.3. **Sync cadence was moved 15 → 30 minutes at
her request on 2026-08-17**, recorded in `netlify.toml` with the honest caveat that
it halves an already-small footprint and is not the fix.

### 2.7 The county map drills into towns (2026-08-17)

Christine: "when i click on any county it moves to this page instead of being able
to click in more". A county click went straight to a price filter scoped to the
whole county — not a scope anyone shops in (Fort Collins alone has 842 active) —
and routed people PAST the 37 town pages, which are this site's best content and
the pages that match how people search. Clicking a county now fills it, fades the
others, zooms in, and swaps the sidebar to its towns; the price popup moved to the
town level. Town data comes from `county-search.json`, generated from `COUNTIES`
and `town_geo.json`, so the map cannot drift from the rest of the site.

**A LESSON WORTH KEEPING.** Building that, I hid every base marker on entering a
county so town pins would not double up with city icons — and the same array held
the POI markers, which are Christine's spots. She opened a county and wrote "all of
my embedded videos are all gone!!!! I had so many". Nothing had been deleted, and
that was beside the point: those pins are the one thing this map has that a portal
map structurally cannot. `tests/test-mapspots.js` now fails if anything registers a
spot with a hide list. **When optimising a view, check what else is in the bucket
you are emptying.**

### 2.7b The two land listings' photos — STILL UNRESOLVED

`IRE1000029` / `IRE1000031` ("0 Rickenbacker Rd", legacy records with sequential low
ids) render grey. Three readings, in order:

1. `image_http_error`, **404**, `authMode: "auth"`, `urlCount: 4` — MLS Grid resolves
   4 photo URLs fine; the image itself 404s. **Ruled out** the 4.4MB inline ceiling,
   which was my first suspicion.
2. After adding a retry: **429** — rate-limited before the second auth mode could be
   tried.
3. After adding the media cooldown: **429 again**, backoff working correctly.

**The open question:** a 404 confirmed on BOTH auth modes means the files are gone
from MLS Grid and nothing here can retrieve them — at which point the honest fix is
cosmetic (stop the card advertising "View All 4 Photos"). A 404 on one mode and
success on the other means the auth heuristic was wrong and the photos come back.
`RETRY_OTHER_MODE_ON` now includes 404 and the debug JSON reports every attempt, so
**one load of `/.netlify/functions/listing-photo?id=IRE1000029&i=0&debug=1` once the
limit is clear will settle it.** Do that before touching anything else in the photo
path.

### 2.8 The health page could show days-old readings as current (2026-08-17)

Five `/status` rows are cached probes that only re-run under `?probe=1`, and the
display had no staleness handling at all — three of the five printed no date. That
is how §1.1 happened.

**My first fix was wrong and the tests caught it.** I made the probes refresh
themselves; that broke three suites, each guarding a lesson already paid for here:
a plain page load makes no outbound calls (`test-leadprobe.js`), rows must not go
red for things that are not broken — "the crying-wolf mistake the Cloudinary row
already taught us" (`test-optional.js`), and a considered cached verdict must not be
silently overwritten (`test-tagsnotreturned.js`). **Probing was never the missing
piece; disclosure was.** Every row now prints when it was checked, a stale reading
is flagged and stops counting as a pass or a fail, and a summary row names anything
that needs re-running. Pinned by `test-healthlive.js`.

**A deliberate trade to know about:** a STALE failure now renders green-with-warning
rather than red. If that ever hides something real, flip it — but read
`test-healthlive.js` case 5 first, which pins that a FRESH failure still fails.

### 2.9 Card photos — TWO separate problems. One is fixed, one is still open.

They got conflated all evening, so separate them before touching anything:

| | Symptom | Status |
|---|---|---|
| **A. Grey cards** | A card shows nothing at all | **FIXED 2026-08-17** — see 2.9a |
| **B. Slow photos** | The photo arrives, but it is 1–3MB for a 400px slot | Still open — see below |

### 2.9a Grey cards — fixed by keeping our own copy

Christine said "photos still arent showing" **four times** on 2026-08-17. Every answer
given to her was accurate and none of them changed what she was looking at:

- MLS Grid's media host was 429ing, so the fetch failed;
- the CDN could not help, because a photo that never succeeded has nothing to cache;
- Cloudinary re-hosting would fix it permanently, but is blocked on credentials only
  she can set (§1.1), and stayed blocked all evening.

All true. Her main listings page still had a hole in it. **The lesson is the one worth
keeping: an accurate explanation is not a fix, and repeating it is not progress.**

`listing-photo.js` now writes a successful photo to Blobs and serves that copy on any
later failure. One success is permanent; a rate limit stops being something a visitor
can see. No third party, no key.

**Bounded deliberately** — this store also holds the ~27,000-listing IRES catalogue:
cover photos only (`PHOTO_CACHE_MAX_INDEX = 0`), her own listings only (via
`mine-listings.json`), and it fails SAFE — an unreadable listing list means cache
nothing, never everything. `test-photocache.js` drives the real functions against a
fake store and is control-tested; unbounding the index makes it fail.

**It does not repair a photo that has never once succeeded** — it makes the next
success permanent. A card can still be grey until its first clear window.

### 2.9b Slow photos — still open, and the reverted attempt

**Still true.** Christine: "pictures just still arent coming
through very quickly". A listing card renders at roughly 400px wide and is handed the
FULL-RESOLUTION MLS photo — routinely 1–3MB of JPEG for a slot that needs about 60KB.
`listing-photo.js` caches hard at the CDN, so a repeat view is fast and still
enormous. The bytes are the problem, not the pipeline. That diagnosis still stands.

**What was shipped (#18, #19) and reverted (#20):** `sizedPhoto()` wrapped our own
photo endpoint in `/.netlify/images?url=…&w=800&fm=webp`, with a `data-raw` fallback
to the untransformed endpoint, plus `width="800" height="600"` on the img to stop
layout shift. Christine's next screenshot showed Current Listings rendering card
images as **enormous grey boxes, roughly 800×900** — the whole page wrecked.

**The most likely cause, untested:** the transform requested `w` only, which
preserves the source aspect ratio, so a portrait MLS photo came back 800×1200. That
collided with the hardcoded `width="800" height="600"` attributes and with
`.listing-card img { aspect-ratio: 4/3 }` in the stylesheet. Grey means the box was
laid out and the image had not arrived or had failed — consistent with the attributes
reserving a box the transform never filled at that shape.

**If you retry it, in this order:**
1. Request a fixed box, not a width: `w=800&h=600&fit=cover`. Then the returned
   image matches both the attributes and the CSS aspect ratio.
2. Change **one page** and deploy it. Not every card on the site at once.
3. **Get a live screenshot from Christine before expanding.** This is the point the
   last attempt skipped, and it is the only step that would have caught it — every
   static check passed on a change that visibly destroyed her main listings page.

**The pattern this is the fourth instance of.** The shell that was never bundled, the
fingerprinting that missed the shell, the map view that swept up her spots, and now
this: *static checks passing while production is broken.* Everything in this repo
that can only be verified in a browser needs a browser, on one page, before it
touches all of them.

---

## 3. Corrections to earlier advice — read before repeating it

### 3.0 Added 2026-08-17
- **"Cloudinary is still broken"** — WRONG, and I said it to her face. I read a
  stale `/status` row after she had already fixed it. See §1.1 and §2.8.
- **"The land photos are probably hitting the 4.4MB ceiling"** — WRONG. Her debug
  output said 404. I had a plausible story (land listings carry huge aerials and
  plat maps) and it was not what was happening. The site already shipped the tool
  that answered it; I should have read it before theorising.
- **"Make the health probes refresh themselves"** — WRONG, reverted the same
  session. Three existing suites each encoded a reason not to. See §2.8.
- **`git push origin <branch>` while standing on `master`** pushes the LOCAL branch
  of that name, not your commits, and `git rev-parse HEAD` will happily report a
  sha that was never pushed. Two commits looked shipped and were not. **Verify
  pushes with `git ls-remote origin <branch>`, never with local HEAD.**
- **"Route the card photos through Netlify's Image CDN"** — right diagnosis, shipped
  wrong, reverted. See §2.9 before trying it again.

### 3.1 "Lofty should work, Resend is a backup" — WRONG
I said this repeatedly. Lofty's API cannot return tags, so the tag-triggered
Smart Plan cannot be made reliable for repeat buyers. The direct email is the only
notification path that can be. Reversed in the code comments and on `/status`.

### 3.2 "Cloudinary is optional, nothing a visitor can see" — HALF WRONG
True about photos rendering. False about the system: it was starving the crawl.
Marking that row `optional: true` on `/status` is what made a real problem look
cosmetic. **Lesson: an "optional" flag on a status page hides consequences that
aren't visible from the row's own name.**

### 3.2b Two status rows that contradicted each other
"Cloudinary configured: ✓ All three env vars present" sat on the same page as
"Cloudinary account healthy: ✗ cloud_name mismatch". Both were true — the vars ARE
set, they just belong to different accounts — but a reader has to work out which to
believe, which is worse than one clear red row. The first row now says present is not
the same as working and points at the row that actually tests it. **Lesson: a status
page's rows have to be readable together, not just individually correct.**

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

**Point her audience at the site — NOW WRITTEN, awaiting her.** See
`docs/YOUTUBE-DESCRIPTION-LINES.md`: the exact line to paste into each of her 22
local videos, with the right town-page URL and real view count, most-watched first.
Regenerate with `python3 build/tools/description_lines.py` after adding spots, and
`tests/test-desclines.js` verifies every URL in it resolves to a page that exists.
This is the highest-leverage action left and it costs her an evening, not a budget.

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
