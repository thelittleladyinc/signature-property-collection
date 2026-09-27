/* "Recently sold & open houses" strip -- browser side.
 *
 * The section ships in the page with the `hidden` attribute and an empty list.
 * This asks /.netlify/functions/recent-activity (which alone holds the Listing
 * Engine key) for up to four cards; with none -- or on any error -- the
 * section simply stays hidden, so there is nothing to reserve and nothing to
 * shift. Every value is written with textContent / setAttribute, never as
 * HTML, so nothing from the feed can inject markup.
 */
(function () {
  "use strict";
  var sections = document.querySelectorAll("[data-recent-activity]");
  if (!sections.length || !window.fetch) return;

  var money = function (n) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
    } catch (e) { return "$" + Math.round(n); }
  };
  var count = function (n) {
    try { return new Intl.NumberFormat("en-US").format(n); } catch (e) { return String(n); }
  };
  var el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  var isHttps = function (u) { return typeof u === "string" && /^https:\/\//i.test(u); };

  function card(item) {
    var li = el("li", "ra-card");
    var wrap = isHttps(item.url) ? el("a", "ra-link") : el("div", "ra-link");
    if (wrap.tagName === "A") wrap.href = item.url;

    var photo = el("div", "ra-photo");
    if (isHttps(item.photo_url)) {
      var img = el("img");
      img.src = item.photo_url;
      img.alt = ""; // the address is right below; repeating it is noise for a screen reader
      img.loading = "lazy";
      img.decoding = "async";
      img.width = 640;
      img.height = 427;
      img.onerror = function () { photo.removeChild(img); };
      photo.appendChild(img);
    }
    wrap.appendChild(photo);

    var body = el("div", "ra-body");
    var sold = item.type === "just_sold";
    body.appendChild(el("span", "ra-badge " + (sold ? "ra-badge-sold" : "ra-badge-open"), sold ? "Just Sold" : "Open House"));
    var when = sold ? (item.sold_label ? "Closed " + item.sold_label : "") : (item.open_house && item.open_house.label) || "";
    if (when) body.appendChild(el("p", "ra-when", when));
    body.appendChild(el("h3", "ra-address", item.address));
    if (item.city) body.appendChild(el("p", "ra-city", item.city));

    if (item.price) {
      var price = el("p", "ra-price", money(item.price));
      if (item.price_label === "list" && sold) price.appendChild(el("span", "ra-price-note", " last list price"));
      else if (item.price_label === "sold") price.appendChild(el("span", "ra-price-note", " sold price"));
      body.appendChild(price);
    }
    var facts = [];
    if (item.beds) facts.push(count(item.beds) + " bd");
    if (item.baths) facts.push(count(item.baths) + " ba");
    if (item.sqft) facts.push(count(item.sqft) + " sq ft");
    if (facts.length) body.appendChild(el("p", "ra-facts", facts.join(" · ")));

    wrap.appendChild(body);
    li.appendChild(wrap);
    return li;
  }

  var endpoint = sections[0].getAttribute("data-recent-activity") || "/.netlify/functions/recent-activity";
  fetch(endpoint, { headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : { items: [] }; })
    .then(function (data) {
      var items = (data && Array.isArray(data.items) ? data.items : []).slice(0, 4);
      if (!items.length) return;
      for (var i = 0; i < sections.length; i++) {
        var list = sections[i].querySelector(".ra-grid");
        if (!list) continue;
        for (var j = 0; j < items.length; j++) {
          if (items[j] && items[j].address) list.appendChild(card(items[j]));
        }
        if (list.children.length) sections[i].hidden = false;
      }
    })
    .catch(function () { /* stays hidden */ });
})();
