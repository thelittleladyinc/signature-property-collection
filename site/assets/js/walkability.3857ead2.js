/*
 * Walkability panel — city and subdivision pages.
 *
 * 2026-08-15 (Christine's request): "a much more detailed walkability score
 * ... maybe add more than school, park and grocery store?" The scoring and
 * the Google Places calls all happen server-side in
 * netlify/functions/walkability.js (so the API key never ships to the
 * browser, same pattern as nearby-places.js and sold-homes-geocode.js);
 * this file only renders what comes back.
 *
 * Lazy: nothing is fetched until the section scrolls near the viewport, so a
 * visitor who never reaches it costs nothing. The observer watches a
 * zero-height sentinel rather than the section itself, because the section
 * ships [hidden] and a display:none element never intersects anything.
 *
 * The whole section — heading included — starts hidden and only reveals
 * itself once there is real data. If the Google key isn't configured yet, or
 * the lookup fails, or too few categories answer to mean anything, the
 * visitor simply never sees it. Two reasons: unlike the sold-homes map there
 * is no way for them to tell something is missing, and a bare "How Walkable
 * Is Eaton?" heading over an error message reads worse than no section at
 * all.
 */
(function () {
  var section = document.getElementById('walk-section');
  var panel = document.getElementById('walk-panel');
  if (!section || !panel) return;

  var place = panel.dataset.place;
  if (!place) return;
  // Subdivision pages pass their parent town so the function can reject a
  // neighborhood name that geocoded somewhere else entirely.
  var near = panel.dataset.near || '';

  var loaded = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtMiles(m) {
    if (m == null) return 'none nearby';
    if (m < 0.1) return 'on the block';
    return m.toFixed(m < 10 ? 1 : 0) + ' mi';
  }

  // Real estate sites date their neighborhood data, and it also makes the
  // 30-day refresh visible instead of implied.
  function checkedLine(data) {
    if (!data.checkedAt) return ' ';
    var d = new Date(data.checkedAt);
    if (isNaN(d)) return ' ';
    var when = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return ' Checked ' + when + '. ';
  }

  function catHtml(cat) {
    // Anything past the no-credit distance is greyed rather than hidden:
    // "nearest pharmacy is 6.2 mi" is genuinely useful for a rural town, and
    // hiding it would make the list look shorter in exactly the places where
    // the honest answer matters most.
    var far = cat.nearestMiles == null || cat.nearestMiles >= 1.5;
    var examples = (cat.examples || []).map(function (p) {
      // place_id is the one Places field Google lets us store, and linking
      // through it is both useful and how the attribution requirement is
      // properly met. Older cached entries predate placeId, so fall back to
      // plain text rather than rendering a dead link.
      var label = esc(p.name) + ' &middot; ' + fmtMiles(p.miles);
      if (!p.placeId) return '<li>' + label + '</li>';
      return '<li><a href="https://www.google.com/maps/place/?q=place_id:' +
        encodeURIComponent(p.placeId) + '" target="_blank" rel="noopener">' +
        label + '</a></li>';
    }).join('');
    return '<li class="walk-cat">' +
      '<div class="walk-cat-top">' +
      '<span class="walk-cat-label">' + esc(cat.label) + '</span>' +
      '<span class="walk-cat-dist' + (far ? ' walk-far' : '') + '">' +
      fmtMiles(cat.nearestMiles) + '</span>' +
      '</div>' +
      (examples ? '<ul class="walk-cat-examples">' + examples + '</ul>' : '') +
      '</li>';
  }

  function render(data) {
    var m = data.method || {};
    panel.innerHTML =
      '<div class="walk-headline">' +
      '<div class="walk-dial" role="img" aria-label="Walkability estimate ' +
      data.score + ' out of 100">' +
      '<div style="text-align:center">' +
      '<div class="walk-dial-score">' + data.score + '</div>' +
      '<div class="walk-dial-of">OUT OF 100</div>' +
      '</div></div>' +
      '<div>' +
      '<p class="walk-band">' + esc(data.band) + '</p>' +
      '<p class="walk-band-sub">Based on how close the nearest of each of ' +
      (m.categoryCount || 10) + ' everyday things is — groceries, food, coffee, ' +
      'schools, parks, the pharmacy, transit, a gym, the library, and a doctor.</p>' +
      '</div></div>' +
      '<ul class="walk-cats">' + (data.categories || []).map(catHtml).join('') + '</ul>' +
      '<p class="walk-method">How this is worked out: each category scores full marks if ' +
      'the nearest one is within ' + (m.fullCreditMiles || 0.25) + ' of a mile, tapering to ' +
      'nothing by ' + (m.noCreditMiles || 1.5) + ' miles, then weighted by how much it ' +
      'matters day to day. Distances are straight-line from the center of ' +
      esc(data.place) + ', not routed walking directions, so treat them as close ' +
      'estimates. This is our own estimate, not an official or licensed walkability ' +
      'rating.' + checkedLine(data) +
      '<span class="walk-attrib">Places data from <strong>Google Maps</strong>.</span></p>';
    section.hidden = false;
    // The sitewide scroll-reveal script tags every <section> with .reveal
    // (opacity: 0) and only clears it when its own observer fires. This section
    // ships [hidden], so that observer had nothing to observe while we were
    // waiting on data -- rather than depend on it firing correctly afterwards,
    // mark this section revealed ourselves. Harmless if the class isn't there.
    section.classList.add('is-visible');
  }

  function load() {
    if (loaded) return;
    loaded = true;
    var url = '/.netlify/functions/walkability?place=' + encodeURIComponent(place) +
      (near ? '&near=' + encodeURIComponent(near) : '');
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // No key configured, or the lookup failed, or too few categories came
        // back to mean anything -- stay hidden. A wrong or half-built score on
        // a town page is worse than no score.
        if (!data || data.error || data.score == null) return;
        if (data.coverage != null && data.coverage < 60) return;
        render(data);
      })
      .catch(function () { /* stays hidden */ });
  }

  var sentinel = document.getElementById('walk-sentinel');
  if (!('IntersectionObserver' in window) || !sentinel) { load(); return; }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) { io.disconnect(); load(); }
    });
  }, { rootMargin: '400px 0px' });
  io.observe(sentinel);
})();
