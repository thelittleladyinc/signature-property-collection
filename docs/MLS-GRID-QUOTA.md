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

## 1. The limits — and the usage numbers you can read yourself

| Limit | Value |
|---|---|
| Request rate | **2 requests/second**, at all times |
| Hourly requests | **7,200 per hour** |
| Hourly volume | **4 GB downloaded per hour** |
| Daily requests | **40,000 per 24 hours** |

Media downloads spend the same budget as API calls, and the binding constraint is
the **2 rps**, not the totals — a detail page's 11 parallel image requests
already breaches it from a single visitor, in an hour that may otherwise be
almost empty.

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

**Option B — pre-host every cover in the catalogue.** 15,471 covers × ~300 KB ≈
**4.6 GB**, ~15,471 downloads. At MLS Grid's own 2 rps that is ~2.2 hours of wall
clock; a `-background` Netlify function gets 15 minutes per run (~1,800 photos),
so the catalogue is ~9 runs — a couple of nights. The refresh sweep's machinery
(throttled, resumable, time-budgeted) is what this needs; repoint it rather than
writing a new job.

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

Shorter than it would have been, because the Usage tab answers two of the old
questions. To `support@mlsgrid.com`, copying the IRES data-feed contact.

> **Subject: Media CDN migration + per-application IDX subscriptions — The Bold Collective Homes IDX Subscription (IRES)**
>
> Hello,
>
> I'm an IRES MLS subscriber in Northern Colorado with one IDX subscription
> ("The Bold Collective Homes IDX Subscription"). Its token is currently used by
> three of my own applications: my public IDX website
> (signaturepropertycollection.com) and two internal tools. Four questions:
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
>    2 rps — is there a rate or a window you'd prefer, so it doesn't read as
>    concerning behaviour on my token?
>
> Thank you,
> Christine Gwinnup
> [licence #, IRES subscriber ID, MLS Grid subscription ID]

Question 4 is deliberate: telling them the backfill is coming, before running it,
turns tens of thousands of paced downloads from a recently-throttled account into
an agreed-in-advance operation.

## 7. Open items

Code:

- [ ] Finding 3 — `looksPresigned()` misses path-signed `media.mlsgrid.com` URLs
- [ ] Finding 4 — `User-Agent: token` missing on the `anon` fetch branch
- [ ] Finding 5 — media resolve: add `OriginatingSystemName eq 'ires'`, swap
      `or`-chains for `in`
- [ ] Finding 1 — stop caching single-use Media URLs (`URL_CACHE_TTL_MS`)
- [ ] Finding 2 — cache the displayed photo set, keyed by MediaKey, not index 0 only
- [ ] Finding 6 — chunk or clamp the 24-vs-12 pre-warm gap
- [ ] Finding 7 — repoint the refresh sweep; consider raw-byte storage; Cloudinary
      for oversize photos

External:

- [ ] Read the Usage tab and record what the three apps actually consume
- [ ] Support: CDN migration before 8 September 2026
- [ ] Support: per-token vs per-account budgets; cost of a second IDX subscription
- [ ] IRES: setup fee and approval for an additional feed
- [ ] Then: decide on splitting, and update the §1.3 blast-radius note
