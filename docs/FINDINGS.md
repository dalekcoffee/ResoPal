# ResoPal — technical findings

Everything below was established by decoding the two supplied `.resonitepackage` files
and cross-checking against the Resonite Knowledge Library
(`protoflux/file-format.md`, `engine/assets-and-import.md`, `protoflux/node-catalog.md`).
Nothing here is guessed unless it says so.

## 1. How Ukilop's Deck Maker actually works

Decoded `Deck_Maker_by_Ukilop_V1.4.resonitepackage` (336 types, engine build 2026.8.12.1196).

Root slot: `Deck Maker by <color=red>Ukilop V1.4.4</color>`

Its `inputs` slot is the entire public contract:

| Input | Component | What it takes |
|---|---|---|
| `FrontTexture` | `AssetFrameSlot<ITexture2D>` | **one** texture holding a grid of card faces |
| `BackTexture`  | `AssetFrameSlot<ITexture2D>` | **one** texture, the card back |
| `Numeric UpDown Column` | `LegacyNumericUpDown` | grid columns |
| `Numeric UpDown Row` | `LegacyNumericUpDown` | grid rows |
| `Numeric UpDown total` | `LegacyNumericUpDown` | how many cells are real cards |
| `frame` / `thickness` / `radius` sliders, `RGB`, `bevel checkbox`, `Backface Radio` | style | cosmetic |
| `bake button` | — | produces the Deck object |

The flux lives in `logixs` (`Edge`, `misc`, `impulses`, `Non-impulse`, `Baking` — 426 nodes total).

## 2. The atlas contract (this is the whole integration surface)

Decoded `Deck.resonitepackage` — a baked 52-card UNO deck.

```
/Deck
  /Made w/ Deck Maker by <color=red>Ukilop V1.4.4</color>   <- credit slot, must survive
  /Assets      AtlasInfo{GridSize:[10,7], GridFrames:52}   <- FRONT atlas
               AtlasInfo{GridSize:[1,1],  GridFrames:1}    <- BACK
               UnlitMaterial x2, 52 x StaticMesh (one per card, UVs baked)
  /logixs /buttons /Surface\cards /holder /buffer /search /filler
```

- Front atlas asset: a single **4096x4096 PNG**, cards laid out **row-major, left-to-right,
  top-to-bottom**, one card per cell, cell size = `imageW/cols` x `imageH/rows`.
- `GridFrames` = number of cells actually used; leftover cells are ignored.
- Back asset: a single 717x1024 PNG, grid `[1,1]`.
- Baking produces **one mesh per card** with that card's atlas UVs baked into the vertex data
  (verified: the 52 mesh blobs are byte-distinct after the MeshX header).

**So: produce one grid image + one back image + three integers, and the Deck Maker does the rest.**

## 3. What Resonite can and cannot do here

Confirmed from the Knowledge Library:

- ✅ **`https` is a supported asset scheme.** `AssetManager.IsSupportedScheme` =
  `{ resdb, local, http, https, ftp }` (`engine/assets-and-import.md` §3). A `StaticTexture2D`
  can point straight at a web URL — no download-and-drag needed.
- ✅ **ProtoFlux can make HTTP requests.** `Network.GET_String` (`URL` -> `Content` +
  `StatusCode`, with `OnResponse`/`OnError`/`OnDenied`), gated by `RequestHostAccessUrl`
  (`protoflux/node-catalog.md` §Network).
- ❌ **No JSON parser nodes.** Flux parsing is literal string-anchor/substring work. Any
  in-game endpoint must return a dead-simple delimited format, not JSON.
- ❌ **No file I/O in ProtoFlux.** A `.txt` or `.csv` on disk cannot be read by an in-world
  object. Your instinct was right — file imports are a website-only path.
- ❌ **No runtime atlas packer** exposed to flux. Atlas composition has to happen outside.

## 4. A round-trip hook worth knowing about

The Deck Maker attaches a `Deck Maker Memory` `DynamicVariableSpace`
(`float3`, `float3`, `colorX`, `string`) **onto the FrontTexture/BackTexture slots themselves** —
i.e. it stamps its settings onto the texture so re-dropping that texture restores them.
The template's values are empty, so the encoding is unknown from the package alone.

If we can capture a *used* instance in-world, a ResoPal-generated texture could carry its own
`Deck Maker Memory` and auto-configure grid/rows/total on drop, with zero typing.
**Open item — needs an in-world capture, not solvable from the files.**

## 5. Blocked / unverified

- **`palify.org` is unreachable from this environment** (egress proxy returns 403 on CONNECT), so
  every claim about Palify's API in these docs comes from their published terms and Dalek, not
  from a fetch I made. Fixing this is an environment setting — see PLAN.md Phase 0.
- **Resolved by Dalek:** Palify publish a free read-only JSON API (`palify.org/developers`),
  usable on condition that we **credit them and cache responses**. That is our data source; we do
  not scrape. Caching is a hard requirement, not an optimisation — see PLAN.md "Caching policy".
- **Resolved by Dalek:** decks carry a soul deck. It becomes a **second deck object** containing
  only soul cards, and the user can pick soul cards from Palify's full soul-card list.
- **Still open:** whether Palify's deck endpoint and `/cards/w1024/*.webp` send CORS headers. This
  is now the only Phase 0 blocker, and it still decides static-site vs Worker.
- **Still open:** re-hosting composed atlases on our own domain (Phase 2 only). Their API terms
  cover the API; a derived image we serve ourselves is a separate question. Much less fraught now
  that they explicitly welcome community tools, but worth a courtesy ask.
