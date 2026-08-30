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

**A Ukilop deck cannot be textured per card.** Each card owns its mesh with its atlas cell
baked into the UVs — measured: 52 cards, 52 distinct meshes, one shared material. Card
slot *i* shows cell *i*, always. So an imported deck needs an atlas laid out in that deck's
order, which is what the browser bake produces and what nothing else can.

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
