# In-world booster spawner — prototype

`out/ResoPal_Booster_BP01.resonitepackage` (13 KB) is a grabbable object holding seven
card quads. Drag it into Resonite. On spawn it asks for host access, GETs
`/api/pull?set=BP01&packs=1&format=flat`, takes the seven `code,rarity` lines apart, and
points each card's texture at the image proxy. Rarest card on top.

No bake, no download, no atlas — the cards appear as fast as the images load.

```
OnStart ─▶ IsHostAccessAllowedUrl ─┬─ true ──▶ GET_String  /api/pull?format=flat
                                   └─ false ─▶ RequestHostAccessUrl ─ OnGranted ─▶ ┘
                                                                          │
                     Content ──▶ 7 × (find comma, substring the code,     │
                                      concat the art URL, StringToAbsoluteURI)
                                            │
                                            └──▶ ObjectFieldDrive<Uri> ──▶ StaticTexture2D.URL
```

Past the GET there are no impulses. The drives pull their inputs every frame, so the
cards fill in the moment the response lands — the confirmed live-texture-swap pattern.

## Build

Needs the Resonite Knowledge Library for its ProtoFlux encoder. That library is not
vendored here; point `RKL` at a checkout.

```bash
cd booster && npm install
RKL=/path/to/Resonite-Knowledge-Library npm run build
RKL=/path/to/Resonite-Knowledge-Library npm test
```

`PROXY=` and `SET=` override the endpoint and the set.

## What is verified, and what is not

Verified here, mechanically:

- **0 dangling references, 0 unbound hooks** — every reference resolves inside the package.
- **The BSON round-trips byte-identical** (155,885 → 155,885).
- **No overlapping comment zones.**
- **The parse graph produces the right seven URLs**, checked by `test-parse.mjs`, which
  evaluates the graph *out of the built package* against a live response from the Worker.
  It covers variable-length codes (`BP01-011` vs `BP01-001SSP`), an empty response, and a
  truncated one.

Every classpath was read off a real decoded package or the decompiled engine, never
inferred — `ObjectFieldDrive<Uri>` and `FieldDriveBase<Uri>+Proxy` come from a captured
graph that drives a URL the same way, and the `OnStart`+`Proxy` pairing matches
`OnDestroying` in this repo's own deck template.

**None of that proves Resonite accepts the file.** Only a drag-test does. The layout gates
from the pretty-flux contract do not apply: this emits *packed* Moduprint (logic-only
slots, no node visuals), and `collectGraph` reads visuals, so it sees zero nodes. Unpack
with Moduprint in-world before laying the graph out.

## Check these first in VR

In rough order of how likely they are to be wrong:

1. **Which end of the stack is the top.** Card 1 is the rarest and sits at the largest
   local Z, matching the deck template's own convention (its card slots run +Z to −Z in
   list order). If the stack comes out inverted, flip `CARD_GAP`'s sign here and
   `STACK_RAREST_FIRST` in `index.html` — nothing else depends on the direction.
2. **The host-access prompt.** It should appear once, naming ResoPal. If `OnStart` fires
   before the user can answer, the first pull lands on the fallback art and a re-trigger
   is needed — the graph has no retry.
3. **Card orientation.** The quads are `DualSided`, so they are never invisible, but from
   behind you see a mirrored front rather than a card back. A back face is the obvious
   next addition.
4. **The white corner rim.** Materials are `Cutout` at `AlphaCutoff 0.72`, the same values
   the deck bake settled on, but the runtime path skips `solidify()` — the art is matted
   against white and nothing here re-mats it. Expect a fainter version of the rim
   `docs/PIPELINE.md` describes.

## What this is not

It is **not** the deck object. The deck's cards share one atlas texture with per-card UVs
baked into the mesh, so card 3 cannot point somewhere else, and nothing in-world can
compose an 8192² atlas anyway. Seven independent textures is the only shape that works at
runtime.

The deck path still exists and is better for *keeping* a pull: rip on the site, export the
seven cards as a real deck package with Ukilop's beveled geometry. Both paths roll through
the same endpoint, so `?seed=` reproduces one from the other.
