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
 */
(function () {
  var mapEl = document.getElementById('sold-homes-map');
  if (!mapEl) return;
  var statusEl = document.getElementById('sold-homes-map-status');

  var BASE_FILL = '#B86F7A'; // dusty rose, matches brand palette

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function popupHtml(pin) {
    var thumb = 'https://i.ytimg.com/vi/' + encodeURIComponent(pin.videoId) + '/hqdefault.jpg';
    var watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(pin.videoId);
    return '' +
      '<div style="width:220px">' +
      '<a href="' + watchUrl + '" target="_blank" rel="noopener" style="display:block;text-decoration:none">' +
      '<img src="' + thumb + '" alt="" loading="lazy" style="width:100%;display:block;border-radius:4px;margin-bottom:8px">' +
      '<span style="font-family:inherit;font-size:13px;font-weight:600;color:#141415;line-height:1.4">' +
      '&#9654; Watch This Home’s Tour</span></a>' +
      '<p style="margin:6px 0 0;font-size:12px;color:#6a6a6c;line-height:1.5">' + esc(pin.address) + '</p>' +
      '</div>';
  }

  function showStatus(msg) {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.display = 'block'; }
  }

  var map = L.map(mapEl, { scrollWheelZoom: false }).setView([40.35, -104.9], 8);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  }).addTo(map);

  fetch('/.netlify/functions/sold-homes-geocode')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error === 'not_configured') {
        showStatus('The map is almost ready — it just needs a Google Maps API key added to this site’s settings before it can plot addresses.');
        return;
      }
      if (data.error) {
        showStatus('The map couldn’t load right now. Please try again shortly.');
        return;
      }
      var pins = data.pins || [];
      if (!pins.length) {
        showStatus('No sold-home locations are available yet.');
        return;
      }
      var markers = [];
      pins.forEach(function (pin) {
        if (typeof pin.lat !== 'number' || typeof pin.lng !== 'number') return;
        var marker = L.circleMarker([pin.lat, pin.lng], {
          radius: 9,
          fillColor: BASE_FILL,
          color: '#F9F9EC',
          weight: 2,
          fillOpacity: 0.95,
        }).bindPopup(popupHtml(pin));
        marker.addTo(map);
        markers.push(marker);
      });
      if (markers.length) {
        var group = L.featureGroup(markers);
        map.fitBounds(group.getBounds().pad(0.25));
      }
      if (statusEl) statusEl.style.display = 'none';
    })
    .catch(function () {
      showStatus('The map couldn’t load right now. Please try again shortly.');
    });
})();
