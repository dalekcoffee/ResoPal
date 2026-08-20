# In-world panel

`out/ResoPal_Panel.resonitepackage` (319 KB) is a grabbable UIX panel. Drag it into
Resonite and you get a working UI immediately — no network call needed to see something.

Five buttons:

| Button | Asks resopal for | Cards |
|---|---|---|
| Trial Deck · Red / Blue | `/api/deck?deck=td01&format=fixed` | 48 |
| Trial Deck · Green / Purple | `/api/deck?deck=td02&format=fixed` | 50 |
| Open 1 Booster · BP01 | `/api/pull?set=BP01&packs=1&format=fixed` | 7 |
| Open 3 Boosters · BP01 | `/api/pull?set=BP01&packs=3&format=fixed` | 21 |
| Open 10 Boosters · BP01 | `/api/pull?set=BP01&packs=10&format=fixed` | 70 |

Press one and the cards appear in a 10×7 grid below the panel, art streaming in from
the image proxy.

Two driven lines under the title tell you where things stand without opening the flux:
the **URL line** shows the request the panel will make (so a press that changes it proves
the whole button chain works), and the **status line** shows the first card parsed — or
the error text, because `GET_String` writes the exception message into the same field.

**Reading or debugging the graph: see [GRAPH.md](GRAPH.md).** The logic lives in two
Moduprint canvases; `Flux - control` is ~42 nodes and is the only one worth unpacking.

**Nothing about a deck is baked in.** The panel knows five URLs. Card codes, how many
there are, and what order they come in all arrive over the wire. Adding a set or a deck
is a line in `BUTTONS` at the top of `build-panel.mjs`; the graph never learns what is
inside one.

## How it hangs together

```
Button ──ButtonDynamicImpulseTrigger──▶ "ResoPal/pack/3"
                                             │
                       DynamicImpulseReceiver │
                                             ▼
              WriteDynamicObjectVariable<string>   ResoPal/url := that button's URL
                                             │ OnSuccess
                                  ContinuationRelay (one trunk for all five)
                                             ▼
      IsHostAccessAllowedUrl ─┬─ yes ─▶ GET_String ──▶ Content
                              └─ no ──▶ RequestHostAccessUrl ─ OnGranted ─┘
                                                                 │
       70 × ( Substring(response, i×64, 64) · TrimString · StringToAbsoluteURI )
                                                                 │
                    ObjectFieldDrive<Uri>  ──▶ StaticTexture2D.URL
                    ValueFieldDrive<bool>  ──▶ Slot.Active
```

Buttons and graph never reference each other — the impulse tag is the only coupling.

Past the GET there are **no impulses**. The drives pull their inputs every frame, so
cards fill in the moment the response lands.

**The count is dynamic without anything counting.** A card is `Active` exactly when
the response reaches its offset. Seven records light seven cards and leave sixty-three
dark; a 50-card deck lights fifty. One decoder handles both, because `/api/deck` and
`/api/pull` return the same fixed-width records.

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

`npm test` runs two files, both against the **built package** rather than the builder's
intentions, so a node wired to the wrong id fails there exactly as it would in-world.

`verify-classpaths.mjs` checks every emitted type against the decompiled engine source,
**generic constraints included**. This is the check that would have caught the build
where every button was dead: it emitted `WriteDynamicValueVariable<string>`, and that
node is declared `where T : unmanaged`, so the string form cannot exist. The package
encoded perfectly and validated with zero dangling references; the component simply
never resolved in-world. A wrong classpath fails silently, so "it encoded cleanly"
proves very little.

`test-panel.mjs` checks:

- **The UI exists**: one Canvas with a real size, its root rect and collider wired to
  components on its own slot, five buttons that each tint an Image on their own slot and
  carry a caption, and every `Text` pointing at a font that actually ships in the package.
- **Buttons reach the graph**: every tag a button sends is heard by a receiver, every
  receiver writes a distinct URL, all five join one trunk into a single shared GET — and
  **nothing references the null GUID**, the general form of the bug where a trigger
  aimed at the object root silently became a null reference.
- **The parse graph, evaluated** against live responses from the Worker for all five
  buttons — 7, 21, 70, 50 and 48 cards — asserting the right number light up, that they
  are the first N, and that each points at its own record's art. Plus an empty response
  and a network error.
- **Both readouts are driven**, and the status shows the error text on failure.
- **Encoding**: zero dangling references, zero unbound hooks, BSON round-trips
  byte-identical.
- **Layout and pretty-flux**: two Moduprint canvases with the control one under 60
  nodes, comment zones present, titled and disjoint, no two nodes overlapping a node
  visual, no producer fanning past a dozen consumers, and relays actually feeding
  something.

The evaluator models the decompiled nodes' own clamping — `Substring` returning `""`
when the start runs past the end rather than throwing — not JavaScript's. That is what
caught an earlier decoder walking its cursor off the end and wrapping back to zero,
which lit 62 cards for a 7-card pull, all showing the first card's art.

**None of that proves Resonite accepts the file.** Only a drag-test does.

### If something is wrong, check these first

1. **Watch the URL line first.** If pressing a button changes it, everything up to and
   including the network call is wired; the failure is the endpoint. If it does not
   change, the problem is in the control canvas — see [GRAPH.md](GRAPH.md).
2. **Host access.** The panel asks once, naming ResoPal. Denying it leaves the status
   line showing the error and no cards.
3. **`/api/pull` and `/api/deck` must be deployed.** Until the Worker ships them, every
   button ends at the status line with a network error. That is the intended failure —
   visible rather than silent — but it is still a failure.
4. **Panel scale.** 620×660 canvas units at 0.00058 ≈ 36×38 cm. Grab and scale it if
   that reads wrong in your session.
5. **Card orientation.** Quads are `DualSided`, so they are never invisible, but from
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
