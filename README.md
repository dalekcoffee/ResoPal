# ResoPal

Turns a [Palworld TCG](https://palify.org) deck into a ready-to-import deck object for
[Resonite](https://resonite.com). Paste a deck link, get a `.resonitepackage` you drag into the
game.

Site: **resopal.dalek.coffee**

**Version 1.0** — the site imports a deck and produces a working `.resonitepackage`, end to end.

## Status

The **generator works end to end.** It produces a verified, importable deck from a real Palify
deck: correct card order, rounded corners, transparent edges, landscape cards rotated, custom card
back, credits, and any card count.

**The website exports real decks.** Load the Green/Purple trial deck, step through review, soul
deck and card back, press Generate, and the browser downloads a `.resonitepackage` that is
structurally identical to the hand-built v7 package. No server involved.

Card art reaches the bake through a Cloudflare Worker (`worker/`), because the bake has to *read*
image pixels and a cross-origin image taints the canvas. `docs/WORKER.md` explains why it is
needed; `worker/README.md` is the setup. `data/art/` holds the TD02 trial deck as a same-origin
fallback, so that deck still builds if the Worker is unreachable.

Not built yet: pasting a Palify deck or profile URL. The Worker's `/deck` and `/profile` routes
return the raw RSC payload; the parser has to be written against a real response.

## How it works

ResoPal does not build a deck from scratch. It takes a deck baked by
**[Deck Maker by Ukilop](resrec:///U-ukilop/R-e7100d16-9b62-4d74-b8e0-058b0492764f) V1.4.4**,
swaps in a composed card atlas and card back, trims it to the right number of cards, and re-packs
it. All the geometry is Ukilop's, reused byte-for-byte.

Read **[docs/PIPELINE.md](docs/PIPELINE.md)** before changing anything — it documents the atlas
contract, the package format, and several non-obvious fixes that are easy to undo by accident.

## Repo layout

```
index.html      the site - served at resopal.dalek.coffee via GitHub Pages
support.js      runtime the front end is built on
assets/         DefaultBack.png (default card back), pack-bp01.png (booster art)
data/
  template.resonitepackage  the stripped Deck Maker template the site patches
  art/            card art the bake can read same-origin
  pool-bp01.json  the BP01 catalogue snapshot the pack roll draws from
  *.csv           the two trial decks; pack-weights.json
web/            the browser build of the generator - bakes the package client-side
tools/          the same pipeline as a command line tool, plus check-codes.html
booster/        the in-world booster spawner - builds a .resonitepackage that pulls at runtime
worker/         the Cloudflare Worker: Palify art, and the pack roll - README has the setup
docs/
  PIPELINE.md      how a deck is built; package format; the fixes and why
  PALIFY-API.md    what Palify actually offers, CORS, catalogue shape, soul cards
  WORKER.md        the Cloudflare Worker the front end needs, and why
  DESIGN-SPEC.md   the front end: screens, tokens, state, interactions
  DESIGN-PROMPT.md brief the design was built from
  PULL-API.md      the /api/pull contract for the in-game pack ripper
  BOOSTER.md       in-world booster packs: feasibility, build order, stack order
  SITE-REVIEW.md   defects found in the front end, and how they were fixed
```

The front end no longer rolls its own packs: `/api/pull` in the Worker does, against the committed
BP01 catalogue, and the site keeps a local roll only for when the Worker is unreachable. Generation
is still simulated in the demo deck path.

## Booster packs

Two ways to hold a pack, both rolled by the same endpoint:

- **In-world** — drag in `booster/out/ResoPal_Booster_BP01.resonitepackage`. It asks for host
  access, pulls seven cards, and points seven textures at the image proxy. No download, no bake.
- **On the site** — rip a pack, export it as a real deck object with Ukilop's beveled geometry.

`?seed=` reproduces one from the other. Cards come back rarest-first, which is stack order: flip
the pile over and you swipe through commons to reach the hit. `booster/README.md` covers what is
mechanically verified and what only a VR drag-test can settle.

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
