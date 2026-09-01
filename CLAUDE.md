# ResoPal — working notes

Read `docs/PIPELINE.md` before changing anything that touches a deck package. It records fixes
whose reasons are not visible from the code, several of which have been re-broken by someone
"cleaning up" the thing that looked redundant.

## Picking this up

Read `docs/HANDOFF.md` first. It records where the in-world panel stands, the one open
bug and everything already ruled out about it, and the fact that the shipped panel is a
hand-packed file the builder does not reproduce — a change ships by grafting into it, not
by rebuilding over it.

## What this is

A static site (`index.html`, GitHub Pages, resopal.dalek.coffee) that turns a Palworld TCG deck
into a `.resonitepackage`. The whole bake runs in the browser. A Cloudflare Worker (`worker/`)
exists only to re-serve Palify's card art with CORS headers.

## Invariants — breaking these is silent

**The bake must stay in the browser.** An 8192² RGBA bitmap is 256 MiB; a Worker's ceiling is
128 MB. The Worker moves bytes and nothing else.

**Card art must be same-origin or CORS-enabled.** Drawing a cross-origin image onto a canvas taints
it and `convertToBlob`/`getImageData` throw. `crossOrigin="anonymous"` makes it worse — the image
then fails to load at all. The loader deliberately goes `fetch → blob → createImageBitmap`, because
a bitmap decoded from a Blob carries no origin and the canvas stays readable.

**Landscape rotation is 90° clockwise, and PIL and canvas disagree about what that means.**
`compose.py` uses `ROTATE_270`, `compose.js` uses `ROT = 90`. They agree; the constants don't.
This has shipped wrong twice.

**Verify atlases against the atlas inside a known-good `.resonitepackage`** — never against a loose
`.webp` in a build directory. The second rotation bug happened because the comparison file predated
the first fix, so both sides were wrong in the same way and the diff came back clean.

**`solidify()` runs before the resize, not after.** Card art is matted against white; downscaling
antialiased edge pixels straight leaves a white rim that survives the alpha cutout.

**Only `StaticMesh` assets may be deleted when trimming.** Reference counting must walk `doc.Assets`
as well as `doc.Object`, because assets reference each other. Getting this wrong deleted `MainFont`
and broke every button on the deck.

**A classpath is a path, not a name.** `[Asm]A.B.C` must have a file at `decompiled/Asm/A/B/C.cs`
and nowhere else will do. `...Nodes.StartAsyncTask` does not exist — the class is
`...Nodes.FrooxEngine.Async.StartAsyncTask` — and the wrong path shipped three times because
every check looked the class up by its **leaf name**, so a file three namespaces away answered
for it. The package validated, had zero dangling references and passed the async-context gate;
in-world the two requests and the whole spawn loop were red with nothing able to run them.
`verify-classpaths.mjs` now requires the exact path.

**A component's members must be emitted in the order the class declares them.** Read the order
out of the class's own `GetSyncMember(int index)` switch — `booster/members.mjs` does. Written in
whatever order the builder happened to list them, the panel encoded cleanly, validated with zero
dangling references, and in-world every node was red with wires on the wrong ports: `If` went out
as `{Condition, OnTrue, OnFalse}` where the class declares `{OnTrue, OnFalse, Condition}`, and
`GET_String` declares `Content` **last** — it comes from a subclass, after the base's impulses — so
emitting it fifth shifted every impulse output by one. A ProtoFlux node must also emit **every**
member, unwired ones as null: they are all ports, and a port that is not in the file is a port the
graph cannot resolve.

**An impulse wire must land on an operation, and a data wire must never land on an action node's
component id.** The binding class says which each member is: `SyncRef<INodeOperation>` is an
impulse, `SyncRef<INode*Output<T>>` is a data input, and a bare `Node*Output<T>` is the node's own
output — which exists to be addressed by its **field** id. `booster/verify-classpaths.mjs` checks
both directions.

**`OnAwake` does not run on load — an omitted `Sync<T>` comes back as the TYPE default.** So a
member left out "to keep its default" gets the opposite of the default that was meant. Three
shipped at once: `Snapper.SnapCheckRadius` loaded 0 instead of 0.01, so a card found no snap
target ever; `Grabbable.Receivable` loaded false, so `Grabber.Release` dropped the card before
any receiver surface heard about it; and the card's space was `CARD`, not `Card`, so every one
of the deck's per-card writes resolved to nothing. Match a known-good artifact field for field
before assuming an absent member is harmless.

**BSON deserializes numbers as `Double` objects.** Assigning a `Double` where a plain JS number is
expected is a silent no-op. `AlphaCutoff` was never applied twice for this reason.

**Never invent card data.** Two phantom cards (`TD01-025`, `TD02-025`) reached production from
placeholder decklists, and a later hand-written demo array shipped three wrong names and two Pals
labelled as Structures. Verify against `palify.org/api/cards?set=<SET>`, or run
`tools/check-codes.html`. `data/pool-*.json` is the committed snapshot everything else reads;
regenerate it with `tools/fetch-pool.mjs`, never hand-edit a card code into it.

**An import that fails must fail visibly.** The site shipped for a while with every import path -
deck URL, profile URL, dropped file - doing nothing but switching screens, so the demo catalogue in
`index.html` (`CARDS`) rendered as if it were the user's deck. `CARDS` is the pack ripper's demo
pool and nothing else; a deck comes from `state.deck` or the import failed. Card names, colours and
printings are resolved against `data/pool-*.json`, never carried over from whatever the source list
claimed.

**There is one pack roll, and it is in the Worker.** `worker/src/roll.js`, over
`data/pack-weights.json` + `data/pool-<set>.json`. The site's local roll is an offline fallback
over the same two files, not a second implementation. A browser roll is one devtools breakpoint
from being whatever the player wants, and the in-world spawner cannot roll at all.

**A pull is ordered rarest-first, and that is stack order.** The atlas is laid out in deck-list
order and the deck's flux drives each card's offset from `IndexOfChild`, so list index is stack
position. Reveal order on the site is the reverse. See `docs/BOOSTER.md` "Stack order".

## Generated files that are committed

`web/bake.bundle.js` and `web/brotli_wasm_bg.wasm` are build outputs, committed because a static
site has to serve them. **Edit `web/*.js`, then `cd web && npm run build`.** Editing the bundle
directly is silently lost on the next build.

`data/template.resonitepackage` is a Deck Maker export run through `tools/strip_template.mjs`
(20.78 MB → 1.65 MB). Re-run it after any re-bake.

## Conventions

- Commit as `Dalek <dalek@users.noreply.github.com>`. Never the owner's name or email.
- Say what you intend to commit before committing it.
- Ukilop's and Palify's credits are a permanent requirement, not a courtesy. They ship inside every
  generated deck in `/credits`.
