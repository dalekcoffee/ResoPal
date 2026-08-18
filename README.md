# ResoPal

Import Palworld TCG decks from [Palify](https://palify.org) into
[Resonite](https://resonite.com).

**Status: planning complete, no implementation yet.** Everything in `docs/` is settled
direction, derived from decoding the real Resonite packages — not speculation.

## Read these in order

| Doc | What it is |
|---|---|
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | What the Deck Maker's input contract actually is, the atlas layout, and what Resonite can and cannot do. All decoded from the supplied packages. |
| [`docs/PLAN.md`](docs/PLAN.md) | The recommended direction, phases, caching policy, credit rules, risks. |
| [`docs/DESIGN-BRIEF.md`](docs/DESIGN-BRIEF.md) | Front-end needs list, ready to hand to Claude Design. |

## The direction in one line

Website as middleware, plus a small in-game companion — **without forking Ukilop's Deck Maker**.
The web does the data and the pixels; the Deck Maker does the deck.

## Two credits, both permanent, both non-negotiable

- **Deck Maker by Ukilop V1.4.4** — the deck system. The baked deck carries a slot literally named
  `Made w/ Deck Maker by <color=red>Ukilop V1.4.4</color>`; we never rename, restyle or remove it.
- **Palify** — the data and card-art source. Their read-only JSON API is free to use on the
  condition that we credit them and cache responses. See the caching policy in `PLAN.md`.

## Next step

One open blocker: **does Palify send CORS headers** on the deck endpoint and on
`/cards/w1024/*.webp`? CORS present → Phase 1 is pure static GitHub Pages. Absent → a small
Cloudflare Worker. Everything else in Phase 1 is ready to build.

## Working on this repo

- Development happens on `claude/palworld-tcg-deck-importer-3ylb7h`.
- The [Resonite Knowledge Library](https://github.com/dalekcoffee/Resonite-Knowledge-Library) is
  required reading for any Resonite-side work — especially `protoflux/file-format.md`,
  `engine/assets-and-import.md`, and `protoflux/node-catalog.md`. It carries a working
  `.resonitepackage` encoder/decoder at `protoflux/skill/scripts/`. **Clone it alongside, never
  into, this repo.**
