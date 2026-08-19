# ResoPal

Turns a [Palworld TCG](https://palify.org) deck into a ready-to-import deck object for
[Resonite](https://resonite.com). Paste a deck link, get a `.resonitepackage` you drag into the
game.

Site: **resopal.dalek.coffee**

## Status

The **generator works end to end.** It produces a verified, importable deck from a real Palify
deck: correct card order, rounded corners, transparent edges, landscape cards rotated, custom card
back, credits, and any card count.

The **web front end is designed but not built.** `design/` holds the high-fidelity design handoff
from Claude Design — a self-contained HTML prototype plus a spec covering every screen, token and
interaction. `docs/DESIGN-PROMPT.md` is the brief it was built from.

## How it works

ResoPal does not build a deck from scratch. It takes a deck baked by
**[Deck Maker by Ukilop](resrec:///U-ukilop/R-e7100d16-9b62-4d74-b8e0-058b0492764f) V1.4.4**,
swaps in a composed card atlas and card back, trims it to the right number of cards, and re-packs
it. All the geometry is Ukilop's, reused byte-for-byte.

Read **[docs/PIPELINE.md](docs/PIPELINE.md)** before changing anything — it documents the atlas
contract, the package format, and several non-obvious fixes that are easy to undo by accident.

## Repo layout

```
tools/          the working generator (see below)
assets/         DefaultBack.png - the default card back
design/         front-end design handoff - prototype, spec, pack art, starter decks
  README.md        the spec: screens, tokens, state, interactions
  ResoPal.dc.html  self-contained HTML prototype; open it in a browser
  data/            pack pull weights and the two trial decks
docs/
  PIPELINE.md      how a deck is built; package format; the fixes and why
  PALIFY-API.md    what Palify actually offers, CORS, catalogue shape, soul cards
  DESIGN-PROMPT.md brief for the web front end
  PULL-API.md      draft /api/pull contract for the in-game pack ripper
```

`design/` is a reference, not production code. It hardcodes a 16-card demo array, simulates
generation with a timer, and rolls pack pulls client-side. Rebuild it against the real pipeline.
`design/assets/DefaultBack.png` is a copy of `assets/DefaultBack.png`, kept so the prototype opens
standalone.

## Running the generator

Requires Node 22+, Python 3 with Pillow and numpy, and `decode.mjs` from the
[Resonite Knowledge Library](https://github.com/dalekcoffee/Resonite-Knowledge-Library)
(`protoflux/skill/scripts/decode.mjs`) copied into `tools/`. That file is not vendored here.

```bash
cd tools && npm install

# 1. compose the atlas (deck.json is [{code,n,name}], cards.json is a /api/cards snapshot)
python3 compose.py --deck deck.json --art art/ --cards cards.json --out front.webp

# 2. prepare the card back
python3 prepare_back.py --src ../assets/DefaultBack.png --out back.webp

# 3. patch the template into a finished deck
node patch.mjs src=template.resonitepackage \
  front=front.webp fw=8192 fh=8192 \
  back=back.webp bw=1024 bh=1463 \
  cards=50 out=MyDeck.resonitepackage "name=My Deck"
```

`patch.mjs` swaps both textures, forces the card materials to `Cutout`, raises `AlphaCutoff`,
strips the unused fallback fonts, trims to `cards=N`, and builds the `/credits` slot. It fails
loudly rather than shipping a broken package — every structural assumption is asserted.

Set `EDGE_TINT=r,g,b` to darken the card edge without re-baking.

## Templates

Geometry is a property of the template, not the code. To change corner rounding, thickness, or the
maximum card count, re-bake in-world with the Deck Maker and use the new export as `src=`.

Bake the template at the **largest** card count you need — `patch.mjs` trims down but cannot grow.
Columns 10 / Rows 7 / Total 70 fills the grid and covers any deck up to 70 cards.

## Credits

- **Deck Maker by Ukilop V1.4.4** — the deck system every generated deck is built on.
- **Palify** — deck data and card art.

Both are credited in-world on every generated deck and are a permanent requirement, not a
courtesy. Palworld and the Palworld OCG are property of Pocketpair & Bushiroad; ResoPal is an
unaffiliated fan tool.

## Working on this repo

- Development happens on `claude/palworld-tcg-deck-importer-3ylb7h`.
- The [Resonite Knowledge Library](https://github.com/dalekcoffee/Resonite-Knowledge-Library) is
  required reading for any Resonite-side work — especially `protoflux/file-format.md`,
  `engine/assets-and-import.md` and `protoflux/node-catalog.md`. It carries the working
  `.resonitepackage` codec at `protoflux/skill/scripts/`. **Clone it alongside, never into, this
  repo.**
