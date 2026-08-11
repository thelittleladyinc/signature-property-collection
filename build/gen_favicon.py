#!/usr/bin/env python3
"""Regenerate the favicon file set from the real SPC brand "Logomark_01"
diamond monogram (black diamond + P/C letterforms + rose cursive "S" swash),
replacing the earlier synthetic charcoal+cream "S" placeholder.

Source: /root/photos/logomarks/logomark_01.png (1080x1080 RGBA, transparent
background) pulled from Christine's Google Drive brand-assets folder
2026-08-11.

Outputs (written to build/assets/img/, matching the filenames/sizes already
referenced by build.py's <head> favicon tags):
  favicon-16x16.png, favicon-32x32.png, favicon-512.png,
  apple-touch-icon.png (180x180, opaque cream background per Apple's
  guidance — Apple's touch-icon renderer does not respect alpha and shows
  black where transparent, so a flat background square is composited in
  behind the mark, cream to match the site's --cream background token),
  android-chrome-192x192.png, android-chrome-512x512.png,
  favicon.ico (multi-size: 16, 32, 48).
"""
from PIL import Image

SRC = "/root/photos/logomarks/logomark_01.png"
OUT_DIR = "/root/signature-migration/build/assets/img"
CREAM = (250, 247, 242, 255)  # --cream brand token, for opaque backgrounds

im = Image.open(SRC).convert("RGBA")

# Small transparent padding margin so the mark doesn't touch the very edge
# once downsized (helps it read cleanly at 16x16 instead of clipping).
pad_frac = 0.06
w, h = im.size
pad = int(w * pad_frac)
canvas = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (255, 255, 255, 0))
canvas.paste(im, (pad, pad), im)
im = canvas


def save_png(size, path, background=None):
    resized = im.resize((size, size), Image.LANCZOS)
    if background:
        flat = Image.new("RGBA", resized.size, background)
        flat.alpha_composite(resized)
        flat.convert("RGB").save(path, "PNG")
    else:
        resized.save(path, "PNG")


save_png(16, f"{OUT_DIR}/favicon-16x16.png")
save_png(32, f"{OUT_DIR}/favicon-32x32.png")
save_png(512, f"{OUT_DIR}/favicon-512.png")
save_png(192, f"{OUT_DIR}/android-chrome-192x192.png")
save_png(512, f"{OUT_DIR}/android-chrome-512x512.png")
# Apple touch icon: opaque background (iOS renders transparent PNG touch
# icons on black), cream to match the site.
save_png(180, f"{OUT_DIR}/apple-touch-icon.png", background=CREAM)

# Multi-resolution .ico (16/32/48), transparent background — all major
# browsers support alpha in .ico.
ico_sizes = [16, 32, 48]
ico_frames = [im.resize((s, s), Image.LANCZOS) for s in ico_sizes]
ico_frames[0].save(
    f"{OUT_DIR}/favicon.ico",
    format="ICO",
    sizes=[(s, s) for s in ico_sizes],
    append_images=ico_frames[1:],
)

print("Favicon set regenerated from Logomark_01.")
