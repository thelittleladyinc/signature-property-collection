# Mapbox — your map data, gorgeous edition

Everything in this folder is generated from the same data your live site runs
on. Nothing here was typed by hand, and nothing changes the live site — this
is a preview and a data package, safe to play with.

Regenerate after adding a spot or a town:

    python3 build/tools/export_mapbox_data.py

## See it right now — `preview.html`

Open `mapbox/preview.html` in your browser (just double-click it). It asks
once for your Mapbox **public token**:

1. Go to <https://account.mapbox.com/access-tokens/>
2. Copy the **Default public token** (starts with `pk.`)
3. Paste it in. It's remembered on your device — you won't be asked again.

What you'll see, all in the brand (charcoal, dusty rose, cream, Corinthia):

- **Your nine counties** with elegant labels — hover glows, click zooms in.
- **All 37 towns** as labeled pins linking to their town pages and a
  pre-filtered $950K+ home search.
- **Every local spot** with its category glyph and the ▶ play badge when
  you zoom in, your video playing right in the popup, review quotes and all.
- **3D Terrain** — the Front Range actually rises out of the map. Try it
  with Satellite on and look at Horsetooth or the Poudre Canyon.
- **Fly the Tour** — a cinematic camera flight across seven of your spots,
  captioned in your voice. This is the "listing flyover" idea in miniature.
- **Filter chips** — Where I eat / Wine & drinks / Outdoors / Around town.

### About "approximate" pins

Most spots' exact coordinates live in your Netlify geocode cache, not in
this repo. The preview fetches them from the live site when it opens; until
that request succeeds (it needs the site deploy that adds the CORS header —
in this same branch), those pins sit at their town's center with a dashed
ring and say so. Nothing is ever guessed onto the wrong building.

## Upload to Mapbox Studio — `data/`

Mapbox Studio (<https://studio.mapbox.com>) → **Tilesets** (or Datasets) →
**New tileset** → upload:

| File | What it is |
|---|---|
| `data/spc-counties.geojson` | The nine county outlines, with your site's slugs |
| `data/spc-towns.geojson` | All 37 towns with links to their pages |
| `data/spc-local-spots.geojson` | Spots with repo-verified coordinates only |

For the **complete** spots file (every spot at its exact geocoded location),
open `preview.html` once the site has deployed, wait for the status line to
say "all at their exact geocoded locations", then click **⬇ GeoJSON for
Studio** in the bottom-right corner. That file is built from your live
geocoder, so every pin is on the right building.

## What this is not (yet)

The preview is a standalone page, not part of the website. If you like it,
the next steps are: a Studio style in the brand for the site itself, the
15-minute isochrone panel, and listing flyovers — see the review in the
session that built this.
