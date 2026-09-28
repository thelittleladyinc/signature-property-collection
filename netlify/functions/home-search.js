// /search-homes.html -> Christine's Lofty home search, with the same filters.
//
// 2026-09-28 (Christine: "Every 'Search Homes' button goes to Lofty" -- the plan
// she approved with "lets do it!!!"). The site links to /search-homes.html from
// the menu, the footer, every town and neighborhood page ("See All & Refine This
// Search"), the map's price buttons and more, most of them carrying a filter in
// the query string (?cities=loveland&minPrice=950000). Rather than rewrite every
// one of those links, build.py routes /search-homes.html here (a forced rewrite
// in _redirects, written only while LISTINGS_SOURCE is lofty) and this answers
// with a redirect to the same search on her Lofty site (lib/_home-search.js).
//
// 302, not 301: where the search lives is a setting (IDX_SEARCH_URL) that will
// change when she moves her Lofty site to its new domain, and a browser that
// cached a permanent redirect would keep going to the old one.
"use strict";

const { homeSearchUrl } = require("./lib/_home-search");

exports.handler = async (event) => {
  const params = (event && event.queryStringParameters) || {};
  const location = homeSearchUrl(params);
  return {
    statusCode: 302,
    headers: {
      Location: location,
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex",
    },
    body: "",
  };
};
