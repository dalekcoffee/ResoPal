# ResoPal — working notes

Read `docs/PIPELINE.md` before changing anything that touches a deck package. It records fixes
whose reasons are not visible from the code, several of which have been re-broken by someone
"cleaning up" the thing that looked redundant.

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

**BSON deserializes numbers as `Double` objects.** Assigning a `Double` where a plain JS number is
expected is a silent no-op. `AlphaCutoff` was never applied twice for this reason.

**Never invent card data.** Two phantom cards (`TD01-025`, `TD02-025`) reached production from
placeholder decklists. Verify against `palify.org/api/cards?set=<SET>`, or run
`tools/check-codes.html`.

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
