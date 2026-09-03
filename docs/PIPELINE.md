# How ResoPal builds a package

Everything here was established by decoding real `.resonitepackage` files and measuring, not by
guessing. Where something is unverified it says so.

**Two exports, two templates, two sets of rules.** The deck (`.resonitepackage`) and the raw sheet
(`front.webp` + `back.webp`, for hand-baking in Ukilop's Deck Maker) used to be one pipeline: bake
an atlas, patch it into a template. As of v1.0 they are not. **The deck writes three strings per
card (a name and two art URLs) into the v1.0 template and re-zips it — no atlas, no canvas, no
pixel is ever read.** The
sheet still composites an 8192² atlas the old way. Anything below marked **sheet-only** applies to
`compose.js`/`imgfix.js`/`tools/compose.py` and nothing else; anything marked **deck-only** applies
to `web/fill.js`/`booster/extract-deck-template.mjs` and nothing else. Unmarked sections are true of
both, or are general package-format facts that predate either.

## The core decision: patch a template, never generate from scratch

Both exports start from a **hand-authored template**, never from BSON built up from nothing. This
matters most for the card meshes, which are **beveled rounded boxes with atlas UVs baked into the
vertex data** (~22 KB each, sheet path) or, since v1.0, **Sharkmake's DeckReader card** (rounded
corners baked into its mesh too, one mesh shared by every card in the deck). Generating either from
scratch is a real project and a permanent maintenance liability against a future template version.
Reusing them costs nothing and inherits the author's geometry exactly.

**Consequence: anything geometric is a template property, not a code problem.** Corner rounding,
thickness, card count ceiling — all are set by re-authoring the template, not by writing code.

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
what makes the client-side pipeline possible for both exports.

Asset references inside the package are `@packdb:///<sha256>` strings in a plain `URL` field.
`packdb` is rewritten to `local` during import. Supported schemes are
`{ resdb, local, http, https, ftp }` — an unsupported scheme makes the asset **silently never
load**, no error.

**Swapping any asset means updating four places:** the blob filename, the `Metadata/*.bitmap`
sidecar (`assetIdenfitier` — the engine really does misspell it), every `packdb:///` reference in
the scene graph, and `assetManifest` in `R-Main.record`. Changing the scene graph changes the FrDT
blob, so its own hash and `assetUri` change too. **The deck path never swaps a texture blob at
all** — a card's art is a live URL fetched by the engine, not a packed asset — so none of this
applies to it; it is entirely a sheet-path concern.

## Deck path: a card carries its art as two URLs, nothing baked

**This is the whole point of the v1.0 change: nothing is composited, and no per-deck bytes are
embedded.** Each card carries its art as a URL in a dynamic variable; the back is one shared URL
for every card in every deck. A player's inventory holds the holder and nothing else — no 8192²
atlas, no per-card texture blob. This is also what lets a future version offer custom card backs:
the back is a URL like the fronts, not pixels baked into a texture.

### The shape of a v1.0 deck

```
Deck                          Grabbable, DynamicVariableSpace "Deck",
                              DynamicValueVariable<float3> "Deck/cardSize", ObjectRoot
├── credits                   attribution, as slot NAMES (see Credits below)
├── Assets                    materials, atlas info (unused by any card), the shared card back
│   └── proxy × N             ONE per buffer: the per-card driver flux, 1:1 with buffers
├── logixs                    Ukilop's deck logic
├── buttons                   shuffle, search
├── Surface/cards
│   └── Cards
│       └── buffer × N        DestroyProxy, SmoothTransform, DestroyWithoutChildren
│           └── Card          a Sharkmake DeckReader card
├── holder / buffer / search
└── filler                    the stack's body + `Edge (Baked)`, the visible deck edge
```

Two families of parts, both third-party, both credited: the **holder** is Deck Maker by Ukilop
V1.4.4; the **card** is Sharkmake's DeckReader card. The card is not Deck Maker's own — DeckReader's
already has rounded corners in the mesh and takes its face from a texture, so nothing needs a
corner mask and nothing needs compositing. One mesh is shared by every card in the deck (`0000944d`
in the reference deck) — there is no per-card `StaticMesh` asset any more, which is also why
trimming a v1.0 deck drops nothing from `/Assets`: see "Variable card count" below.

### How a card gets its picture

```
DATATEMPLATE (DynamicVariableSpace "DATA", hoisted onto Card itself - see below)
  DynamicValueVariable<string> "NAME"    e.g. "TD02-001"
  DynamicValueVariable<string> "FRONT"   e.g. "https://…/img/TD02-001?w=512&v=2"
  DynamicValueVariable<string> "BACK"    e.g. "https://…/back"
```

and the chain each one drives, verified in the committed deck:

```
FRONT (string)
  → GlobalReference<IValue<string>> → ObjectValueSource<string>
  → StringToAbsoluteURI
  → ObjectFieldDrive<Uri>  drives  DATATEMPLATE/Front · ValueField<Uri>.Value
  → ValueCopy<Uri>         copies to  flipper · BooleanValueDriver<Uri>.FalseValue

BACK  → … same → BooleanValueDriver<Uri>.TrueValue

flipper · BooleanValueDriver<Uri>   (State ← TouchToggle, i.e. the card being flipped)
  → drives  Card/Template · StaticTexture2D.URL
```

**So an exporter's entire job per card is to write three strings.** `NAME`, `FRONT` and `BACK` on
that card's `DATATEMPLATE`. Everything downstream is driven in-world — including the flip: the card
is not literally two-sided geometry, it is a `TouchToggle` swapping which URL a single texture
slot points at. (The pre-v1.0 panel's own hand-built card *was* two-sided geometry, and getting a
real back face onto it was an open problem for months — `docs/HANDOFF.md` records everything that
was ruled out chasing it. Adopting DeckReader's card sidesteps the whole problem rather than
solving it: there is no back face to get wrong.)

`Card/Template`'s `StaticTexture2D.URL` is a **driven** field — writing it is only seeding what
shows before the drivers first run. `web/fill.js` seeds it anyway so an imported deck is never
briefly blank.

**Every card's `BACK` is the same URL.** One shared back for the deck.

### The `DATA` space is hoisted onto `Card`, and this is checked, not assumed

Sharkmake's own card puts the `DATA` variable space on `DATATEMPLATE`. The panel's template —
which is where the shipped deck template comes from — hoists that space one level up, onto `Card`
itself. This is **not** cosmetic: dynamic-variable lookup only ever walks **up** the slot tree, so
a write addressed at the `Card` slot (which is how the panel writes a fresh card's art after an
import) finds the hoisted space and misses the un-hoisted one entirely, silently. `web/fill.js`
asserts the space is on `Card` before writing anything, specifically because of this.

The one committed hand-capture (`booster/out/ResoPal_TD02_Deck_v1.0.resonitepackage`) still has the
space on `DATATEMPLATE` — it predates the hoist and is not a template to copy that detail from. Its
card **order**, **stack geometry**, and **shared back** are still the oracle; its DATA-space
placement and its art URL shape are not — see the next two sections.

### Art URLs must match the Worker's shape, or the same card is two different assets

The reference deck's `FRONT` reads `…/img/TD02-001?w=1024` with no cache-bust. That is a hand
capture, not builder output, and copying its shape is wrong. What the panel actually receives from
the Worker (`worker/src/roll.js`, `toFixed()`) is `?w=512&v=2`:

- **`w=512`, not `1024`.** In-world art is per-card, not atlas cells — 50 cards at `w=1024` is
  ~95 MB of VRAM resident at once; at `w=512` it is ~24 MB, the same per-card resolution a
  whole-set atlas could have managed inside Resonite's 8192 texture limit anyway.
- **`&v=2` is load-bearing.** Resonite caches a texture by URL, in the install, and neither a new
  world nor a fresh import clears it. Without a version bump baked into the URL, a client that
  already fetched a card once keeps whatever it fetched — stale art after a re-rotation, forever.

`web/fill.js`'s `IN_WORLD_WIDTH`/`ART_VERSION` constants **must** track `worker/src/roll.js`'s
`IN_WORLD_WIDTH` and the `&v=` literal in `toFixed()`. If they drift, a card the panel fetches and
a card the site's deck fetches are two different URLs for the same art — two different cache
entries, two different downloads, for every player who has both.

### How cards go into the deck

`Surface/cards/Cards` holds **one `buffer` slot per card**, each with exactly one `Card` child, and
`Assets` holds exactly one `proxy` per buffer — the two lists are **1:1 by position**, checked
before anything is written (`web/fill.js` `readTemplate()`).

**A buffer with no children destroys itself.** Each carries `DestroyWithoutChildren`, so "empty the
template then fill it" does not work — every buffer self-destructs on import and the deck arrives
empty with nothing to put cards into. Trim by removing whole buffers, never by emptying one.

Buffers are **pre-positioned** by the exporter. The holder only recomputes card positions on an
event (shuffle, search), not on load, so a freshly imported deck sits at whatever spacing the file
says:

```
z = (i − (n−1)/2) × step        for i in 0…n−1        step = Deck/cardSize.z
```

Each buffer's `SmoothTransform.TargetPosition` has to move with its position, or the buffer springs
back to the template's old spacing the moment it is grabbed.

### Numbers that must be right

Measured against a known-good deck in-world; several were wrong for multiple rounds first.

| what | value | why |
|---|---|---|
| `Deck/cardSize` | `0.17602, 0.24643, 0.00130` | **z IS the per-card step** — the holder lays buffers out by it |
| deck root scale | `1, 1, 1` | Deck Maker exports ship at 1.42188; leave it and a card taken to a playmat and back comes home shrunk |
| card slot scale | `0.495` | what the play board assigns on contact. **Do not derive from mesh bounds** — there is an inner `Visual` at scale 5.6 between slot and renderer |
| card thickness | inner `Visual` y = `7.5036` | on `Visual`, never the Card slot: the play board overwrites the Card slot with a *uniform* scale |
| card collider z | `= the step` | thinner and you cannot place a card; thicker and colliders overlap and you cannot pick one up |
| filler `Edge (Baked)` mesh | `b3dad283…99300a9a` | **two bakes exist with identical 528-vertex topology**, one rounded and one square. The panel shipped the wrong one for weeks with all the right numbers beside it. Assert the hash |
| deck template buffer count | **52** | the v1.0 template's real ceiling — see "Variable card count" |

### Variable card count — nothing per-card is an asset any more

The deck's flux still drives its loops from **`Children Count`**, not a baked-in number — the same
fact PIPELINE.md has always recorded, still true. But what trimming *touches* changed completely.
The pre-v1.0 (atlas) deck owned one `StaticMesh` per card with its atlas cell baked into the UVs,
so trimming had to drop `template_cards - N` orphaned meshes and assert the count. **A v1.0 deck
shares one mesh across every card and carries no atlas, so a v1.0 trim orphans nothing at all** —
`web/fill.js` asserts exactly that (zero newly-unreferenced assets after a trim) rather than a
mesh-count subtraction, and throws if the template ever stops being that shape.

Trimming to N means:
- `/Surface/cards/Cards` children -> N
- `/Assets` children -> N (still **per-card driver flux**, 1:1 with cards, same as before)
- re-lay `z` per buffer and its `SmoothTransform.TargetPosition` (see above)
- write `NAME`/`FRONT`/`BACK` per card, seed `Template.URL`

**The template's buffer count is a hard ceiling, not a soft one.** A deck cannot grow past it —
each buffer carries its own driver flux under `/Assets`, so there is no "spare capacity" to fill,
only buffers that exist or don't. The v1.0 template holds **52**. Raising it means re-exporting a
larger holder from the panel (`booster/extract-deck-template.mjs`) — see "The shipped templates".

### Credits

`/credits` under the deck root holds **four** name-only slots (`web/credits-v1.js` *verifies*
this — see below for why it no longer builds it):

```
Card data - Palify - palify.org
Deck template - Deck Maker by Ukilop V1.4.4
Card templates & TCG field systems - Sharkmake (AKA Flux)
Tool by Dalek - dalek.coffee - ResoPal v1.0 - resopal.dalek.coffee
```

Sharkmake is new in v1.0 — the card templates every card is now built on are theirs. Ukilop's line
keeps its version number on purpose: it matters when a future Deck Maker changes the template.
Slot names are plain text — no rich text, no links — so urls are written out to be read.

**Why `web/credits-v1.js` verifies instead of building them:** the old `web/credits.js` built
`/credits` at bake time, because a raw Deck Maker export only ever carried Ukilop's own line. The
v1.0 template ships all four already, extracted straight out of the panel that carries them — so
building them again would either duplicate the slot or quietly disagree with the panel's copy.
Checking is the whole job, and it fails the export loudly rather than shipping a deck that credits
the wrong people. (`web/credits.js` is unreferenced by the deck path now but is not deleted — see
"What's dead and what isn't".)

## Sheet path: an atlas patched into an older template

Everything in this section is **sheet-only** — it describes `compose.js`/`imgfix.js`,
`tools/compose.py`/`tools/imgfix.py`, and the `bakeSheetOnly()` half of `web/bake.js`. None of it
touches the deck any more.

### The atlas contract

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
- **The grid is baked into the mesh UVs.** It cannot be changed without re-baking the template, and
  the atlas image must keep the grid's proportions — cropping unused rows would break every UV.

Resolution: at 8192² a card is 819 px wide (source is 1024) and effect text stays readable. At
4096² it is 409 px and text suffers. **8192 is the default.**

WebP is the right format — 2.5 MB versus 14.6 MB for the same 4096² atlas as PNG, and Resonite
ingests WebP natively.

### White rim on card corners

Palify card art is **matted against white**: the antialiased edge pixels are light grey (~169)
while the card interior at the corner is dark (~42), and their alpha (~140) is above a 0.5 cutout
threshold, so they survive as a visible white rim.

Fix is two-part, in `imgfix.solidify` plus the material:
1. **Solidify before resizing** — replace RGB in transparent and semi-transparent pixels with the
   nearest trusted-opaque colour so the white matte cannot bleed inward. Measured: rim-vs-interior
   brightness gap **+22.9 -> +5.1**.
2. **`AlphaCutoff` 0.5 -> 0.72** to trim what remains.

Both facts are specific to the **atlas** card, whose corner rounding is a texture cutout on a flat
mesh. The v1.0 deck card's rounding is baked into DeckReader's own mesh geometry, so it has no
white-rim problem to fix and ships at the default `AlphaCutoff` (0.5, `Opaque`) — see "Materials".

### Materials

The atlas card materials must be `Cutout`, not `Opaque` — Opaque discards alpha entirely and the
rounded corners (cut into the texture, not the mesh) render solid.

`Cutout` is chosen over `Alpha` deliberately: 50 cards stacked face-to-face would show transparency
sorting artifacts with `Alpha`. `Cutout` stays in the opaque queue.

**This is inverted for the v1.0 deck.** DeckReader's card has its rounding baked into the mesh, not
cut from the texture, so its material ships `Opaque` with the default `AlphaCutoff` (0.5) and stays
that way — verified against the reference deck. Do not port the atlas card's `Cutout`/`0.72`
assertion onto the deck path; it would be forcing a fix for a problem the new geometry does not
have.

### Landscape cards

26 of 158 cards (every one a `Structure`) are printed sideways, and Palify serves them
**already landscape** (1024x732). They must be rotated **clockwise** (`Image.ROTATE_270` in
`compose.py`, `ROT = 90` in `compose.js` — they agree, the constants don't) before placement, or
they get squashed into the portrait cell. The catalogue's `landscape` boolean is authoritative — do
not infer from dimensions.

**The deck path does not rotate anything client-side.** Landscape rotation for in-world art moved
server-side, into the Worker's `/img/` route (`worker/src/index.js`, `isLandscape` + the `ROTATED`
fetch) — the site never sees the pixels, so it cannot rotate them and does not try to.

### Card edge colour

The card edge is material `0000b06d`: a 64x256 stripe texture tiled 100x vertically to fake stacked
paper, with a **white `TintColor`** — the Deck Maker's "Edge Color" picker. At high bevel the white
rim is wide enough to wrap into view from the front and read as glare. Patchable without a re-bake
via `EDGE_TINT` — but only in `tools/patch.mjs`, the CLI hand-bake path. `web/`'s deck export never
touches this material at all any more (nothing about the deck path patches the atlas template), so
`edgeTint` is now dead weight in `web/bake.js`'s old signature; it was never threaded through
`fillDeck`.

### Fonts are 88% of a raw Deck Maker export

The stock template embeds 5 fonts totalling ~18.4 MB of a 20.9 MB package. **`MainFont` is only
452 KB; the four fallbacks are 17.9 MB** (the largest is a 16.5 MB CJK font).

Dropping the fallbacks and clearing both `FontChain.FallbackFonts` arrays takes a package from
25 MB to ~11 MB with zero dangling references. Latin text renders unchanged; CJK glyphs would now
fall back to the engine default. This is `tools/strip_template.mjs`'s (and `web/patch.js`'s) job for
the sheet path's template.

**The deck template needs no font strip of its own.** It was extracted out of the panel by
reachability (see "The shipped templates"), and reachability already drops anything the kept deck
subtree does not name — including any font the deck itself does not reference.

## Facts true of both paths

### BSON numeric gotcha

`deserializeBson` returns doubles as **`Double` objects, not primitives**, so
`typeof x === 'number'` is false and a numeric edit silently no-ops. Assign a plain JS number and
BSON re-serializes it correctly — this is exactly why `web/fill.js` wraps every position/scale
write in `new Double(...)`.

### A URL field is `@` + the URL, and without the `@` it loads as null

The single highest-value fact in this document, and it is load-bearing on **every export**.
`Elements.Core/DataTreeValue.cs`:

```
UpdateValue(Uri url)  ->  Value = "@" + url.ToString()
IsURL                 ->  Value is string, Length > 1, [0] == '@' && [1] != '@'
ExtractURL()          ->  throws "DataTreeValue isn't an URL" unless IsURL,
                          then returns new Uri(text.Substring(1))
```

So `@` is the DataTree's **type tag for a `Uri`**, not decoration — that is how a `Sync<Uri>` is
told apart from a `Sync<string>` in a format where both are strings. A plain string that really
does begin with `@` is escaped by doubling it (`PreprocessString`), which is why `IsURL` checks
`[1] != '@'`.

Write a URL without the marker and `Extract<Uri>` throws, the load swallows it, **the field ends up
null and the asset silently never loads**. No error in-world, no error in the package: it
validates, it round-trips byte-identical, every reference resolves.

This cost a drag-test. The deck probe wrote `https://…/img/TD01-001?w=512` straight into
`StaticTexture2D.URL`; in-world all three cards were blank with a null URL.

The stock Deck Maker export carries **62 URL values and marks every one**, which is what makes it
usable as an oracle. `booster/urlmarker.mjs` holds the rule; `web/fill.js` imports it directly
(rather than re-implementing it) and calls `scanUrlFields` as a hard gate before writing the
package — an unmarked `https://` anywhere fails the export instead of shipping.

The rule has to be narrow. A ProtoFlux request node also has a field called `URL`, but it holds a
*reference* to the node feeding it; and a plain string field that happens to contain a URL — the
panel's `ResoPal/url` variable, a card's `DATA/FRONT`, or the `ValueObjectInput<string>` behind
each button — is a string and must **not** be marked. So: a field named `URL`, whose value is a
string that is not a GUID.

**None of this applies to a URL set at runtime.** ProtoFlux hands the field a live `Uri` object
(`StringToAbsoluteURI` → `ObjectFieldDrive`), which never goes through DataTree string parsing.
That is exactly why the panel's driven card art works and a statically authored one did not — and
why the deck's `FRONT`/`BACK` strings are written plain while `Template.URL` (the seeded, driven
field) is written marked.

### An id is declared under five different key spellings

Counting ids is how reference counting and every "zero dangling references" check works, and a
scan that only knows `ID` gets the answer badly wrong. In the stock (atlas) template:

| key | count | where |
|---|---|---|
| `ID` | 38220 | components and every sync field |
| `persistent-ID` | 3347 | a component's persistence flag |
| `Persistent-ID` | 2084 | **slots** — note the capital |
| `ParentReference` | 2084 | slots, one per `Persistent-ID` |
| `<name>-ID` | ~90 | a type's private fields: `_shader-ID`, `_unlit-ID`, `_unlitBillboard-ID`, `__legacyZWrite-ID`, `__legacyActiveUserRootOnly-ID` … |

So the rule is **`ID`, `ParentReference`, or anything ending `-ID`** declares; every other
guid-shaped value is a reference. `booster/splice.mjs`'s `isDeclarationKey` and
`booster/extract-deck-template.mjs`'s dangling-reference assertion both use exactly this rule.

This is not academic: cloning a `UnlitMaterial` while remapping only `ID` and `persistent-ID` left
every copy sharing the original's `_unlit-ID` and `_unlitBillboard-ID`. The package encoded cleanly
and had no dangling references — the duplicate-id check is the only thing that saw it.

## What's dead and what isn't

`web/patch.js`, `web/trim.js`, `web/credits.js` (the atlas-era, build-time credit constructor —
not `web/credits-v1.js`) and `web/imgfix.js` are **unreachable from `web/bake.js` for the deck
path** as of v1.0 — nothing imports them any more, and `esbuild`'s bundle confirms it (the built
`bake.bundle.js` shrank, not grew, despite two new modules). They are **not deleted**:

- `tools/patch.mjs` is `web/patch.js`'s command-line twin (`tools/trim.mjs`, `tools/credits.mjs`,
  `tools/compose.py`/`imgfix.py` alongside it), and the sheet-hand-bake workflow this file
  documents still exists and still uses them — `web/*.js`'s versions are its browser port.
- Every fix this file records about the atlas card (solidify, `Cutout`, the font strip, the edge
  tint) lives in their comments, not just in prose here.
- Deleting working code that nothing currently calls, on the strength of "the deck path doesn't
  need it any more," is exactly the kind of cleanup this file's own opening warns against.

Delete them once the sheet-hand-bake path is confirmed to still work standalone without them ever
having been reachable from `bake.js` — not before.

## Verification that must pass before shipping a package

Every one of these is cheap and each has caught a real bug. Deck-path checks live in
`web/fill.js` itself (it throws rather than shipping); sheet-path checks are `tools/`'s and
`web/patch.js`'s own assertions.

- every `Assets/<hash>` blob hashes to its own filename
- `assetUri` resolves to a present blob
- `assetManifest` and the blob set agree **in both directions**
- zero dangling `packdb:///` references
- zero duplicate IDs across the whole document
- the package re-decodes with its full type table
- **sheet path:** meshes dropped == `template_cards - N`
- **deck path:** zero assets newly unreferenced by a trim (nothing per-card is an asset)
- **deck path:** every Uri field marked, no string field marked (`scanUrlFields`)
- **deck path:** `/credits` carries all four required lines (`verifyCredits`)

## Deck Maker settings (in-world, panel labels in brackets)

| Control | Package field | Notes |
|---|---|---|
| Bevel | `radius Slider` | range 0–0.35. **0 = square corners.** Printed art radius is 3.22% of card width |
| Thickness | `thickness Slider` | card depth only; does not affect corner rounding |
| Edge Color | material `0000b06d` `TintColor` | white by default. **Sheet-path only** — see "Card edge colour" |
| Columns / Rows / Card Amount | `AtlasInfo` GridSize / GridFrames | **sheet-path only** — the grid is baked into the atlas card's mesh UVs and has no equivalent on the deck path |

The Deck Maker itself: `resrec:///U-ukilop/R-e7100d16-9b62-4d74-b8e0-058b0492764f`

## Browser port (`web/`)

`web/` is the browser build of everything in `tools/`. For the sheet path, `trim.js` and
`credits.js` are byte-for-byte copies of their `tools/` counterparts — they were already
dependency-free. The rest is ported:

| Node/Python | Browser |
|---|---|
| numpy `solidify` | typed arrays over `ImageData`, same 8-neighbour dilation with wraparound |
| PIL `resize(LANCZOS)` | `drawImage` with `imageSmoothingQuality:'high'` |
| PIL `save(WEBP, q95)` | `OffscreenCanvas.convertToBlob({type:'image/webp'})` |
| `crypto.createHash` | `crypto.subtle.digest('SHA-256')` (async) |
| `brotli-wasm` CJS build | the web build; its `.wasm` ships beside `bake.bundle.js` |

Sheet output is **structurally identical** to the Node pipeline — same file count, asset count,
manifest length — but **not byte-identical**, because the browser's WebP encoder and resampler are
not libwebp `method=6` and LANCZOS. Measured against an approved package: whole-atlas mean absolute
difference 1.31/255. Compare structure, never bytes.

**The deck path has no Node/Python counterpart to port from.** `booster/build-deck-probe.mjs` is
the tool that first proved per-card URL art works at all (see its own header comment for the UV/ST
math), and `booster/extract-deck-template.mjs` is what turns the panel's own template into
`data/template.resonitepackage`, but neither is a "the same thing, run in Node" twin of
`web/fill.js` the way `tools/patch.mjs` is of `web/patch.js`. `web/fill.js` is verified instead
against `booster/out/ResoPal_TD02_Deck_v1.0.resonitepackage`, the hand-captured reference deck —
see `web/test-fill.mjs`.

### Two packages in one run — sheet path

The soul deck is not a separate pipeline: it is the same bake over a one-code deck
(`[{code: soulCode, n: soulCount}]`), because every `Soul` printing is the same card with different
art — see `docs/PALIFY-API.md`. "Generate and download both" runs the bake twice against the same
template `ArrayBuffer`, which is safe; JSZip reads it without taking ownership.

What is **not** safe, sheet-path only, is reusing decoded art. `composeAtlas` calls `bmp.close()`
on every bitmap it draws, so an `ImageBitmap` can be handed to exactly one bake — the second gets a
detached bitmap and `drawImage` throws. The art cache in `index.html` therefore caches the
**fetched Blob** and decodes per bake.

**The deck path reads no pixels, so this entire failure mode does not exist for it.** Two
`fillDeck()` calls against the same template `ArrayBuffer` — verified — need no such care; there is
no bitmap to close.

### Rotation direction is inverted between PIL and canvas — sheet path

PIL's `Image.ROTATE_270` and a canvas `rotate(90°)` are **not** the same direction. `compose.py`
uses `ROTATE_270` and `compose.js` uses `ROT = 90`; they agree, and the constants don't. Getting
this wrong is silent — the cards still tile correctly, they are just upside down.

Verify by rendering a landscape card (any Structure, e.g. `TD02-008`) and diffing it against a
known-good bake, both as-is and rotated 180°. If the 180° diff is the smaller one, the direction is
wrong.

**Extract the reference atlas from inside the package you are comparing against — never from a
loose intermediate file.** This bug shipped twice. The second time was because the comparison used
`front_8192.webp` left lying in the build directory, which predated the rotation fix by twenty
minutes: the browser was "corrected" to match an atlas that was itself wrong, and the diff came
back clean because both sides were wrong in the same way. A stale oracle is worse than no oracle,
because it manufactures confidence. Pull the atlas out of the `.resonitepackage` every time.

**The equivalent deck-path caution: a reference deck can itself be stale.** The one committed for
comparison here (`booster/out/ResoPal_TD02_Deck_v1.0.resonitepackage`) is a hand capture that
predates two things this file documents as current — the `?w=1024`, no-`&v=` art URL, and the
un-hoisted `DATA` space (see "Art URLs must match the Worker's shape" and "The `DATA` space is
hoisted onto `Card`" above). Diff a build against it for **card order, stack geometry, and the
shared back** — those are still the oracle — never for the exact URL string or where the `DATA`
space sits; `web/test-fill.mjs` asserts the divergence on both counts explicitly, precisely so a
future reader does not "fix" the site to match the older shape.

## The shipped templates

### `data/template.resonitepackage` — the deck (v1.0)

**Extracted, not built, and not stripped from a Deck Maker export any more.**
`booster/extract-deck-template.mjs` lifts the `Deck template` subtree straight out of
`booster/out/ResoPal_Panel_v1.0.resonitepackage` — the same subtree the panel duplicates and fills
on every in-world import — so the site and the panel produce the same object by construction, not
by two implementations staying in sync by hand. (They drifted apart once already, over credits;
that is the whole reason this tool exists rather than a second hand-authored template.)

The panel's own ids are kept: they are already unique inside that one document, and a document
that contains nothing else cannot collide with them, so nothing is remapped. Two tables are pruned
by **reachability**, never by name — `Types` (a component's `Type` is an index into it, so a
dropped entry silently renumbers everything above it; collected from the kept components, then
remapped in one pass) and `Assets` (assets reference each other, so reachability is iterated to a
fixpoint — the same "walk the whole document, not just the object graph" rule that, done wrong,
once deleted `MainFont` and broke every button).

```bash
RKL=/path/to/Resonite-Knowledge-Library node booster/extract-deck-template.mjs
#   panel=booster/out/ResoPal_Panel_v1.0.resonitepackage   (default)
#   out=data/template.resonitepackage                      (default)
```

Re-run it whenever the panel's `Deck template` subtree changes — a bevel, a bigger buffer count, a
credits update. Then re-verify with `node web/test-fill.mjs`, which fills the new template with the
real TD02 decklist and checks the result against the committed hand-captured reference deck.

### The sheet-path template — a Deck Maker export, stripped

Unchanged by v1.0. A Deck Maker export run through `tools/strip_template.mjs`, which removes the
payloads every sheet bake throws away anyway: the fallback font chain, the placeholder atlas and
the placeholder back. `Metadata/*.bitmap` sidecars are kept — `web/patch.js` reads the old ones to
build the new ones — and the doc is untouched, so `patch.js` still runs its own font strip and
texture swap and simply finds less to do.

```bash
node tools/strip_template.mjs src=DeckRounded.resonitepackage out=<wherever the sheet path reads from>
```

This is no longer `data/template.resonitepackage` — that path now belongs to the deck template
above. Point the sheet-hand-bake tooling at wherever its own template now lives before running it.
