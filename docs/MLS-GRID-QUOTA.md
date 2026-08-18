# MLS Grid: audit, media rules, subscriptions, and what to ask

Written 2026-08-17. Companion to `NEXT-SESSION.md` §2.6, which diagnosed the
media 429s and fixed everything fixable at the time, then concluded the last
remaining fix was not code but the shared account quota.

**That conclusion was wrong, and this document supersedes it.** Reading MLS
Grid's own API documentation against this codebase turns up six places where the
site does something the docs explicitly say not to do — including caching
single-use URLs and re-downloading media that never changes. Those explain grey
cards without needing a quota shortage, and none of them get better with more
quota. There is also a **hard deadline: 8 September 2026**, when MLS Grid's media
delivery moves off AWS, in a way that breaks one of this codebase's assumptions.

Sources: MLS Grid Documentation (Overview + API Version 2.0), the Manage
Subscriptions screen of Christine's own account, and a full read of the photo
path in this repo. **ASK** marks the few things only MLS Grid or IRES can answer
— which is now a much shorter list, because the usage numbers turn out to be
self-serve (§1).

---

## 0. Audit findings, worst first

Read in full: `listing-photo.js`, `lib/_media.js`, `listings-search.js`,
`listing-page.js`, the photo paths in `sync-listings.js`, `site-health.js`, and
the front-end callers in `build.py`.

### Finding 1 — we cache single-use URLs for 40 minutes and re-serve them

MLS Grid, on Media URLs: *"**Single-use** — the URL may be used to download its
image only once. A second request using the same URL will fail."* And: *"do not
store or cache a Media URL for later use. Retrieve it from the API and download
the image promptly."*

`lib/_media.js` does exactly the opposite: `URL_CACHE_TTL_MS = 40 * 60 * 1000`,
with `readCachedUrls()`/`writeCachedUrls()` storing resolved URLs in Blobs under
`photo-urls/` and serving them to any request in the next 40 minutes.

So the second use of any cached URL **fails by design**. That is:

- the pre-warm resolves 12 URLs → the first visitor's browser spends them;
- any reload, any second CDN edge, any other visitor in that 40-minute window,
  and the detail page's own re-request → **all replaying spent URLs**.

This produces exactly the reported symptom: some photos load, some don't, on the
same page, intermittently, worse when many people are looking at the same
listings. It is not rate limiting and it is not a quota shortage. It also means
the throttling story has been partly chasing the wrong failure — a spent URL and
a throttled request both end in a grey box.

**Fix:** treat a resolved URL as a one-shot token. Either resolve immediately
before each download and never store it, or (better, see Finding 2) resolve once,
download the bytes once, store the *bytes*, and never keep the URL at all. The
`photo-urls/` cache should hold "this listing has N photos and here are their
MediaKeys", not URLs.

### Finding 2 — we re-download media the docs say never needs downloading twice

MLS Grid: *"You must maintain your own copy of all media files."* And: *"The
media never updates and retains the original Media URL. If there are ANY changes
to the media a new Media URL is issued. **There is NEVER a reason to download the
same media more than once.**"*

Today `listing-page.js` renders up to **12 photos** per listing
(`Math.min(count, 12)` in `listingBody()`), while the Blobs photo cache is bounded
to **index 0** (`PHOTO_CACHE_MAX_INDEX = 0`) and Cloudinary re-hosting covers only
Christine's own 11 listings. So for any catalogue listing:

- photo 0 → served from Blobs after the first success. Free.
- **photos 1–11 → re-downloaded from MLS Grid**, on every view that misses a CDN
  edge, forever.

One detail-page view costs up to 11 media downloads, fired in parallel — several
times the 2 rps ceiling from a single visitor — and they recur tomorrow. This is
the dominant consumer on this site's side of the token, it grows with traffic,
and it is precisely the thing the docs say there is never a reason to do.

**Fix:** raise the cache bound so the whole displayed set is stored on first
fetch. Cost is bounded by traffic, not catalogue size: ~12 photos × ~300 KB ×
1.33 (base64, see Finding 7) ≈ **4.8 MB per listing anyone actually opens**. 500
browsed listings ≈ 2.4 GB. After the first viewer, a detail page costs MLS Grid
nothing, ever again.

The docs also hand us the correctness rule for free: media is keyed by
**MediaKey**, and `MediaModificationTimestamp` / `PhotosChangeTimestamp` change
when and only when an image has actually changed. Key the stored copy by MediaKey
and a re-download only ever happens when MLS Grid says the photo is genuinely new.

### Finding 3 — the 8 September 2026 media migration breaks `looksPresigned()`

MLS Grid is moving media off AWS on **8 September 2026** — about three weeks from
today. The new URL format puts the signature **in the path, not the query
string**:

```
https://media.mlsgrid.com/token=…&expires=…&id=…/images/MFR781897278/….jpeg
```

`looksPresigned()` in `lib/_media.js` only ever inspects the query string:

```js
const query = (String(url).split("?")[1] || "").toLowerCase();
if (!query) return false;
```

A new-format URL has **no `?` at all**, so `looksPresigned()` returns `false`,
so `fetchMediaResponse()` tries **`auth` mode first** and sends
`Authorization: Bearer …` alongside a signed URL — the exact two-auth-mechanisms
situation the 2026-08-15 fix was written to avoid, which that same commit
documented as producing 403s (and possibly the 404s seen since).

The file's own comment guessed at this: *"a path-signed URL would slip past"* the
heuristic. The docs now confirm that is the format everything is moving to. This
is very likely already biting, since the 429s and 404s in evidence are from
`media.mlsgrid.com`, not from AWS.

**Fix:** stop guessing. Treat any `media.mlsgrid.com` URL as signed, or simply
never send `Authorization` on a media download at all. Also note the migration
notice: *"If your integration currently accesses Media via Amazon CloudFront, it
will need to be reconfigured… Contact support@mlsgrid.com so we can get you set
up on the new CDN ahead of the transition."* That contact needs making before
8 September regardless of everything else in this document.

### Finding 4 — the anonymous fetch mode omits the User-Agent MLS Grid requires

MLS Grid: *"**ALL** requests to download the expanded media using the Media URL
MUST include the HTTP header User-Agent. The User-Agent value MUST be the Oauth 2
access token… **Any User-Agent that is not your Oauth 2 access token will be
blocked by our service.**"*

In `fetchMediaResponse()`, `User-Agent: token` is set **only in the `auth`
branch**. The `anon` branch sends `Accept` and nothing else, so it goes out with
the platform default agent — by definition "not your OAuth2 access token". And
for URLs that *do* look pre-signed, `anon` is tried **first**.

The 2026-08-15 change was right that an `Authorization` header breaks a signed
URL, but it dropped the User-Agent along with it, and only one of the two was the
problem. A User-Agent is not an authentication mechanism and cannot conflict with
a signature.

**Fix:** send `User-Agent: token` in **both** modes. Vary only `Authorization`.

### Finding 5 — the media resolve query breaks two documented API limits

`resolveMediaFor()` builds:

```js
"$filter": `(${idClause}) and MlgCanView eq true`   // idClause = up to 12 × "ListingId eq '…'" joined by " or "
```

Two problems against the v2 docs:

1. **"The query must include no more than 5 'or' operators per query."** Twelve
   ids is eleven `or` operators — more than double the documented ceiling. The
   docs add: *"It is preferred to use the `in` operator instead which is new in
   version 2.0."*
2. **"Each request must contain a single OriginatingSystemName specified in the
   filter criteria of the request."** `OriginatingSystemName eq 'ires'` appears
   exactly once in this codebase — `sync-listings.js:276`, the replication
   filter. It is **absent from every media resolve and every single-listing
   refresh** (`_media.js`, and `sync-listings.js` lines 421, 484, 516).

This is the highest-frequency API call the site makes, and it is out of spec in
two ways at once. It may well be the cause of the behaviour `_media.js` already
works around: *"This feed is documented to sometimes ignore a ListingId filter
and return an unrelated record."* An unfiltered-by-system query would do that.

**Fix:** `$filter=OriginatingSystemName eq 'ires' and ListingId in ('IRE…','IRE…') and MlgCanView eq true`.
Same call, one `or`-free clause, inside every documented limit.

### Finding 6 — the pre-warm silently covers only the first 12 of up to 24 cards

`listings-search.js` accepts `top` up to **24** (`Math.min(parseInt(top)||12, 24)`),
but `prewarmPhotoUrls()` and `resolveMediaFor()` both slice to
`MAX_IDS_PER_BATCH = 12` with no log line. The site's own UI uses `TOP = 12` (two
places in `build.py`), so this is dormant — but anything hitting `?top=24` gets 12
cards with no pre-warm, each firing its own resolve: the exact burst the pre-warm
exists to prevent. Chunk it, clamp `top`, or at least log the truncation.

### Finding 7 — smaller things worth knowing

- **Photos over ~4.4 MB can never be served.** `MAX_INLINE_IMAGE_BYTES` is a hard
  Netlify limit (6 MB response, +33% base64). Those listings return `too_large`
  and stay grey no matter what happens to the quota. Only serving from a real
  image host (Cloudinary) fixes them, because that bypasses the function response
  entirely. Land listings with full-res aerials are the common case.
- **The photo cache stores base64 JSON**, ~33% more bytes than the raw buffer, on
  every cached photo — and it compounds once the cache covers 12 photos instead
  of 1.
- **The refresh sweep spends ~240 requests/day on URLs nobody uses.**
  `REFRESH_SWEEP_BATCH_SIZE = 5` × 48 runs/day, whose stated purpose is keeping
  stored signed photo URLs fresh. But `photoUrlFor()` only ever emits a *stored*
  URL when it is a Cloudinary URL; raw MLS Grid photo URLs are never served to
  anyone any more. At 5 per run it also needs **64 days** to walk 15,471
  listings, so it was never keeping anything fresh. Its status-checking half is
  still useful; its photo half should be repointed at downloading photos into the
  cache (§4).

### What the audit did *not* find

No hidden second consumer. `site-health.js` only touches MLS Grid behind an
opt-in `?probe=1`. `listings-search.js` never calls MLS Grid except through the
pre-warm. The sync really is ~7 calls per run, as §2.6 measured. The traffic is:
the sync, the pre-warm, and photo downloads — and photo downloads dwarf the rest.

---

## 1. The limits — which you already have in writing

**Correction, from Expired-Luxury's `MLS_REINSTATEMENT.md`: this account was
SUSPENDED on 2026-08-01, and the suspension email listed the enforced limits.**
They are not identical to the public documentation, and two of the differences
matter. These are the numbers to encode, not the published ones:

| # | Limit (from the 2026-08-01 suspension notice) | vs public docs |
|---|---|---|
| 1 | **7,200 requests** in any hour | same |
| 2 | **3,072 MB downloaded** in any hour | public docs say 4 GB — **the real limit is 25% lower** |
| 3 | **4 requests/second** at all times | public docs say 2 rps |
| 4 | **40,000 requests** per rolling 24 hours | same |
| 5 | **40 GB downloaded** per 24 hours | **not in the public docs at all** |

And the sentence the suspension actually fired on:

> *"Your hourly 6.0 requests per second exceeded the 2 requests per second limit."*

So both are true and they are different things: **4 rps is the instantaneous
ceiling, 2 rps is the sustained hourly average.** A burst is survivable; an hour
that averages above 2 rps is what gets the token suspended.

**The documented cause of that suspension was not any of the three apps' normal
traffic.** It was *"ad-hoc diagnostic scripts run by hand against the live API
from Render Shell, with no rate limiting — they bypassed the app's limiter
entirely."* Which is worth carrying into every future debugging session: **never
probe the live API with a bare `curl` or `node -e` loop.** Use a throttled
endpoint.

Media downloads spend the same budget as API calls, and the binding constraint is
the sustained **2 rps**, not the totals — a detail page's 11 parallel image
requests breaches even the 4 rps instantaneous ceiling from a single visitor, and
a page getting steady traffic is what turns that into an hourly average.

Enforcement is at the **token**: *"the access token will be suspended and a
shut-off message sent to the Primary email address"*, reinstated automatically
once usage falls back inside the limits. Whether two tokens on one account get
two budgets is still **ASK**.

**The usage breakdown is self-serve — do this before emailing anyone:**

1. Log in to MLS Grid → **Manage Subscriptions**
2. **Edit Data Subscription Details**
3. **Usage** tab → hourly summary
4. **Usage Logs** button at the bottom → 24-hour breakdown

That answers "what am I actually using, and when" without waiting on support, and
it is the fastest way to find out whether the three apps together are anywhere
near the ceiling — or whether, as the audit suggests, the grey cards were never
about the ceiling at all.

## 2. What the media rules actually require

Not "a good idea" — the documented obligations:

- **"You must maintain your own copy of all media files."**
- **"DO NOT use these URLs on your website or in your application"** (in bold,
  twice). Download-only.
- **Signed, single-use, one-hour** URLs; *"do not store or cache a Media URL for
  later use."*
- **`User-Agent` must be the OAuth 2 access token**, or the request is blocked.
- **"There is NEVER a reason to download the same media more than once"** — new
  media means a new `MediaKey` and a new URL, signalled by
  `PhotosChangeTimestamp` and `MediaModificationTimestamp`.
- From **8 September 2026**: media served from `media.mlsgrid.com`, no more S3
  bucket-to-bucket, and CloudFront users must be moved to the new CDN by
  arrangement with support.

Read together, these describe one architecture: **replicate the media alongside
the records, keyed by MediaKey, download each file exactly once, serve every
visitor from your own storage.** The site is currently a hybrid — it self-hosts,
but resolves and downloads at request time, caches the URLs it was told not to
cache, and re-downloads what it was told never to re-download. Findings 1 and 2
are the gap between the two designs.

## 3. Subscriptions: are there different kinds, and should you add one?

From your Manage Subscriptions screen: one **IDX Subscription** ("The Bold
Collective Homes IDX Subscription"), 1 finished broker licence, 1 approved source
MLS, **$28.00/month**.

**Yes, there are different kinds — but they are use-case licences, not capacity
tiers.** The docs define them by what each record may be used for (`MlgCanUse`):

| Feed | What the records may be used for | Relevant here? |
|---|---|---|
| **IDX** | Public display on IDX websites **and in CRM and transaction-management tools** | **Yes — this is the one you have** |
| **VOW** | Virtual Office Website: broker-consumer relationship, consumer registration, more data, more rules | No |
| **BO** (Broker Back Office) | Agent production analytics, CMA, market analytics, participant listings | No |
| **PT** (Broker Only / Participant) | Participant listings use only | No |

**None of them raises a rate limit.** Adding a VOW or BBO feed buys different
data rights, extra compliance surface and extra fees, and zero headroom. If the
goal is fewer 429s, that is the wrong button.

Two further consequences of the `MlgCanUse` definitions, one of which corrects an
earlier assumption of mine:

- **IDX explicitly covers CRM and transaction-management tools**, so one IDX
  subscription serving both a public site and an internal tool is not obviously a
  licence violation. Splitting is an operations decision, not a compliance
  emergency. (Your subscription's description — *"Internal marketing platform…
  for social media content generation"* — describes Listing-Engine rather than
  the public website, so it is still worth mentioning to support; but it is a
  description-accuracy point, not a breach.)
- The honest case for a second IDX subscription is **attribution** (right now
  nobody can tell which of the three apps burns what) and **blast radius** (one
  suspension takes down all three at once). At **$28/month** that is cheap
  insurance — all three split is ~$84/month, plus any IRES setup fee (their
  published IDX setup is ~$150 one-time) — **ASK**.

Note also: "Add Broker/Agent" adds a *licensee* to the existing subscription. It
does not create a second token.

**My recommendation: don't add anything yet.** Read the Usage tab first (§1) and
fix Findings 1–5. If usage turns out to be nowhere near the ceiling — which the
audit predicts — then a second subscription buys attribution and isolation, worth
$28, but it was never going to fix the photos.

## 4. Cost of the remaining work

The store holds **15,471 listings**, against an IRES catalogue nearer 27,000.

**Option A — store what people look at (Findings 1 + 2).** Raise the cache bound
to cover the displayed set and stop replaying spent URLs. Free, no approval, and
it removes the largest recurring source of media requests. ~4.8 MB per listing
anyone opens.

**Option B — pre-host every cover in the catalogue.** ~29,000 covers × ~300 KB ≈
**8.7 GB**, ~29,000 downloads. Two things follow from the corrected number:

- **It cannot be done in one sitting.** 8.7 GB is nearly three times the real
  3,072 MB/hour cap, so the backfill must span at least three hours and honestly
  more like a week of nightly runs. At 2 rps it is ~4 hours of pure wall clock
  regardless.
- **It cannot go to Cloudinary on the free tier.** The health page shows credits
  already at **36% of 25**, and 8.7 GB of storage is ~9 more credits before any
  delivery traffic. Netlify Blobs is the right store for a backfill this size;
  Cloudinary stays for her own 11 listings and the oversize rescues.

**Cloudinary vs Blobs.** Cloudinary's free tier is 25 credits/month, where 1
credit = 1 GB storage *or* 1 GB delivery *or* 1,000 transformations. Cover-only is
~5 credits of storage plus delivery — inside free for a solo agent's traffic,
with Plus ($99/mo, 225 credits) as the ceiling. Cloudinary also serves straight
from its CDN instead of through a Netlify function, which removes the 4.4 MB
ceiling (Finding 7) and stops every photo view costing an invocation. Blobs are
free, already wired up, and fine for Option A. **Do A in Blobs now; move to
Cloudinary for B if delivery volume or the oversize photos justify it.**

**What NOT to do:** all 30-odd photos for all 15,471 listings up front ≈ 460,000
images ≈ 115 GB. Out of any free tier, for photos nobody will open. Option A
makes galleries cheap on demand, which is the right shape.

## 5. Recommended order

1. **Read the Usage tab** (§1). Ten minutes, no waiting, and it tells you whether
   quota is even the constraint.
2. **Fix Findings 3, 4 and 5** — the path-signed URL detection, the missing
   `User-Agent` on anonymous fetches, and the out-of-spec `or`-heavy query with
   no `OriginatingSystemName`. Small changes, all three are the site failing to
   follow documented requirements, and none of them need anyone's permission.
3. **Fix Findings 1 and 2** — stop caching single-use URLs; store the bytes for
   the whole displayed set instead, keyed by MediaKey. This is the real fix for
   the grey cards.
4. **Contact support about the 8 September CDN migration** (§6) — deadline-driven,
   independent of everything else.
5. **Backfill covers** (Option B) by repointing the refresh sweep, having told
   support it's coming.
6. **Then decide on a second subscription**, on attribution and blast radius,
   informed by what the Usage tab showed.

Steps 2 and 3 are the ones that make photos stop going grey. Everything about the
quota is downstream of them.

## 6. The email to MLS Grid support

Shorter than it would have been: the Usage tab answers two of the old questions,
and the 1 August suspension notice already answered the one about limits. To
`support@mlsgrid.com`, copying the IRES data-feed contact.

> **Subject: Media CDN migration + per-application IDX subscriptions — The Bold Collective Homes IDX Subscription (IRES)**
>
> Hello,
>
> I'm an IRES MLS subscriber in Northern Colorado with one IDX subscription
> ("The Bold Collective Homes IDX Subscription"). Its token is currently used by
> three of my own applications: my public IDX website
> (signaturepropertycollection.com) and two internal tools. Five questions:
>
> 1. **The 8 September media migration.** My integration downloads media directly
>    from the URLs in the Media resource. Your notice asks CloudFront users to
>    contact you to be set up on the new CDN ahead of the transition — is there
>    anything I need on my side beyond continuing to download from the MediaURL
>    as returned by the API, and is my subscription already serving the new
>    media.mlsgrid.com format?
> 2. **Are rate limits enforced per access token, or per account?** If I hold two
>    IDX subscriptions with two tokens, do they get separate budgets or share one?
> 3. **May I hold a separate IDX subscription per application, and would you
>    prefer that?** My current subscription's description covers my internal
>    marketing tool; my public IDX website is a separate application on the same
>    token. What does an additional subscription cost on your side, does IRES
>    charge a separate setup fee, and does each need separate IRES approval?
> 4. **Backfill pacing.** I'm correcting my integration to download each image
>    exactly once and serve it from my own storage, per your media rules. That
>    means a one-off backfill of roughly 15,000 cover photos. I'll pace it inside
>    the limits your 1 August notice set out — 2 rps sustained, 3,072 MB/hour — but
>    is there a rate or a window you'd prefer, so it doesn't read as concerning
>    behaviour on my token?
> 5. **Confirmation.** Are the limits in that 1 August suspension notice still the
>    ones on my subscription, or has anything been adjusted since? I've encoded
>    them and I'd rather not be working from a stale copy.
>
> Thank you,
> Christine Gwinnup
> [licence #, IRES subscriber ID, MLS Grid subscription ID]

Question 4 is deliberate: telling them the backfill is coming, before running it,
turns tens of thousands of paced downloads from a recently-throttled account into
an agreed-in-advance operation.

## 7. What is now fixed, and how to check it in production

All six findings are fixed, and `tests/test-mediarules.js` is a new suite that
pins each one to the sentence of MLS Grid documentation it comes from — 39 suites
pass. What changed:

| Finding | Fix |
|---|---|
| 1 — single-use URLs cached 40 min | `URL_CACHE_TTL_MS` 40 min → 5 min, and every index is marked spent (`markUrlUsed`) the moment a download is attempted. A spent index is never handed out again, however fresh the entry. A cached URL that fails is retried once with a freshly resolved one — but never on a 429. |
| 2 — re-downloading media | `PHOTO_CACHE_MAX_INDEX` 0 → 11, matching exactly what `listing-page.js` renders, and the handler now asks its own store **before** it contacts MLS Grid at all. A stored photo is served even with no token and with MLS Grid down. |
| 3 — path-signed URLs | `looksPresigned()` treats any `media.mlsgrid.com` URL as signed, so the Bearer header never rides along with a signature. Legacy AWS query-string detection kept for URLs still in flight. |
| 4 — missing User-Agent | `User-Agent: <token>` now goes on **both** fetch modes; only `Authorization` varies. |
| 5 — out-of-spec query | Media resolves send `OriginatingSystemName eq 'ires'` and use `ListingId in (…)` — zero `or` operators. A 400 on `in` falls back to `or` chunked to five ids and remembers, so one wrong assumption about the feed can't blank a page. `sync-listings.js`'s three single-purpose queries also carry the originating system now. |
| 6 — 24-vs-12 pre-warm | Batch cap raised to 24 to match the largest page `listings-search.js` will serve, and an over-cap batch logs instead of truncating silently. |
| also | `site-health.js`'s `?probe=1` marks the URL it spends, so the diagnostic stops creating the fault it exists to find. |

**How to confirm it worked, in order** — all of these are single requests through
throttled endpoints. Do **not** verify with a bare `curl` or `node -e` loop against
the live API: that is exactly what suspended this account on 2026-08-01 (§1).


1. **`?debug=1` on a photo that was grey.** `/.netlify/functions/listing-photo?id=IRE…&i=0&debug=1`
   should return `"ok": true`. If it fails, `reason` now distinguishes
   `url_unavailable` (spent URL, self-healing) from `media_rate_limited` (a real
   429) — those were indistinguishable before.
2. **Load the same listing page twice.** The second load should serve from our own
   store: response header `X-Photo-Cache: hit`, and no MLS Grid traffic at all.
3. **Watch the Usage tab** (§1) over a day. If Findings 1 and 2 were the bulk of
   it, media requests should drop sharply and keep dropping as the cache fills.
4. **`/site-health?probe=1`** for a live end-to-end resolve-plus-fetch.

**Deliberately not changed:**

- **The refresh sweep** still runs 5 listings per 30-minute run. Its photo-freshness
  half is now pointless (nothing serves stored MLS URLs), but its status-checking
  half is real, and repointing it at a catalogue-wide cover backfill is Option B —
  which should wait for support's answer on pacing.
- **Base64 storage in Blobs** (~33% overhead). The proven path is worth more than
  the saving right now, and storage is the cheap axis.
- **Photos over 4.4 MB** still cannot be served through a function response. Only
  Cloudinary fixes that; it needs her credentials and is Option B's territory.
- **The pre-warm still resolves URLs for listings whose photos are already stored** —
  one wasted API call per search page render, bounded and harmless, but it would
  need cross-module knowledge of the photo store to avoid.

## 7b. What Listing-Engine does, and what it proves

Read at `thelittleladyinc/listing-engine` (`api/routes/photos.js`,
`api/routes/mls.js`, plus its own status docs).

**First, the premise: Listing-Engine's photos do not reliably work either.** Its
own documentation, in three separate files:

- `CONTRACTOR-START-HERE.md`: *"`[Photo import] Result: 0 uploaded, 3 failed —
  429 Too Many Requests` from `https://media.mlsgrid.com/token=...`"*
- `VALTS-PRIORITIES.md`: PR #729's shared rate budget *"was meant to fix 429s from
  media.mlsgrid.com… **but the bug is still reproducing in production**."*
- `STATE-OF-PLATFORM.md` lists it as open production issue #2, after six prior PRs.

It also silently drops everything past photo 25 (`photos.js`: `urls.slice(0, 25)`)
on listings with 50-80 photos. So "it brings in photos" is half true: when a run
succeeds the result is permanent, and when it fails it fails into a log rather than
onto a page a buyer is looking at. **That visibility difference is most of the
apparent gap between the two apps.**

**What it genuinely does better, and why:**

| Listing-Engine | Why the website could not just copy it |
|---|---|
| Downloads each photo once, hands Cloudinary a Buffer, never touches the URL again | The site is serverless: no import step, photos are demanded by browsers |
| ONE global gate (`mlsGridRateGate`, 1500ms) shared by **both** the OData API and media downloads, in one long-lived Render process | Netlify Functions are many separate containers; a module-level `_lastRequestTime` cannot coordinate them. The site's blob-based cooldowns are the equivalent, and now cover media separately from the API. |
| A media 429 suspends the OData path too, persisted to a DB table so it survives restarts | The site does this in Blobs, and deliberately keeps photo cooldowns from pausing the sync |

The important part: **its architecture is the one MLS Grid's docs describe, and the
fixes in §7 move the website to the same shape** — fetch once, store the bytes,
never replay a URL, serve everything afterwards from our own storage.

**What Listing-Engine does WORSE, and should be fixed there too:**

1. **It sends a browser User-Agent.** `photos.js` sends
   `'User-Agent': 'Mozilla/5.0 (compatible; ListingEngine/1.0)'`, where MLS Grid's
   docs say the value **MUST** be the OAuth token and *"Any User-Agent that is not
   your Oauth 2 access token will be blocked by our service."*

   This is the most interesting thing in the whole comparison. **A job hard-gated
   to one request per 1500ms — 0.67 rps, a third of the allowance — should never
   see a rate limit at all.** Six PRs have chased pacing, cooldowns and Redis;
   nobody has checked the header. If "blocked" surfaces as a 429, that is a
   complete explanation for 429s the pacing theory cannot account for. It is a
   hypothesis, not a proven cause — but it is one line to test and it has never
   been tested.

2. **No `OriginatingSystemName` on any query.** `mls.js` sends
   `$filter=ListingId eq '…'` — and its own comments describe the documented
   consequence: *"MLS Grid may silently ignore $filter on ListingId"*, *"where
   $filter=ListingId is silently ignored and a random listing"* is returned. Two
   independent codebases, the same omission, the same bug, each written up as a
   quirk of the feed. It is a missing required parameter (Finding 5).

3. **The rate budget is in-memory only**, wiped by every Render restart — its own
   notes name this as the probable reason the shared-gate fix didn't hold.

**Two things this settles for the questions in this document:**

- **The new path-signed URL format is already live, not a September problem.** That
  production log line is `https://media.mlsgrid.com/token=...` — exactly the format
  §0 Finding 3 is about. The fix is load-bearing today.
- **The account has already been warned.** `mls.js`'s own comment: the gap was
  *"bumped from 600ms → 1500ms after MLS Grid sent an 'API Access Warning' email
  reporting we hit 4 RPS"*. So the Usage tab and the primary contact's inbox have
  real history, and the support conversation in §6 should acknowledge it.

**And it is the strongest evidence yet against buying more quota.** Listing-Engine
takes 429s while deliberately running at a third of the documented rate. Whatever
is producing those, it is not volume.

## 7c. What Expired-Luxury does, and what to steal from it

Read at `thelittleladyinc/expired-luxury` (`lib/mlsClient.ts`,
`MLS_REINSTATEMENT.md`, `components/DetailsDrawer.tsx`). **Nothing changed there
— read only.**

This is by a distance the most disciplined MLS Grid integration of the three, and
it is that way because it is the one that got the account suspended and had to
write a reinstatement plan. It is worth treating as the reference implementation:

| Guard | What it does |
|---|---|
| `MLS_DISABLED` kill switch | One env var stops every MLS code path without removing credentials |
| Token bucket + **hard ceiling** | `MLS_GRID_RPS_CEILING = 2`; `MLS_GRID_RPS` can tune **down** but not up, so a well-meant "make it faster" cannot cost days of downtime |
| **Quota budget read before every call** | `getMLSQuotaUsage()` aggregates `mls_api_call_log` and refuses any request past **50%** of any published limit — hourly and daily, requests and megabytes |
| Fails **closed** | If the call log is unreadable it blocks, because "zero usage" is the most permissive answer the function could give and would silently turn the guard into a no-op |
| Circuit breaker | 5 consecutive 429/5xx → 15 minutes closed, mirrored to `system_settings` so a cold start doesn't reopen it against a still-suspended account |
| `Retry-After` honoured | On 429/503, backs off by the server's own hint |
| Replication checkpoint | Highest `ModificationTimestamp` per `OriginatingSystemName`, so pulls are deltas, not a rolling 7-day window |
| `$select` on every query | 5–10× smaller responses, straight off the bandwidth quota |
| Per-call log + `/api/admin/mls-usage` | It can see its own burn **before MLS Grid does** |
| Truncation is an error | A partial index cannot be reported as a verified check, so nobody is tempted to raise the page cap |

**The two worth stealing for this site, in order:**

1. **A per-call log and a usage view.** This site has *no* visibility of its own
   consumption — which is the single reason §2.6 ended in a guess and this
   document had to be written at all. Expired-Luxury can answer "what did we
   spend in the last hour" from its own database. That is the highest-value thing
   missing here.
2. **A budget guard that fails closed.** Cooldowns react to a 429 that has already
   happened; a budget refuses the request that would cause one. Their QUOTA-2
   note — that an unreadable log must block rather than report zero — is a
   genuinely good piece of reasoning and the kind of thing that is only ever
   learned the hard way.

A kill switch and an rps ceiling that env vars can only lower are both cheap and
both worth having.

**But it has two problems of its own, and one is the same bug this site just
fixed:**

- **It caches Media URLs for a WEEK.** `getPropertyMedia()` sets
  `MLS_MEDIA_MAX_AGE_HOURS = 24 * 7`, reasoning that "off-market photos don't
  change". The photos don't; the URLs do. MLS Grid Media URLs are single-use and
  expire in **one hour**, so a URL cached for a week is dead within about an hour
  of being stored — the same Finding 1 as this site had, at 168 hours instead of
  40 minutes.
- **It renders raw MLS Grid URLs straight into the browser.**
  `DetailsDrawer.tsx` and `UploadSection.tsx` both do `<img src={m.MediaURL}>`.
  That is hot-linking, which MLS Grid prohibits in bold — *"DO NOT use these URLs
  on your website or in your application"* — and it is also why those photos can
  only ever work for the first viewer within the first hour. It is an internal
  admin tool, so the audience is small, but MLS Grid runs quarterly compliance
  audits of "the websites where listings are displayed", and this is the kind of
  thing they are looking for.

It does not download media bytes at all, so it spends none of the megabyte
budget on photos — which is why its quota trouble was always request-count, never
bandwidth.

### The three apps side by side

| | This site (now) | Listing-Engine | Expired-Luxury |
|---|---|---|---|
| Single-use URLs respected | **yes** — marked spent on use | yes — used immediately | **no** — cached 7 days |
| Raw MLS URLs in a browser | never | never (Cloudinary) | **yes** |
| Media stored permanently | yes (Blobs, on first view) | yes (Cloudinary, on import) | n/a — doesn't download |
| `OriginatingSystemName` | **yes** (fixed) | **no** | yes, everywhere |
| `User-Agent` = token | **yes** (fixed) | **no** — browser UA | n/a — no media downloads |
| Rate discipline | per-host cooldowns in Blobs | one 1500ms process gate | token bucket + hard ceiling + quota budget + breaker + kill switch |
| Can see its own usage | **no** | no | **yes** |

**What this settles about buying more quota.** Both documented incidents on this
account have a named cause and neither is legitimate demand: the 2026-08-01
suspension was hand-run scripts bypassing the limiter, and the 4-rps warning was
Listing-Engine's pre-fix code. Buying a second subscription to cover that would
be paying rent on a defect. Fix the defects, watch the usage tab, then decide.

## 7d. Instrumentation, built 2026-08-18

The §7c conclusion was that the biggest thing this site lacked was any view of its
own consumption. That is now built: `netlify/functions/lib/_mls-usage.js`, plus
`/.netlify/functions/mls-usage` and a row on `/site-health`. It is Expired-Luxury's
guard rebuilt for a runtime with no shared process memory.

**What it does**

| Piece | Behaviour |
|---|---|
| **Per-call log** | Every MLS Grid request from this site — API *and* media — records kind, status and bytes into an hourly bucket in Blobs. The api-vs-media split is the number nobody could see, and the one that mattered: the 429s were always on media while every fix aimed at the API. |
| **Budget guard** | Checked **before** each request, not after a 429. Refuses at **50%** of the real limits. A cooldown reacts to a limit already hit; a budget refuses the request that would hit it. |
| **Fails closed** | If the log can't be read, it blocks and says so. Expired-Luxury's QUOTA-2 lesson: "zero usage" is the most permissive answer an unreadable log can give, so reporting it turns the guard into a silent no-op. Safe here because `listing-photo.js` serves its own stored copy *before* the guard runs — a block costs a placeholder on a photo nobody has loaded, never a page of holes. |
| **Ceilings tune down only** | `MLS_QUOTA_*` env vars can lower a limit but never raise it past what MLS Grid enforces. Straight from Expired-Luxury's `MLS_GRID_RPS_CEILING`, for the reason its comment gives: a well-meant "make it faster" must not be able to cost days of downtime. |
| **Kill switch** | `MLS_DISABLED=true` stops every MLS Grid path on the site without touching credentials. |
| **Retention** | 48 hours of hourly buckets, pruned by the sync job. |

**The limits it encodes are the enforced ones** (§1) — 7,200 requests/hour,
**3,072 MB/hour**, 40,000/day, **40 GB/day** — not the published figures. The
public docs' 4 GB/hour would have been 33% too generous on the cap that photo
traffic actually spends.

**Where to look:**

- `/.netlify/functions/mls-usage` — this hour and the last 24, API vs media,
  errors, percentage of budget, in a sentence at the top. Add `?hours=1` for the
  hour-by-hour breakdown.
- `/site-health` — one row, "MLS Grid usage inside our own budget".
- `app.mlsgrid.com/subs/view/usage/` — the **account** total across all three
  apps. Comparing that against this site's own number is how consumption gets
  attributed while one token serves three applications — which is half of what the
  support email in §6 is asking for, answerable now without waiting for a reply.

**A limitation, stated rather than discovered later:** Netlify Functions are many
separate containers and Blobs has no atomic increment, so two invocations writing
the same hour bucket in the same instant can lose one count. The response is to
budget at half the real limit, which absorbs that error many times over. An
approximate number that exists beats an exact number that does not.

`tests/test-mlsusage.js` covers it: the right limits, ceilings that only tune down,
counting and the api/media split, failing closed, the kill switch, pruning, and
that the guard runs *before* the request in all three call paths. 40 suites pass.

## 7e. Further repairs, 2026-08-18

Beyond the instrumentation in §7d:

| Repair | Why it mattered |
|---|---|
| **Oversize photos re-hosted instead of going grey** | A photo over ~4.4 MB could never be returned by `listing-photo.js` — Netlify caps a function response at 6 MB and base64 inflates by a third. That ceiling is the platform's, not MLS Grid's, so those listings were **permanently** grey and immune to every cache, cooldown and quota fix. Land listings with full-res aerials and scanned plats hit it routinely. They now go to Cloudinary using the bytes already in hand (no second download) and are served as a cached redirect. |
| **Stale photos on a changed listing** | The photo store is keyed by index; MLS Grid keys media by MediaKey. A listing that gains, loses or re-orders photos would serve whatever was stored at that index forever — at worst a photo the seller removed. The sync now drops the stored copies when a listing's photo count changes. Caveat written into the code: a same-count *replacement* needs `PhotosChangeTimestamp` in `$select`, which this feed has a history of 400ing, so it's flagged for isolated probing rather than risked in the crawl. |
| **One constant for "how many photos"** | `listing-page.js` rendered 12, the cache stored 12, and they agreed only by comment. Every photo rendered beyond what is stored is a live MLS Grid download per view, forever. Both now derive from `PHOTO_CACHE_MAX_INDEX` in `lib/_media.js`. |
| **A warm page now costs nothing** | The pre-warm resolved URLs even for listings whose cover this site already holds — a request spent on a fetch that never happens, once per page render. It now skips them, so a page of already-browsed listings makes **zero** MLS Grid requests. That is the steady state the whole photo store exists to reach. |
| **Cloudinary downloads are measured** | The sync's Cloudinary path downloaded from MLS Grid without recording it, so §7d's usage endpoint could not see one of the site's real consumers. |
| **Dead code removed** | `uploadDataUri()` carried an unreachable duplicate of the delivery-URL block after its own `return`, reading a `result` variable never declared in that scope. Harmless only because it could not run — a `ReferenceError` waiting for whoever tidied the return above it. |

## 7f. Self-review findings, and what was deliberately left alone

Reviewing the day's own diff turned up three faults in it. Recorded because a
repair pass that only reports its successes is not a repair pass.

- **The quota guard was spending the sync's time budget on measuring the sync.**
  The per-call check asked for the full 24-hour picture — up to 24 blob reads,
  ~168 of them inside an 11-second budget for a job that makes seven requests.
  Per call is now the one-hour read; the full picture is checked once at the top,
  and it primes the memo so later checks are free.
- **The Cloudinary SDK was being imported on the hottest path.** `listing-photo.js`
  runs for every photo on every page; requiring `_cloudinary.js` at module load
  pulled the SDK into every cold start to serve the rare oversize branch. Lazy now.
- **The byte-measurement helper assumed `res.headers` exists.** True of the
  platform, false of every test double in the repo — so the first wiring made the
  whole suite look like an MLS Grid outage. It tolerates a headerless response now,
  and that tolerance is tested by name.

**Deliberately not done, with reasons:**

| Not done | Why |
|---|---|
| **The catalogue cover backfill** (Option B, §4) | Still the right next step, and still gated on the support reply about pacing (§6 q4). Running ~15,000 paced downloads from an account with a suspension on its record, without telling them first, is the one move on this list that could cost days. |
| **Retiring the refresh sweep** | Its photo-freshness purpose is now genuinely dead — nothing serves stored MLS URLs, and photos are permanently stored and invalidated on change. What remains is status freshness, which the incremental replication checkpoint arguably covers already. That would reclaim ~240 calls/day, but it is a behaviour change I cannot verify from here. **Let the data decide:** check `/.netlify/functions/mls-usage` after a day. If sync API calls dominate the daily total, cut the sweep. |
| **Raw-byte blob storage** (~33% saving over base64) | The proven path is worth more than the saving; storage is the cheap axis. |
| **`PhotosChangeTimestamp` in `$select`** | The correct signal for a same-count photo replacement, but this feed has a documented history of 400ing standard RESO field names, and a 400 in the crawl's `$select` breaks the whole sync. Probe it in isolation, the way `discoverHerOfficeMlsId()` does. |

## 7g. The loaded gun that is still on the table

The 2026-08-01 suspension was not caused by any app's normal traffic. From
Expired-Luxury's own runbook:

> *"Cause of the 2026-08-01 suspension: ad-hoc diagnostic scripts run by hand
> against the live API from Render Shell, with no rate limiting — they bypassed
> the app's limiter entirely. Never probe the live API with a bare `node -e` or
> `curl` loop."*

**That script still exists, and its own header tells you to run it.**
`expired-luxury/scripts/proveRelistMismatch.js` has its own `mlsGet()` built on
bare `fetch` — no token bucket, no quota guard, no `Retry-After`, none of the
protection `lib/mlsClient.ts` provides — and it loops:

```js
while (url && pages < 50) {
  const data = await mlsGet(url, token)   // no delay of any kind
  url = data['@odata.nextLink']
  pages++
}
```

Up to **50 back-to-back requests with no pacing**, per status tier, per MLS —
and `RELIST_PROBE_SYSTEMS` multiplies it. Unpaced over a fast link that is
comfortably 10–25 rps against a 4 rps instantaneous ceiling and a 2 rps
sustained average. It is the exact shape of *"your hourly 6.0 requests per second
exceeded the 2 requests per second limit"*.

Its documented usage is *"LIVE MODE (what you should run — needs MLS
credentials): Render Shell, or your Mac with .env.local values exported"*.

**Nothing in this repo's work protects against it.** The guard built today
(§7d) only covers this website. A hand-run script on another machine reaches MLS
Grid directly, and a suspension there takes the token down for all three apps —
including every photo on the public site.

Not touched (Expired-Luxury is read-only in this work), but it belongs at the top
of anyone's list: that script needs the same rate limiter as everything else, or
a refusal to run without one. Until then, **the single most important operational
rule is the one its own runbook already wrote down: never probe the live API by
hand.**

## 7h. The account's real usage, read 2026-08-18 — the quota question is closed

From MLS Grid's own Usage tab, for the whole account (all three apps together):

| Window | Used | Limit | % of limit |
|---|---|---|---|
| Requests, last hour | **32** | 7,200 | **0.4%** |
| Download, last hour | **3.83 MB** | 3,072 MB | **0.12%** |
| Requests, last 24h | **808** | 40,000 | **2%** |
| Download, last 24h | **622.7 MB** | 40 GB | **1.5%** |
| Sustained rate, 24h avg | **1.4 rps** | 2 rps | 70% |
| Peak instantaneous | **2–3 rps** | 4 rps | — |

The busiest single hour in the log was 207 requests and 203 MB — **2.9% of the
hourly request allowance and 6.6% of the hourly bandwidth**.

**There is no capacity problem, and there never was.** A second subscription would
have bought headroom that is already 98% unused. That question is now closed on
evidence rather than inference, and every earlier recommendation in this document
that hedged on it should be read as settled: **do not buy more quota.**

### What this DOES explain

**Attribution, finally.** This site's own log recorded 7 requests in 24 hours
against the account's 808. **The website is under 1% of the account's usage.**
Listing-Engine and Expired-Luxury are essentially all of it — visible as the two
bulk hours at 04:00 and 05:00 (387 requests, 387 MB between them) and another at
14:00 the previous day (145 MB), which are photo imports and the daily sweep.

**The 429s are a RATE collision, not a volume shortage.** The account averages
1.4 rps against a 2 rps sustained ceiling — 70% of the rate limit while using 2%
of the daily volume. So the binding constraint is requests *per second*, exactly
as MLS Grid's documentation says, and it binds while the account is nearly empty
on every other axis. When two apps fire at the same instant, the account brushes
the ceiling and somebody gets a 429. That is why the health probe took one at
14:07 while this site had made five requests all hour.

**Which means the remedy is coordination, not capacity.** Nothing bought from MLS
Grid fixes a per-second collision between three of your own applications. What
fixes it is exactly what this branch has been doing: never fetch a photo twice,
never fire a burst, and let a warm page cost nothing. Every one of those reduces
the chance of being the app that collides.

### The one number worth watching

**1.4 rps average against a 2 rps sustained limit is 70%, and that is the only
figure on the page that is not comfortable.** It is also the exact metric the
2026-08-01 suspension fired on ("your hourly 6.0 requests per second exceeded the
2 requests per second limit"). Volume has enormous headroom; rate does not. If
anything is ever going to suspend this account again, it is that column — which
makes Listing-Engine's unpaced diagnostic script (§7g) the single largest
remaining risk to every photo on this website.

## 8. Open items

External:

- [x] ~~Read the Usage tab and record what the three apps actually consume~~ —
      done 2026-08-18, see §7h. Account uses 2% of its daily allowance; this site
      is under 1% of the account. Quota question closed.
- [x] ~~Per-call log + usage view for this site~~ — built 2026-08-18, see §7d
- [ ] Expired-Luxury (read only, not touched): Media URL cache is 7 days against a
      1-hour single-use URL, and it renders raw MLS Grid URLs in `<img src>`. Both
      are rules this site fixed today. Worth its own session.
- [ ] Listing-Engine (read only, not touched): browser User-Agent where the token
      is required, and no `OriginatingSystemName` (§7b).
- [ ] Support: CDN migration before 8 September 2026
- [ ] Support: per-token vs per-account budgets; cost of a second IDX subscription
- [ ] IRES: setup fee and approval for an additional feed
- [ ] Then: decide on splitting, and update the §1.3 blast-radius note
