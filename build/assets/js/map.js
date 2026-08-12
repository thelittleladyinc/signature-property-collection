/*
 * Northern Colorado "Find Your Community" interactive county map.
 * Built with Leaflet + OpenStreetMap-based tiles (both free, no API key)
 * and real US Census county boundary data, styled to the audited brand
 * palette (dusty rose #B86F7A / mauve #BA8C84 — no red). Click a county to
 * go to its page; hover to preview. Priority counties (Larimer, Weld,
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
    'Adams': 'adams'
  };

  // City lists per county, kept in sync by hand with COUNTIES[].cities in
  // build.py (same pattern already used for CITY_ICONS below) — this is what
  // powers the "click a county -> search all its cities at once" popup.
  // Only the three IRES-covered counties (priority=True in build.py) get
  // live MLS results; the rest fall back to the county guide page link only
  // since a live search there would just return zero matches.
  var COUNTY_CITIES = {
    'Larimer': ['Fort Collins', 'Loveland', 'Berthoud', 'Masonville', 'Windsor',
      'Timnath', 'Wellington', 'Red Feather Lakes'],
    'Weld': ['Greeley', 'Windsor', 'Severance', 'Eaton', 'Ault', 'Johnstown',
      'Milliken', 'Firestone', 'Frederick', 'Dacono', 'Fort Lupton', 'Mead', 'Erie'],
    'Boulder': ['Boulder', 'Lafayette', 'Louisville', 'Nederland']
  };
  var IRES_COUNTIES = { 'Larimer': true, 'Weld': true, 'Boulder': true };

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
  var POI_ICONS = {
    golf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="21" x2="6" y2="3"/><path d="M6 3 L17 7 L6 11 Z" fill="currentColor" stroke="none"/><circle cx="6" cy="21" r="1.6" fill="currentColor" stroke="none"/></svg>',
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
  ];

  function poiIcon(poi) {
    var glyph = POI_ICONS[poi.icon] || POI_ICONS.golf;
    return L.divIcon({
      html: '<div class="poi-icon-marker">' + glyph + '</div>',
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
    overlay.querySelector('#poi-blurb').textContent = poi.blurb || '';
    overlay.querySelector('#poi-source').textContent = poi.videoSource ? ('Video: ' + poi.videoSource) : '';
    overlay.querySelector('#poi-video-wrap').innerHTML =
      '<iframe width="100%" height="100%" style="display:block" ' +
      'src="https://www.youtube-nocookie.com/embed/' + poi.videoId + '?rel=0" ' +
      'title="' + String(poi.videoTitle || poi.name).replace(/"/g, '&quot;') + '" frameborder="0" ' +
      'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
      'allowfullscreen></iframe>';

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
      points: [
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
      : 'Live search covers Larimer, Weld & Boulder County. Browse the area guide below instead.';
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

    fetch('/assets/data/noco-counties.geojson')
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
              lyr.setStyle({ fillColor: HOVER_FILL });
            });
            lyr.on('mouseout', function () {
              lyr.setStyle({ fillColor: BASE_FILL });
            });
            lyr.on('click', function () {
              lyr.setStyle({ fillColor: CLICK_FILL });
              var covered = !!IRES_COUNTIES[name];
              openQuickSearch({
                label: name + ' County',
                cities: COUNTY_CITIES[name] || [],
                covered: covered,
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
          if (city.priority) {
            L.marker([city.lat, city.lng], { icon: cityLabel(city), interactive: false }).addTo(map);
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
        POI_MARKERS.forEach(function (poi) {
          var marker = L.marker([poi.lat, poi.lng], {
            icon: poiIcon(poi), interactive: true, zIndexOffset: 600,
          }).addTo(map);
          marker.bindTooltip('▶ Watch: ' + poi.name, { direction: 'top', offset: [0, -10] });
          marker.on('click', function () { openPoiModal(poi); });
        });

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

        map.fitBounds(layer.getBounds(), { padding: [20, 20] });
      });
  }

  // Style the permanent county-label tooltips via a small injected stylesheet
  // (Leaflet renders tooltips outside our normal CSS scope).
  var style = document.createElement('style');
  style.textContent =
    '.county-label-tooltip{background:transparent;border:none;box-shadow:none;' +
    'color:#F9F9EC;font-family:"Poppins",sans-serif;font-weight:700;font-size:13px;' +
    'letter-spacing:.04em;text-shadow:0 1px 4px rgba(0,0,0,.85);}' +
    '.county-label-tooltip::before{display:none;}';
  document.head.appendChild(style);

  document.addEventListener('DOMContentLoaded', init);
})();
