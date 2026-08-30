# Handoff — the in-world panel, 2026-08-30

Where the in-world import stands, what is known, and what to do next. Written to be
read cold. Start here, then `booster/GRAPH.md` for the graph and `docs/PIPELINE.md`
before touching anything that produces a deck package.

## The one thing that will bite you

**The shipped panel is a file the owner hand-packed in-world. The builder does not
reproduce it.**

`booster/build-panel.mjs` produces a correct package with a *machine* layout. The owner
then imported it, rewired it in-world, and ran it through **Moduprint's pack** — which
relaid the whole graph, inserted 86 relays, collapsed duplicated constants, and produced
the layout they want to keep. That file is the artifact. The builder is upstream of it.

So a change to `build-panel.mjs` does **not** ship by rebuilding. It ships by grafting the
changed subtree into their packed file, keeping ids stable where anything outside points
in. Handing them a fresh build throws away their layout work — that happened once and it
was not welcome.

Grafting is viable because the card template is **self-contained**: its texture, material,
variable and three flux nodes all live on the slot, which `test-panel.mjs` gates. The only
reference from outside is a `GlobalReference<Slot>` in the flux, so the card slot must keep
its original id and that wire never notices. A graft was verified structurally identical to
the tested build, so the mechanism itself is sound.

## What works right now

- **Worker** — deployed, current, serving `/api/pull`, `/api/deck`, `/api/resolve`, `/img/`.
  Deployment is a **dashboard paste**, not `wrangler deploy`: run `node worker/bundle.mjs`
  and paste `worker/dist/resopal-worker.js` over the editor. `dist/` is gitignored.
- **The panel** — four buttons (two trial decks, one booster, paste-and-import). Presses
  fetch, the loop unpacks, cards spawn on a grid.
- **Cards** — art loads at `w=512`, and each card has a `BoxCollider` and a `Grabbable`,
  so it can be picked up.
- **In-world art is 512px**, where the site bakes from 1024. See `worker/src/roll.js`
  `IN_WORLD_WIDTH` for why.

## What does not work

**A card has no back.** Its quad is `DualSided: true`, so the reverse shows the front art.
Every attempt to add a real back face broke the card, and the reason is still open.

## The card-back problem, and everything ruled out

Three attempts, each shipped and each broken in-world. Do not repeat them blind.

| attempt | what shipped | result in-world |
|---|---|---|
| 1 | back child slot rotated 180°, front `DualSided: false`, mesh rotations left at their defaults | backs visible, fronts blank |
| 2 | as above plus the **card slot** turned 180° | front showed the back image, back transparent |
| 3 | facing moved onto each **mesh** (front `[0,1,0,0]`, back identity), no slot turned, fixed collider | cards spawned, no art at all |

Ruled out by measurement, not by argument:

- **The URL is not the problem.** A probe replaced the per-card URL with one constant,
  known-good URL. Cards still had no art.
- **The loop is not the problem.** The spawn write diffed byte-identical to the build that
  worked, and the panel's status line shows a valid art URL.
- **The graft is not the problem.** The grafted card subtree diffed identical to the tested
  build with ids stripped.
- **The template is fine when the variable is pre-set.** A three-card probe with `CARD/url`
  filled in at build time loaded art (card A). So variable → `StringToAbsoluteURI` →
  `ObjectFieldDrive` → `StaticTexture2D.URL` works.
- **A null `URL` on the template is normal.** It is a driven field. The working build has
  it null too. It is not the tell it looks like.

So the fault is in **something attempt 3 added to the card**, and the candidates that
remain are: `DualSided: false`, setting `QuadMesh.Rotation` explicitly, the back child
slot itself, `Snapper`, or the embedded `@packdb:///` back texture. Only one of those can
plausibly stop a texture *loading* — the rest can only make a card face the wrong way,
which looks identical from in-world.

**The current file is attempt 3 reverted**: the owner's known-good card template restored
byte-for-byte, plus `BoxCollider` and `Grabbable` cloned from components Resonite itself
wrote into that same file (so member order cannot be wrong). It works.

## Next step

**Drag `booster/out/ResoPal_DeckProbe.resonitepackage` into Resonite and look at it.**
Three cards off the real template, three real TD01 codes, art URLs written at build time,
no ProtoFlux. It isolates the one open variable in the per-card-material finding above:

| what you see | what it means |
|---|---|
| each card shows its own card, right way up | the remap works — the deck path is open |
| each card shows a sliver, or the wrong crop | the offset formula is wrong |
| every card shows the same art | the materials did not actually split |
| no art at all | the URL/loading path, not the remap — compare against the panel |

Rebuild it with `RKL=… npm run build:deck-probe` in `booster/`, verify with
`npm run test:deck-probe`. `cards=` picks the codes, and every one is checked against
`data/pool-*.json` before it is used.

If it works, the shape of the real thing is: ship a trimmed deck template inside the panel,
one front material and one texture per card slot with its cell's ST baked in, and let the
existing spawn loop write `CARD/url` per card exactly as it already does for loose cards.
Two things still need answering before that is a plan:

- **Landscape cards will be sideways.** 26 of 158 printings are landscape and Palify serves
  them already-rotated; the browser bake rotates them into the cell, and `_Tex_ST` cannot —
  scale and offset can flip an axis but not swap them. Either the Worker serves a rotated
  variant for those codes, or the site publishes 26 pre-rotated 512px images and the Worker
  redirects to them. The `landscape` list in each `data/pool-*.json` is authoritative.
- **How the deck gets trimmed to N in-world.** Ukilop already built the hook: each card's
  buffer slot carries a `DestroyProxy` pointing at that card's `/Assets` driver proxy, so
  destroying a card takes its flux with it, and the deck's layout is driven from
  `ChildrenCount` and `IndexOfChild` rather than a baked count.

## The card back, on the loose-card path

Add the back **one variable at a time**, verifying each in-world before the next. The
planned first test — built, not yet shipped — was a single static card with **different art
on each face**, so which side shows which answers the facing question by looking:

- front `TD01-001`, `DualSided: false`, mesh rotation left as the working card has it
- back child, own quad/material/texture/renderer, mesh rotation the opposite, same position
- both faces use ordinary art URLs, so the embedded-texture question is out of the way

Front shows `TD01-001` and back shows `TD01-002` → the arrangement is right, and the only
remaining question is the back *image*. Front shows `TD01-002` → the two rotations are
swapped.

For the back image itself, prefer **a Worker route** (`/back`, proxying
`resopal.dalek.coffee/assets/DefaultBack.png`) over embedding. Same origin as the card art,
so no second host-access prompt, and it uses a loading path already proven in this package.
Embedding needs an `Assets/<sha256>` entry, a `Metadata/<sha256>.bitmap` sidecar and a
manifest entry, and whether it loaded was never established.

## Decisions worth not relitigating

**Per-card textures beat an atlas here**, despite the intuition. An atlas is a full 8192²
sheet whatever the card count — ~85 MB for seven cards or seventy alike. Per-card scales
with the count: a 50-card deck is ~24 MB at `w=512`. And Resonite caches by URL, so eight
players holding decks drawn from the same 178 printings share the same textures, where
eight bespoke atlases are eight different images sharing nothing. The atlas wins only on
draw calls, which is an argument for the deck object, not for baking sheets per import.

**~~A Ukilop deck cannot be textured per card.~~ Superseded 2026-08-30 — it can.** The
measurement behind this was right and the conclusion was wrong, so read both. Each card does
own its mesh with its atlas cell baked into the UVs: 52 cards, 52 distinct meshes, and the
three material slots on every card's `MeshRenderer` — edge / **front** / back, matching the
mesh's three submeshes and the deck's own `Deck/Material*` reference variables — are shared
by all of them. Card slot *i*'s front UVs really do cover cell *i* and nothing else.

What that misses is that a material can move the cell. `UnlitMaterial.TextureScale` and
`.TextureOffset` reach the shader as `_Tex_ST` (`UnlitMaterial.UpdateMaterial` →
`MaterialUpdateWriter.UpdateST` → `float4(scale, offset)`), sampled Unity-style at
`uv * scale + offset` — so a cell can be blown back up to the whole of a texture:

```
card i sits at col = i % 10, row = floor(i / 10) of the 10×7 grid
  TextureScale  = (10, 7)
  TextureOffset = (-col, -(6 - row))
```

Give card *i* its **own** front material and its **own** `StaticTexture2D` at that ST, and it
shows its own full-size card art with no atlas anywhere. The edge and back materials stay
shared. Everything per-card is a build-time constant, so **no ProtoFlux is involved in the
picture at all** — the only thing left for the graph to do is what it already does for the
loose-card path: write a URL string per card.

Measured, not argued: `booster/meshx.mjs` decodes each card mesh's MeshX blob and reads
submesh 1's UV bounds. Card 0 came back at u [0, 0.1] v [0.857, 1]; card 51 at u [0.1, 0.2]
v [0.143, 0.286] — col 1, row 5, exactly. `booster/test-deck-probe.mjs` asserts the shipped
ST against those bounds rather than re-deriving it from the index, and a deliberately
flipped V offset fails it.

**Not yet drag-tested.** `booster/build-deck-probe.mjs` builds the three-card probe that
settles it; see "Next step".

**The Worker cannot bake one.** 8192² RGBA is 256 MiB against a 128 MB ceiling, and the
grid is fixed at 10×7 by the meshes, so even a 7-card pack needs a full sheet. At a
Worker-safe 4096² a card is 409px, which `docs/PIPELINE.md` puts below where text stays
readable.

**One booster in-world, three and ten on the site.** A pull spawns a card per record and
each fetches its own texture; ten packs is seventy simultaneous loads per person in a room
where several people may be opening at once.

## Open tasks

1. **The card back** — above.
2. **Decks into a real Ukilop deck** (deferred, and the owner asked that nothing be thrown
   away in the meantime). Boosters stay loose cards. The `Snapper` keyed `"Card"` from
   attempt 3 is the hook a deck's `GrabbableReceiverSurface` looks for; it is not in the
   current file but the design note is here. `Surface/cards` accepts any grabbable dropped
   on it — its 51-node add/remove handler hangs off
   `OnGrabbableReceiverSurfaceReceived` — so a spawner reparents directly and sets
   `OrderOffset` itself, the way DeckReader's `DuplicateSlot(OverrideParent)` does.
3. **The site's silent fallback.** `index.html:894` catches a failed `/api/pull` and rolls
   in the browser instead. `serverDown` is set at line 905 and never read anywhere, so the
   fallback is invisible — it hid a ten-day-stale Worker deploy. The comment above
   `fillPacks` promises pulls are "marked `local` and the export says so"; neither exists.

## How to debug this thing

What worked, repeatedly, was **diffing against a known-good artifact** rather than
reasoning about intent:

- Dump a subtree canonically with ids replaced by `owner/Type.member` labels, and diff two
  packages. That found the facing field and proved three separate hypotheses wrong.
- Build a **probe package** that isolates one variable — a card with the URL pre-set, a
  loop writing one constant URL. Each took one import and killed a whole class of theory.
- Check a classpath by its **full namespace path**, never its leaf name. `verify-classpaths.mjs`
  enforces this now, after `Nodes.StartAsyncTask` (which does not exist) validated cleanly
  for three builds and came up red in-world.

Scratch inspectors are named `booster/_*.mjs` and are gitignored. Write them freely, delete
them after; the findings belong in tests and in docs.
