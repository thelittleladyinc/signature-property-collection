// A real, shareable, indexable page for one listing: /listing/<MLS number>
//
// 2026-08-15 (Christine, on the biggest remaining gap: "is this something we
// can do?" -- "No individual listing pages. Every listing lives in a card and a
// modal, so there's no link a buyer can text a spouse, and Google can't index a
// single address").
//
// Why a function instead of 15,000 static files: the inventory changes every 15
// minutes and a listing that goes off-market has to stop being served. Static
// pages would be stale within the hour and would leave sold homes published,
// which is exactly the thing this site's MLS handling is careful about
// everywhere else (see REPLICATED_STATUSES in _mls-shared.js).
//
// The page chrome is NOT written here. build.py generates
// lib/_listing-page-shell.html from the same head()/header_html()/footer_html()
// the other 141 pages use, and this function fills in the slots. A second
// hand-written copy of the site design in a JS file would drift the first time
// the header changed -- same reason the sold-homes pin data and the map's county
// data are generated rather than duplicated.
//
// Routing: netlify.toml rewrites /listing/:id to this function, so the public
// URL is clean (/listing/IRE1234567) and canonical.
//
// Compliance, deliberately conservative:
//   - Only Active listings render. Anything under contract, pending, sold or
//     missing returns 404 with a real "no longer available" page, so a texted
//     link can never become a public record of a sold home.
//   - The full IDX Rule 26 disclaimer, source attribution, and listing
//     brokerage/agent line appear on every page, same text as the search pages.
//   - Photos come through listing-photo.js, never as raw signed MLS Grid URLs.
//   - mlgCanView is re-checked here, not assumed from storage.
const { getStore } = require("@netlify/blobs");
const fs = require("fs");
const path = require("path");
const {
  LISTINGS_KEY, SYNC_STATE_KEY, getBlobStore, AGENT_SURNAME,
} = require("./lib/_mls-shared");
// How many photos this page may render is not a design choice on its own: every
// photo shown beyond what listing-photo.js stores is re-downloaded from MLS Grid
// on every view that misses a CDN edge, forever. The two numbers have to be the
// same number, so they are literally the same number. See lib/_media.js.
const { PHOTO_CACHE_MAX_INDEX } = require("./lib/_media");
const GALLERY_PHOTOS = PHOTO_CACHE_MAX_INDEX + 1;

const SHELL_PATH = path.join(__dirname, "lib", "_listing-page-shell.html");
const SITE_DOMAIN = "https://signaturepropertycollection.com";
const AGENT_NAME = "Christine Gwinnup";
const AGENT_PHONE = "303-709-4262";

// Cached across warm invocations -- it's a static 12KB file.
//
// 2026-08-17: this threw ENOENT in production and Netlify answered every
// /listing/<id> request with its red "This function has crashed" page, stack
// trace and all. Two things were wrong and only one of them was the missing file.
//
// The missing file is fixed in netlify.toml (included_files -- the bundler traces
// require(), and this is the one lib/ file read with fs). But a public endpoint
// that a buyer reaches from a text message must not be one readFileSync away from
// showing a stack trace to a stranger. So the read is now guarded: if the shell is
// somehow absent, the page degrades to a plain, self-contained document that still
// shows the listing and still links home, and the failure is logged for us instead
// of rendered for them.
const FALLBACK_SHELL = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>{{TITLE}}</title><meta name="description" content="{{DESCRIPTION}}">' +
  '<link rel="canonical" href="{{CANONICAL}}">{{SCHEMA}}' +
  '<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:32px;' +
  'line-height:1.6;color:#141415;background:#f7f5f2}a{color:#B86F7A}' +
  'main{max-width:70ch;margin:0 auto}</style></head><body><main>{{BODY}}' +
  '<p style="margin-top:40px"><a href="/">' + AGENT_NAME + ' — Signature Property Collection</a></p>' +
  '</main></body></html>';

// 2026-08-19: this one function serves BOTH brands. thelittleladysellshomes.com
// proxies /listing/:id here with ?brand=tllsh (see that repo's netlify.toml),
// and gets its own header/footer/palette instead of Signature's -- same
// listing data, same canonical (Signature stays the canonical home of listing
// pages so the two domains never compete in search). The TLLSH shell is a
// checked-in copy of that repo's generated lib/_listing-page-shell.html;
// refresh it after a TLLSH redesign by copying the regenerated file over.
const SHELL_PATH_TLLSH = path.join(__dirname, "lib", "_listing-page-shell-tllsh.html");

const _shells = {};
function shell(brand) {
  const key = brand === "tllsh" ? "tllsh" : "default";
  if (_shells[key] == null) {
    const p = key === "tllsh" ? SHELL_PATH_TLLSH : SHELL_PATH;
    try {
      _shells[key] = fs.readFileSync(p, "utf8");
    } catch (err) {
      console.error(
        `listing-page: shell missing at ${p} (${err && err.code}) — falling back. ` +
        "Check included_files in netlify.toml; the bundler cannot trace an " +
        "fs.readFileSync, so these files have to be declared explicitly."
      );
      // A missing brand shell degrades to the Signature shell (worse branding,
      // working page); a missing Signature shell degrades to the plain document.
      _shells[key] = key === "tllsh" ? shell() : FALLBACK_SHELL;
    }
  }
  return _shells[key];
}

// The brand owns more than the shell: the <title> a visitor sees in the tab
// (and in a texted link's preview) must match the site they're browsing. The
// tllsh proxy always sends brand=tllsh in the query, so the CDN caches the
// two brands' renders separately without any Vary gymnastics.
function brandName(brand) {
  return brand === "tllsh" ? "The Little Lady Sells Homes" : "Signature Property Collection";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function money(n) {
  if (n == null) return "Price available on request";
  return "$" + Number(n).toLocaleString("en-US");
}

function photoUrl(listing, i) {
  const rehosted = Array.isArray(listing.cloudinaryPhotos) ? listing.cloudinaryPhotos[i] : null;
  if (typeof rehosted === "string" && rehosted.indexOf("res.cloudinary.com") !== -1) return rehosted;
  if (i === 0 && typeof listing.cloudinaryPhoto === "string" &&
      listing.cloudinaryPhoto.indexOf("res.cloudinary.com") !== -1) {
    return listing.cloudinaryPhoto;
  }
  return `/.netlify/functions/listing-photo?id=${encodeURIComponent(listing.listingId)}&i=${i}`;
}

function photoCount(listing) {
  if (Array.isArray(listing.photos) && listing.photos.length) return listing.photos.length;
  if (typeof listing.photoCount === "number") return listing.photoCount;
  return listing.photo ? 1 : 0;
}

function isHers(listing) {
  const a = (listing.agentName || "").toLowerCase();
  const c = (listing.coAgentName || "").toLowerCase();
  return a.includes(AGENT_SURNAME) || c.includes(AGENT_SURNAME);
}

function render(shellHtml, fields) {
  let out = shellHtml;
  for (const [key, value] of Object.entries(fields)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

// Rule 26 disclaimer -- same content as _mls_disclaimer_html() in build.py.
// Duplicated in wording only because this page is assembled server-side; if the
// legal text ever changes, change it in both places (build.py is the original).
function disclaimerHtml(fetchedAt) {
  return `<div class="mls-disclaimer">
      <p><span class="mls-source-badge">Source: IRES MLS</span> &mdash; Listings courtesy of IRES MLS
      as distributed by MLS Grid. Based on information submitted to MLS Grid as of
      ${esc(fetchedAt || "page load")}. All data is obtained from various sources and may not have
      been verified by broker or MLS Grid. Supplied open house information is subject to change
      without notice. All information should be independently reviewed and verified for accuracy.
      Properties may or may not be listed by the office/agent presenting the information. Some IDX
      listings have been excluded from this website. Offer of compensation is made only to
      participants of the MLS where the listing is filed.</p>
    </div>`;
}

function notFoundBody(reason) {
  return `<section class="hero" style="padding:90px 0 60px">
  <div class="wrap">
    <span class="eyebrow" style="color:var(--dusty-rose)">Listing Unavailable</span>
    <h1>This Listing Isn&rsquo;t Available</h1>
    <p class="lede">${esc(reason)}</p>
    <div class="btn-row">
      <a class="btn btn-dark" href="/search-homes.html">Search Active Listings</a>
      <a class="btn btn-outline" style="border-color:#141415;color:#141415" href="/contact.html">Ask ${esc(AGENT_NAME.split(" ")[0])} About It</a>
    </div>
  </div>
</section>`;
}

function listingBody(l, fetchedAt) {
  const count = photoCount(l);
  const addressLine = [l.address, l.city, l.state, l.zip].filter(Boolean).join(", ");
  const specs = [
    l.beds ? `${l.beds} Bedrooms` : null,
    l.baths ? `${l.baths} Bathrooms` : null,
    l.sqft ? `${Number(l.sqft).toLocaleString()} Sq Ft` : null,
    l.propertyType || null,
    l.subdivision ? `${l.subdivision} neighborhood` : null,
  ].filter(Boolean);

  const gallery = count > 1
    ? `<div class="listing-detail-thumbs">` +
      // 2026-08-18: MLS Grid warned twice in one day about request-per-second
      // bursts. This gallery was one of the two sources: up to 12 <img> tags
      // on one HTTP/2 connection all fire at once, and every not-yet-stored
      // photo is a live MLS Grid fetch. Photo 0 keeps a real src (it is the
      // page's main image); the rest carry data-src and are drained two at a
      // time by the pacer in the script block below.
      Array.from({ length: Math.min(count, GALLERY_PHOTOS) }, (_, i) =>
        i === 0
          ? `<img src="${esc(photoUrl(l, i))}" alt="${esc(addressLine)} &mdash; photo ${i + 1}">`
          : `<img data-src="${esc(photoUrl(l, i))}" alt="${esc(addressLine)} &mdash; photo ${i + 1}" style="background:#eee">`
      ).join("") +
      (count > GALLERY_PHOTOS ? `<p class="fs-advanced-note">Showing ${GALLERY_PHOTOS} of ${count} photos &mdash;
       <a href="/contact.html" style="text-decoration:underline">ask for the full set</a>.</p>` : "") +
      `</div>`
    : "";

  // Christine's own listings get her name and number on the page; everyone
  // else's carry the listing agent's name, which is the attribution IDX
  // requires -- her CTA is still there, phrased as representation rather than as
  // if she listed it.
  const hers = isHers(l);
  const agentBlock = hers
    ? `<div class="card">
        <h3>Listed By ${esc(AGENT_NAME)}</h3>
        <p>This is one of ${esc(AGENT_NAME)}&rsquo;s own listings. Call
        <a href="tel:${esc(AGENT_PHONE.replace(/[^0-9]/g, ""))}" style="text-decoration:underline">${esc(AGENT_PHONE)}</a>
        or send a message and you&rsquo;ll hear back from her directly.</p>
        <a class="cta" href="/contact.html">Request A Private Showing &rarr;</a>
      </div>`
    : `<div class="card">
        <h3>Want To See This Home?</h3>
        <p>${esc(AGENT_NAME)} can show you this property and any other active listing in
        Northern Colorado, and will tell you honestly how it compares to the rest of what&rsquo;s
        available at this price.</p>
        <a class="cta" href="/contact.html">Schedule A Showing &rarr;</a>
      </div>`;

  const listedBy = l.agentName
    ? `<p class="fs-advanced-note">Listing courtesy of ${esc(l.agentName)}${l.officeName ? `, ${esc(l.officeName)}` : ""}. MLS# ${esc(l.listingId)}.</p>`
    : `<p class="fs-advanced-note">MLS# ${esc(l.listingId)}.</p>`;

  return `<section class="hero" style="padding:60px 0 30px">
  <div class="wrap">
    <span class="eyebrow" style="color:var(--dusty-rose)">${esc(l.city || "Northern Colorado")} &middot; ${esc(l.status || "Active")}</span>
    <h1 style="margin-bottom:8px">${esc(l.address || "Listing")}</h1>
    <p class="lede" style="margin-top:0">${esc(addressLine)}</p>
  </div>
</section>
<section class="tight" style="padding-top:10px">
  <div class="wrap grid-2">
    <div>
      ${count ? `<img src="${esc(photoUrl(l, 0))}" alt="${esc(addressLine)}"
        style="width:100%;border-radius:4px;box-shadow:0 10px 30px rgba(20,20,21,.10)">` : ""}
    </div>
    <div>
      <p class="listing-price" style="font-size:34px;margin:0 0 12px">${esc(money(l.price))}</p>
      ${specs.length ? `<ul class="nearby-list">${specs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      ${hers && l.remarks ? `<p class="lede">${esc(l.remarks)}</p>` : ""}
      ${agentBlock}
      ${listedBy}
    </div>
  </div>
</section>
${gallery ? `<section class="tight"><div class="wrap">
  <h2 class="section-title">More Photos</h2>
  ${gallery}
</div></section>` : ""}
<section class="tight">
  <div class="wrap">
    <div class="listing-nearby">
      <button type="button" class="nearby-toggle" onclick="toggleNearby(this)" data-address="${esc(addressLine)}">
      &#128205; What&rsquo;s Nearby: Coffee, Grocery, Schools &amp; Parks</button>
      <div class="nearby-panel" style="display:none">
        <div class="nearby-tabs">
          <button type="button" class="nearby-tab active" data-cat="coffee" onclick="showNearbyCat(this)">Coffee</button>
          <button type="button" class="nearby-tab" data-cat="grocery" onclick="showNearbyCat(this)">Grocery</button>
          <button type="button" class="nearby-tab" data-cat="dining" onclick="showNearbyCat(this)">Dining</button>
          <button type="button" class="nearby-tab" data-cat="school" onclick="showNearbyCat(this)">Schools</button>
          <button type="button" class="nearby-tab" data-cat="park" onclick="showNearbyCat(this)">Parks</button>
        </div>
        <div class="nearby-results"><p class="search-status" style="margin-top:0">Loading nearby places&hellip;</p></div>
      </div>
    </div>
    ${localSpotsBlock(l)}
    <div class="btn-row" style="justify-content:flex-start;margin-top:28px">
      <a class="btn btn-dark" href="/contact.html">Ask About ${esc(l.address || "This Home")}</a>
      <a class="btn btn-outline" style="border-color:#141415;color:#141415" href="/search-homes.html?cities=${encodeURIComponent(l.city || "")}">More Homes In ${esc(l.city || "This Area")}</a>
    </div>
    ${disclaimerHtml(fetchedAt)}
  </div>
</section>
${nearbyScript()}`;
}

// ---- "Around <town>, from Christine" -------------------------------------
// 2026-08-16 (Christine: "build the most detailed most complex but perfect idea
// to integrate buyers and sellers with this knowledge", then "fix all you can").
//
// The idea in one line: the panel above this one lists nearby coffee and grocery
// from Google, which every portal has. This one lists places CHRISTINE has
// personally filmed or reviewed, with her own view counts. Google can tell a
// buyer there is a taqueria 4 minutes away. Only this page can tell them the
// agent has eaten there and 1,635 people watched her do it.
//
// SCOPED DELIBERATELY TO THE TOWN, not to a radius. The honest reason: listings
// from MLS Grid carry no latitude or longitude in this feed, so true distance
// ranking would mean geocoding all 15,000 of them — real money and a lot of
// moving parts for a panel that is already convincing at town level. A buyer
// looking at a Loveland house wants to know what Loveland is like. If listing
// coordinates ever arrive, this function is the only place that changes.
//
// Reads the same build/data/local_spots.json the map and the town pages read, so
// adding one spot updates all three.
const LOCAL_SPOTS = require("./lib/_local-spots.json");
const MAX_SPOTS_ON_LISTING = 3;

function spotsForCity(city) {
  if (!city) return [];
  const want = String(city).trim().toLowerCase();
  return (LOCAL_SPOTS.spots || [])
    .filter((s) => String(s.city || "").trim().toLowerCase() === want)
    // Most-watched first, counting whichever platform the spot lives on, so the
    // strongest piece of local proof is the one a buyer sees.
    .sort((a, b) => ((b.views || 0) + (b.reviewViews || 0)) - ((a.views || 0) + (a.reviewViews || 0)))
    .slice(0, MAX_SPOTS_ON_LISTING);
}

function spotCard(s) {
  const count = (s.views || 0) + (s.reviewViews || 0);
  const proof = count
    ? `<p class="spot-proof">${count.toLocaleString()} views on ${s.videoId ? "YouTube" : "Google"}</p>`
    : "";
  // A video embeds; a review-backed spot shows her words instead. Same rule as
  // the map modal and the town pages.
  const media = s.videoId
    ? `<div class="video-embed"><button type="button" class="yt-facade" data-yt="${esc(s.videoId)}"
        data-yt-title="${esc(s.videoTitle || s.name)}" aria-label="Play video: ${esc(s.videoTitle || s.name)}"
        onclick="window.__ytPlay(this)"><img src="https://i.ytimg.com/vi/${esc(s.videoId)}/hqdefault.jpg"
        alt="" loading="lazy" width="480" height="360"></button></div>`
    : (s.reviewQuote ? `<blockquote class="spot-quote">${esc(s.reviewQuote)}</blockquote>` : "");
  return `<article class="spot-card">
    <h3 class="spot-card-title">${esc(s.name)}</h3>
    ${media}
    ${proof}
    <p class="spot-blurb">${esc(s.blurb || "")}</p>
  </article>`;
}

function localSpotsBlock(l) {
  const spots = spotsForCity(l && l.city);
  if (!spots.length) return "";
  const town = esc(l.city);
  return `<div class="spot-section" style="margin-top:36px">
    <span class="eyebrow" style="color:var(--dusty-rose)">Around ${town}, From Christine</span>
    <h2 class="section-title" style="margin:6px 0 10px">Not just what's nearby — what's actually worth your time</h2>
    <p class="lede">Places ${town} locals go, filmed or reviewed by ${esc(AGENT_NAME)} herself.</p>
    <div class="spot-grid">
      ${spots.map(spotCard).join("\n      ")}
    </div>
  </div>`;
}

// The same on-demand distance panel the listing cards use. Inlined rather than
// imported because build.py owns that JS as a Python string; kept minimal here
// and pointed at the same nearby-places function and CSS classes.
function nearbyScript() {
  return `<script>
(function () {
  // Paced photo loading — same queue as the search page (see _paced_photo_js
  // in build/build.py for the full story): at most 2 gallery photos load at
  // once so a cold listing page cannot burst past MLS Grid's shared 2 rps
  // account limit. A failed photo (their 1-2 minute cooldown) retries once
  // after 80s, so grey tiles heal without a reload.
  var _pq = [], _pqActive = 0;
  function _pqPump() {
    while (_pqActive < 2 && _pq.length) {
      (function (im) {
        _pqActive++;
        var done = function () { _pqActive--; _pqPump(); };
        im.addEventListener('load', done, { once: true });
        im.addEventListener('error', function () {
          done();
          if (!im.getAttribute('data-retried')) {
            im.setAttribute('data-retried', '1');
            setTimeout(function () {
              var u = im.getAttribute('data-src');
              im.src = u + (u.indexOf('?') === -1 ? '?' : '&') + 'r=1';
            }, 80000);
          }
        }, { once: true });
        im.src = im.getAttribute('data-src');
      })(_pq.shift());
    }
  }
  function _pqEnqueue(im) {
    if (im.getAttribute('data-queued')) return;
    im.setAttribute('data-queued', '1');
    _pq.push(im); _pqPump();
  }
  var _pqIO = ('IntersectionObserver' in window)
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { _pqIO.unobserve(e.target); _pqEnqueue(e.target); }
        });
      }, { rootMargin: '300px' })
    : null;
  var _pqImgs = document.querySelectorAll('img[data-src]');
  for (var _pi = 0; _pi < _pqImgs.length; _pi++) {
    if (_pqIO) _pqIO.observe(_pqImgs[_pi]); else _pqEnqueue(_pqImgs[_pi]);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var LABELS = { grocery: 'grocery stores', coffee: 'coffee shops', dining: 'restaurants',
    school: 'schools', park: 'parks' };
  function renderCat(panel, cat) {
    var data = panel._nearbyData;
    var el = panel.querySelector('.nearby-results');
    if (!data) return;
    var items = (data.categories && data.categories[cat]) || [];
    if (!items.length) {
      el.innerHTML = '<p class="search-status" style="margin-top:0">No nearby ' +
        (LABELS[cat] || cat) + ' found.</p>';
      return;
    }
    el.innerHTML = '<ul class="nearby-list">' + items.map(function (p) {
      var name = esc(p.name);
      var inner = p.placeId
        ? '<a href="https://www.google.com/maps/place/?q=place_id:' +
          encodeURIComponent(p.placeId) + '" target="_blank" rel="noopener">' + name + '</a>'
        : name;
      return '<li><span class="nearby-name">' + inner + '</span><span class="nearby-dist">' +
        esc(p.distanceMiles != null ? p.distanceMiles + ' mi' : '') + '</span></li>';
    }).join('') + '</ul><p class="nearby-attrib">Places data &copy; Google Maps</p>';
  }
  window.showNearbyCat = function (tab) {
    var tabs = tab.parentElement;
    tabs.querySelectorAll('.nearby-tab').forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
    renderCat(tabs.parentElement, tab.dataset.cat);
  };
  window.toggleNearby = function (btn) {
    var panel = btn.nextElementSibling;
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    panel.style.display = '';
    if (panel.dataset.loaded === 'true') return;
    var el = panel.querySelector('.nearby-results');
    fetch('/.netlify/functions/nearby-places?address=' + encodeURIComponent(btn.dataset.address))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          el.innerHTML = '<p class="search-status" style="margin-top:0">Couldn\\u2019t look up nearby places right now.</p>';
          return;
        }
        panel.dataset.loaded = 'true';
        panel._nearbyData = data;
        renderCat(panel, 'coffee');
      })
      .catch(function () {
        el.innerHTML = '<p class="search-status" style="margin-top:0">Couldn\\u2019t look up nearby places right now.</p>';
      });
  };
})();
</script>`;
}

// schema.org for the listing. Deliberately RealEstateListing/Residence rather
// than Product+Offer: a house is not a retail product, and Google's own
// guidance for real estate is the RealEstateListing type.
function listingSchema(l, canonical, image) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    "url": canonical,
    "name": [l.address, l.city].filter(Boolean).join(", "),
    "datePosted": l.modificationTimestamp || undefined,
    "address": {
      "@type": "PostalAddress",
      "streetAddress": l.address || undefined,
      "addressLocality": l.city || undefined,
      "addressRegion": l.state || "CO",
      "postalCode": l.zip || undefined,
      "addressCountry": "US",
    },
  };
  if (image) schema.image = image;
  if (l.price != null) {
    schema.offers = {
      "@type": "Offer",
      "price": l.price,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
    };
  }
  const spec = {};
  if (l.beds != null) spec.numberOfBedrooms = l.beds;
  if (l.baths != null) spec.numberOfBathroomsTotal = l.baths;
  if (l.sqft != null) {
    spec.floorSize = { "@type": "QuantitativeValue", "value": l.sqft, "unitCode": "FTK" };
  }
  if (Object.keys(spec).length) {
    schema.mainEntity = Object.assign({ "@type": "SingleFamilyResidence" }, spec);
  }
  return JSON.stringify(schema);
}

exports.handler = async (event) => {
  const params = (event && event.queryStringParameters) || {};
  // Accept either the rewrite's ?id= or a raw /listing/<id> path, so a direct
  // function call behaves the same as the pretty URL.
  let id = String(params.id || "").trim();
  if (!id && event && event.path) {
    const m = event.path.match(/\/listing\/([^/?#]+)/);
    if (m) id = decodeURIComponent(m[1]);
  }

  const notFound = (reason, status) => ({
    statusCode: status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Short cache: a listing coming back on the market shouldn't be stuck
      // behind a day of CDN caching of its own 404.
      "Cache-Control": "public, max-age=120",
      "X-Robots-Tag": "noindex",
    },
    body: render(shell(params.brand), {
      TITLE: `Listing Unavailable | ${brandName(params.brand)}`,
      DESCRIPTION: "This listing is no longer available. Search current Northern Colorado listings instead.",
      CANONICAL: `${SITE_DOMAIN}/search-homes.html`,
      OG_IMAGE: `${SITE_DOMAIN}/assets/img/logo-full.png`,
      SCHEMA: "",
      BODY: notFoundBody(reason),
    }),
  });

  try {
    if (!id || !/^[A-Za-z0-9_-]{3,40}$/.test(id)) {
      return notFound("That listing link doesn’t look right. Search below and you’ll find what you’re after.", 404);
    }

    // 2026-08-16. Her Search Console coverage export reported 12 pages under
    // "Server error (5xx)", and this function was the only thing on the site that
    // can produce one. Tracing it: everything below this read either succeeds or
    // returns a 404, so a 5xx here means the BLOBS READ failed -- Netlify Blobs
    // being briefly unavailable, or a token problem.
    //
    // 500 is the wrong answer to that, and not a cosmetic distinction. A 500 tells
    // Google the page is broken; repeated 500s cost crawl rate across the whole site
    // and can drop pages from the index. 503 with Retry-After tells it the truth --
    // temporarily unavailable, come back -- which Google handles without penalty.
    //
    // Separated from the outer catch so a real bug in the rendering below still
    // surfaces as a 500 rather than being disguised as an outage. Reporting every
    // failure as transient would be its own lie.
    let listings, state;
    try {
      const store = getBlobStore(getStore, "mls-listings");
      [listings, state] = await Promise.all([
        store.get(LISTINGS_KEY, { type: "json" }),
        store.get(SYNC_STATE_KEY, { type: "json" }),
      ]);
    } catch (err) {
      console.error("listing-page: listing store unavailable:", err && err.message);
      return {
        ...notFound("This listing is taking a moment to load. Please refresh, or search below.", 503),
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          // Don't let a CDN or a crawler cache an outage as the page's content.
          "X-Robots-Tag": "noindex",
          "Retry-After": "3600",
        },
      };
    }
    const l = listings && listings[id];
    if (!l) {
      return notFound("This listing isn’t in our current feed — it may have sold or been withdrawn.", 404);
    }
    // 2026-08-18 (full endpoint audit): /listing/IRE1054310 — Christine's own
    // Nunn listing — 404'd, because this gate was "Active only" and her listing
    // went UNDER CONTRACT. But current-listings proudly renders her pending
    // listings with "View This Listing & Share It" links pointing here: the
    // exact link a seller texts to family was dead for every one of her
    // under-contract homes. Her OWN listings get a page in active and
    // under-contract/pending states (that page is marketing she is entitled
    // to); everyone else's stay active-only, as before. mlgCanView re-checked
    // rather than trusted from storage, unchanged.
    const status = String(l.status || "").toLowerCase();
    const hers = String(l.agentName || "").toLowerCase().includes(String(AGENT_SURNAME || "").toLowerCase());
    const showable = status === "active" ||
      (hers && (status.includes("pending") || status.includes("contract")));
    if (!showable || l.mlgCanView === false) {
      return notFound("This home is no longer on the market as an active listing.", 404);
    }

    const canonical = `${SITE_DOMAIN}/listing/${encodeURIComponent(id)}`;
    const addressLine = [l.address, l.city, l.state].filter(Boolean).join(", ");
    const title = `${l.address || "Listing"}, ${l.city || "CO"} — ${money(l.price)} | ${brandName(params.brand)}`;
    const bits = [
      l.beds ? `${l.beds} bed` : null,
      l.baths ? `${l.baths} bath` : null,
      l.sqft ? `${Number(l.sqft).toLocaleString()} sq ft` : null,
    ].filter(Boolean).join(", ");
    const description = `${addressLine} — ${money(l.price)}${bits ? `, ${bits}` : ""}. Active IRES MLS listing. See photos, what's nearby, and schedule a showing with ${AGENT_NAME}.`;

    // Absolute OG image so link previews work when the URL is texted or pasted
    // into Facebook. A relative path silently renders no preview.
    const cover = photoCount(l) ? photoUrl(l, 0) : null;
    const ogImage = cover
      ? (cover.startsWith("http") ? cover : SITE_DOMAIN + cover)
      : `${SITE_DOMAIN}/assets/img/logo-full.png`;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Long enough to absorb a burst from a shared link, short enough that a
        // price change or status flip surfaces within the hour.
        "Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
      },
      body: render(shell(params.brand), {
        TITLE: title,
        DESCRIPTION: description,
        CANONICAL: canonical,
        OG_IMAGE: ogImage,
        SCHEMA: `<script type="application/ld+json">${listingSchema(l, canonical, ogImage)}</script>`,
        BODY: listingBody(l, state && state.lastRunAt),
      }),
    };
  } catch (err) {
    console.error("listing-page error:", err && err.message);
    return notFound("Something went wrong loading this listing. Please try again.", 500);
  }
};
