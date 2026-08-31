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

**Drive CONFIRMED in-world 2026-08-31.** All three fronts loaded from `Card/url` through the
cloned chain. Per-card art is finished: remap, drive and all. What is left for the importer is
the loop that writes the variable, and trimming the deck to N.

The same test showed the backs were still Ukilop's placeholder, because nothing had ever
touched the back material. Now fixed — see "The card back" below. **That is what the current
probe changes, and the only thing left to eyeball.**

### The card back

One texture and one material shared by every card, so it is the one thing on a card that is
not per-card. Its submesh covers a 1x1 atlas, so unlike the front it needs no ST remap — only
a texture to point at. The URL is written at build time, so it takes the `@` marker.

`back=` picks where it comes from:

| | | |
|---|---|---|
| `back=site` | default | straight off `resopal.dalek.coffee`. Works with no deploy, but it is a **second host**, so Resonite asks for two access permissions. |
| `back=proxy` | preferred | the Worker's new `/back` route. Same origin as the card art, so **one prompt** for the whole deck. Needs the Worker deployed first. |
| `back=<url>` | | used verbatim. |

The Worker route is written and bundled but **not deployed** — deployment is a dashboard
paste (`node worker/bundle.mjs`, then paste `worker/dist/resopal-worker.js`). Until that
happens, `back=site` is the one that works.

`DefaultBack.png` is 1287x1800 and 464 KB, carrying its corner transparency in a palette
`tRNS` chunk. It is fetched once per player ever, since Resonite caches by URL, but it is
larger than it needs to be — a 512-wide variant committed to the site would be a cheap win.

### Row math confirmed by building a real deck

The three-card probe only ever occupied **row 0** of the 10x7 grid, where the row term of the
offset sits at its default — a wrong `-(6 - row)` would have looked perfect. `deck=td01` and
`deck=td02` build the real 48- and 50-card trial decks out of `data/decks.json`, spanning rows
0 to 4, and every card's ST is asserted against its own mesh's UV bounds. All 48 and all 50
pass. A duplicate printing gets its own cell, so `2x Grizzbolt` is two cards, two meshes, two
materials, two textures — and one shared art URL, which is why the test checks that the cards
do not *all* share one URL rather than demanding they all differ.

A 48-card deck is **1.8 MB** packaged, and pulls 24 distinct textures at `w=512`.

## Landscape cards — why no in-world setting can fix it

Confirmed in-world 2026-08-31: the 8 landscape printings in TD01 import wrong, squashed
rather than rotated. Palify serves them **already landscape** (1024x732); the cell is
portrait; nothing rotates them.

**There is no material setting that can.** `TextureScale`/`TextureOffset` reach the shader as
`_Tex_ST` and are applied as `uv * scale + offset` — per-axis scale and translate. A 90°
rotation requires *swapping* u and v, which that form cannot express at any values (a negative
scale mirrors, it does not transpose). Checked against the decompile: no FrooxEngine material
carries a UV rotation, and `UnlitMaterial` has nothing beyond scale/offset for the main
texture. Rotating the card slot instead is wrong — it turns the mesh, the bevel and the back
with it, so the card sticks out of the stack sideways.

So the rotation has to be **in the pixels**, which is exactly what the browser bake already
does (`compose.js`, `ROT = 90`; `compose.py`, `Image.ROTATE_270` — they agree, the constants
do not, see docs/PIPELINE.md).

**The mechanism is built; the images are not generated yet.** Two halves:

1. **`.github/workflows/rotate-landscape.yml`** — press *Run workflow* in the Actions tab.
   It runs `tools/rotate-landscape.mjs`, which checks **every** code in `data/pool-*.json`,
   **measures** each image, turns the ones wider than tall **90° clockwise** with sharp, writes
   256/512/1024 WebPs to `assets/rot/w<width>/<CODE>.webp` and commits them. A `codes` input
   takes extra codes from a set the snapshots do not cover, and it re-runs by itself whenever
   a `data/pool-*.json` changes — which is exactly when a new set brings new landscape cards.

   It runs there because the job needs three things at once: Palify's images, an image
   library, and a checkout to commit into. A browser has the first, a cloud agent has the
   third, a runner has all three.

   It shows each card **before and after, side by side**, on purpose: the rotation direction
   has been got wrong twice in this project and both times silently. Look at the pairs before
   committing. The rotation itself is `web/imgfix.js`'s `toImageData(src, 90)` copied
   verbatim rather than re-derived.

2. **The Worker substitutes it.** `/img/<CODE>` reads the WebP header of what Palify sent
   (`worker/src/webp.js`) and serves the rotated copy for anything wider than it is tall —
   **no list anywhere**, so a card from a set nobody has snapshotted is handled the same as a
   trial-deck card. Deploying this before the images exist is a no-op: a missing rotated copy
   **falls back to Palify**, and that fallback is deliberately not cached (`max-age=300`, no
   edge cache) so it is replaced the moment the images land. `?orig=1` bypasses the whole
   thing, which is what the generator reads through.

Nothing in-world or in the deck builder changes — the URL stays `{PROXY}/img/{code}?w=512` for
every card and the Worker decides.

Not doable from the cloud container: it has no image tooling at all — no PIL, ImageMagick,
ffmpeg or JS equivalent — which is why the generator is a browser page rather than a script.

## Getting the deck into the panel — the architecture, decided

The probe work is upstream of the goal, not the goal. What it settled, each by one drag-test:
the UV remap, the `@` marker, the drive chain, the card back, and the row arithmetic at real
deck sizes. **The panel itself has not been touched** beyond the one-field logo graft — its
buttons, its loop and its Moduprint layout are exactly as they were.

What is left is the actual goal: the deck template inside the panel, and flux to fill it in.
Two ways to do that, and the second is better:

**Ship 70 cards and destroy the extras.** No surgery on Ukilop's deck, but it adds ~2.5 MB of
meshes to the panel, needs trim flux that destroys 63 slots for a 7-card booster, caps a deck
at 70, and keeps the per-card ST because card *i* keeps mesh *i*.

**Make a card self-contained and duplicate it** — chosen, and built:
`build-deck-probe.mjs selfcontained=1`. Each card's position flux lives
in `/Assets/proxy_i`, outside the card, which is why `DuplicateSlot` alone was not enough.
Move that proxy inside its own `buffer` slot at build time and the card becomes duplicable.
Measured on proxy 0: of its 8 external references, **2 point into its own buffer subtree**
(the card slot, and the `SmoothTransform.TargetPosition` it drives) — which `DuplicateSlot`
rewires to the copy, exactly what is wanted — and **6 point at shared deck machinery**
(`add/remove handling`, the `Cards` parent, shared constant sources) which it leaves alone,
also exactly what is wanted.

That buys: one card in the package instead of seventy, no trim flux, no 70-card cap, the same
`DuplicateSlot` loop the panel already runs — and **one constant ST for every card**, since
every duplicate shares the template card's mesh and therefore its cell.

`DestroyProxy` on the buffer already points at that proxy, so destroying a card still takes
its flux with it once the proxy is its child — Ukilop built the link, the move only shortens
it. The pairing is read from that `DestroyProxy` rather than by index, because "`/Assets` order
matches card order" is an assumption and the component is the fact.

`test-deck-probe.mjs` simulates the duplication rather than trusting it: it collects every id
DECLARED inside a card's buffer, then splits the subtree's references into those that follow a
copy and those that stay shared. **67 follow, 11 stay** — and the two that decide whether this
works at all are on the right side: the card slot `IndexOfChild` reads, and the
`SmoothTransform.TargetPosition` the driver writes. The shared `Cards` parent stays shared.
Getting that split wrong gives a deck whose cards all sit on top of each other.

### Still unproven Same three cards, but each card's texture URL
is null and driven from a `Card/url` variable through the panel's five-component chain —
exactly what the importer will do, minus the loop that writes the variable.

| what you see | what it means |
|---|---|
| fronts right, backs are the ResoPal back | done — on to the loop and trimming |
| backs blank | the back URL did not load; check the second host prompt was accepted |
| backs still the Deck Maker's | the build did not replace the placeholder — the test gates this |
| every card shows the same front | the chain is cross-wired; see "Two bugs" above |

```bash
cd booster
RKL=… npm run build:deck-probe                      # mode=driven, back=site
RKL=… npm run build:deck-probe back=proxy           # once the Worker /back route is deployed
RKL=… npm run build:deck-probe mode=static          # isolates the remap, no flux at all
RKL=… npm run test:deck-probe
```

`cards=` picks the codes, and every one is checked against `data/pool-*.json` before it is
used. `verify-classpaths.mjs` takes the package as an argument too — the stock template
reports **26 problems across 177 types** (Ukilop's packed graph, which works in-world), and
the probe reports the same 26 across 183, so compare the two rather than reading the count.

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

## Writing the art in

**Settled 2026-08-31: the cards keep `http` URLs and nothing is embedded.** The owner's call,
for two reasons that outrank the request count — every player's copy costs no storage, and
the art is always served from a public CDN rather than redistributed inside an item. Resonite
caches by URL, so eight players holding decks drawn from the same 178 printings share the
same textures; that was already recorded below as why per-card textures beat an atlas.

So there is nothing to download and nothing to bake. The importer's whole job is to put the
right URL string on the right card, and the mechanism is the one the panel already runs:

```
Card/url (string) -> ObjectValueSource -> StringToAbsoluteURI -> ObjectFieldDrive -> StaticTexture2D.URL
```

This is also the **only** way an image ever gets into a material — there is no ProtoFlux node
that turns bytes into a texture. `AttachTexture2D` attaches the component; the URL is still
what you set. And because the drive hands the field a live `Uri` rather than a serialized
string, it is immune to the `@` marker bug that blanked the first probe.

`build-deck-probe.mjs mode=driven` builds exactly that, and it is what the current probe is.
Per card, on the `Visual (Baked)` slot: its own `StaticTexture2D` (URL null, driven), its own
`UnlitMaterial` at the cell's ST, a `Card/url` variable holding the URL as a **plain,
unmarked string**, and the five-component chain above cloned from the panel.

**Everything hangs off `Visual (Baked)`, never off `Card`.** The deck chains `GetChild` —
eleven of them, three taking another `GetChild` as their instance — so it walks
`Cards -> buffer -> Card` and those child orderings are load-bearing. `Visual (Baked)` is a
leaf with no children, so nothing existing can depend on what it holds. The test asserts no
card or buffer slot gained a child.

## Two bugs the tests caught before Resonite could

Both were invisible to every check that existed before, and both are the same shape: a
reference that resolves perfectly and points at the wrong thing.

**Cloning the chain slot by slot.** The three flux slots reference each other —
`StringToAbsoluteURI.Input` comes from the `ObjectValueSource` on the previous slot. Cloned
one at a time, each with its own id map, those cross-slot references kept the **donor's**
ids; and since the deck's own ids occupy the same low range, they landed on real but
unrelated components. Zero dangling references, valid package, wrong graph. Clone a group
that references itself in **one** call.

**And then cloning one slot twice in that call.** Passing the same donor slot twice to build
both the container and the first chain slot gave both copies identical ids, because one map
keyed by old id maps each to one new id. That one the duplicate-id check caught.

## Whether the art stays (closed)

The importer cannot bake URLs at build time — the codes arrive over the wire — so it must
**drive** each card's `StaticTexture2D.URL`, which is also the only way an image ever gets
into a material: there is no ProtoFlux node that turns bytes into a texture. `AttachTexture2D`
attaches the component; the URL is still what you set. So "fetch it and write it into the
material" *is* the URL drive, and the panel already runs it per card:

```
CARD/url (string) -> ObjectValueSource -> StringToAbsoluteURI -> ObjectFieldDrive -> StaticTexture2D.URL
```

That path is proven in-world and, being a live `Uri` rather than a serialized string, is
immune to the `@` bug that blanked the static probe. Ship each deck card slot with that
mechanism and its own material/texture, and the spawn loop's only new job is writing one
string per card.

Deliberately not pursued. A deck depending on the Worker is the intended design, not a
defect — see "Writing the art in" above. If that ever needs revisiting, the open question was
whether saving to inventory gathers and uploads an `http` texture: `AssetUploadTask` can be
initialised from a URL (`http`/`https`/`ftp`), but the gathering step lives in
`FrooxEngine.Store`, which is not in the decompile. Settle it in-world rather than in the
source — save a deck, restart, and see whether the URLs come back as `resdb`.

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

**Drag-tested and CONFIRMED 2026-08-31: the remap works in-world.** A three-card deck
imported with each card showing its own art, right way up, from its own texture, with no
atlas anywhere. The deferred "decks into a real Ukilop deck" task is unblocked.

The first attempt failed and is worth keeping: The probe imported and gave three
real cards with the stock backs, but every front was blank: the `StaticTexture2D` had a
**null URL**. That was not the remap and not a Resonite limitation — the probe wrote
`https://…` into a `Sync<Uri>` without the DataTree's `@` marker, so the load threw and the
field came out null. See `docs/PIPELINE.md`, "A URL field is `@` + the URL". Fixed, along
with the same bug in the panel's logo, and both test suites now gate it. **The remap itself
is still unproven in-world** — that is what the rebuilt probe is for.

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
