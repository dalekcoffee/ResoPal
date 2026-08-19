#!/usr/bin/env python3
"""Resize a card back to the template's cell aspect (0.700).

The card art is 0.7156 but the atlas cell is 0.700, so fronts are squashed 2.2%.
The back is matched to the same aspect so it doesn't sit at different proportions.
"""
import argparse, os
from PIL import Image
from imgfix import solidify

p = argparse.ArgumentParser()
p.add_argument("--src", required=True)
p.add_argument("--out", required=True)
p.add_argument("--width", type=int, default=1024)
a = p.parse_args()

h = round(a.width / 0.700)
im = solidify(Image.open(a.src).convert("RGBA")).resize((a.width, h), Image.LANCZOS)
im.save(a.out, "WEBP", quality=95, method=6, exact=True)
print(f"{a.out}  {a.width}x{h}  {os.path.getsize(a.out)/1048576:.2f}MB")
