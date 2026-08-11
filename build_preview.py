import json, base64, os

BASE = "/root/signature-migration"
BUILD = os.path.join(BASE, "build")

css = open(os.path.join(BUILD, "assets/css/style.css")).read()
leaflet_css = open(os.path.join(BUILD, "assets/vendor/leaflet/leaflet.css")).read()
leaflet_js = open(os.path.join(BUILD, "assets/vendor/leaflet/leaflet.js")).read()
mapjs = open(os.path.join(BUILD, "assets/js/map.js")).read()
geojson = open(os.path.join(BUILD, "assets/data/noco-counties.geojson")).read()
logo_svg = open(os.path.join(BUILD, "assets/img/logo.svg")).read()
logo_b64 = base64.b64encode(logo_svg.encode()).decode()

# Leaflet's CSS references marker images via relative url(images/...) —
# inline those as data URIs so the standalone file has zero external deps
# for the map chrome itself (tiles still come from the network, same as
# any live map).
img_dir = os.path.join(BUILD, "assets/vendor/leaflet/images")
for fname in os.listdir(img_dir):
    with open(os.path.join(img_dir, fname), "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    leaflet_css = leaflet_css.replace(f"images/{fname}", f"data:image/png;base64,{b64}")

# map.js normally fetch()es the geojson from a relative path — swap that for
# the inlined data so this works as a single file with no server.
mapjs_inline = mapjs.replace(
    "fetch('/assets/data/noco-counties.geojson')\n      .then(function (r) { return r.json(); })",
    f"Promise.resolve({geojson})"
)

html = f"""<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview — The Bold Collective / Find Your Community Map</title>
<style>
{leaflet_css}
{css}
body {{ margin:0; }}
.preview-banner {{
  background:#000; color:#F9F9EC; text-align:center; padding:10px 16px;
  font-family:'Poppins',sans-serif; font-size:13px; letter-spacing:.03em;
}}
</style>
</head>
<body>
<div class="preview-banner">Standalone preview — new brand colors, real logo, bigger interactive map with city icons. Not yet live on the internet.</div>
<header class="site-header">
  <div class="wrap">
    <div class="brand">
      <img class="brand-logo" src="data:image/svg+xml;base64,{logo_b64}" alt="Signature Property Collection">
    </div>
  </div>
</header>
<section class="county-hero">
  <div class="wrap">
    <span class="eyebrow">Click To Explore</span>
    <h1 class="section-title" style="color:#fff">Find Your Community</h1>
    <p class="lede" style="color:rgba(255,255,255,.8)">Explore Northern Colorado county by
    county — Larimer, Weld, Boulder, Broomfield, Jefferson, Denver, Arapahoe, and Adams.</p>
  </div>
</section>
<section class="tight">
  <div class="wrap communities-layout">
    <div class="communities-panel">
      <div class="county-list">
        <a class="county-btn" href="#">Larimer County <span>&rsaquo;</span></a>
        <a class="county-btn" href="#">Weld County <span>&rsaquo;</span></a>
        <a class="county-btn" href="#">Boulder County <span>&rsaquo;</span></a>
        <a class="county-btn" href="#">Broomfield County <span>&rsaquo;</span></a>
        <a class="county-btn" href="#">Jefferson County <span>&rsaquo;</span></a>
        <a class="county-btn" href="#">Denver County <span>&rsaquo;</span></a>
        <a class="county-btn" href="#">Arapahoe County <span>&rsaquo;</span></a>
        <a class="county-btn" href="#">Adams County <span>&rsaquo;</span></a>
      </div>
    </div>
    <div id="county-map"></div>
  </div>
</section>
<script>
{leaflet_js}
</script>
<script>
{mapjs_inline}
</script>
</body>
</html>
"""

out_path = os.path.join(BASE, "map_preview.html")
with open(out_path, "w") as f:
    f.write(html)
print("wrote", out_path, len(html), "bytes")
