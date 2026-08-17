# MLS Grid quota: what the limits are, whether to split the key, and what to ask

Written 2026-08-17. Companion to `NEXT-SESSION.md` §2.6, which diagnosed the
media 429s and fixed everything fixable in code. This document covers the part
that is not code: the shared account quota.

Sources are public MLS Grid / IRES documentation and MLS Grid's own wording as
quoted in `netlify/functions/lib/_cloudinary.js`. Anything that could only come
from Christine's own account (her actual limits, her actual usage, her fees) is
marked **ASK** — it is a question for support, not something research can answer.

---

## 1. The published limits

MLS Grid applies the same published limits to all data consumers:

| Limit | Value |
|---|---|
| Request rate | **2 requests/second**, at all times |
| Hourly requests | **7,200 per hour** |
| Daily requests | **40,000 per 24 hours** |
| Hourly volume | **4 GB downloaded per hour** |

Three things about these numbers matter more than the numbers themselves.

**Media downloads spend the same budget as API calls.** `media.mlsgrid.com` is
not a separate allowance. Every photo byte counts against the same 4 GB/hour,
and every photo request counts against the same request ceiling. This is why the
site's API footprint being tiny (§2.6 measured ~7 calls per sync run) never
protected the photos: a 12-card page is 12 media requests, and three apps doing
that concurrently is where the 2 rps ceiling actually bites. The ceiling is
requests-per-second first and totals second — a burst of 12 simultaneous fetches
is already 6× the sustained rate, no matter how quiet the hour was.

**Enforcement is described at the token level.** MLS Grid's language is that
*the access token* is suspended, that a shut-off notice goes to the account's
primary contact, and that permissions reinstate automatically once usage falls
back inside the limits. Whether two tokens on one vendor account get two
separate budgets or share one is the single most valuable unknown here, and it
is **ASK** #1 below. Today it is moot: all three apps share one token, so the
distinction is invisible — one token, one budget, three consumers.

**Higher limits are not a published tier.** There is no rate-limit price list.
MLS Grid's documented route is to contact support in advance for guidance if you
need to exceed the standard limits. So "buy a bigger tier" is not a thing you
can order; it is a conversation, and the answer may simply be no.

## 2. The media rules change the shape of the right answer

MLS Grid's own documentation (quoted at the top of
`netlify/functions/lib/_cloudinary.js`) says Media URLs are **signed, single-use
and expire in about an hour**, that all media downloads must send the OAuth
access token as the `User-Agent` header, and — in bold, twice — **"DO NOT use
these URLs on your website or in your application."** Hot-linking is prohibited;
displayed media must be self-hosted.

Read that next to the current architecture and the conclusion is uncomfortable
but useful: **fetching a photo from MLS Grid at the moment a visitor asks for it
is not the intended use of the media host at all.** The intended pattern is
download-once, server-side, re-host, serve from your own storage forever. The
site already does exactly that for Christine's 11 listings via Cloudinary, and
now caches any cover photo a visitor loads (commit 4eabf05).

That reframes the whole question. The remaining exposure — the first-ever view
of a listing nobody has loaded — is not really a quota shortage. It is the last
place the site still uses MLS Grid's media host the way its docs tell you not
to. More quota would paper over it. Pre-hosting would remove it.

## 3. Should the three apps get separate credentials?

**Permitted? Almost certainly yes, and plausibly expected.** MLS Grid's model is
account → subscription → licensee → token, with one Master Data License
Agreement covering many feeds and many MLSs. Multiple subscriptions under one
signed agreement is a normal shape, not a workaround. IRES requires that the
data licence be completed through The MLS Grid and that at least one IRES
subscribing broker requests the feed — which Christine is, for all three apps.
Nothing found says one licensee may hold only one token.

**Worth it? Yes, but not primarily for quota.** The honest case for splitting is
not "three times the headroom" — it may well not be, if the budget turns out to
be per account. The case is:

1. **Attribution.** Right now nobody can tell which of the three apps burned the
   quota. That is the actual reason §2.6 ended in a guess.
2. **Blast radius.** One token means one suspension takes down the public
   website, Listing-Engine and Expired-Luxury at the same time. §1.3 already
   flags this.
3. **Cleanliness of the licence.** Three products with three purposes sitting on
   one token is the kind of thing that is fine until an audit asks about it.

**Cost? ASK — but the shape is knowable.** IRES publishes one-time setup fees
around **$150 for IDX** (VOW and AVM are higher, $300 each), with recurring fees
in their fee-structure table and all billing handled inside The Grid. Whether a
second and third subscription each trigger a fresh setup fee, or whether
additional feeds under an existing licence are free, is **ASK** #4. Budget for
the possibility of a couple of hundred dollars up front per extra feed plus
whatever the recurring line is; do not assume it is free, and do not assume it
is expensive.

## 4. The cheaper option, and why it is also the better one

Re-hosting the whole catalogue's **cover photos** — not just Christine's — is
cheaper than any credential change, needs no permission from anybody, and is
already 90% built.

**Volume.** Cover-only is one image per listing. Across the nine operating
counties at Active / Active Under Contract / Pending, expect low tens of
thousands at the outside. At roughly 250 KB per cover:

- 10,000 covers ≈ **2.5 GB** stored, ≈ 10,000 media requests
- Filling it at MLS Grid's own pace (2 rps) is **~1.4 hours of wall clock**, and
  ~2.5 GB — inside a single hour's 4 GB ceiling even if done in one sitting.
  Spread over nightly batches of ~1,500 it is ~13 minutes a night and invisible.

**Cloudinary cost.** The free tier is 25 credits/month, where 1 credit = 1 GB
storage *or* 1 GB delivery *or* 1,000 transformations. Cover-only lands around
2–3 credits of storage plus real delivery traffic — comfortably inside free for
a solo agent's traffic, with Plus ($99/mo, 225 credits) as the ceiling if the
site ever gets big. Cloudinary's CDN also serves the many-card pages better than
routing every image through a Netlify Function.

**What NOT to do: full galleries for the whole catalogue.** ~30 photos per
listing × 10,000 listings ≈ 300,000 images ≈ 75 GB. That is straight out of the
free tier and into a real monthly bill, for photos nobody will ever look at.
Galleries should stay exactly as they are: cached permanently the first time
someone opens that listing's detail page, plus Christine's own 11 up front.

**So the split is:** every cover pre-hosted, every gallery on demand. That is
the cheapest option on this list *and* the one most in line with MLS Grid's
media rules.

## 5. Recommended order

1. **Pre-warm every cover photo in the catalogue into Cloudinary**, paced inside
   2 rps, in nightly batches. This is the actual fix for "first view of a listing
   nobody has loaded." It costs nothing, needs no approval, and turns the media
   host from a request-time dependency into a background one. The mechanism
   already exists in `_cloudinary.js`; what changes is which listings are
   eligible and that a paced background job walks the catalogue.
2. **Send the email in §6.** Ask before deciding — the answers change whether
   step 3 is worth doing at all.
3. **Then split the credentials**, for attribution and blast radius, once support
   has confirmed whether budgets are per token or per account and what it costs.

Doing 1 first means that even if MLS Grid says "one budget per account, no
increases, extra feeds cost money" — the worst case — the grey cards are gone
anyway.

## 6. The email to MLS Grid support

To `support@mlsgrid.com`, copying the IRES data-feed contact. Short, numbered,
each question answerable in one line, and no room for "reduce your usage" as a
complete reply.

> **Subject: Rate limits and per-application subscriptions — [account name], IRES feed**
>
> Hello,
>
> I'm an IRES MLS subscriber in Northern Colorado. I have one MLS Grid data
> subscription, and its token is currently used by three of my own applications:
> my public IDX website (signaturepropertycollection.com), and two internal
> tools. I'm getting HTTP 429s from media.mlsgrid.com on pages that display
> several listings at once, and I want to fix it properly rather than keep
> tuning around it.
>
> Five questions:
>
> 1. **What are the exact limits on my account today** — requests/second, per
>    hour, per 24 hours, and GB/hour — and do the published figures (2 rps /
>    7,200 hr / 40,000 day / 4 GB hr) apply to my subscription as-is or has
>    anything been adjusted?
> 2. **Are those limits enforced per access token, or per vendor account?** If I
>    hold two subscriptions with two tokens, do they get separate budgets or
>    share one?
> 3. **Can you send me my recent usage** — say the last 14 days, broken down by
>    hour, and ideally separating API calls from media.mlsgrid.com downloads? I
>    currently have no way to see which of my applications is consuming what, and
>    that is the main thing blocking me.
> 4. **May I hold a separate subscription and token for each application**, and
>    is that in fact what you'd prefer? If so, what does each additional
>    subscription cost — MLS Grid side and IRES side — and does each need
>    separate IRES approval?
> 5. **Do media downloads count against the same request and volume budget as API
>    calls?** I'm planning to pre-download and self-host cover photos for the
>    listings I display, once each, rather than fetching at page-load time, which
>    I understand is the intended pattern. I'd like to confirm both that this is
>    correct under my licence and at what pace you'd like me to run that backfill
>    so it doesn't look like abuse.
>
> Happy to be told my usage pattern is the problem — I'd just like to see the
> numbers so I can fix the right thing.
>
> Thank you,
> Christine Gwinnup
> [licence #, IRES subscriber ID, MLS Grid account/subscription ID]

**Why question 5 is in there.** Telling them the backfill is coming, before
running it, converts the single riskiest thing on the plan — tens of thousands
of paced media downloads from an account that has recently been throttled — from
a red flag into an agreed-in-advance operation. It also gets the licence
question answered in writing.

## 7. Open items to record when the answers come back

- [ ] Actual per-account limits (vs published)
- [ ] Per-token or per-account enforcement
- [ ] Usage breakdown received — which app is the heavy one
- [ ] Additional subscriptions: permitted? cost? IRES approval needed?
- [ ] Backfill pace blessed by support
- [ ] Then: decide on splitting credentials, and update §1.3 blast-radius note
