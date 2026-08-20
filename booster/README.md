# In-world panel

`out/ResoPal_Panel.resonitepackage` (335 KB) is a grabbable UIX panel. Drag it into
Resonite and you get a working UI immediately — no network call needed to see something.

Five buttons:

| Button | Asks resopal for | Cards |
|---|---|---|
| Trial Deck · Red / Blue | `/api/deck?deck=td01&format=flat` | 48 |
| Trial Deck · Green / Purple | `/api/deck?deck=td02&format=flat` | 50 |
| Open 1 Booster · BP01 | `/api/pull?set=BP01&packs=1&format=flat` | 7 |
| Open 3 Boosters · BP01 | `/api/pull?set=BP01&packs=3&format=flat` | 21 |
| Open 10 Boosters · BP01 | `/api/pull?set=BP01&packs=10&format=flat` | 70 |

Press one and the cards appear in a 10×7 grid below the panel, art streaming in from
the image proxy. The status line under the title shows the first card it parsed — or,
when a request fails, the error text, because `GET_String` writes the exception message
into the same field.

**Nothing about a deck is baked in.** The panel knows five URLs. Card codes, how many
there are, and what order they come in all arrive over the wire. Adding a set or a deck
is a line in `BUTTONS` at the top of `build-panel.mjs`; the graph never learns what is
inside one.

## How it hangs together

```
Button ──ButtonDynamicImpulseTrigger──▶ "ResoPal/pack/3"
                                             │
                       DynamicImpulseReceiver│
                                             ▼
                      WriteDynamicValueVariable  ResoPal/url := <that button's URL>
                                             │ OnSuccess
                                             ▼
      IsHostAccessAllowedUrl ─┬─ yes ─▶ GET_String ──▶ Content
                              └─ no ──▶ RequestHostAccessUrl ─ OnGranted ─┘
                                                                 │
                    70 × ( find comma · substring the code · concat the art URL )
                                                                 │
                    ObjectFieldDrive<Uri>  ──▶ StaticTexture2D.URL
                    ValueFieldDrive<bool>  ──▶ Slot.Active
```

Buttons and graph never reference each other — the impulse tag is the only thing
between them, which is what lets the flux live in its own subtree.

Past the GET there are **no impulses**. The drives pull their inputs every frame, so
cards fill in the moment the response lands.

**The count is dynamic without anything counting.** A card's slot is `Active` exactly
when its own line parsed. Seven lines light seven cards and leave sixty-three dark; a
50-card deck lights fifty. One shared parser handles both because `/api/deck` returns
the same `code,rarity` lines a pull does.

## Build

Needs the Resonite Knowledge Library for its ProtoFlux encoder. That library is not
vendored here; point `RKL` at a checkout.

```bash
cd booster && npm install
RKL=/path/to/Resonite-Knowledge-Library npm run build
RKL=/path/to/Resonite-Knowledge-Library npm test
```

`PROXY=`, `LOGO=` override the endpoint and the mark.

## What is verified, and what is not

`npm test` reads the **built package** — not the builder's intentions — so a node wired
to the wrong id fails there exactly as it would in-world. It checks:

- **The UI exists**: one Canvas with a real size, its root rect and collider wired to
  components on its own slot, five buttons that each tint an Image on their own slot and
  carry a caption, and every `Text` pointing at a font that actually ships in the package.
- **Buttons reach the graph**: every tag a button sends is heard by a receiver, every
  receiver writes a distinct URL, and all five funnel into one shared GET.
- **The parse graph, evaluated** against live responses from the Worker for all five
  buttons — 7, 21, 70, 50 and 48 cards — asserting the right number of cards light up,
  that they are the first N, and that each one points at its own line's art. Plus an
  empty response and a network error, which must light nothing.
- **Encoding**: zero dangling references, zero unbound hooks, BSON round-trips
  byte-identical, no overlapping comment zones.
- **Layout**: the graph is split into labelled `(f)` groups, no two groups overlap, and
  nodes inside a group clear the footprint of a real node visual.

The evaluator models the decompiled nodes' own clamping — `IndexOfString` returning −1
for an out-of-range start, `Substring` returning `""` — rather than JavaScript's. That
matters: it is what caught the cursor wrapping to 0 past the last line, which lit 62
cards for a 7-card pull and showed the first card's art on all of them.

**None of that proves Resonite accepts the file.** Only a drag-test does.

### If something is wrong, check these first

1. **Host access.** The panel asks once, naming ResoPal. Denying it leaves the status
   line showing the error and no cards.
2. **`/api/pull` and `/api/deck` must be deployed.** Until the Worker ships them, every
   button ends at the status line with a network error. That is the intended failure —
   visible rather than silent — but it is still a failure.
3. **Panel scale.** 620×600 canvas units at 0.00058 ≈ 36×35 cm. Grab and scale it if
   that reads wrong in your session.
4. **Card orientation.** Quads are `DualSided`, so they are never invisible, but from
   behind you see a mirrored front rather than a card back.

## Known gaps

- **Landscape cards render sideways.** 19 of BP01's 101 cards are printed landscape
  (`data/pool-bp01.json` lists them) and nothing here rotates them. The fix needs a node
  that exposes a loaded texture's aspect; worth confirming one exists before designing
  around it.
- **The white corner rim.** Materials are `Cutout` at `AlphaCutoff 0.72`, the values the
  deck bake settled on, but this path skips `solidify()` — expect a fainter version of
  the rim `docs/PIPELINE.md` describes.
- **70 cards is the ceiling**, matching the deck template's 10×7 atlas grid. A deck
  larger than that would be truncated rather than refused.
- **No retry.** One request per press; nothing re-fires if the permission prompt is
  still open.

## Why this is not the deck object

The deck's cards share **one atlas texture** with the per-card UVs baked into the mesh,
so card 3 cannot be pointed anywhere else — and nothing in-world can compose an 8192²
atlas anyway (`docs/WORKER.md`). Seven independent textures is the only shape that works
at runtime.

The deck path is still the better way to *keep* a pull: rip on the site and export the
cards as a real deck object with Ukilop's beveled geometry. Both paths roll through the
same endpoint, so `?seed=` reproduces one from the other.
