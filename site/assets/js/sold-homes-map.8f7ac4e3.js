/*
 * Sold Homes Map — Christine's request 2026-08-13: "map my sold listings
 * and their videos using google api to be able to document homes sold."
 * Built with Leaflet (already vendored for the county map, free, no
 * client-side API key) for the actual map rendering; the pin coordinates
 * themselves come from Google's Geocoding API, called server-side by
 * netlify/functions/sold-homes-geocode.js so the API key never reaches
 * the browser. See that function's file comment for the full design
 * rationale (same "secret key stays server-side" pattern as
 * nearby-places.js).
 *
 * 2026-08-14: two changes, both from Christine asking why only 12 of her
 * 150+ sales were on the map. A pin no longer needs a YouTube tour to
 * exist (videoId is optional now, and homes without one get an
 * address-only popup instead of a broken video link), and because the
 * address list is now long enough that a cold geocode cache can't be
 * filled inside one function invocation, this polls for the rest instead
 * of showing whatever happened to resolve first and stopping there. See
 * the function's `pending` flag.
 */
(function () {
  var mapEl = document.getElementById('sold-homes-map');
  if (!mapEl) return;
  var statusEl = document.getElementById('sold-homes-map-status');

  var BASE_FILL = '#B86F7A'; // dusty rose, matches brand palette
  var MAX_REFETCHES = 6;     // ~1 min of warming, then leave it alone
  var REFETCH_DELAY_MS = 10000;

  var plotted = {};   // address -> true, so a refetch never double-pins
  var markers = [];
  var refetches = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function popupHtml(pin) {
    var when = pin.year ? '<p style="margin:6px 0 0;font-size:12px;color:#6a6a6c;' +
      'line-height:1.5">Sold ' + esc(pin.year) + '</p>' : '';
    var where = '<p style="margin:6px 0 0;font-size:12px;color:#6a6a6c;line-height:1.5">' +
      esc(pin.address) + '</p>';

    // No tour filmed for this one — the address is the whole popup. Better
    // than the old behavior, which assumed every pin had a video and built
    // a YouTube thumbnail URL out of an undefined ID.
    if (!pin.videoId) {
      return '<div style="width:220px">' + where + when + '</div>';
    }

    var thumb = 'https://i.ytimg.com/vi/' + encodeURIComponent(pin.videoId) + '/hqdefault.jpg';
    var watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(pin.videoId);
    return '' +
      '<div style="width:220px">' +
      '<a href="' + watchUrl + '" target="_blank" rel="noopener" style="display:block;text-decoration:none">' +
      '<img src="' + thumb + '" alt="" loading="lazy" style="width:100%;display:block;border-radius:4px;margin-bottom:8px">' +
      '<span style="font-family:inherit;font-size:13px;font-weight:600;color:#141415;line-height:1.4">' +
      '&#9654; Watch This Home’s Tour</span></a>' +
      where + when +
      '</div>';
  }

  function showStatus(msg) {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.display = 'block'; }
  }

  function hideStatus() {
    if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; }
  }

  // An empty dark rectangle reads as broken. If there will never be pins,
  // drop the canvas entirely and let the status line stand on its own.
  function hideMapCanvas() {
    mapEl.style.display = 'none';
  }

  var map = L.map(mapEl, { scrollWheelZoom: false }).setView([40.35, -104.9], 8);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  }).addTo(map);

  function addPins(pins) {
    var added = 0;
    pins.forEach(function (pin) {
      if (typeof pin.lat !== 'number' || typeof pin.lng !== 'number') return;
      if (plotted[pin.address]) return;
      plotted[pin.address] = true;
      var marker = L.circleMarker([pin.lat, pin.lng], {
        radius: 9,
        fillColor: BASE_FILL,
        color: '#F9F9EC',
        weight: 2,
        fillOpacity: 0.95,
      }).bindPopup(popupHtml(pin));
      marker.addTo(map);
      markers.push(marker);
      added += 1;
    });
    return added;
  }

  function fitToPins() {
    if (!markers.length) return;
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.25));
  }

  function load(isRefetch) {
    fetch('/.netlify/functions/sold-homes-geocode')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // 2026-08-15: this used to tell the visitor the site "just needs a
        // Google Maps API key added to this site's settings". True, but it is
        // Christine's setup detail showing on a public page to buyers, and
        // since the key genuinely isn't set yet it was the message EVERY
        // visitor saw. Now the map hides itself and points at the pages that
        // do work; the real reason goes to the console for whoever is
        // debugging, not to the reader.
        if (data.error === 'not_configured') {
          console.warn('sold-homes-map: GOOGLE_MAPS_API_KEY is not set on this site.');
          hideMapCanvas();
          showStatus('The map isn’t available right now — every home with a filmed tour is ' +
            'on the Past Sales and Listing Video Portfolio pages linked below.');
          return;
        }
        if (data.error) {
          if (!markers.length) {
            hideMapCanvas();
            showStatus('The map couldn’t load right now. Every home with a filmed tour is ' +
              'on the Past Sales and Listing Video Portfolio pages linked below.');
          }
          return;
        }
        var pins = data.pins || [];
        if (!pins.length && !markers.length) {
          if (!data.pending) {
            hideMapCanvas();
            showStatus('No mapped sold homes yet — every home with a filmed tour is on the ' +
              'Past Sales and Listing Video Portfolio pages linked below.');
          }
          return;
        }

        var added = addPins(pins);
        // Only re-frame the map on the first load, or when a refetch
        // actually brought in a pin outside the current view — otherwise
        // the map would jump under the reader every ten seconds.
        if (!isRefetch || added) fitToPins();
        hideStatus();

        // The server still has addresses it hasn't geocoded yet (cold
        // cache). They're permanent once resolved, so a short poll fills
        // the map in on this same visit rather than making her reload.
        if (data.pending && refetches < MAX_REFETCHES) {
          refetches += 1;
          setTimeout(function () { load(true); }, REFETCH_DELAY_MS);
        }
      })
      .catch(function () {
        if (!markers.length) {
          hideMapCanvas();
          showStatus('The map couldn’t load right now. Every home with a filmed tour is on the ' +
            'Past Sales and Listing Video Portfolio pages linked below.');
        }
      });
  }

  load(false);
})();
