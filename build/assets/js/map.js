/*
 * Northern Colorado "Find Your Community" interactive county map.
 * Built with Leaflet + OpenStreetMap-based tiles (both free, no API key)
 * and real US Census county boundary data, styled to the audited brand
 * palette (dusty rose #B86F7A / mauve #BA8C84 — no red). Click a county to
 * go to its page; hover to preview. The three core counties (Larimer, Weld,
 * Boulder) get labeled city markers for extra detail.
 *
 * County slugs must match /communities/<slug>.html
 */
(function () {
  var COUNTY_SLUGS = {
    'Larimer': 'larimer',
    'Weld': 'weld',
    'Boulder': 'boulder',
    'Broomfield': 'broomfield',
    'Jefferson': 'jefferson',
    'Denver': 'denver',
    'Arapahoe': 'arapahoe',
    'Adams': 'adams',
    // 2026-08-15 (Christine: "lets add morgan into the geojapn map too").
    // The Morgan County polygon was appended to noco-counties.geojson from
    // the same US Census cartographic-boundary data the other eight came
    // from (GEO_ID 0500000US08087, CENSUSAREA 1280.433 sq mi). Without this
    // entry the polygon would still draw and label itself, but clicking it
    // would open a popup with no link to /communities/morgan.html.
    'Morgan': 'morgan'
  };

  // 2026-08-15 (Christine: "i need it to be the same through the entire
  // site"): the county -> cities map and the live-search list are no longer
  // maintained here. build.py generates /assets/data/county-search.json from
  // COUNTIES -- the same source the county pages, city pages and Search Homes
  // dropdown are built from -- and loadCountyData() below fills these in from
  // it. Hand-syncing this failed twice: the city lists went stale for a while
  // in August 2026, and the live-search list below still named three counties
  // after five more had gone live, so clicking Denver or Adams on the map told
  // visitors live search didn't cover them while their own city pages searched
  // live.
  //
  // What's left below is a deliberately minimal FALLBACK for the case where
  // that fetch fails: the three original IRES counties. A stale-but-correct
  // subset degrades to "guide link only" for the rest, which is honest; an
  // empty object would make every popup a dead end.
  var COUNTY_CITIES = {
    'Larimer': ['Fort Collins', 'Loveland', 'Estes Park', 'Berthoud', 'Masonville',
      'Windsor', 'Timnath', 'Wellington', 'Laporte', 'Red Feather Lakes'],
    'Weld': ['Greeley', 'Windsor', 'Evans', 'Severance', 'Eaton', 'Ault',
      'Johnstown', 'Milliken', 'Firestone', 'Frederick', 'Dacono', 'Fort Lupton',
      'Mead', 'Erie', 'Platteville', 'Kersey', 'LaSalle', 'Gilcrest', 'Hudson',
      'Keenesburg', 'Lochbuie', 'Nunn', 'Pierce', 'Garden City', 'Grover', 'New Raymer'],
    'Boulder': ['Boulder', 'Longmont', 'Lafayette', 'Louisville', 'Superior',
      'Nederland', 'Lyons', 'Jamestown', 'Ward']
  };
  var IRES_COUNTIES = { 'Larimer': true, 'Weld': true, 'Boulder': true };

  // The full per-county record from county-search.json, keyed by the geojson NAME.
  // The three constants above stay as they are because other code reads them; this
  // is what the 2026-08-17 drill-down needs, since it wants `towns` (name, url and
  // real geocoded coordinates) rather than just the city-name list. Empty until the
  // fetch lands, and an empty entry simply means "no drill-down for this county",
  // which falls back to the county-wide popup.
  var COUNTY_DATA = {};

  // Replaces the three constants above with build.py's generated copy. Resolves
  // either way -- a failed or malformed fetch just leaves the fallbacks in
  // place, so the map still draws and still links to every county guide.
  function loadCountyData() {
    return fetch('/assets/data/county-search.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var counties = data && data.counties;
        if (!counties) return;
        Object.keys(counties).forEach(function (name) {
          var c = counties[name] || {};
          COUNTY_DATA[name] = c;
          if (c.slug) COUNTY_SLUGS[name] = c.slug;
          if (Array.isArray(c.cities) && c.cities.length) COUNTY_CITIES[name] = c.cities;
          if (c.liveSearch) IRES_COUNTIES[name] = true;
        });
      })
      .catch(function () {
        console.warn('map: county-search.json unavailable; using built-in county list.');
      });
  }

  // Quick price-floor presets for the popup. $950K+ matches the site's
  // luxury default; the lower presets are the deliberate, narrow exception
  // added 2026-08-11 (see listings-search.js's noFloor comment) — Christine
  // wanted map searchers able to go below the site's usual luxury floor
  // since her clients sometimes need family-sized homes too, not just
  // $950K+ single properties. Floored at $350K rather than truly "no
  // minimum" so the map still reads as this site's (luxury-leaning)
  // inventory rather than the full general market.
  var PRICE_PRESETS = [
    { label: '$950K+', value: 950000 },
    { label: '$700K+', value: 700000 },
    { label: '$500K+', value: 500000 },
    { label: '$350K+', value: 350000 }
  ];

  var BASE_FILL = '#141415';
  var HOVER_FILL = '#BA8C84';   /* mauve */
  var CLICK_FILL = '#B86F7A';   /* dusty rose — no red anywhere */
  var BORDER = '#F9F9EC';

  // Clean white line-art icons (inline SVG, no emoji) matching the look of
  // the original map's markers: mountain peaks, pine trees, a paw print for
  // parks/trail towns, columns for Fort Collins' Old Town historic district,
  // a grad cap for Greeley (home of UNC), and a wave for river towns.
  var ICONS = {
    mountain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 20 L9 7 L13 14 L16 9 L22 20 Z" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    tree: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2 L18 12 H14 L19 19 H5 L10 12 H6 Z" stroke-linejoin="round" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    paw: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="7" cy="9" r="2"/><circle cx="12" cy="6.5" r="2"/><circle cx="17" cy="9" r="2"/><path d="M12 12c-3.3 0-6 2.2-6 5 0 1.7 1.5 3 3.3 3 1 0 1.8-.4 2.7-.4.9 0 1.7.4 2.7.4 1.8 0 3.3-1.3 3.3-3 0-2.8-2.7-5-6-5z"/></svg>',
    columns: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="3" y1="21" x2="21" y2="21"/><line x1="4" y1="21" x2="4" y2="9"/><line x1="8" y1="21" x2="8" y2="9"/><line x1="12" y1="21" x2="12" y2="9"/><line x1="16" y1="21" x2="16" y2="9"/><line x1="20" y1="21" x2="20" y2="9"/><path d="M2 9 L12 3 L22 9 Z" stroke-linejoin="round"/></svg>',
    grad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M2 9 L12 4 L22 9 L12 14 Z"/><path d="M6 11.5 V17 C6 18.5 9 20 12 20 C15 20 18 18.5 18 17 V11.5"/><line x1="22" y1="9" x2="22" y2="16"/></svg>',
    wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 9c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/><path d="M2 15c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/></svg>',
  };

  // Priority-county cities with a real line-art icon glyph, matching the
  // level of on-map detail from the original (mountains around Loveland /
  // Nederland, pines through the foothill towns, a paw print for parks and
  // trail towns, the Old Town columns landmark in Fort Collins, a grad cap
  // over Greeley for UNC, and a wave for towns that sit right on a river).
  var CITY_ICONS = [
    // Larimer County — core farm area
    { name: 'Fort Collins', lat: 40.5853, lng: -105.0844, icon: 'columns', priority: true },
    { name: 'Loveland', lat: 40.3978, lng: -105.0748, icon: 'mountain', priority: true },
    { name: 'Berthoud', lat: 40.3097, lng: -105.0797, icon: 'tree', priority: true },
    { name: 'Masonville', lat: 40.4967, lng: -105.2058, icon: 'mountain', priority: true },
    { name: 'Windsor', lat: 40.4772, lng: -104.9008, icon: 'wave', priority: true },
    { name: 'Timnath', lat: 40.5286, lng: -104.9836, icon: 'tree' },
    { name: 'Wellington', lat: 40.7050, lng: -105.0044, icon: 'paw' },
    { name: 'Red Feather Lakes', lat: 40.8036, lng: -105.5975, icon: 'mountain' },

    // Weld County — core farm area
    { name: 'Greeley', lat: 40.4233, lng: -104.7091, icon: 'grad', priority: true },
    { name: 'Severance', lat: 40.5250, lng: -104.8511, icon: 'tree' },
    { name: 'Eaton', lat: 40.5286, lng: -104.7297, icon: 'paw' },
    { name: 'Ault', lat: 40.5828, lng: -104.7314, icon: 'paw' },
    { name: 'Johnstown', lat: 40.3372, lng: -104.9119, icon: 'wave' },
    { name: 'Milliken', lat: 40.3169, lng: -104.8553, icon: 'paw' },
    { name: 'Firestone', lat: 40.1153, lng: -104.9377, icon: 'tree' },
    { name: 'Frederick', lat: 40.1003, lng: -104.9394, icon: 'paw' },
    { name: 'Dacono', lat: 40.0855, lng: -104.9364, icon: 'paw' },
    { name: 'Fort Lupton', lat: 40.0858, lng: -104.8122, icon: 'wave' },
    { name: 'Mead', lat: 40.2358, lng: -104.9975, icon: 'paw' },

    // Boulder County — core farm area
    { name: 'Boulder', lat: 40.0150, lng: -105.2705, icon: 'mountain', priority: true },
    { name: 'Lafayette', lat: 39.9936, lng: -105.0897, icon: 'paw' },
    { name: 'Louisville', lat: 39.9778, lng: -105.1319, icon: 'paw' },
    { name: 'Nederland', lat: 39.9614, lng: -105.5108, icon: 'mountain' }
  ];

  // Lifestyle/amenity markers — real places worth a video, not just a pin.
  // Clicking one opens a real, existing YouTube video (never fabricated —
  // same "never a lookalike" rule as LISTING_VIDEOS in build.py) plus a
  // quick link back to that city's search. Started 2026-08-12 with
  // Christine's request to feature Mariana Butte; add more entries here as
  // she asks for restaurants/parks/other amenities (kept deliberately small
  // for now — see notes/websites-strategy.md-style scoping: build what's
  // asked, not a speculative full POI system).
  // 2026-08-15 (Christine: "make the map way more detailed for how people would
  // find me - based on local spots?"). One glyph per kind of place, so the map
  // reads at a glance as somewhere a person actually goes -- eats, hikes,
  // swims, rides -- rather than a choropleth with two golf flags on it.
  var POI_ICONS = {
    golf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="21" x2="6" y2="3"/><path d="M6 3 L17 7 L6 11 Z" fill="currentColor" stroke="none"/><circle cx="6" cy="21" r="1.6" fill="currentColor" stroke="none"/></svg>',
    restaurant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v8a2 2 0 0 0 4 0V3"/><line x1="8" y1="11" x2="8" y2="21"/><path d="M16 3c-1.6 1-2.4 2.6-2.4 4.4S14.4 11 16 11.6V21"/></svg>',
    winery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8l-.7 5a3.3 3.3 0 0 1-6.6 0Z"/><line x1="12" y1="13" x2="12" y2="19"/><line x1="9" y1="21" x2="15" y2="21"/></svg>',
    trail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19l6-9 3 4 2-3 7 8Z"/></svg>',
    lake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 3-2"/><path d="M3 15c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 3-2"/></svg>',
    downtown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V8l5-3v16"/><path d="M9 21V11l6-3v13"/><path d="M15 21V12l5 2v7"/></svg>',
    scenic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M3 21c2-5 5.5-7 9-7s7 2 9 7"/></svg>',
    // A street festival / annual event, e.g. Taste of Loveland.
    event: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21l5-13 8 5Z"/><line x1="9" y1="8" x2="10.5" y2="4"/><circle cx="11" cy="3" r="1.4" fill="currentColor" stroke="none"/></svg>',
    // The fallback for a category this build doesn't know a glyph for.
    spot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  };
  var POI_MARKERS = [
    {
      name: 'Mariana Butte Golf Course',
      lat: 40.3990, lng: -105.1430,
      icon: 'golf',
      cityLabel: 'Loveland',
      cityHref: '/communities/larimer/loveland.html',
      searchCity: 'Loveland',
      blurb: 'A public, city-owned 18-hole course along the Big Thompson River with sweeping ' +
        'Front Range views — one of the lifestyle perks of calling Loveland home.',
      videoId: 'gvO0ZPJ4gD0',
      videoTitle: 'Mariana Butte Golf Course — Loveland, CO',
      videoSource: 'Golf Loveland (City of Loveland)',
    },
    // 2026-08-15: The Olde Course used to be the second entry here, playing the
    // City of Loveland's promo video. It moved into build/data/local_spots.json
    // because Christine has her OWN film of it now ("Why Loveland Buyers Love
    // The Olde Course"), and hers is about what living on the course is like
    // rather than about the course. Removed from this list rather than left in,
    // so the map doesn't grow two pins on the same fairway.
  ];

  // Shared by the built-in POI_MARKERS and the fetched local spots, so both
  // kinds of pin behave identically -- one place to change the interaction.
  // Positions already used by a pin, so co-located pins can be nudged apart.
  // 2026-08-15: Downtown Loveland and Taste of Loveland genuinely share an
  // address -- the event happens on that street -- and geocoding both returned
  // the identical point, so the second marker sat exactly under the first and
  // could never be clicked. Nudging the duplicate is honest in a way that
  // inventing a different address for it would not be: the place really is the
  // same, this is a display offset and nothing more. Deterministic, so pins
  // don't shuffle between page loads, and ~25m so it reads as "same block".
  var usedPositions = {};
  function nudgeIfStacked(lat, lng) {
    var key = lat.toFixed(4) + ',' + lng.toFixed(4);
    var n = usedPositions[key] || 0;
    usedPositions[key] = n + 1;
    if (!n) return [lat, lng];
    var angle = (n - 1) * (Math.PI * 2 / 6);
    return [lat + Math.cos(angle) * 0.00022, lng + Math.sin(angle) * 0.00029];
  }

  function addPoiMarker(map, poi) {
    if (!poi || typeof poi.lat !== 'number' || typeof poi.lng !== 'number') return;
    var marker = L.marker(nudgeIfStacked(poi.lat, poi.lng), {
      icon: poiIcon(poi), interactive: true, zIndexOffset: 600,
    }).addTo(map);
    // The view count goes in the tooltip because it is the reason to click: it
    // says a few thousand people have already watched this, which no stock
    // amenity pin on a portal map can say.
    var label = (poi.videoId ? '▶ Watch: ' : '★ Read: ') + poi.name;
    var count = poi.views || poi.reviewViews;
    if (count) label += ' (' + Number(count).toLocaleString() + ' views)';
    marker.bindTooltip(label, { direction: 'top', offset: [0, -10] });
    marker.on('click', function () { openPoiModal(poi); });
  }

  function poiIcon(poi) {
    // 2026-08-15: this read poi.icon only. The hardcoded POI_MARKERS above set
    // `icon`, but the spots fetched from local-spots.js carry `category` — so
    // every single one of Christine's 19 pins fell through to the golf flag,
    // including the restaurants. The whole point of adding seven glyphs was that
    // the map should read at a glance as places a person goes.
    //
    // Falling back to `spot` rather than `golf` too: an unrecognised category
    // should look like a generic place, not silently claim to be a golf course.
    var glyph = POI_ICONS[poi.icon || poi.category] || POI_ICONS.spot;

    // 2026-08-17 (Christine: "if we could zoom in and a little video icon of it pops
    // up - that would be asesome!").
    //
    // The glyph says what KIND of place a pin is. It never said which pins carry a
    // film of hers, and that is the thing worth advertising -- a portal map can show
    // a restaurant, it cannot show her standing in one. Until now that was only
    // discoverable by hovering each pin one at a time to read the tooltip.
    //
    // A badge rather than a different glyph: the category is still the useful thing
    // at a glance, so this adds to it instead of replacing it. Shown only when zoomed
    // in (see .map-zoomed-in in style.css) because at county level the pins cluster
    // and a badge on every one is just noise -- which is exactly what she described.
    var badge = poi.videoId
      ? '<span class="poi-video-badge" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
        '</span>'
      : '';
    return L.divIcon({
      html: '<div class="poi-icon-marker' + (poi.videoId ? ' has-video' : '') + '">' +
        glyph + badge + '</div>',
      className: '',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  }

  // ---- POI video modal ---------------------------------------------------
  function buildPoiModal() {
    if (document.getElementById('map-poi-modal')) return;
    var overlay = document.createElement('div');
    overlay.className = 'lb-overlay';
    overlay.id = 'map-poi-modal';
    overlay.innerHTML =
      '<div class="lb-box lb-box-media" style="max-width:640px">' +
        '<button type="button" class="lb-close" aria-label="Close">&times;</button>' +
        '<div id="poi-video-wrap" style="aspect-ratio:16/9;background:#000"></div>' +
        '<div style="padding:20px 4px 4px">' +
          '<h3 id="poi-title" style="color:#fff;margin:0 0 8px"></h3>' +
          '<p id="poi-blurb" style="color:rgba(255,255,255,.82);font-size:14px;margin:0 0 6px"></p>' +
          '<p id="poi-source" style="color:rgba(255,255,255,.5);font-size:12px;margin:0 0 18px"></p>' +
          '<div class="btn-row" id="poi-actions" style="justify-content:flex-start"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.lb-close').addEventListener('click', closePoiModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closePoiModal(); });
  }

  function closePoiModal() {
    var overlay = document.getElementById('map-poi-modal');
    if (!overlay) return;
    overlay.classList.remove('open');
    var wrap = document.getElementById('poi-video-wrap');
    if (wrap) wrap.innerHTML = ''; // stop playback on close
  }

  function openPoiModal(poi) {
    buildPoiModal();
    var overlay = document.getElementById('map-poi-modal');
    overlay.querySelector('#poi-title').textContent = poi.name;
    var blurbEl = overlay.querySelector('#poi-blurb');
    blurbEl.textContent = poi.blurb || '';
    // A review-backed pin shows her actual words as a pull quote underneath the
    // blurb. Built with textContent on a child node rather than innerHTML so a
    // quote can contain anything without becoming markup.
    var oldQuote = overlay.querySelector('#poi-review-quote');
    if (oldQuote) oldQuote.remove();
    if (poi.reviewQuote) {
      var q = document.createElement('blockquote');
      q.id = 'poi-review-quote';
      q.style.cssText = 'margin:0 0 12px;padding:10px 14px;border-left:3px solid #B86F7A;' +
        'color:rgba(255,255,255,.9);font-size:14px;font-style:italic';
      q.textContent = '“' + poi.reviewQuote + '”';
      blurbEl.parentNode.insertBefore(q, blurbEl.nextSibling);
    }
    // Two kinds of pin, credited honestly: the two municipal golf-course videos
    // are the City of Loveland's, everything else is Christine's own footage --
    // and saying so is the whole point of the layer.
    var credit;
    if (poi.videoSource) {
      credit = 'Video: ' + poi.videoSource;
    } else if (poi.videoId) {
      credit = 'Filmed by Christine — The Little Lady Sells Homes';
    } else {
      credit = 'Reviewed by Christine — The Little Lady Sells Homes';
    }
    if (poi.views) credit += ' · ' + Number(poi.views).toLocaleString() + ' views on YouTube';
    if (poi.reviewViews) {
      credit += ' · ' + Number(poi.reviewViews).toLocaleString() + ' views on Google';
    }
    overlay.querySelector('#poi-source').textContent = credit;
    // 2026-08-15: a spot may be backed by a Google review rather than a video
    // ("i have over 10k views on the mexican restuarant in berthoud"). With no
    // videoId there is nothing to embed, so the media panel is dropped entirely
    // instead of rendering a black box with a broken player in it.
    var wrap = overlay.querySelector('#poi-video-wrap');
    if (poi.videoId) {
      wrap.style.display = '';
      wrap.innerHTML =
        '<iframe width="100%" height="100%" style="display:block" ' +
        'src="https://www.youtube-nocookie.com/embed/' + poi.videoId + '?rel=0" ' +
        'title="' + String(poi.videoTitle || poi.name).replace(/"/g, '&quot;') + '" frameborder="0" ' +
        'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
        'allowfullscreen></iframe>';
    } else {
      wrap.style.display = 'none';
      wrap.innerHTML = '';
    }

    var actionsEl = overlay.querySelector('#poi-actions');
    actionsEl.innerHTML = '';
    if (poi.searchCity) {
      var searchBtn = document.createElement('button');
      searchBtn.type = 'button';
      searchBtn.className = 'btn btn-outline';
      searchBtn.style.cssText = 'border-color:#fff;color:#fff';
      searchBtn.textContent = 'See Homes Near Here';
      searchBtn.addEventListener('click', function () {
        closePoiModal();
        openQuickSearch({ label: poi.searchCity, cities: [poi.searchCity], covered: true });
      });
      actionsEl.appendChild(searchBtn);
    }
    // Optional, and empty in the data today: her Google Business posts get real
    // views too, so the slot exists for those URLs rather than being invented.
    var googleUrl = poi.googleReviewUrl || poi.googlePostUrl;
    if (googleUrl) {
      var gLink = document.createElement('a');
      gLink.className = 'btn btn-outline';
      gLink.style.cssText = 'border-color:#fff;color:#fff';
      gLink.href = googleUrl;
      gLink.target = '_blank';
      gLink.rel = 'noopener';
      // Worded for what the link actually does. Google has no per-review
      // permalink, so this opens the business's listing -- promising "read my
      // review" and landing someone on a wall of other people's would be a
      // small lie, and the quote above already shows them hers.
      gLink.textContent = poi.googleReviewUrl ? 'See It On Google' : 'See This On Google';
      actionsEl.appendChild(gLink);
    }
    if (poi.cityHref) {
      var cityLink = document.createElement('a');
      cityLink.className = 'btn btn-outline';
      cityLink.style.cssText = 'border-color:#fff;color:#fff';
      cityLink.href = poi.cityHref;
      cityLink.textContent = 'More About ' + (poi.cityLabel || 'This Area');
      actionsEl.appendChild(cityLink);
    }
    overlay.classList.add('open');
  }

  // The two rivers visible on the original map, labeled in the script
  // accent font. Coordinates are simplified/approximate paths, not surveyed
  // hydrology — just enough to place a recognizable line + label.
  var RIVERS = [
    {
      name: 'Cache la Poudre River',
      labelAt: [40.53, -105.03],
      labelRotate: -18,
      points: [
        [40.65, -105.33], [40.62, -105.20], [40.585, -105.10],
        [40.56, -105.02], [40.50, -104.94], [40.44, -104.85],
        [40.42, -104.75], [40.42, -104.69],
      ],
    },
    {
      name: 'South Platte River',
      labelAt: [40.30, -104.80],
      labelRotate: -22,
      // The first six points below are the Morgan County reach, added
      // 2026-08-15 when that county joined the map -- the river is the whole
      // reason Fort Morgan and Brush are where they are, and the line
      // stopping dead at the Poudre confluence in Greeley looked like the
      // county had been pasted on. Schematic, like the rest of this
      // polyline: drawn east from the confluence past the river towns
      // (Kersey, Weldona, then just north of Fort Morgan and Brush) out to
      // the county line, not traced from survey data.
      points: [
        [40.31, -103.47], [40.29, -103.63], [40.27, -103.80],
        [40.32, -104.02], [40.36, -104.30], [40.39, -104.55],
        [40.42, -104.69], [40.38, -104.72], [40.33, -104.78],
        [40.27, -104.83], [40.18, -104.90], [40.08, -104.94],
        [39.98, -104.98], [39.85, -105.00],
      ],
    },
  ];

  function cityIcon(city) {
    var cls = 'city-icon-marker' + (city.priority ? ' priority' : '');
    var glyph = ICONS[city.icon] || ICONS.paw;
    return L.divIcon({
      html: '<div class="' + cls + '">' + glyph + '</div>',
      className: '',
      iconSize: city.priority ? [30, 30] : [26, 26],
      iconAnchor: city.priority ? [15, 15] : [13, 13],
    });
  }

  function cityLabel(city) {
    return L.divIcon({
      html: '<div class="city-label">' + city.name + '</div>',
      className: '',
      iconSize: [0, 0],
      iconAnchor: city.priority ? [-18, 4] : [-16, 4],
    });
  }

  // ---- Click-to-search popup -------------------------------------------
  // Clicking a city marker or a county shape opens this instead of (city)
  // or in addition to (county) the old behavior, per Christine's request
  // 2026-08-11: "when I click into the maps it isn't filtering prices for
  // me — I want a search bar to pop up with auto 950k and up but they can
  // lower it to include other homes too."

  var quickSearchState = { cities: [], selectedPrice: 950000 };

  function buildQuickSearchModal() {
    if (document.getElementById('map-quick-search')) return;
    var overlay = document.createElement('div');
    overlay.className = 'lb-overlay';
    overlay.id = 'map-quick-search';
    overlay.innerHTML =
      '<div class="lb-box">' +
        '<button type="button" class="lb-close" aria-label="Close">&times;</button>' +
        '<h3 id="mqs-title">Search Homes</h3>' +
        '<p class="lede" style="font-size:14px;margin:0 0 20px" id="mqs-sub">' +
          'Live, active IRES MLS listings.</p>' +
        '<div class="quick-price-row" id="mqs-presets"></div>' +
        '<div class="field" style="margin-top:16px">' +
          '<label for="mqs-price" style="font-size:12px;color:#6a6a6c;margin-bottom:6px;display:block">' +
            'Or set your own minimum price</label>' +
          '<input type="number" id="mqs-price" step="10000" min="0" value="950000" ' +
          'style="padding:12px 14px;border:1px solid var(--gray);width:100%;font-family:var(--font-sans);font-size:14px">' +
        '</div>' +
        '<div class="btn-row" style="margin-top:24px;justify-content:flex-start">' +
          '<a class="btn btn-dark" id="mqs-go" href="/search-homes.html">View Listings</a>' +
          '<a class="btn btn-outline" id="mqs-guide" style="border-color:#141415;color:#141415;display:none">Full Area Guide</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var presetsEl = overlay.querySelector('#mqs-presets');
    PRICE_PRESETS.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-price-btn';
      btn.textContent = p.label;
      btn.dataset.value = p.value;
      btn.addEventListener('click', function () {
        setSelectedPrice(p.value);
      });
      presetsEl.appendChild(btn);
    });

    overlay.querySelector('#mqs-price').addEventListener('input', function (e) {
      setSelectedPrice(parseInt(e.target.value, 10) || 0, true);
    });
    overlay.querySelector('.lb-close').addEventListener('click', closeQuickSearch);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeQuickSearch();
    });

    function setSelectedPrice(value, skipInputSync) {
      quickSearchState.selectedPrice = value;
      presetsEl.querySelectorAll('.quick-price-btn').forEach(function (b) {
        b.classList.toggle('active', parseInt(b.dataset.value, 10) === value);
      });
      if (!skipInputSync) overlay.querySelector('#mqs-price').value = value;
      updateGoLink();
    }

    function updateGoLink() {
      var params = new URLSearchParams();
      if (quickSearchState.cities.length === 1) {
        params.set('city', quickSearchState.cities[0]);
      } else if (quickSearchState.cities.length > 1) {
        params.set('cities', quickSearchState.cities.join(','));
      }
      var price = quickSearchState.selectedPrice;
      if (price !== 950000) {
        params.set('minPrice', String(price));
        params.set('noFloor', 'true');
      } else {
        params.set('minPrice', '950000');
      }
      overlay.querySelector('#mqs-go').href = '/search-homes.html?' + params.toString();
    }

    overlay._setSelectedPrice = setSelectedPrice;
    overlay._updateGoLink = updateGoLink;
  }

  function closeQuickSearch() {
    var overlay = document.getElementById('map-quick-search');
    if (overlay) overlay.classList.remove('open');
  }

  function openQuickSearch(opts) {
    buildQuickSearchModal();
    var overlay = document.getElementById('map-quick-search');
    quickSearchState.cities = opts.cities || [];
    overlay.querySelector('#mqs-title').textContent = 'Homes in ' + opts.label;
    overlay.querySelector('#mqs-sub').textContent = opts.covered
      ? 'Live, active IRES MLS listings — defaults to $950K+, adjust below to include more homes.'
      // 2026-08-15: this used to name the three counties live search covered.
      // It covers all nine now (see loadCountyData), so the only way to reach
      // this line is a failed data fetch -- which is a "try the guide" problem,
      // not a coverage fact to state.
      : 'Browse the full area guide below for this county.';
    var goBtn = overlay.querySelector('#mqs-go');
    var guideBtn = overlay.querySelector('#mqs-guide');
    if (opts.guideHref) {
      guideBtn.href = opts.guideHref;
      guideBtn.style.display = 'inline-block';
    } else {
      guideBtn.style.display = 'none';
    }
    if (opts.covered) {
      goBtn.style.display = 'inline-block';
      overlay.querySelector('#mqs-presets').style.display = 'flex';
      overlay.querySelector('#mqs-price').closest('.field').style.display = 'block';
      overlay._setSelectedPrice(950000);
    } else {
      goBtn.style.display = 'none';
      overlay.querySelector('#mqs-presets').style.display = 'none';
      overlay.querySelector('#mqs-price').closest('.field').style.display = 'none';
    }
    overlay.classList.add('open');
  }

  // ---- County drill-down ---------------------------------------------------
  // 2026-08-17 (Christine: "when i click on any county it moves to this page
  // instead of being able to click in more ... can we click into the county and
  // then have the popup search? not sure the smartest way").
  //
  // She was right, and about the more important half of it. A county click went
  // straight to a price filter scoped to the whole county, and a county is not a
  // scope anyone shops in -- Fort Collins alone carries 842 active listings. It
  // also routed people PAST the 37 town pages, which are this site's strongest
  // content (live market figures, schools, commute times, videos, FAQ schema) and
  // the pages that match how people actually search: "moving to Windsor Colorado",
  // not "Weld County real estate". The map was sending traffic away from the pages
  // built to win it.
  //
  // It was inconsistent too: the sidebar's "Larimer County" link went to the county
  // guide while the same county on the map opened a price box. Same county, two
  // different outcomes.
  //
  // So a county click now zooms to that county, swaps the sidebar to its towns, and
  // leaves the price popup for the town level, where the scope is real. "Search all
  // of <County>" is still one click away for anyone who genuinely wants the wide net.
  //
  // Counties with no town pages yet (Jefferson, Arapahoe, Adams -- cities listed but
  // no pages built) have an empty `towns` array, and fall straight through to the old
  // county-wide popup. That is deliberate: an empty drill-down panel would be a dead
  // end, and the previous behaviour is the correct fallback rather than a regression.
  var countyView = { active: null, markers: [], layer: null, homeBounds: null };

  // City icon/label markers ONLY. The county view hides these, because a town that
  // already has an icon marker (Fort Collins, Masonville, Loveland ...) would
  // otherwise render twice -- once as its icon, once as a town pin -- which is
  // worse than either alone.
  //
  // 2026-08-17, same day, and my regression: this array originally held the POI
  // markers too, so entering a county hid every one of Christine's spots. Those
  // pins ARE her content -- the "▶ Watch" markers carrying her YouTube tours and
  // reviews with their real view counts -- and they are the single thing this map
  // has that a portal map structurally cannot. She opened a county and said "all
  // of my embedded videos are all gone!!!!", which is exactly what it looked like.
  //
  // Nothing was ever deleted, but that is not the point: hiding them was wrong on
  // its own terms. The duplication problem was only ever about CITY icons sitting
  // under town pins. A restaurant or a trailhead is a different place from the town
  // pin beside it and duplicates nothing, so POI markers now stay visible at every
  // zoom -- including inside a county, where someone looking at one town is exactly
  // the person most likely to want them.
  var cityMarkers = [];
  function setCityMarkersVisible(map, visible) {
    cityMarkers.forEach(function (m) {
      if (visible) { if (!map.hasLayer(m)) m.addTo(map); }
      else if (map.hasLayer(m)) map.removeLayer(m);
    });
  }

  function townMarkerIcon(name) {
    return L.divIcon({
      className: '',
      html: '<div class="town-pin"><span>' + name + '</span></div>',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  // Fill the chosen county, fade the others. Zoom alone does not communicate the
  // state change: fitBounds on a container this tall keeps every neighbour in
  // frame, so the map looks much as it did and the drill-down reads as an
  // unrelated sidebar change rather than a selection.
  function paintCounties(selected) {
    var layers = countyView.layer || {};
    Object.keys(layers).forEach(function (n) {
      if (!selected) {
        layers[n].setStyle({ fillColor: BASE_FILL, fillOpacity: 0.9, opacity: 1 });
      } else if (n === selected) {
        layers[n].setStyle({ fillColor: CLICK_FILL, fillOpacity: 0.55, opacity: 1 });
      } else {
        layers[n].setStyle({ fillColor: BASE_FILL, fillOpacity: 0.9, opacity: 0.25 });
      }
    });
  }

  function clearCountyView(map) {
    countyView.markers.forEach(function (m) { map.removeLayer(m); });
    countyView.markers = [];
    countyView.active = null;
    setCityMarkersVisible(map, true);
    paintCounties(null);
  }

  // Rebuilds the sidebar. Two states only: the county list it ships with, and one
  // county's towns. Kept in this file rather than pre-rendered per county because
  // the town list already exists in county-search.json and duplicating it into the
  // HTML would be a second copy to keep in sync -- the exact problem the comment on
  // write_map_county_data() in build.py describes.
  function renderCountyPanel(map, countyName, data) {
    var list = document.querySelector('.county-list');
    if (!list) return;
    if (!list.dataset.home) list.dataset.home = list.innerHTML;

    var slug = COUNTY_SLUGS[countyName];
    var towns = (data && data.towns) || [];
    var html = '<button type="button" class="county-back">&lsaquo; All counties</button>' +
      '<p class="county-panel-title">' + countyName + ' County</p>';

    towns.forEach(function (t) {
      // A real link, not a button: these are the town pages, and they must stay
      // crawlable and middle-clickable. The click handler enhances, it doesn't
      // replace -- see the listener below.
      html += '<a class="county-btn town-btn" href="' + t.url + '" data-town="' + t.name + '">' +
        t.name + ' <span>&rsaquo;</span></a>';
    });

    html += '<button type="button" class="county-wide-btn">Search all of ' + countyName + ' County &rsaquo;</button>';
    if (slug) {
      html += '<a class="county-guide-link" href="/communities/' + slug + '.html">' +
        'Full ' + countyName + ' County guide &rsaquo;</a>';
    }
    list.innerHTML = html;

    list.querySelector('.county-back').addEventListener('click', function () {
      list.innerHTML = list.dataset.home;
      bindHomePanel(map);
      clearCountyView(map);
      if (countyView.homeBounds) map.fitBounds(countyView.homeBounds, { padding: [20, 20] });
    });

    list.querySelector('.county-wide-btn').addEventListener('click', function () {
      openQuickSearch({
        label: countyName + ' County',
        cities: (data && data.cities) || COUNTY_CITIES[countyName] || [],
        covered: !!IRES_COUNTIES[countyName],
        guideHref: slug ? '/communities/' + slug + '.html' : null,
      });
    });

    // Clicking a town in the panel opens its price search rather than navigating,
    // because the price filter is the thing that was missing at this level. The
    // href stays for crawlers, middle-click and cmd-click; the guide is reachable
    // from inside the popup via Full Area Guide.
    Array.prototype.forEach.call(list.querySelectorAll('.town-btn'), function (a) {
      a.addEventListener('click', function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
        ev.preventDefault();
        openQuickSearch({
          label: a.dataset.town,
          cities: [a.dataset.town],
          covered: true,
          guideHref: a.getAttribute('href'),
        });
      });
    });
  }

  function enterCounty(map, countyName, data, lyr) {
    clearCountyView(map);
    countyView.active = countyName;
    setCityMarkersVisible(map, false);
    paintCounties(countyName);
    renderCountyPanel(map, countyName, data);

    if (lyr && lyr.getBounds) map.fitBounds(lyr.getBounds(), { padding: [30, 30] });

    ((data && data.towns) || []).forEach(function (t) {
      var m = L.marker([t.lat, t.lng], {
        icon: townMarkerIcon(t.name), zIndexOffset: 900, interactive: true,
      }).addTo(map);
      m.on('click', function () {
        openQuickSearch({
          label: t.name, cities: [t.name], covered: true, guideHref: t.url,
        });
      });
      countyView.markers.push(m);
    });
  }

  // The sidebar's county links: same drill-down as the map, so one county cannot
  // mean two things. preventDefault only on a plain left click, so the href still
  // works for crawlers and for anyone opening it in a new tab on purpose.
  function bindHomePanel(map) {
    Array.prototype.forEach.call(document.querySelectorAll('.county-list .county-btn'), function (a) {
      if (a.classList.contains('town-btn')) return;
      a.addEventListener('click', function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
        var name = (a.textContent || '').replace(/\s*›\s*$/, '').replace(/\s*County\s*$/i, '').trim();
        var data = COUNTY_DATA[name];
        if (!data || !(data.towns || []).length) return;  // no towns yet -> let the link do its job
        ev.preventDefault();
        enterCounty(map, name, data, countyView.layer && countyView.layer[name]);
      });
    });
  }

  function init() {
    var mapEl = document.getElementById('county-map');
    if (!mapEl || typeof L === 'undefined') return;

    var map = L.map('county-map', {
      zoomControl: true,
      scrollWheelZoom: true,
      attributionControl: true,
      minZoom: 7,
    }).setView([40.35, -104.85], 8);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 18,
    }).addTo(map);

    // 2026-08-17: reveal the play badge on video-backed pins once you are zoomed in
    // far enough that pins are not on top of each other. See poiIcon().
    //
    // THIS HANDLER TOGGLES A CSS CLASS AND DOES NOTHING ELSE, and that restraint is
    // the whole point. On 2026-08-17 a view change of mine hid every one of her spot
    // pins and she wrote "all of my embedded videos are all gone!!!! I had so many" --
    // and separately, a browser-cache issue had her reporting that pins "disappear
    // when we zoom in" for a bug that never existed. Zoom on this map has now been
    // suspected twice. So this must never add, remove, hide or re-create a layer:
    // if it only ever sets a class name, it cannot be the cause of a third one.
    // Pinned by test-mapspots.js.
    var ZOOM_SHOW_VIDEO_BADGE = 10;
    function syncZoomClass() {
      mapEl.classList.toggle('map-zoomed-in', map.getZoom() >= ZOOM_SHOW_VIDEO_BADGE);
    }
    map.on('zoomend', syncZoomClass);
    syncZoomClass();

    // County data first: the popup's live-search decision and city list come
    // from it, and a polygon is clickable the moment it's drawn.
    loadCountyData()
      .then(function () { return fetch('/assets/data/noco-counties.geojson'); })
      .then(function (r) { return r.json(); })
      .then(function (geojson) {
        var layer = L.geoJSON(geojson, {
          style: function () {
            return { fillColor: BASE_FILL, fillOpacity: 0.9, color: BORDER, weight: 1.5 };
          },
          onEachFeature: function (feature, lyr) {
            var name = feature.properties.NAME;
            var slug = COUNTY_SLUGS[name];

            // Permanent label at the county's visual center, not just a hover tooltip.
            lyr.bindTooltip(name.toUpperCase(), {
              permanent: true,
              direction: 'center',
              className: 'county-label-tooltip',
              opacity: 1,
            });

            lyr.on('mouseover', function () {
              if (countyView.active) return;   // don't fight the selection paint
              lyr.setStyle({ fillColor: HOVER_FILL });
            });
            lyr.on('mouseout', function () {
              if (countyView.active) return;
              lyr.setStyle({ fillColor: BASE_FILL });
            });
            // Remembered so the sidebar's county links can zoom to the same
            // bounds the map click does.
            countyView.layer = countyView.layer || {};
            countyView.layer[name] = lyr;

            lyr.on('click', function () {
              var data = COUNTY_DATA[name];
              // Drill into the towns when there are any. See the note above
              // enterCounty() for why this beats jumping to a county-wide price
              // filter; counties with no town pages keep the old behaviour rather
              // than opening an empty panel.
              if (data && (data.towns || []).length) {
                enterCounty(map, name, data, lyr);
                return;
              }
              lyr.setStyle({ fillColor: CLICK_FILL });
              openQuickSearch({
                label: name + ' County',
                cities: COUNTY_CITIES[name] || [],
                covered: !!IRES_COUNTIES[name],
                guideHref: slug ? '/communities/' + slug + '.html' : null,
              });
            });
          },
        }).addTo(map);

        // City icon markers, for extra detail on the priority (Larimer /
        // Weld / Boulder) counties, matching the original map's level of
        // on-map detail. Priority cities keep an always-visible label;
        // the rest show their name on hover so the dense cluster of small
        // towns doesn't turn into unreadable overlapping text.
        CITY_ICONS.forEach(function (city) {
          var marker = L.marker([city.lat, city.lng], { icon: cityIcon(city), interactive: true, zIndexOffset: 500 }).addTo(map);
          cityMarkers.push(marker);
          if (city.priority) {
            var lbl = L.marker([city.lat, city.lng], { icon: cityLabel(city), interactive: false }).addTo(map);
            cityMarkers.push(lbl);
          } else {
            marker.bindTooltip(city.name, { direction: 'right', offset: [14, 0] });
          }
          // Every CITY_ICONS entry is inside Larimer/Weld/Boulder (see the
          // grouping comments above), so live search always covers it.
          marker.on('click', function () {
            openQuickSearch({ label: city.name, cities: [city.name], covered: true });
          });
        });

        // Lifestyle/amenity POI markers (golf courses, restaurants, etc. —
        // see POI_MARKERS above). Distinct rose-colored round icon so they
        // read as "a real place with a video," not just another city pin.
        POI_MARKERS.forEach(function (poi) { addPoiMarker(map, poi); });

        // Christine's own local spots, geocoded and cached server-side (see
        // netlify/functions/local-spots.js). Fetched rather than baked in
        // because coordinates have to come from a real geocode -- guessed
        // coordinates would pin her personal recommendation onto the wrong
        // building. Failure is silent by design: the counties, cities and
        // rivers are already drawn by this point, so a spots outage costs
        // detail, never the map.
        fetch('/.netlify/functions/local-spots')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data || !Array.isArray(data.spots)) return;
            data.spots.forEach(function (spot) { addPoiMarker(map, spot); });
          })
          .catch(function () { /* map already works without them */ });

        // River lines + script-font labels, matching the original map's
        // "Cache la Poudre River" / "South Platte River" cursive callouts.
        RIVERS.forEach(function (river) {
          L.polyline(river.points, {
            color: '#7FA9BA', weight: 2, opacity: 0.85, interactive: false,
          }).addTo(map);
          L.marker(river.labelAt, {
            icon: L.divIcon({
              html: '<div class="river-label" style="transform:rotate(' + river.labelRotate + 'deg)">' + river.name + '</div>',
              className: '', iconSize: [0, 0],
            }),
            interactive: false,
          }).addTo(map);
        });

        countyView.homeBounds = layer.getBounds();
        map.fitBounds(countyView.homeBounds, { padding: [20, 20] });
        // Sidebar links drill down the same way the map shapes do, now that the
        // county data and the layers both exist.
        bindHomePanel(map);
      });
  }

  // Style the permanent county-label tooltips via a small injected stylesheet
  // (Leaflet renders tooltips outside our normal CSS scope).
  var style = document.createElement('style');
  style.textContent =
    // Town pins for the drill-down. A labelled dot rather than a bare marker: at
    // county zoom the whole point is reading which town is which, and the icon-only
    // pins the map already uses need a hover to identify.
    '.town-pin{transform:translate(-7px,-7px);display:flex;align-items:center;gap:7px;' +
    'white-space:nowrap;cursor:pointer}' +
    '.town-pin::before{content:"";width:14px;height:14px;border-radius:50%;' +
    'background:#B86F7A;border:2px solid #F9F9EC;box-shadow:0 1px 5px rgba(0,0,0,.6);' +
    'flex:0 0 auto}' +
    '.town-pin span{font-family:"Poppins",sans-serif;font-weight:600;font-size:12px;' +
    'color:#F9F9EC;text-shadow:0 1px 4px rgba(0,0,0,.9);letter-spacing:.02em}' +
    '.town-pin:hover::before{background:#F9F9EC;border-color:#B86F7A}' +
    '.county-back{display:block;width:100%;text-align:left;background:none;border:none;' +
    'color:#BA8C84;font-family:"Poppins",sans-serif;font-size:12px;letter-spacing:.08em;' +
    'text-transform:uppercase;padding:0 0 14px;cursor:pointer}' +
    '.county-back:hover{color:#F9F9EC}' +
    '.county-panel-title{font-family:"Poppins",sans-serif;color:#F9F9EC;font-size:13px;' +
    'letter-spacing:.1em;text-transform:uppercase;margin:0 0 12px;opacity:.7}' +
    '.county-wide-btn{display:block;width:100%;text-align:left;margin-top:14px;' +
    'background:none;border:1px solid rgba(249,249,236,.35);color:#F9F9EC;' +
    'font-family:"Poppins",sans-serif;font-size:13px;padding:14px 18px;cursor:pointer}' +
    '.county-wide-btn:hover{border-color:#BA8C84;color:#BA8C84}' +
    '.county-guide-link{display:block;margin-top:12px;color:#BA8C84;font-size:12px;' +
    'font-family:"Poppins",sans-serif;text-decoration:underline}' +
    '.county-guide-link:hover{color:#F9F9EC}' +
    '.county-label-tooltip{background:transparent;border:none;box-shadow:none;' +
    'color:#F9F9EC;font-family:"Poppins",sans-serif;font-weight:700;font-size:13px;' +
    'letter-spacing:.04em;text-shadow:0 1px 4px rgba(0,0,0,.85);}' +
    '.county-label-tooltip::before{display:none;}';
  document.head.appendChild(style);

  // 2026-08-13 (performance fix): this script (plus leaflet.css/leaflet.js)
  // is now lazy-injected only when the #county-map section nears the
  // viewport (see the loadMapWhenNear() loader build.py writes into each
  // page's <head>) instead of being loaded eagerly on every page view. By
  // the time that happens the DOM has always already finished loading, so
  // the DOMContentLoaded event this used to wait for has already fired and
  // would never come again -- init() must run immediately in that case.
  // Kept the DOMContentLoaded fallback too so this file still works
  // correctly if it's ever loaded the old eager way.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
