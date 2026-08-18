# ResoPal — recommended direction and plan

## The recommendation, in one line

**Build the website as the middleware, add a small in-game companion that talks to it, and do
not fork the Deck Maker.**

## Why

The Deck Maker's input contract is narrow and stable: one grid texture, one back texture, three
integers, press bake (see FINDINGS.md §2). Everything genuinely hard — resolving a Palify deck,
mapping card codes to art, compositing an atlas, cropping a custom back — is trivial in a browser
and either impossible or miserable in ProtoFlux. Everything easy in-game — laying out and baking
the deck — Ukilop already solved, well, and the flux is 426 nodes we would inherit responsibility
for the moment we fork it.

So the split writes itself: **web does the data and the pixels, the Deck Maker does the deck.**

The reason this ends up feeling native rather than like a file-shuffling chore is the two
capabilities confirmed in FINDINGS.md §3: Resonite loads textures straight from `https://` URLs,
and ProtoFlux can perform an HTTP GET. Together they mean a companion panel can take a short
code, fetch a one-line manifest, write the atlas URL and the three integers into the Deck Maker's
own fields, and fire bake. **The "100% in game" version you wanted is feasible** — just not as an
in-game *parser*. The parsing lives on the web; the game only ever receives an answer.

## What that means for your original asks

| Your ask | Verdict |
|---|---|
| Import by public deck URL | ✅ Yes — website, and in-game via the companion |
| Import by profile URL (pick a deck) | ✅ Yes — website; in-game as a deck picker if the API supports listing |
| Import private decks via .txt / .csv | ✅ Website only. Confirmed: flux has no file I/O |
| Soul decks | ✅ Auto-generated as a **second deck**, plus a picker over all Palify soul cards |
| 100% in-game | ✅ For public decks, via companion + hosted manifest. ❌ For files |
| Grab card fronts from Palify URLs by code | ✅ `https://palify.org/cards/w1024/<CODE>.webp` |
| Modify the in-game builder? | ❌ **No.** Add a companion beside it |
| Website, GitHub Pages, or both? | **Both, in that order** — see phases |
| Custom card backs with pan/zoom/trim | ✅ Website, output as the single `BackTexture` image |
| Keep Ukilop's credit | ✅ Automatic — the maker stamps it; we never touch it |

## Credit rule (non-negotiable, applies to every artifact we ship)

The baked deck carries a slot named literally:

```
Made w/ Deck Maker by <color=red>Ukilop V1.4.4</color>
```

We never rename, restyle, or remove it. The companion panel adds its own credit **beside**
Ukilop's, never in place of it, and the website credits the Deck Maker by name on every page that
produces an import. If Phase 3 ever generates a deck without the Deck Maker, it still carries a
"deck format by Ukilop" credit slot.

**Palify is the second mandatory credit.** Their read-only JSON API is free to use on the
condition that we credit them and cache responses. Every page that shows Palify data, and the
in-game companion panel, credits Palify as the data and card-art source with a link back. Two
credits, both permanent: **Ukilop for the deck system, Palify for the data.**

## Phases

### Phase 0 — unblock

1. ~~Find a data source.~~ **Settled: Palify's own free read-only JSON API**
   (`https://palify.org/developers`). No scraping, no third-party mirror. Read their endpoint
   list and confirm: single-deck fetch, profile/user deck listing, full card catalogue including
   printings and soul cards.
2. **Check CORS on the deck endpoint and on `/cards/w1024/*.webp`.** This is now the only open
   fork:
   - CORS present -> Phase 1 is pure static GitHub Pages. No server, no cost.
   - CORS absent -> a small Cloudflare Worker proxies fetches and un-taints the canvas for atlas
     composition. Still cheap, but it is now infrastructure. The Worker is also where the cache
     lives, so if Phase 2 is happening anyway, this is less of a loss than it sounds.
3. Confirm the soul-deck shape in the API payload, and get the full soul-card list for the picker.
4. Send Palify a courtesy note about Phase 2 hosting composed atlases (see Risks).

### Caching policy (a condition of use, not an optimisation)

Palify ask that we cache. We should over-deliver on this — it costs us nothing and it is the
whole reason the API stays free.

| Data | Volatility | Strategy |
|---|---|---|
| Card catalogue (153 cards, 242 printings) | changes on set release | Fetch **once at build time**, commit the snapshot, refresh on a weekly scheduled job. Normal users make **zero** Palify metadata requests. |
| Deck payload by UUID | user can edit their deck | Cache ~1h, stale-while-revalidate |
| Profile deck listing | user adds/removes decks | Cache ~15m |
| Card images | immutable per code | Never re-fetch within a session; cache 30d if we ever proxy them |

Plus: cap concurrent image fetches at ~6, never fetch the same code twice for one deck, and send
a `User-Agent` that identifies ResoPal with a link back so Palify can see who we are and contact
us if we misbehave.

### Phase 1 — the website (MVP, ships value immediately)

Static site on GitHub Pages (plus the Worker if Phase 0 says so).

**In:** a Palify deck URL, a Palify profile URL (then pick a deck), or a dropped `.txt` / `.csv`.
**Out:** `front-atlas.png`, `back.png`, and the three numbers to type into the Deck Maker.

Atlas rules, derived from the decoded deck:
- Row-major fill, left-to-right, top-to-bottom, one card per cell, transparent padding.
- Grid chosen automatically as the best fit for N cards at card aspect ≈0.71, so cells waste as
  little of the texture as possible. For a 50-card deck that lands near 9x6.
- Two quality tiers: **Standard 4096²** and **High 8192²**. Above 8192 is not worth shipping.
- Duplicates: a deck with `3x Eikthyrdeer` gets three cells, because the Deck Maker builds one
  card per frame. `GridFrames` = total physical cards, not unique cards.

**Soul decks.** A Palify deck carries a soul deck alongside the main deck. It becomes a
**second, separate deck object in Resonite** containing only the soul cards — its own atlas, its
own three numbers, its own bake. Both decks share the card back by default, with an option to
give the soul deck its own. Because we hold Palify's full card catalogue anyway, the site also
offers a **soul-card picker over every soul card Palify knows about**, so a user can assemble or
adjust a soul deck even when the source (a `.txt` or `.csv`, which carry no soul section) has none.

At this point the user flow is: paste URL -> download the PNGs -> import to Resonite -> drop into
the maker -> set 3 numbers -> bake, once per deck. **This works today against an unmodified
V1.4.4.**

### Phase 2 — the in-game companion ("ResoPal Importer")

A small panel that sits next to the Deck Maker. Never modifies it; only writes to its fields.

1. Text field: a short import code (or the full Palify deck URL).
2. `RequestHostAccessUrl` -> `GET_String` on `https://<our-api>/d/<code>.txt`.
3. Response is deliberately trivial to parse — no JSON, because flux has no JSON nodes:
   ```
   v1
   Green/Purple Trial
   https://<our-cdn>/back/<code>.png
   main|https://<our-cdn>/atlas/<code>-main.png|9|6|50
   soul|https://<our-cdn>/atlas/<code>-soul.png|2|1|2
   ```
   One line per deck, so the companion bakes the main deck and the soul deck in turn. A deck with
   no soul cards simply omits the `soul` line.
4. Writes atlas URL into `FrontTexture`'s `StaticTexture2D.URL`, back into `BackTexture`,
   the three integers into the Column / Row / total `LegacyNumericUpDown`s, then triggers bake.
5. Panel shows the deck name and credits Ukilop and ResoPal.

Now the flow is: paste a code in-game -> bake. Nothing leaves the headset.

**Prerequisite this phase adds:** we must host the generated atlas at a stable URL, which Phase 1
does not require. That is exactly the re-hosting question from Phase 0 — do not start Phase 2
before it is answered.

### Phase 3 — optional: direct `.resonitepackage` export

For people who do not own the Deck Maker. This is genuinely feasible: the Knowledge Library
carries a byte-level spec of the FrDT/Brotli/BSON format **and a working encoder, decoder and
validator** (`protoflux/skill/scripts/`), which I used to decode both of your packages cleanly.

The remaining work is a **MeshX writer** — the baked deck has one mesh per card with UVs baked in,
so generating a deck from scratch means emitting 50 quad meshes with per-card UVs. That is real
work and it is a standing maintenance liability against future Deck Maker versions, which is
exactly why it is Phase 3 and not Phase 1.

## Risks and open questions

- **Re-hosting card art.** Phase 1 composes atlases in the user's browser and hosts nothing —
  clean. Phase 2 requires us to serve composed atlases from our own domain, which is
  re-distributing Pocketpair art. Palify's API terms cover the API, not derived images we serve
  ourselves, so this stays a courtesy ask: keep hosted atlases short-lived (24h), keyed to the
  deck, and be ready to drop to "browser-composed only" if they object. **I have not contacted
  anyone.**
- **Being a good API citizen.** The caching table above is a commitment, not a suggestion. If we
  ever find ourselves fetching the card catalogue per page load, we have broken the deal.
- **CORS** may force the Worker. Cheap, but it changes "static site" to "service".
- **Deck Maker version drift.** We depend on field names and the atlas contract of V1.4.4. Pin the
  version in the companion's UI and re-verify on each Deck Maker release.
- **`Deck Maker Memory`** (FINDINGS.md §4) could remove the three-number typing step entirely in
  Phase 1. Needs one in-world capture to decode.
- **Palify unreachable from my environment** — every claim about Palify's API in this document is
  from their published terms, your examples and a web search, not from my own fetch. Fix by
  setting the cloud environment's network access to **Custom** and allowing `palify.org`.
