# Palify as a data source

Measured against palify.org, not taken from documentation. Re-check before relying on any of it.

## What is actually offered

`palify.org/developers` documents a free, no-key, read-only JSON API and asks two things in
return: **credit Palify, and cache responses.** Both are conditions of use, not suggestions.

It documents exactly **one** endpoint family:

```
GET /api/cards                  every card
GET /api/cards?set=BP01         filter by set
GET /api/cards?color=Red&type=Pal
GET /api/cards?q=jormuntide     search name, code, effect
```

`GET /api/prices` also responds with JSON but is undocumented.

**There is no deck endpoint and no profile endpoint.** Probed and got 404 on all of:
`/api/decks/<uuid>`, `/api/deck/<uuid>`, `/api/deck?id=`, `/api/v1/decks/<uuid>`,
`/api/decks?id=`, `/api/users/<h>/decks`, `/api/u/<h>`, `/api/profile/<h>`, `/api/trpc/deck.get`,
`/api/sets`, `/api/cards/<code>`.

## CORS is absent everywhere

Tested with `Origin:` set, on both `GET` and the `OPTIONS` preflight:

| Endpoint | `Access-Control-Allow-Origin` |
|---|---|
| `/api/cards` (GET and OPTIONS) | **none** |
| `/cards/w1024/*.webp` | **none** |
| `/cards/*.webp` | **none** |
| `/decks/<uuid>` | **none** |
| `/u/<handle>` | **none** |

So a static page cannot `fetch()` any of it — not merely "the canvas gets tainted", the request
fails outright. **A proxy is required for anything the browser must read**, which includes card
image bytes, since ResoPal bakes the art into the package rather than hotlinking.

Card images are served `cache-control: public, max-age=31536000, immutable` behind Cloudflare, so
a proxy cache is nearly free.

## Deck and profile data

Only obtainable from the page itself. Both are Next.js and embed their data in the RSC flight
payload. A cleaner fetch than parsing HTML:

```
curl -H "RSC: 1" https://palify.org/decks/<uuid>     # text/x-component, ~108KB vs ~156KB of HTML
```

A deck payload carries a ready-made list — no lookup needed:

```json
{"n":3,"name":"Eikthyrdeer Terra – Guardian of Nature","code":"TD02-005"}
```

plus a slug->quantity map and a `stats.total`. A profile page yields each public deck's UUID, name
and card count.

Two measured quirks, both of which will bite whoever rewrites the parser:

- **A missing page is HTTP 200.** A nonexistent deck UUID returns 200 and ~19 KB whose only marker
  is the RSC error digest `NEXT_HTTP_ERROR_FALLBACK;404`. The string
  `404: This page could not be found.` is *not* a marker — it ships inside the unrendered
  `notFound` slot of every page, valid decks included.
- **The page `<title>` is nav chrome.** A profile's display name is in its own island
  (`{"kind":"profile","title":"DalekCoffee","handle":"dalek"}`), not the first `"title"` in the
  payload, which is the card index's.

A profile payload gives each public deck a UUID, a name, a card count and the colour split behind
Palify's own colour bar — but no card codes. Showing four card faces per row in a deck picker would
cost one full deck fetch each, which is why ResoPal's picker shows the colour bar instead.

This is scraping, and it is version-fragile. Worth noting for a courtesy note to Palify:
`robots.txt` **disallows `/api/`** for generic agents while `/decks/` and `/u/` are allowed — the
invited API is the disallowed path and the pages we must read are the permitted ones. Asking them
for a real deck endpoint is the right fix.

## Catalogue shape

158 cards, 264 printings.

| field | notes |
|---|---|
| `code` | e.g. `TD02-005` |
| `name`, `nameJp`, `effect`, `effectJp`, `flavor` | |
| `type` | `Pal` 92, `Structure` 26, `Event` 17, `Gear` 14, `Soul` 9 |
| `setCode` | `BP01` 101, `TD01` 25, `TD02` 25, `PR` 7 |
| `landscape` | **26 cards, all `Structure`** — served already-landscape at 1024x732 |
| `printings[]` | `{code, rarity, image, variant, imageJp}` |

`printings` distribution: 80 cards have one, 50 have two, 28 have three. **`variant: false` marks
the base printing** — use it for the default art selection.

Images: `/cards/<CODE>.webp` is the canonical path, with `w1024`, `w512`, `w256` variants (226 KB /
93 KB / 34 KB at those sizes; full is 453 KB). Use **w256 for review thumbnails**, w1024 for atlas
composition.

## Soul cards are not what they look like

There are 9 `Soul` records with **8 distinct codes** (`SOUL-000`..`SOUL-008`, no `004`;
`SOUL-001` appears twice for TD01 and TD02). **Every one is named literally "Soul"** with `color`,
`cost` and `power` all null. They are reprints of one card with different art.

**A Palify deck payload carries no soul deck at all** — no `soulDeck`, `soulCards` or equivalent
key. A soul deck is 10 copies of one Soul card, chosen for its art.

So the UI for this is **an 8-art picker plus a count**, not a deck builder — and it is needed on
every deck, not just as a fallback.

## Caching commitment

Palify ask for caching as a condition of use. Over-deliver:

| Data | Strategy |
|---|---|
| Card catalogue | fetch once at build time, **commit the snapshot**, refresh on a weekly job. Normal users make zero Palify metadata requests |
| Deck payload | ~1h, stale-while-revalidate |
| Profile listing | ~15m |
| Card images | immutable per code; never fetch the same code twice for one deck; cache 30d when proxied |

Cap concurrent image fetches around 6, and send a `User-Agent` identifying ResoPal with a link
back so Palify can see who we are and reach us.
