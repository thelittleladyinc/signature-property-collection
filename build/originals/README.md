# Source originals — kept in git, never deployed

These are the full-quality JPEG originals for hero images whose pages render the
`.webp` version. They are **not referenced by any page**, so shipping them did
nothing for a visitor: no browser ever requested them. They were simply being
copied into `site/assets` and pushed to the CDN on every deploy — about 1.9MB of
storage and deploy bandwidth for files nobody could reach.

They are not deleted, because they are the only high-quality source left to
re-encode from if the WebP quality setting is ever revisited (the current WebPs
were produced at quality 58 — see the note in `build.py` on `CITY_HERO_PHOTOS`).
Deleting the originals would make that a one-way door.

`copy_static_assets()` mirrors `build/assets` into `site/assets` wholesale, which
is why "keep it but do not deploy it" means living in a sibling directory rather
than an ignore list — there is no list to get out of sync, and the directory name
says what it is.

## Rules

- Nothing in here is served. Do not link to it from a page.
- A file belongs here when it is a source we want to keep but not publish.
- If a page ever needs one of these, re-encode it into `build/assets` instead of
  moving it back — the published tree should carry the optimised file, not the
  original.

## What's here

`img/communities/` — eaton, erie, greeley, johnstown. Each has a `.webp` twin in
`build/assets/img/communities/` that the pages actually load as a CSS
background-image.
