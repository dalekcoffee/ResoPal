# How a v1.0 deck is built — brief for the website port

**Working brief, not permanent documentation.** It exists so the site's exporter can be
changed to produce what the v1.0 panel produces, then folded into `PIPELINE.md` and deleted.

Read alongside the two committed artifacts:

- `booster/out/ResoPal_Panel_v1.0.resonitepackage` — the panel
- `booster/out/ResoPal_TD02_Deck_v1.0.resonitepackage` — **a finished 50-card deck in the
  target format.** Decode it and compare against whatever the site produces; it is the
  reference, and it is worth more than this file.

Everything here was read out of that deck, not remembered.

## The shape of it

```
Deck                          Grabbable, DynamicVariableSpace "Deck",
                              DynamicValueVariable<float3> "Deck/cardSize", ObjectRoot
├── credits                   attribution, as slot NAMES (see below)
├── Assets                    materials, atlas info, the shared card back
├── logixs                    Ukilop's deck logic
├── buttons                   shuffle, search
├── Surface/cards             GrabbableReceiverSurface — where a card lands
│   └── Cards                 ONE `buffer` child per card
│       └── buffer            DestroyProxy, SmoothTransform, DestroyWithoutChildren
│           └── Card          a DeckReader card
├── holder / buffer / search
└── filler                    the stack's body + `Edge (Baked)`, the visible deck edge
```

Two families of parts, both third-party, both credited: the **holder** is Deck Maker by
Ukilop V1.4.4; the **card** is Sharkmake's DeckReader card. The card is not Deck Maker's —
DeckReader's already has rounded corners in the mesh and takes its face from a texture, so
nothing needs a corner mask and nothing needs compositing.

## How a card gets its picture

**This is the whole point of the change: nothing is baked.** No atlas, no canvas, no
compositing. Each card carries two strings and the card wires itself up at runtime.

```
DATATEMPLATE (DynamicVariableSpace "DATA")
  DynamicValueVariable<string> "NAME"    e.g. "TD02-001"
  DynamicValueVariable<string> "FRONT"   e.g. "https://…/img/TD02-001?w=1024"
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

**So an exporter's entire job per card is to write two strings.** `FRONT` and `BACK` on that
card's `DATATEMPLATE`. Everything downstream is driven in-world.

`Card/Template`'s `StaticTexture2D.URL` is a **driven** field — writing it is only seeding
what shows before the drivers first run. The panel's builder seeds it anyway so an imported
deck is never briefly blank.

**Every card's `BACK` is the same URL.** One shared back for the deck. (When custom backs
land, that is the single string to vary.)

### The `@` rule — this one is silent and it has bitten twice

A URL written into a **`Field_Uri`** needs a leading `@`:

```
StaticTexture2D.URL   →  "@https://…"      ✅
StaticMesh.URL        →  "@packdb:///…"    ✅
Hyperlink.URL         →  "@https://…"      ✅
```

A bare `https://` in a Uri field **deserialises to null on import, silently** — the card
renders white and nothing errors anywhere.

The inverse is equally true: `DynamicValueVariable<string>`, `ValueField<string>` and every
other **string** holder takes the URL **plain**. Put an `@` there and it renders as text.
`FRONT` and `BACK` are strings — no `@`.

The panel's builder has an `auditUrls()` pass that fails the build on an unmarked `https://`
in a Uri field. Port it; it is twenty lines and it catches the whole class.

## How cards go into the deck

`Surface/cards/Cards` holds **one `buffer` slot per card**, each with exactly one `Card`
child. Deck size *is* buffer count.

**A buffer with no children destroys itself.** Each carries `DestroyWithoutChildren`, so
"empty the template then fill it" does not work — every buffer self-destructs on import and
the deck arrives empty with nothing to put cards into. Populate as you trim, or trim by
removing whole buffers.

Buffers are **pre-positioned** by the builder. The holder only recomputes card positions on
an event (shuffle, search), not on load, so a freshly imported deck sits at whatever spacing
the file says. Each buffer's `SmoothTransform.TargetPosition` has to move with its position,
or the buffer springs back.

```
z = (i − (n−1)/2) × step        for i in 0…n−1
```

## Numbers that must be right

From the panel builder's `baseline.mjs`. Each was measured against a known-good deck
in-world, and several were wrong for multiple rounds first.

| what | value | why |
|---|---|---|
| `Deck/cardSize` | `0.17602, 0.24643, 0.00130` | **z IS the per-card step** — the holder lays buffers out by it |
| deck root scale | `1, 1, 1` | Deck Maker exports ship at 1.42188; leave it and a card taken to a playmat and back comes home shrunk |
| card slot scale | `0.495` | what the play board assigns on contact. **Do not derive from mesh bounds** — there is an inner `Visual` at scale 5.6 between slot and renderer |
| card thickness | inner `Visual` y = `7.5036` | on `Visual`, never the Card slot: the play board overwrites the Card slot with a *uniform* scale |
| card collider z | `= the step` | thinner and you cannot place a card; thicker and colliders overlap and you cannot pick one up |
| filler `Edge (Baked)` mesh | `b3dad283…99300a9a` | **two bakes exist with identical 528-vertex topology**, one rounded and one square. The panel shipped the wrong one for weeks with all the right numbers beside it. Assert the hash |

## Credits are a requirement

Ukilop's and Palify's credits ship inside every generated deck — that is already in
`CLAUDE.md`. v1.0 adds **Sharkmake**, whose card templates every card is now built on, and
carries all four as **slot names** under `/credits`, because slot names are all a deck has
once it is loose in a world:

```
Card data - Palify - palify.org
Deck template - Deck Maker by Ukilop V1.4.4
Card templates & TCG field systems - Sharkmake (AKA Flux)
Tool by Dalek - dalek.coffee - ResoPal v1.0 - resopal.dalek.coffee
```

Slot names are plain text — no rich text, no links — so urls are written out to be read.
The list lives in one module in the panel builder precisely because a standalone deck and a
panel-spawned deck drifted apart once.

## What this means for `web/`

The site currently composes an 8192² atlas in the browser and patches it into
`data/template.resonitepackage`. With URL cards there is nothing to composite.

**Likely dead:** `bake.js`, `bake.bundle.js` (340 KB), `compose.js`, the atlas half of
`trim.js`, `imgfix`/`solidify`, and `tools/compose.py` + `imgfix.py`.

**Two invariants in `CLAUDE.md` go with them,** because both are consequences of drawing to
a canvas and neither applies once nothing does:

- *"The bake must stay in the browser"* — the 8192²/256 MiB argument
- *"Card art must be same-origin or CORS-enabled"* — the canvas-tainting argument

The Worker's `/img/` CORS re-serve exists to feed that canvas. Resonite fetches the art URL
itself, so it may not be needed at all — **but check before deleting**: art URLs also want
to be stable and long-lived, which is a reason to keep proxying them that has nothing to do
with CORS.

**What replaces it:** make `data/template.resonitepackage` the deck template the v1.0 panel
spawns — the same holder, with a DeckReader card in every buffer and the geometry above
already applied — put through `tools/strip_template.mjs` as today. The site's job then
becomes:

1. clone the template
2. trim buffers to the deck size (remove whole buffers, never empty them)
3. write `FRONT` and `BACK` on each card's `DATATEMPLATE`
4. re-lay buffer positions and their `SmoothTransform.TargetPosition`
5. re-zip

That is the same sequence the panel's flux performs at runtime, which is the point: the two
paths stay identical by construction rather than by discipline.

`PIPELINE.md` and `HANDOFF.md` are both written around the bake and will need rewriting.
`PIPELINE.md` opens by warning that its fixes get re-broken by people removing what looks
redundant — worth reading before deciding any of the above is dead.
