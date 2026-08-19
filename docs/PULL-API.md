# ResoPal pull API — draft, not live

For the in-game random-pack tool. Nothing here is deployed yet; this file pins the
contract so the Resonite side can be written against it.

## GET /api/pull

Query params:

    set     BP01            optional, defaults to BP01
    packs   1               optional, 1-12
    seed    <string>        optional, same seed = same pull (for shared sessions)
    format  json | flat     optional, defaults to json

### format=json

    {
      "set": "BP01",
      "packs": 1,
      "seed": "a3f19c",
      "generated": "2026-08-19T07:00:00Z",
      "pulls": [
        { "pack": 1, "slot": "C",   "code": "BP01-011",    "base": "BP01-011", "rarity": "C" },
        { "pack": 1, "slot": "HIT", "code": "BP01-001SSP", "base": "BP01-001", "rarity": "SSP" }
      ],
      "best": "SSP"
    }

### format=flat

One card per line, `code,rarity` — trivial to split in Resonite with no JSON parser:

    BP01-011,C
    BP01-001SSP,SSP

Then hand the same codes to the existing importer to bake a deck of exactly what
was pulled.

## Weights

Server rolls against `data/pack-weights.json` — the same file the web ripper reads,
so in-game and on-site odds can never drift. `perPackBonus` and `globalBonus` in
that file raise rates for events; no code change needed.

## Notes / open

- Rate limit per IP, since this is cheap to spam.
- `seed` is not implemented yet; the ripper currently uses `Math.random()`.
- No auth planned. If abuse shows up, a short-lived token issued by the site.
