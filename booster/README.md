# In-world panel

`out/ResoPal_Panel.resonitepackage` (264 KB) is a grabbable UIX panel. Drag it into
Resonite and you get a working UI immediately — no network call needed to see something.

Five preset buttons, a paste field and an import button:

| Button | Asks resopal for | Cards |
|---|---|---|
| Trial Deck · Red / Blue | `/api/deck?deck=td01&format=fixed` | 48 |
| Trial Deck · Green / Purple | `/api/deck?deck=td02&format=fixed` | 50 |
| Open 1 Booster · BP01 | `/api/pull?set=BP01&packs=1&format=fixed` | 7 |
| Open 3 Boosters · BP01 | `/api/pull?set=BP01&packs=3&format=fixed` | 21 |
| Open 10 Boosters · BP01 | `/api/pull?set=BP01&packs=10&format=fixed` | 70 |
| **Import what I pasted** | `POST /api/resolve?format=fixed` | whatever it is |

**The paste field takes a palify.org deck link, a bare deck id, or a decklist** — the
Worker works out which (`worker/src/resolve.js`), so the panel never has to parse a
decklist in ProtoFlux. Palify's own copy-as-text export works verbatim:

```
# Green/Purple Trial (50 cards)
2x Mossanda – Guard Captain [TD02-001]
3x Eikthyrdeer Terra – Guardian of Nature [TD02-005]
```

Press one and the cards appear in a grid below the panel, one per frame, art streaming in
from the image proxy. **Nothing caps the count in the graph** — cards are duplicated from a
template as records arrive. The only cap is the Worker's, at 200.

Three driven lines under the title tell you where things stand without opening the flux:

- the **URL line** shows the request the panel will make, so a press that changes it proves
  the whole button chain works;
- the **status line** shows the first card parsed — or the error text, because `GET_String`
  writes the exception message into the same field;
- the **event line** names the branch the graph took: `could not set ResoPal/url`,
  `host access refused`, `network error`, `response received - HTTP 200`, `all cards
  placed`. Every terminal impulse in the graph writes it, so "nothing happened" is not one
  of the things it can say.

**Reading or debugging the graph: see [GRAPH.md](GRAPH.md).** One canvas, 124 nodes, four
zones. [PRIOR-ART.md](PRIOR-ART.md) is what an existing, working in-world deck importer
does differently, and which of those we took.

**Nothing about a deck is baked in.** The panel knows five URLs and one endpoint to POST to.
Card codes, how many there are, and what order they come in all arrive over the wire.
Adding a set or a deck is a line in `BUTTONS` at the top of `build-panel.mjs`; the graph
never learns what is inside one.

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
                       StartAsyncTask ──▶ GET_String ──▶ Content
                                                            │
  paste field ──▶ StartAsyncTask ──▶ POST_String ───────────┤
                                                            ▼
                   rest := the response,  then per record, one frame each:
                     DuplicateSlot(card template) ─▶ set CARD/url ─▶ place it
                     ─▶ rest := everything past the newline ─▶ round again
```

Buttons and graph never reference each other — the impulse tag is the only coupling.

There is **one card** in the package, inactive, and every card in-world is a duplicate of
it. `DuplicateSlot` copies the ProtoFlux inside the slot too, so the three nodes that turn
`CARD/url` into a texture exist once here and once per card in-world.

**The count is dynamic without anything counting it.** A card exists because a record
existed. `ChildrenCount` on the spawn parent gives the index its grid position is computed
from. Seven records make seven cards; a 50-card deck makes fifty; two decks pasted together
make 98.

**Landscape cards render landscape**, with no ProtoFlux at all: a `TextureSizeDriver`
reads the loaded texture's own pixel size and drives the quad from it.

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

`verify-classpaths.mjs` checks every emitted type against the decompiled engine source:
**generic constraints**, **member order and completeness**, **port kinds** on both ends of every
wire, and an impulse walk proving no `AsyncActionNode` is reachable from a synchronous entry point
without a `StartAsyncTask` in between.

Member order is the one that cost a whole build. Emitted in the order the builder happened to list
them, the package encoded cleanly and in-world every node was red with wires on the wrong ports —
`If` went out as `{Condition, OnTrue, OnFalse}` where the class declares `{OnTrue, OnFalse,
Condition}`, and `GET_String` declares `Content` last, so emitting it fifth shifted every impulse
output by one. `members.mjs` reads the real order out of each class's own `GetSyncMember` switch. This is the check that would have caught the build
where every button was dead: it emitted `WriteDynamicValueVariable<string>`, and that
node is declared `where T : unmanaged`, so the string form cannot exist. The package
encoded perfectly and validated with zero dangling references; the component simply
never resolved in-world. A wrong classpath fails silently, so "it encoded cleanly"
proves very little.

`test-panel.mjs` checks:

- **The UI exists**: one Canvas with a real size, its root rect and collider wired to
  components on its own slot, six buttons that each tint an Image on their own slot and
  carry a caption, a paste field whose Text / TextEditor / TextField actually reference
  each other, and every `Text` pointing at a font that ships in the package.
- **Buttons reach the graph**: every tag a button sends is heard, five receivers write five
  distinct URLs into one trunk into one GET, the sixth POSTs the paste field's own text to
  `/api/resolve` — and **nothing references the null GUID**, the general form of the bug
  where a trigger aimed at the object root silently became a null reference.
- **The card template is self-contained**: its own texture and material as components
  rather than shared assets, its own `CARD/url` in its own `CARD` space, and its own three
  nodes turning that string into the texture URL.
- **The spawn loop, simulated out of the built package** against live Worker responses for
  all five buttons — 7, 21, 70, 50 and 48 cards, plus a 98-card double deck past the old
  ceiling — asserting each card gets its own record's art, in order, on the right grid
  square. Plus an empty response, an error string, a truncated last record, and a body with
  no newline at all.
- **The loop terminates**, argued from the built graph rather than assumed: the guard reads
  the same `IndexOfString` the remainder does, and the remainder starts one past it, so the
  string strictly shrinks.
- **Order of operations inside one pass** — eating the record before writing the card would
  give every card the *next* card's art, and nothing else would notice.
- **All three readouts are driven**, and **every way a request can end reports on the event
  line**: `OnResponse`, `OnError` and `OnDenied` on both request nodes, both failure paths
  of every URL write, and the loop running out of records.
- **Encoding**: zero dangling references, zero unbound hooks, BSON round-trips
  byte-identical.
- **Layout and pretty-flux**: one Moduprint canvas under 130 nodes inside 16 × 11 units,
  four comment zones, titled, side by side with a gap and none overlapping, no two nodes
  overlapping a node visual, no producer fanning past a dozen consumers, relays actually
  feeding something, and **no wire running through a constant** — a constant is a leaf, so
  a wire touching one can only be an accident of position. Wires crossing a node that has
  inputs of its own are counted and capped instead: **14 against a budget of 30**.

The evaluator models the decompiled nodes' own clamping — `Substring` returning `""` when
the start runs past the end rather than throwing, `IndexOfString` returning −1 — not
JavaScript's. That is what caught an earlier decoder walking its cursor off the end and
wrapping back to zero, which lit 62 cards for a 7-card pull, all showing the first card's
art.

**None of that proves Resonite accepts the file.** Only a drag-test does.

### If something is wrong, check these first

1. **Read the event line first.** It names the branch that ran, so it tells you which
   half of the chain to look at before you open anything. The table in
   [GRAPH.md](GRAPH.md) maps all three lines to a diagnosis.
2. **Host access.** The request node asks for it itself, so the prompt says "Web Request
   Node" rather than naming ResoPal. Denying it puts `host access refused` on the event
   line.
3. **The endpoints must be deployed.** Until the Worker ships `/api/pull`, `/api/deck` and
   `/api/resolve`, every button ends with `HTTP 404` on the event line. That is the
   intended failure — visible rather than silent — but it is still a failure.
4. **The paste field.** Click it and type or paste; the import button sends whatever is in
   it. An empty field comes back as a message from the Worker, not silence.
5. **Panel scale.** 620×660 canvas units at 0.00058 ≈ 36×38 cm. Grab and scale it if that
   reads wrong in your session.
6. **Card orientation.** Quads are `DualSided`, so they are never invisible, but from
   behind you see a mirrored front rather than a card back.

## Known gaps

- **The white corner rim.** Materials are `Cutout` at `AlphaCutoff 0.72`, the values the
  deck bake settled on, but this path skips `solidify()` — expect a fainter version of the
  rim `docs/PIPELINE.md` describes.
- **No card backs, and no flip.** Every card is one quad showing its front. The shape for
  it is known and needs no ProtoFlux — a second URL and a `BooleanValueDriver<Uri>` driven
  by a `TouchToggle`, per `PRIOR-ART.md` §7 — but the records carry one URL per card today.
- **Cards are not grabbable, and do not stack.** They are a flat grid. Turning them into a
  real deck object is the next step, and `OrderOffset` is how stack position is expressed.
- **No retry.** One request per press; nothing re-fires if the permission prompt is still
  open.
- **`DuplicateSlot` has not been drag-tested.** Everything about it is asserted structurally
  and simulated against real responses, but whether Resonite rewires a duplicated slot's
  ProtoFlux the way this design assumes is the one thing only a drag-test settles.

## Why this is not the deck object

The deck's cards share **one atlas texture** with the per-card UVs baked into the mesh,
so card 3 cannot be pointed anywhere else — and nothing in-world can compose an 8192²
atlas anyway (`docs/WORKER.md`). Seven independent textures is the only shape that works
at runtime.

The deck path is still the better way to *keep* a pull: rip on the site and export the
cards as a real deck object with Ukilop's beveled geometry. Both paths roll through the
same endpoint, so `?seed=` reproduces one from the other.
