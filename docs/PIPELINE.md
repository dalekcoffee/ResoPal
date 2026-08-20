# How ResoPal builds a deck

Everything here was established by decoding real `.resonitepackage` files and measuring, not by
guessing. Where something is unverified it says so.

## The core decision: patch a template, never generate from scratch

A baked deck from **Deck Maker by Ukilop V1.4.4** is the template. ResoPal swaps two textures,
edits a few values, trims the card count, and re-zips. We never author BSON from nothing and we
never write mesh geometry.

This matters because the card meshes are **beveled rounded boxes with atlas UVs baked into the
vertex data** (~22 KB each). Generating those is a real project and a permanent maintenance
liability against future Deck Maker versions. Reusing them costs nothing and inherits Ukilop's
geometry exactly.

**Consequence: anything geometric is a template property, not a code problem.** Corner rounding,
thickness, card count — all are set by re-baking the template in-world with different slider
values, not by writing code.

## Package format

`.resonitepackage` is a ZIP:

```
R-Main.record                 JSON: assetUri -> the main blob, plus assetManifest[{hash,bytes}]
Assets/<sha256>               every asset, named by the SHA-256 of its own bytes
Metadata/<sha256>.bitmap      JSON sidecar per texture: width/height/baseFormat/channelCount/...
```

The main blob is **FrDT**: 9-byte header (`"FrDT"` magic, byte 8 = 3 meaning Brotli), then
Brotli-compressed BSON. Codec: `decode.mjs` from the Resonite Knowledge Library
(`protoflux/skill/scripts/`) — `frdtToBsonBytes` / `deserializeBson` / `serializeBson` /
`bsonBytesToFrdt`. Deps `bson`, `brotli-wasm`, `jszip` — **all three run in a browser**, which is
what makes the planned client-side version possible.

Asset references inside the package are `@packdb:///<sha256>` strings in a plain `URL` field.
`packdb` is rewritten to `local` during import. Supported schemes are
`{ resdb, local, http, https, ftp }` — an unsupported scheme makes the asset **silently never
load**, no error.

**Swapping any asset means updating four places:** the blob filename, the `Metadata/*.bitmap`
sidecar (`assetIdenfitier` — the engine really does misspell it), every `packdb:///` reference in
the scene graph, and `assetManifest` in `R-Main.record`. Changing the scene graph changes the FrDT
blob, so its own hash and `assetUri` change too.

## The atlas contract

```
AtlasInfo  GridSize [10,7]  GridFrames <N>      front atlas
AtlasInfo  GridSize [1,1]   GridFrames 1        back
```

- Cells fill **row-major**, left-to-right, top-to-bottom, one physical card per cell. Duplicates
  each get their own cell: `3x Eikthyrdeer` occupies three.
- Cards **fill their cell completely** — measured on Ukilop's own atlas, content bbox equals the
  cell exactly. No padding, no letterboxing.
- Cell aspect at 10x7 is **0.7000**; Palify card art is **0.7156**. The 2.2% squash is invisible.
- `GridFrames` must equal the card count.
- **The grid is baked into the mesh UVs.** It cannot be changed without re-baking the template,
  and the atlas image must keep the grid's proportions — cropping unused rows would break every UV.

Resolution: at 8192² a card is 819 px wide (source is 1024) and effect text stays readable. At
4096² it is 409 px and text suffers. **8192 is the default.**

WebP is the right format — 2.5 MB versus 14.6 MB for the same 4096² atlas as PNG, and Resonite
ingests WebP natively (the stock template already contains WebP textures).

## Fixes that are not obvious

### White rim on card corners

Palify card art is **matted against white**: the antialiased edge pixels are light grey (~169)
while the card interior at the corner is dark (~42), and their alpha (~140) is above a 0.5 cutout
threshold, so they survive as a visible white rim.

Fix is two-part, in `imgfix.solidify` plus the material:
1. **Solidify before resizing** — replace RGB in transparent and semi-transparent pixels with the
   nearest trusted-opaque colour so the white matte cannot bleed inward. Measured: rim-vs-interior
   brightness gap **+22.9 -> +5.1**.
2. **`AlphaCutoff` 0.5 -> 0.72** to trim what remains.

### Materials

The card materials must be `Cutout`, not `Opaque` — Opaque discards alpha entirely and the rounded
corners render solid. Ukilop's UNO deck was opaque rectangles so `Opaque` was correct for him.

`Cutout` is chosen over `Alpha` deliberately: 50 cards stacked face-to-face would show
transparency sorting artifacts with `Alpha`. `Cutout` stays in the opaque queue.

Note: Resonite auto-detects transparency on import (`CalculateTextureAlpha`), so a freshly baked
template may already ship `Cutout`. The patcher validates the **end state**, not the transition.

### Landscape cards

26 of 158 cards (every one a `Structure`) are printed sideways, and Palify serves them
**already landscape** (1024x732). They must be rotated **clockwise** (`Image.ROTATE_270`) before
placement, or they get squashed into the portrait cell. The catalogue's `landscape` boolean is
authoritative — do not infer from dimensions.

### Card edge colour

The card edge is material `0000b06d`: a 64x256 stripe texture tiled 100x vertically to fake
stacked paper, with a **white `TintColor`** — this is the Deck Maker's "Edge Color" picker. At high
bevel the white rim is wide enough to wrap into view from the front and read as glare. Patchable
without a re-bake (see `EDGE_TINT` in `patch.mjs`); the better fix is a lower bevel.

### Fonts are 88% of the package

The stock template embeds 5 fonts totalling ~18.4 MB of a 20.9 MB package. **`MainFont` is only
452 KB; the four fallbacks are 17.9 MB** (the largest is a 16.5 MB CJK font).

Dropping the fallbacks and clearing both `FontChain.FallbackFonts` arrays takes a package from
25 MB to ~11 MB with zero dangling references. Latin text renders unchanged; CJK glyphs would now
fall back to the engine default.

### Variable card count

The deck's flux drives its loops from **`Children Count`** nodes, not a baked-in number — verified
by inspecting `/logixs` and confirming the literals 50/51/52/70 appear only once or twice in the
whole graph and none is a card count. So trimming is safe.

Trimming to N means:
- `/Surface/cards/Cards` children -> N
- `/Assets` children -> N (these are **per-card driver flux**, `ValueDiv`/`ValueSub`/`FieldDrive`
  computing each card's offset — genuinely 1:1 with cards)
- `GridFrames` -> N
- drop the now-orphaned `StaticMesh` assets

**Only `StaticMesh` assets may ever be removed.** A version of this that removed anything
unreferenced deleted the `MainFont` and broke every button's text, because
`FontChain -> MainFont` is an **asset-to-asset** reference that a scan of only the object graph
never sees. Reference counting must cover the whole document. `trim.mjs` asserts that exactly
`template_cards - N` meshes were dropped.

Trimming only shrinks. **Bake the template at the largest size you will ever need** (Columns 10 /
Rows 7 / Total 70 fills the grid) and trim down per deck.

### BSON numeric gotcha

`deserializeBson` returns doubles as **`Double` objects, not primitives**, so
`typeof x === 'number'` is false and a numeric edit silently no-ops. Assign a plain JS number and
BSON re-serializes it correctly. This cost a build; it will bite the browser port the same way.

## Verification that must pass before shipping a package

Every one of these is cheap and each has caught a real bug:

- every `Assets/<hash>` blob hashes to its own filename
- `assetUri` resolves to a present blob
- `assetManifest` and the blob set agree **in both directions**
- zero dangling `packdb:///` references
- zero duplicate IDs across the whole document (~41k references)
- the package re-decodes with its full type table (177 types)
- meshes dropped == `template_cards - N`

## Deck Maker settings (in-world, panel labels in brackets)

| Control | Package field | Notes |
|---|---|---|
| Bevel | `radius Slider` | range 0–0.35. **0 = square corners.** Printed art radius is 3.22% of card width |
| Thickness | `thickness Slider` | card depth only; does not affect corner rounding |
| Edge Color | material `0000b06d` `TintColor` | white by default |
| Columns / Rows / Card Amount | `AtlasInfo` GridSize / GridFrames | grid is baked into mesh UVs |

The Deck Maker itself: `resrec:///U-ukilop/R-e7100d16-9b62-4d74-b8e0-058b0492764f`

## Credits (non-negotiable)

The generated deck carries a `/credits` slot at its root holding three name-only slots. Ukilop's
original credit string is preserved character-for-character, `<color=red>` markup included:

```
/credits
  Made w/ Deck Maker by <color=red>Ukilop V1.4.4</color>
  Card images & deck data by Palify - palify.org
  ResoPal import tool by Dalek - resopal.dalek.coffee
```

## Browser port (`web/`)

`web/` is the browser build of everything in `tools/`. `trim.js` and `credits.js` are byte-for-byte
copies — they were already dependency-free. The rest is ported:

| Node/Python | Browser |
|---|---|
| numpy `solidify` | typed arrays over `ImageData`, same 8-neighbour dilation with wraparound |
| PIL `resize(LANCZOS)` | `drawImage` with `imageSmoothingQuality:'high'` |
| PIL `save(WEBP, q95)` | `OffscreenCanvas.convertToBlob({type:'image/webp'})` |
| `crypto.createHash` | `crypto.subtle.digest('SHA-256')` (async) |
| `brotli-wasm` CJS build | the web build; its `.wasm` ships beside `bake.bundle.js` |

Output is **structurally identical** to the Node pipeline — same file count, asset count, manifest
length — but **not byte-identical**, because the browser's WebP encoder and resampler are not
libwebp `method=6` and LANCZOS. Measured against the approved v7 package: whole-atlas mean absolute
difference 1.31/255. Compare structure, never bytes.

### Rotation direction is inverted between PIL and canvas

PIL's `Image.ROTATE_270` and a canvas `rotate(270°)` are **not** the same direction. `compose.py`
uses `ROTATE_270` and `compose.js` uses `ROT = 270`; they only agree because the canvas convention
is the opposite way round. Getting this wrong is silent — the cards still tile correctly, they are
just upside down, which is exactly the bug the first port shipped.

Verify by rendering a landscape card (any Structure, e.g. `TD02-008`) and diffing it against a
known-good bake, both as-is and rotated 180°. If the 180° diff is the smaller one, the direction is
wrong.

**Extract the reference atlas from inside the package you are comparing against — never from a
loose intermediate file.** This bug shipped twice. The second time was because the comparison used
`front_8192.webp` left lying in the build directory, which predated the rotation fix by twenty
minutes: the browser was "corrected" to match an atlas that was itself wrong, and the diff came
back clean because both sides were wrong in the same way. A stale oracle is worse than no oracle,
because it manufactures confidence. Pull the atlas out of the `.resonitepackage` every time:

```js
// the only trustworthy reference is the one that actually shipped
for (const [name, e] of Object.entries(zip.files))
  if (bytes.length > 5e6 && bytes.slice(8, 12).toString() === 'WEBP') // the atlas
```

## The shipped template

`data/template.resonitepackage` is a Deck Maker export run through `tools/strip_template.mjs`,
which removes the payloads every bake throws away anyway: the fallback font chain, the placeholder
atlas and the placeholder back. **20.78 MB → 1.65 MB.** `Metadata/*.bitmap` sidecars are kept —
`patch.js` reads the old ones to build the new ones — and the doc is untouched, so `patch.js` still
runs its own font strip and texture swap and simply finds less to do. Verified: a bake from the
stripped template is structurally identical to one from the full export.

Re-run it whenever you re-bake the template:

```bash
node tools/strip_template.mjs src=DeckRounded.resonitepackage out=../data/template.resonitepackage
```
