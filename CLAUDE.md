# ResoPal — working notes

Read `docs/PIPELINE.md` before changing anything that touches a deck package. It records fixes
whose reasons are not visible from the code, several of which have been re-broken by someone
"cleaning up" the thing that looked redundant.

## Picking this up

Read `docs/PANEL-V1.md` first — it describes the panel that actually ships
(`booster/out/ResoPal_Panel_v1.0.resonitepackage`) and how it's built (a UIX Studio shell
transplanted with the ResoPal flux). `docs/HANDOFF.md` is older and describes the *previous*
panel (`out/ResoPal_Panel.resonitepackage`, kept only because this doc still refers to it) — its
"one open bug" (no real card back) was not fixed, it was made moot: v1.0 dropped the hand-built
card for Sharkmake's DeckReader card, whose front/back is a texture swap on touch, not two-sided
geometry. Read `docs/HANDOFF.md` for the card-back debugging history if you are touching a
hand-built card again; skip it otherwise.

## What this is

A static site (`index.html`, GitHub Pages, resopal.dalek.coffee) that turns a Palworld TCG deck
into a `.resonitepackage`. **Two exports, and only one still bakes anything.** The deck
(`web/fill.js`) writes each card's art as a URL into the v1.0 template and re-zips — no pixel is
ever read. The raw sheet, for hand-baking in Deck Maker (`web/bake.js`'s `bakeSheetOnly`,
`compose.js`), still composites an 8192² atlas client-side, the way the deck used to. A Cloudflare
Worker (`worker/`) re-serves Palify's card art with CORS headers and does the in-world texture
routing every card — panel-spawned or site-exported — actually fetches from at runtime.

## Invariants — breaking these is silent

**The bake must stay in the browser — sheet export only.** An 8192² RGBA bitmap is 256 MiB; a
Worker's ceiling is 128 MB. The Worker moves bytes and nothing else. **This does not apply to the
deck export**: `fillDeck` reads no pixels, so there is nothing here for it to violate — see
`docs/PIPELINE.md` "Deck path: a card carries its art as two URLs, nothing baked".

**Card art must be same-origin or CORS-enabled — sheet export only.** Drawing a cross-origin image
onto a canvas taints it and `convertToBlob`/`getImageData` throw. `crossOrigin="anonymous"` makes it
worse — the image then fails to load at all. The loader deliberately goes
`fetch → blob → createImageBitmap`, because a bitmap decoded from a Blob carries no origin and the
canvas stays readable. **The deck export draws nothing, so this does not apply to it either** — a
card's art is a live URL the *engine* fetches in-world, never a browser `<img>` or canvas source.

**A v1.0 card's art URL must match what the Worker emits, byte for byte, or the same card is two
different cached assets.** `web/fill.js`'s `IN_WORLD_WIDTH`/`ART_VERSION` (`?w=512&v=2`) must track
`worker/src/roll.js`'s `IN_WORLD_WIDTH` and the `&v=` literal in `toFixed()` exactly. Resonite
caches a texture by URL, in the install, forever — a mismatch is not a bug that shows up once, it
is every player who owns both a panel-spawned and a site-exported copy of the same card paying for
the download twice. The reference deck committed for comparison
(`booster/out/ResoPal_TD02_Deck_v1.0.resonitepackage`) carries the *wrong* shape on purpose (a hand
capture predates this URL, at `?w=1024` with no `&v=`) — do not copy it.

**A v1.0 card's `DATA` variable space lives on `Card`, not on `DATATEMPLATE` where Sharkmake's own
card puts it.** The panel's template hoists it up one level so a write addressed at the `Card` slot
— which is how the panel fills a freshly imported deck — can find it; dynamic-variable lookup only
walks **up**. Write to the un-hoisted location and the write finds nothing, silently: no error, no
dangling reference, the card just never gets its art. `web/fill.js` asserts the space is on `Card`
before writing anything, specifically because of this.

**Landscape rotation is 90° clockwise, and PIL and canvas disagree about what that means — sheet
export only.** `compose.py` uses `ROTATE_270`, `compose.js` uses `ROT = 90`. They agree; the
constants don't. This has shipped wrong twice. The deck export rotates nothing client-side at
all — that moved server-side, into the Worker's `/img/` route.

**Verify atlases against the atlas inside a known-good `.resonitepackage`** — never against a loose
`.webp` in a build directory. The second rotation bug happened because the comparison file predated
the first fix, so both sides were wrong in the same way and the diff came back clean.

**`solidify()` runs before the resize, not after.** Card art is matted against white; downscaling
antialiased edge pixels straight leaves a white rim that survives the alpha cutout.

**Only `StaticMesh` assets may be deleted when trimming — sheet-era template.** Reference counting
must walk `doc.Assets` as well as `doc.Object`, because assets reference each other. Getting this
wrong deleted `MainFont` and broke every button on the deck. **A v1.0 deck trim drops nothing**:
nothing per-card is an asset any more (one mesh, one back texture, shared by every card), so
`web/fill.js` asserts zero newly-unreferenced assets after a trim instead of a mesh-count
subtraction. The underlying rule — walk the whole document, never just the object graph — is the
same rule `booster/extract-deck-template.mjs` uses to prune the deck template's own `Assets` table
by reachability, iterated to a fixpoint, when it lifts that subtree out of the panel.

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

**A pull is ordered rarest-first, and that is stack order.** Cards are laid out — atlas cell order
before v1.0, card-buffer order since — in deck-list order, and the deck's flux drives each card's
offset from `IndexOfChild`, so list index is stack position. Reveal order on the site is the
reverse. See `docs/BOOSTER.md` "Stack order".

## Generated files that are committed

`web/bake.bundle.js` and `web/brotli_wasm_bg.wasm` are build outputs, committed because a static
site has to serve them. **Edit `web/*.js`, then `cd web && npm run build`.** Editing the bundle
directly is silently lost on the next build.

`data/template.resonitepackage` is the v1.0 deck template — **extracted, not stripped, since
v1.0.** `booster/extract-deck-template.mjs` lifts the `Deck template` subtree straight out of
`booster/out/ResoPal_Panel_v1.0.resonitepackage`, the same subtree the panel itself duplicates and
fills on import, so the site and the panel produce the same object by construction. Re-run it
whenever that subtree changes, then re-verify with `node web/test-fill.mjs`. (Before v1.0 this was
a Deck Maker export run through `tools/strip_template.mjs` — that tool still exists, for the
unrelated sheet-export template; see `docs/PIPELINE.md` "The shipped templates".)

## Conventions

- Commit as `Dalek <dalek@users.noreply.github.com>`. Never the owner's name or email.
- Say what you intend to commit before committing it.
- Ukilop's, Palify's, Sharkmake's and ResoPal's own credits are a permanent requirement, not a
  courtesy. All four ship inside every generated deck in `/credits`, verified by
  `web/credits-v1.js` rather than built — see `docs/PIPELINE.md` "Credits".
