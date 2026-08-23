# ResoPal pull API

For the in-game random-pack tool and the website's ripper. **Implemented** in
`worker/src/index.js` + `worker/src/roll.js`; `worker/test/routing.mjs` asserts the
contract below. Deploy the Worker to make it live.

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

With `packs=N` you get `N x packSize` lines in pack order, each pack internally
sorted. `text/plain; charset=utf-8`, trailing newline.

### Ordering

Within a pack, cards are **rarest first** — that is stack order for the deck bake.
See `BOOSTER.md` "Stack order" for why, and for the one thing about it only a VR
check can settle.

## GET /api/deck

The in-world panel carries no deck of its own, so decks are served in the same
shape as a pull.

    deck    td01 | td02      omit to list what exists
    format  json | flat      optional, defaults to json

`flat` expands quantities: a 4-of appears as four `code,rarity` lines, because the
panel spawns one card per line and a physical deck has four of that card. That is
the same format `/api/pull` emits, so the ProtoFlux side has one parser, not two.

Deck contents come from the committed CSVs via `data/decks.json`
(`tools/build-decks.mjs`); rarities are looked up in the pool snapshots, so nothing
here invents card data.

## `GET | POST /api/resolve` — "here is what I pasted"

    GET  /api/resolve?deck=<uuid>&format=fixed
    GET  /api/resolve?url=https%3A%2F%2Fpalify.org%2Fdecks%2F<uuid>
    POST /api/resolve?format=fixed          body: the pasted text, text/plain

One route for three inputs, because the caller should not have to say which it
has: a **palify.org deck link**, a **bare deck id**, or a **pasted decklist**.
`worker/src/resolve.js` sniffs it. Output is the same records `/api/pull` and
`/api/deck` already serve, so a booster, a committed deck and someone's own brew
all arrive in-world looking identical and the ProtoFlux side keeps one parser.

POST exists for exactly one reason: ProtoFlux has `POST_String` and no way to put
a 2 KB decklist in a query string. Nothing else on this Worker accepts POST.

### The decklist grammar

Palify's own copy-as-text export is what this was written against:

    # Green/Purple Trial (50 cards)
    2x Mossanda – Guard Captain [TD02-001]
    3x Eikthyrdeer Terra – Guardian of Nature [TD02-005]

but these all work, because people paste from everywhere:

    2 Mossanda [TD02-001]      TD02-001 x2      TD02-001,2
    2x TD02-001                TD02-001         - 4x td02-006

**A line counts only if it carries a card code.** A line without one is skipped
and reported under `unrecognised`; a comment line with no code becomes the deck
name. Matching names to cards would mean inventing card data on a typo, and two
phantom cards have already reached production here that way.

Every code is then checked against **Palify's own catalogue** (`/api/cards?set=`,
fetched per set and edge-cached for a day). Codes it does not know come back
under `unknown` and are not served. That is the "never invent card data"
invariant, enforced at request time rather than by hand.

### Response

`format=json` adds the provenance, so a caller can see what was thrown away:

    { source: {kind:"palify", id, url} | {kind:"list"},
      name, total, cards: [{code, base, rarity, name}],
      unknown?: ["ZZ99-001"], unrecognised?: ["Some line with no code"],
      truncated?: 200 }

`flat` and `fixed` are byte-identical in shape to `/api/pull`'s, plus an
`x-card-count` header.

### Errors

    400   nothing to resolve, or a bad format
    404   palify does not have that deck
    422   no code in the paste, or none of the codes exist
    429   throttled
    502   palify answered with a deck page this parser could not read

That 502 is deliberate and specific. The deck page is a Next.js route with no
public API, so the only machine-readable form is the RSC flight payload, which is
undocumented and will change without warning. When it does, the failure is loud
and names the parser — rather than a deck that quietly comes back empty.

## Weights

Server rolls against `data/pack-weights.json` — the same file the web ripper reads,
so in-game and on-site odds can never drift. `perPackBonus` and `globalBonus` in
that file raise rates for events; no code change needed.

## Caching

A pinned `seed` makes the response a pure function of its inputs, so it is served
`immutable`. An unpinned pull is `no-store` — cache it and two players would share
a "random" pack.

## Errors

    400   bad packs / format / seed
    404   no pool for that set
    429   throttled (with retry-after)
    500   the weights ask for a rarity the pool cannot supply

A rarity the weights want but the pool lacks is dropped from the hit table and
named in `unavailable` on the JSON response, never silently swapped for another
rarity — quietly changing the odds is worse than visibly refusing to.

## Notes / open

- **Rate limiting is per-isolate**, so it slows one client's loop and nothing more.
  See `BOOSTER.md` "Open questions".
- `seed` is implemented (xmur3 + mulberry32). Same seed, same pull, forever — which
  is also how a pack opened in-world is reproduced as a baked deck on the site.
- No auth planned. If abuse shows up, a short-lived token issued by the site.
