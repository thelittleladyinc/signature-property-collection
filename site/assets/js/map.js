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
              if (slug) {
                window.location.href = '/communities/' + slug + '.html';
              }
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
