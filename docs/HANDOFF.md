# Handoff — the in-world panel, 2026-08-30

Where the in-world import stands, what is known, and what to do next. Written to be
read cold. Start here, then `booster/GRAPH.md` for the graph and `docs/PIPELINE.md`
before touching anything that produces a deck package.

## The one thing that will bite you

> **That "stale" note is itself withdrawn — re-measured 2026-08-31, and the section below
> is live again.** The comparison it rested on predates the autorouter being switched on.
> Counted now, on the Moduprint canvas:
>
> | | logic nodes | relays | total |
> |---|---|---|---|
> | committed `out/ResoPal_Panel.resonitepackage` | 100 | 16 | **116** |
> | a fresh `build-panel.mjs` | 101 | 111 | **212** |
>
> The router puts a relay on very nearly every wire, and the result fails this repo's own
> layout gates: 576 pairs of overlapping node visuals and 226 wires crossing a wired node
> against a budget of 30. **The builder does not reproduce the shipped panel and handing
> back a rebuild would throw away his cleanup.** A change ships by grafting.
>
> That router regression is a separate, untouched problem. It is the reason `npm test` now
> runs against the grafted artifact rather than a build.
>
> `build-panel.mjs` takes `out=`, so a comparison build cannot overwrite a shipped package.

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

## Three caches sit between a fixed image and a card in-world

Landscape stayed broken twice after the fix was correct, both times because
something was still holding older bytes. Worth knowing all three before debugging
anything image-shaped:

| Cache | Keyed on | Cleared by |
|---|---|---|
| Cloudflare edge | the Worker's own cache key | bumping `IMAGE_CACHE_VERSION` in `worker/src/index.js` |
| Resonite's asset store | the full URL, per install | changing the URL — `ART_VERSION` in `build-deck-probe.mjs`, which appends `&v=` |
| Resonite's session | nothing that matters here | — a new world does **not** clear the store above |

A new world proves nothing: the asset store is per install, so a card fetched days
ago comes back from disk. When an image change does not show up, bump both versions
before suspecting the code.

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

**Make a card self-contained and duplicate it** — tried, and it BREAKS THE DECK. Do not
repeat it. Moving each card's `/Assets` proxy inside its own `buffer` slot makes the card
duplicable on paper, and every structural check passed: the reference split came out 67
following a copy and 11 staying shared, with the card slot and the driven transform on the
right side. In-world the deck imported and looked perfect, the top card grabbed, shuffle
worked — and after **"show all cards"** none of the spread cards could be picked up.

The cause: the deck holds a `GlobalReference<Slot>` aimed at `/Deck/Assets` and indexes its
children to reach a card's flux. Relocating the proxies emptied that slot, so those lookups
find nothing. `Card/Grabbable` is written from `/Deck/logixs/Deck functions`, which is exactly
the kind of code that walks it.

The lesson is bigger than the bug: **a reference audit proves what a duplicate would carry,
not what the rest of the deck still expects to find.** Ukilop's graph reaches into `/Assets`
by position, and nothing in the card's own subtree says so.

So the deck stays exactly as exported, and the importer takes the other route: **ship the deck
at its full card count and destroy the extras in-world.** `DestroyProxy` on each buffer already
removes that card's `/Assets` proxy with it, which keeps the two lists in step — Ukilop built
trimming in, and it is the supported way to change a deck's size.

## ~~The deck cannot live inside the panel~~ — withdrawn 2026-08-31, it can

The numbers below are right and the conclusion was wrong, so both are kept. What the
component and flux-slot counts miss is **where** that flux lives: `Deck/logixs` and 52
packed `Assets/proxy` slots, none of which is a Moduprint canvas. The panel still has
exactly one canvas after the graft, still carrying his nodes and nothing else, and
`test-graft-deck.mjs` gates that. The deck is a passenger in the package, not on his canvas.

The other half of the objection was real and is fixed: the template used to arrive
**inactive**, so its nodes bound to nothing and read as red — which is what "the flux is
severely broken again" was. It now arrives **active inside an inactive holder**, the way the
card template already does, because `DuplicateSlot` copies `Active` verbatim and duplicating
an inactive deck gives an invisible one.

The original note follows.

Tried, measured, withdrawn. `graft-deck.mjs` folds a deck template into the panel package
correctly - the splice verifies, every card keeps its mesh, material, texture and `Card/url`,
no id is used twice across 52736 of them, and **the panel's own subtree comes out unchanged**:
151 slots, identical components and positions before and after.

It is still the wrong shape, and the numbers say why:

| | components | flux slots |
|---|---|---|
| the panel | 228 | 119 |
| a deck template | 3763 | 1992 |

The panel's canvas is the thing the owner reads and has hand-cleaned to the pretty-flux
standard. Grafting buries it under sixteen times its own size in Ukilop's flux. And the
template has to arrive **inactive**, or a full deck sits in front of the panel - so its nodes
bind to nothing and read as red, which is what "the flux is severely broken again" was.

Nothing in the panel was damaged. The passenger was the problem.

So the deck stays its own item. What is still open is how the panel reaches one — the
importer needs a deck to write into, and the two shapes are: the panel targets a deck the
player has already spawned, or the deck package carries its own import controls. That choice
has not been made.

## Putting an imported deck into the deck holder — everything needed to build it

Both open questions are answered, read out of `data/template.resonitepackage` itself.

**~~Reparenting a card into the deck.~~ WRONG — corrected 2026-08-31, from the engine
source.** The note said `Surface/cards` and `Cards` each carry a `GrabbableReceiverSurface`
with four `OnGrabbableReceiverSurfaceReceived` handlers, so reparenting onto one lets the
deck's own handler stack the card and set `OrderOffset`, with nothing to drive by hand.

The first half is true and the conclusion does not follow. That node hangs off
`GrabbableReceiverSurface.OnLocalReceived`, which is raised in exactly one place —
`Receive(grabbable, grabber)` — and `Receive` has exactly one caller in the whole engine:
`Grabber.cs:447`, a person letting go of something they had grabbed. **A `SetParent` from
ProtoFlux raises nothing.** A card reparented onto `Cards` gets no buffer, no position
driver and no `OrderOffset`; it simply sits there.

So the importer does what the handler does, in the handler's order, read out of
`/Deck/logixs/add/remove handling`:

1. `DuplicateSlot(/Deck/buffer)` — the buffer template, which carries that card's packed
   position flux as its `proxy` child;
2. `SetParent(the copy's proxy → /Deck/Assets)`;
3. `SetParent(the card → the buffer copy)`;
4. `SetParent(the buffer copy → /Deck/Surface/cards/Cards)`.

Appending to `Cards` and to `Assets` in the same pass is what keeps the two lists in step,
which is the thing the deck indexes **by position** — the same coupling that broke grabbing
the last time those proxies were moved.

**~~Engaging the search spread.~~ WRONG — corrected 2026-08-31, from the deck itself.**
"Not an impulse" is right: the deck defines exactly one dynamic impulse tag, `"Card
removed"`, so there is nothing to fire. But `InnerDeck/grid X` and `InnerDeck/grid Y` are
**outputs, not inputs**. Both `Value` fields are DRIVEN, by two `ValueFieldDrive<int>` in
`/Deck/logixs/Deck functions`, off `ChildrenCount(Cards)` and the card aspect:

```
aspect = Deck/cardSize.Y / .X = 0.25 / 0.175 = 1.42857
grid Y = round(sqrt(n / aspect))      grid X = ceil(aspect * sqrt(n / aspect))
n = 52  ->  grid Y = round(6.03) = 6      grid X = ceil(8.62) = 9
```

which is exactly the 9 and 6 the file ships. Writing a driven field is undone on the next
update, and there is nothing to write anyway — the grid follows the card count on its own
the moment the cards land.

What actually opens the spread is a **bool**: `BooleanValueDriver<floatQ>.State` on
`/Deck/Surface/cards`, copied to the `float3` driver beside it by a `ValueCopy<bool>`. The
search button's label is driven from that same field and reads **"Search" while it is true,
"Close" while it is false** — so `false` is open. Its writer is a `ValueWrite` inside the
button's packed flux, which is why the button's `logix` child reads as empty.

It is a plain field with no variable on it, so `graft-deck.mjs` attaches one
`DynamicField<bool>` exposing it as `InnerDeck/spread` — the same idiom the deck already
uses to expose `InnerDeck/SmoothSpeed` on every buffer — and the importer writes that false
once every card has landed. It is written last because the spread lays out from
`ChildrenCount`, so opening a half-filled deck would spread it twice.

**The build, as specced with the owner:**

- graft the deck template in (`graft-deck.mjs`), `DuplicateSlot` it on import
- gate on **more than 30 cards**, so boosters and single cards keep spawning loose with no
  branch of their own. The count is a `ChildrenCount` on the panel's own `Cards` slot, read
  after the loop finishes. Note the grid index does **not** use one — it asks `IndexOfChild`
  for the card's own index, deliberately (see `booster/GRAPH.md`), so this is a new read
  rather than a shared one.
- move each card into the deck through a duplicated **buffer**, as above; a bare reparent
  does nothing
- write `InnerDeck/spread` false to engage search
- **new nodes go at x ≥ 14.3**, right of the owner's canvas (his ends at 13.57), on his row
  Ys, wired into his existing chain so he can merge them in. He cleans up and merges; that is
  the agreed division of labour, not licence to be sloppy.

**Built 2026-08-31.** `booster/deck-import.mjs` is the branch, emitted through a kit so the
same 51 nodes go into both the builder and the graft. `booster/graft-deck-import.mjs`
splices them into the packed panel; `booster/graft-deck.mjs` then folds the deck template in
and fills in the branch's template reference. `npm run ship` does both in order.

Its placement was **hill-climbed against this repo's own crossing test**, not eyeballed:
constants into gutter columns half a pitch left of their consumer, leaf producers duplicated
beside the nodes that read them rather than wired back across the zone. It measures **0
wires through a constant and 2 through a wired node** — his own graph carries 16 — in
17.18 × 8.35 units. The autorouter was tried first and made it worse twice (32 relays and
98 crossings at his pitch, 33 and 85 at double it): a router needs empty lanes to thread,
and a branch bolted onto the right edge of a full canvas has none.

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
2. ~~**Decks into a real Ukilop deck.**~~ Built 2026-08-31, **drag-tested the same day**.
   The mechanism is confirmed: cards spawn, move into a real deck, and the spread engages.
   Three placement bugs came out of that first import and are fixed — see "Three things a
   Deck Maker export brings with it" below. Worth another import to confirm the fixes.
3. **The router regression.** A fresh `build-panel.mjs` emits 148 relays for 51 logic nodes
   and fails the layout gates outright. Nothing in this round touched it and the shipping
   path routes around it by grafting, but the builder's own output is not importable until
   it is fixed. Numbers are in "The one thing that will bite you", above.
4. **The site's silent fallback.** `index.html:894` catches a failed `/api/pull` and rolls
   in the browser instead. `serverDown` is set at line 905 and never read anywhere, so the
   fallback is invisible — it hid a ten-day-stale Worker deploy. The comment above
   `fillPacks` promises pulls are "marked `local` and the export says so"; neither exists.

## The template must be a WHOLE deck, not the stripped one

`graft-deck.mjs` defaulted to `out/ResoPal_DeckTemplate.resonitepackage`, a
`build-deck-probe.mjs` output over `data/template.resonitepackage` — and that file is a Deck
Maker export run through `tools/strip_template.mjs`, which drops the fallback fonts and the
placeholder atlas **because the website's `patch.js` replaces both on every bake**. Nothing
replaces them on the in-world path. The grafted deck shipped with five packdb references and
no blobs behind them:

```
971a5f8b…  StaticTexture2D   the placeholder atlas      1.1 MB
4cac5211…  StaticFont                                   0.6 MB
23e7ad7c…  StaticFont                                   0.4 MB
415dc629…  StaticFont                                   0.4 MB
bcda0bcc…  StaticFont        the big fallback face     16.5 MB
```

In-world that is text that does not sit on its button and untextured card edges.

The probe build was the wrong source on its own terms too: everything it adds is the
per-card art chain on the 52 stock cards, and **the importer destroys all 52**. What it needs
from a deck is the furniture — the holder, the buttons, `Surface/cards`, the `buffer`
template and `logixs` — which is what a plain export already is. The furniture is byte-alike
between the two; the only difference was the missing blobs.

So `data/deck-template.resonitepackage` is the owner's own confirmed-good export, committed
whole, and it is the default now. `test-graft-deck.mjs` fails on any packdb reference without
a blob, so this cannot come back quietly.

**19.9 MB, of which 17.5 is fonts and 16.5 of that is one fallback face.** That face is the
trim to make if the size matters — but only once the text has been confirmed good in-world,
because a missing font is what the offset text was.

## Three things a Deck Maker export brings with it

All three came out of the first in-world import, which otherwise worked: the cards spawned,
moved into a deck, and the spread engaged. The deck was twenty metres away, the cards were
scattered off it, and every card was a third of the size of the slot it sat in.

**1. The export carries the world transform it was saved from.** The deck template measured

```
pos [-20.2569, 2.1762, 10.5210]   rot ~[-0.19, -0.23, -0.59, 0.75]   scale 0.91
```

and `DuplicateSlot` copies a template's local transform verbatim, so the duplicate landed
twenty metres away, rotated, at 0.91. The **Deck Maker itself** measures `pos [-28.68, 2.59,
26.38] scale 0.91` from a different session — which is what says the 0.91 is the same
saved-in-world residue as the position rather than an authored size. `Deck/cardSize` is
written as `0.175 x 0.25`, and that means metres at scale 1. `graft-deck.mjs` resets all
three. **Anything re-exported from Deck Maker will bring its own, so this reset is not
optional and not one-off.**

**2. `SetParent` keeps the LOCAL transform, so a card arrives holding its grid position.**
`PreserveGlobalPosition` unwired is `false`. Each card reaches the deck still carrying the
position `SetLocalPosition` gave it on the panel's grid, so it sits that far off its own
buffer and the deck spreads into a cloud beside the holder. The deck's own handler solves
this and it is easy to read as a no-op:

```
SetLocalPositionRotation( Instance = the received card, Position = null, Rotation = null )
```

Both inputs are **deliberately unwired** — an unconnected `ValueInput` evaluates to its
type's default, `float3.Zero` and `floatQ.Identity`. The node *is* the reset. The importer
does the same thing now, in the same place in the sequence.

**3. A panel card is a third of a deck card.** The panel's card is 0.088 m tall, which is
what a grid of loose cards wants in front of a 0.36 m panel; the deck's cell is
`Deck/cardSize`.Y = 0.25. Dropped in unchanged the spread reads as small cards with wide
gaps — measurable straight off the screenshot, where the spacing was about 2.8 card widths
and 0.25/0.088 is 2.84. The card is scaled to the cell on the way in
(`SetLocalScale`), because the deck's furniture — its collider, its baked edge mesh, its
spacing — is all built around 0.175 x 0.25 and shrinking `cardSize` instead would move all
of it. `test-panel.mjs` reads the card height off the template's own `BoxCollider` and
checks the emitted scale lands on 0.25, so the two cannot drift apart.

The deck also lands **beside** the panel now (`Decks` at `[0.45, -0.30, 0]`), not under it:
the loose-card grid grows downward from -0.22 and a 50-card import reaches about -0.70, so a
deck parked below would land inside it.

## `SetParent` preserves the GLOBAL position unless you say otherwise

The one that made an imported deck read as three pieces lying apart, and the reason it took
three imports to find: it is a **default**, not a wire, so nothing about the graph looks
wrong.

```cs
[DefaultValueAttribute(true)]
public ValueInput<bool> PreserveGlobalPosition;
...
slot.SetParent(slot2, PreserveGlobalPosition.Evaluate(context, defaultValue: true));
```

Unwired it is **true**. The slot keeps its world position and the engine recomputes a local
offset to match. An export of the broken deck says it exactly:

| | known-good | broken import |
|---|---|---|
| `Cards/buffer/Card` position | `[0, 0, 0]` | `[-0.319, 0.480, -0.031]` |
| `filler` position | `[0, 0, 0]` | `[-0.161, 0.240, -0.010]` |

The same offset on all 48 cards — because they had all been reset to the same point on the
panel first — and `filler` at exactly **half** of it, because the deck drives its edge stack
off the cards' bounds and followed them off the holder. The buttons never moved at all; the
stack moved away from them. One unwired port, and the deck reads as a holder, a floating
edge stack and a stray Search button.

Ukilop's own handler leaves it unwired and gets away with it because it calls
`SetLocalPositionRotation` **after** the reparent. This branch resets **before**, so that
`GetChild` still names the same card (below), and therefore has to say `false` — on all three
of its `SetParent`s, including the one that moves a buffer's packed proxy into `/Deck/Assets`,
where a preserved world position writes junk onto the flux canvas instead.

## `GetChild` does not latch

Worth its own heading, because one wrong assumption produced two symptoms that look
unrelated.

`GetChild` is a **function** node: it re-evaluates on every read. Three action nodes reading
`the card on top` are three separate calls to `GetChild(panel Cards, 0)`, and the moment
`SetParent` moves that card out of `Cards` the same expression names a *different* card.

The move ran first, so each pass moved card A and then reset and scaled card **B**, still
sitting on the panel. Two symptoms out of that:

- **the first card is a third of the size of the others** — card A was moved before anything
  scaled it, and nothing ever came back for it;
- **the last card never leaves the stack** — on the final pass `GetChild` returned null,
  which breaks an `ActionBreakableFlowNode`, and the break took the `SetParent` that puts the
  buffer into `Cards` with it.

The fix is ordering, not a new node: reset and scale while the card is still under `Cards`,
and move it last. Both survive the move — `SetParent` with `PreserveGlobalPosition` unwired
keeps the local transform, and local scale is not touched by reparenting at all.
`test-panel.mjs` asserts the order and that all three nodes name the same card.

## TypeVersions is not decoration — it decides which loader runs

The one that made the buttons' text sit off its button, in a file whose button subtree was
**byte-identical** to a known-good deck's. Every `Text` field in the package was right;
the loader overwrote them.

A component that declares `public override int Version => N` and is written at a LOWER
version gets its `OnLoading` legacy-upgrade path. `UIX.Text` is version 1 and its path is:

```cs
if (control.GetTypeVersion(GetType()) != 0) return;
control.OnLoaded(this, delegate {
    HorizontalAutoSize.Value = true;
    Align = _legacyAlign.Value;                    // -> Left / Top
    Font.Target = base.World.GetDefaultFont();     // -> the world's font chain
    LineHeight.Value = 0.8f;
});
```

Which is the symptom exactly. An export of the imported deck measured `H=Left V=Top
autoH=true` and a **six**-fallback font chain of faces the package does not contain, against
`H=Center V=Middle autoH=false` in the template on disk and in both known-good decks.

**The panel had it too, and always had.** `build-panel.mjs` hand-listed
`{Grabbable: 2, BoxCollider: 1}` and that was all — so `Text`, `Canvas`, `RectTransform`,
`Image`, `TextField`, `UI_UnlitMaterial`, `Snapper` and `QuadMesh` all shipped at 0. The
panel's own button captions have been left-aligned in the world's font this whole time.

Fixed the way member order was: **read out of the engine, never restated.**
`members.mjs` gained `typeVersion(classpath)`, which walks the base chain — `BoxCollider`
declares no version of its own and inherits 1 from `Collider`, which has its own legacy
branch. The builder derives `TYPE_VERSIONS` from every type it emits, the graft rewrites the
packed panel's table from the engine, and `test-panel.mjs` fails on any declared version that
disagrees. The numbers it produces match the owner's own exports for all nine shared types.

`splice.mjs` carried a related bug: it copied a type's version only when the type was
**appended**. The deck's `UIX.Text` mapped onto the panel's existing `UIX.Text` entry, kept
the panel's (absent) version, and every Text in the deck loaded legacy. It now carries the
version whether the type is new or not, and throws if two documents disagree.

### The other side of that coin: QuadMesh's version-0 loader flips every quad

Declaring the versions correctly immediately broke the cards — backs on the front — and the
reason is worth keeping, because it is the same mechanism pointing the other way.

`QuadMesh.Version` is 1, and its version-0 branch is:

```cs
float3 v  = Rotation.Value * float3.Forward;
float3 up = Rotation.Value * float3.Up;
Rotation.Value = floatQ.LookRotation(-v, in up);
```

It aligns forward with **-v** and leaves up alone, which is exactly `Rotation × <half turn
about Y>`. So every quad in a version-0 package is flipped 180° as it loads.

The card's two quads were tuned in-world **against that flip** — front `[0,1,0,0]`, back
identity, both flipped on the way in — so stopping the flip swapped the faces. The stored
rotations are the post-upgrade ones now: front identity, back `[0,1,0,0]`. For this pair the
transform is its own inverse, so it reads as a straight swap.

`graft-deck-import.mjs` applies the same upgrade to the packed panel at build time, with a
self-check on the two cases it has to get right, and normalises `w >= 0` so the file reads
`[0,0,0,1]` rather than the equivalent `[0,0,0,-1]`.

**The general lesson: correcting a TypeVersion is not free.** A file authored under version 0
has values that assume the upgrade will run. Declaring the version stops it, so the stored
values have to be upgraded at the same time. Anything else added to that table needs the same
check — what does the old loader do, and does this file depend on it?

## Shuffle is a swap, so every buffer needs its own OrderOffset

Shuffle survived the import structurally — the buttons subtree and its flux come out
byte-alike, and both `ButtonEvents` still resolve — and did nothing at all. It is not driven
off the cards:

```
RandomInt(0, ChildrenCount(Cards))  ->  GetChild(Cards, that)
SetSlotOrderOffset( that buffer, GetSlotOrderOffset( another ) )   ← a SWAP
```

It permutes `OrderOffset` between the buffers under `Cards` and never touches a `Card` slot.
So a deck whose buffers all carry the **same** offset shuffles perfectly and changes nothing
— and `DuplicateSlot` copies `OrderOffset` verbatim, so every buffer duplicated from
`/Deck/buffer` inherits its 0.

Ukilop's own handler assigns one to every card it receives (`SetSlotOrderOffset` off an
`ImpulseMultiplexer`). The importer had skipped it, reasoning that insertion order already
reads correctly — true, and beside the point.

It now writes `ChildrenCount(deck Cards)` — read **before** the buffer joins, so the offsets
come out 0, 1, 2 … in insertion order, keeping list index equal to stack position.

**The wider lesson: the deck has a per-card contract and it is worth reading before adding to
it.** Every `Card` slot Ukilop makes carries a `Card` space with `Card/index` and
`Card/Grabbable`, and the buffer around it carries the `OrderOffset`. Our imported cards
satisfy none of the `Card/*` half — they carry `CARD`/`CARD/url`, which is the panel's own
space and deliberately not the deck's. Nothing has needed those two yet; if a deck feature
turns out dead on an imported deck, that is the first place to look. The full list of
variable names the deck defines:

```
Card/Grabbable | Card/index | Deck/Filler | Deck/MaterialBack | Deck/MaterialEdge
Deck/MaterialFront | Deck/Ready | Deck/cardSize | InnerDeck/SmoothSpeed
InnerDeck/grid X | InnerDeck/grid Y
```

## Where a spawned deck sits — and why the pose goes on the TEMPLATE

A deck is authored **Y-up** — its buffers stack along local +Z and its card faces look along
local +Y — and the panel is a **wall**. So a deck at identity rotation stands on its side,
which is what the first few imports did.

**The pose goes on the deck template's root, not on the `Decks` slot duplicates land under.**
Putting it on `Decks` was tried and did nothing at all:

```cs
public Slot Duplicate(Slot duplicateRoot = null, bool keepGlobalTransform = true, …)
```

and the ProtoFlux node calls `slot.Duplicate(duplicateRoot)`, taking that default. A duplicate
keeps the **template's** world transform and is merely re-parented — the new parent's own pose
never enters into it. Posing the parent is the one thing that cannot work.

**That is the second time a transform-preserving flag has defaulted to TRUE and quietly
ignored what this code set** — `SetParent.PreserveGlobalPosition` was the first, and it moved
every card off its buffer. Assume any such flag is on unless the file says otherwise.

So `graft-deck.mjs` writes the pose onto the grafted deck's root, the holder above it stays at
identity so it adds nothing, and `Decks` stays at identity too. The template is a child of the
panel, so the pose is still panel-relative and a deck still comes up square to the reader.

```
Deck template (holder)   identity, inactive
  Deck (the template)    pos 0.2, 0, -1.31   rot Euler(-90, -90, -90)
Decks                    identity — somewhere for duplicates to hang, nothing more
```

`Euler(-90, -90, -90)` through `floatQ.EulerRad` is `(0, -0.70710678, -0.70710678, 0)`, a half
turn about the axis between −Y and −Z. Checked against the basis vectors, it maps local +Z to
panel up and local +Y to panel forward. `test-graft-deck.mjs` holds the deck root to the pose,
the holder to identity and the scale to 1; `test-panel.mjs` holds `Decks` to identity and
checks the duplicate is parented into it.

> **One number to confirm.** The owner read the position as `.2 1.3 -1.3`, but the inspector
> shows `y = 1.31130226e-06` — that is 1.3 × 10⁻⁶, i.e. zero, and its mantissa happens to
> match the z. `0.2, 0, -1.31` is what shipped. If the deck wants to be a metre and a third
> **above** the panel rather than level with it, `DECK_POSITION` is the one line to change.

## Square corners — fixed with a mask, not a mesh

Ukilop's card is `Card/Visual (Baked)`: a baked mesh per card, rounded, with three submeshes
(edge / front / back). The imported card is the panel's own — two `QuadMesh` quads — and a
quad has square corners, so they poked out past the holder and a stacked deck's edge came out
as a **sawtooth**.

The fix turned out to be one reference, not an architecture change. `UnlitMaterial` carries a
mask (`_MASK_TEXTURE_MUL` / `_MASK_TEXTURE_CLIP`), and the card already had a texture whose
alpha **is** the card silhouette: `DefaultBack.png`, rounded corners in its `tRNS` chunk,
embedded already because the back face uses it. So the FRONT material multiplies its alpha by
the back's, and the `Cutout` at `AlphaCutoff 0.72` it already ran clips what is left.

```
front UnlitMaterial   MaskTexture = <the back's StaticTexture2D>
                      MaskMode    = MultiplyAlpha
                      MaskScale   = (1, 1)      MaskOffset = (0, 0)
```

No new asset, no mesh, no ProtoFlux. The back needed nothing — it samples that alpha directly
and was always round.

Two things worth keeping:

- **`MaskScale` must be stated.** An omitted `Sync<float2>` loads as `(0, 0)`, which collapses
  the mask to a single texel. The suite checks it is `(1, 1)`.
- **The graft rebuilds the material's fields in declared order** rather than appending the four
  new ones, the same rule `comp()` follows.

The options that were on the table and are no longer needed: rounding the art at the Worker
(ruled out by the invariant that the Worker moves bytes and nothing else), grafting one of
Ukilop's baked meshes onto our card, and dropping the move-cards-in architecture to retexture
his cards in place. The third is still the tidier end state if a card ever needs a real edge or
a per-card back — but it is no longer the price of round corners.

## (superseded) Square corners: the imported card is ours, not Ukilop's

Kept for the measurements. The fix is architectural rather than a value to change.

Ukilop's card is `Card/Visual (Baked)` — a **baked mesh per card**, rounded, with three
submeshes (edge / front / back) and its atlas cell baked into the UVs. The imported card is
the panel's own: two `QuadMesh` quads, front and back. A quad has square corners.

The back looks right because `DefaultBack.png` carries transparent corners and the material
is already `BlendMode: Cutout` at `AlphaCutoff 0.72`. The front is square because Palify's
art is a square image with no alpha.

Three ways out, and only one of them is cheap in the wrong way:

1. **Round the art at the Worker.** Ruled out: CLAUDE.md's invariant is that the Worker
   "moves bytes and nothing else", and this would make it decode and re-encode every card.
2. **Give the panel's card one of Ukilop's baked meshes** and remap the full-size texture
   onto that mesh's atlas cell, exactly as `build-deck-probe.mjs` already does per card
   (`TextureScale = (10, 7)`, `TextureOffset = (-col, -(6 - row))`, verified against the
   MeshX UV bounds by `meshx.mjs`). One mesh and one constant ST serves every card, because
   they would all share the same cell. Also gives the card a real edge and back.
3. **Stop moving cards in at all** — keep the deck's own 52 cards, give each its own front
   material and texture at its cell's ST, and write `Card/url` per card instead of
   reparenting. This is what "the shape of the real thing" in the section above always
   described, and the remap half of it is drag-tested. It gets the rounded corners, the
   `Card/index` and `Card/Grabbable` contract and the deck's own materials for free, and
   caps a deck at the template's card count with the extras destroyed in-world.

3 is the end state. 2 is the smaller step and keeps the current import branch intact.
There is no procedural rounded-rect mesh in the engine to shortcut either — `RectMeshSource`
and `StandaloneRectMesh` carry no corner radius.

## The card is thinned, not just scaled

The deck stacks its buffers exactly `Deck/cardSize`.Z apart — the reference deck's buffers
measure z = 0.0406, 0.0390, 0.0374, a 1.6 mm pitch. The panel's card is 2 mm thick at the
collider, so scaled **uniformly** to fill the 0.25 cell it becomes 5.7 mm — three and a half
times the gap it has to sit in, and it pokes through the card above it. So the scale is not
uniform: X and Y take the card to the cell, Z takes it to the pitch.

## The record width was drifting

`worker/src/roll.js` moved `RECORD_WIDTH` to 80 and `build-panel.mjs` still had a literal
64, so the status line's `Substring` cut the first record at 64 characters and showed a
truncated URL. Nothing failed: the loop walks newlines and never reads the constant, so only
the readout was wrong, and only for URLs longer than 64. The builder imports the Worker's
constant now — there is one definition of it. `test-panel.mjs` had the same 64 hard-coded
and was slicing live responses into fragments with it, which is what the five
"want &lt;url&gt; got &lt;url&gt;" failures were; it splits on newlines now, the way the graph does.

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
