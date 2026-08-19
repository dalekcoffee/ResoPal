#!/usr/bin/env python3
"""Compose a Palworld TCG card atlas for the Deck Maker template.

Layout must match the template's baked UVs: cells are filled row-major,
left-to-right, top-to-bottom, and each card fills its cell completely
(the template's own atlas has zero padding - verified by measurement).

  python3 compose.py --deck deck.json --art art/ --cards cards.json --out front.webp
"""
import argparse, json, os
from PIL import Image
from imgfix import solidify

COLS, ROWS = 10, 7          # must match the baked template's AtlasInfo GridSize
ROT = Image.ROTATE_270      # clockwise: landscape cards are turned right to read


def compose(deck, art_dir, landscape, size=8192):
    """deck: [{'code':..,'n':..}]  ->  RGBA atlas with one cell per physical card."""
    phys = [e["code"] for e in deck for _ in range(e["n"])]
    if len(phys) > COLS * ROWS:
        raise SystemExit(f"{len(phys)} cards exceeds the {COLS}x{ROWS} grid")
    atlas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for i, code in enumerate(phys):
        r, c = divmod(i, COLS)
        x0, y0 = round(c * size / COLS), round(r * size / ROWS)
        x1, y1 = round((c + 1) * size / COLS), round((r + 1) * size / ROWS)
        im = Image.open(os.path.join(art_dir, f"{code}.webp")).convert("RGBA")
        if code in landscape:
            im = im.transpose(ROT)
        # solidify BEFORE resizing: card art is matted against white, so the
        # antialiased edge pixels are light. Downscaling them straight would
        # leave a white rim that survives the material's alpha cutout.
        atlas.paste(solidify(im).resize((x1 - x0, y1 - y0), Image.LANCZOS), (x0, y0))
    return atlas, len(phys)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--deck", required=True, help="JSON: [{code,n,name}]")
    p.add_argument("--art", required=True, help="directory of <CODE>.webp")
    p.add_argument("--cards", required=True, help="Palify /api/cards snapshot")
    p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=8192, help="8192 keeps effect text readable")
    p.add_argument("--quality", type=int, default=95)
    a = p.parse_args()

    cards = json.load(open(a.cards))["cards"]
    landscape = {c["code"] for c in cards if c.get("landscape")}
    deck = json.load(open(a.deck))
    atlas, n = compose(deck, a.art, landscape, a.size)
    atlas.save(a.out, "WEBP", quality=a.quality, method=6, exact=True)
    print(f"{a.out}  {a.size}x{a.size}  cards={n}  {os.path.getsize(a.out)/1048576:.2f}MB")
    print(f"pass --cards {n} to patch.mjs so the deck is trimmed to match")


if __name__ == "__main__":
    main()
