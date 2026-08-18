#!/usr/bin/env python3
"""Regenerates assets/img/og-card.png — the 1200x630 social/share card.

2026-08-18: og:image was logo-full.png, a wide transparent-background logo
that share platforms crop unpredictably. This composes the brand card the
og spec actually wants: logo centered on the site's cream (--cream #F8F6F4)
inside a crop-safe area, with the rose+charcoal keyline echoing the site's
card styling. Run from repo root: python3 build/tools/make-og-card.py
"""
from PIL import Image, ImageDraw

W, H = 1200, 630
CREAM = (248, 246, 244, 255)
ROSE = (184, 111, 122, 255)
CHARCOAL = (20, 20, 21, 255)

card = Image.new("RGBA", (W, H), CREAM)
logo = Image.open("build/assets/img/logo-full.png").convert("RGBA")
r = min(880 / logo.width, 380 / logo.height)
logo = logo.resize((round(logo.width * r), round(logo.height * r)), Image.LANCZOS)
card.alpha_composite(logo, ((W - logo.width) // 2, (H - logo.height) // 2 - 20))
d = ImageDraw.Draw(card)
d.rectangle([0, H - 14, W, H], fill=ROSE)
d.rectangle([0, H - 16, W, H - 14], fill=CHARCOAL)
card.convert("RGB").save("build/assets/img/og-card.png", optimize=True)
print("wrote build/assets/img/og-card.png")
