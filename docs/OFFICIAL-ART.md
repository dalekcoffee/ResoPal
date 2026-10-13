# Official-site card art

Status: **route built, not deployed, not used by anything.** Palify remains the only art source
every shipped panel, every exported deck and the site actually use.

## What exists

`GET /official/<CODE>?w=512` on the Worker (`worker/src/index.js` `official()`,
`worker/src/official.js`, `worker/src/png.js`, tests in `worker/test/official.mjs`). It serves
`https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist/E<SET>/E<CODE>.png`
for a Palify code, and returns exactly what `/img/` would for anything it cannot serve. The
details are in `docs/WORKER.md`.

Why it cannot break an existing user:

- **`/img/` is not modified.** The diff that added `/official/` removes no line from any existing
  file. `/img/`'s cache key (`/img/v2/...`), its bytes and its URL shape are unchanged, and
  `worker/test/official.mjs` asserts that `/img/` never contacts the official host.
- **Nothing emits an `/official/` URL.** `web/fill.js` and `roll.js`'s `toFixed` still write
  `/img/<CODE>?w=512&v=2`, so no panel or deck can reach the new route until someone changes them.
- **Every failure falls back to Palify.** That covers a wrong filename mapping, an official 404,
  an HTML error page served as 200, a landscape PNG, a 5xx or a network failure. A bad mapping costs
  that printing its official art; the card still loads.
- **It fits the fixed-width record.** The longest pool code (`TD01-024TSR-ERR`) makes a
  74-character `/official/` URL on the workers.dev origin, inside the 79 that every
  already-spawned panel decodes. This is asserted in the tests.

Reverting it is deleting the route branch and the two modules. Nothing else references them.

## Not verified yet: image quality

**No official image has been measured.** This was explored in a cloud session whose network
policy blocked both `en.palworld-official-cardgame.com` and `palify.org`. Web tools there had no
DNS either, so the dimensions, byte sizes, headers (CORS, cache-control) and filename coverage
below are still open.

| | Palify `/cards/w1024/` (what `/img/` uses) | Official cardlist PNG |
|---|---|---|
| format | WebP | PNG (from the URL) |
| size | 1024 wide, ratio ≈ 0.7156 (`docs/DESIGN-SPEC.md`), ~1431 tall | **unmeasured** |
| widths | 256 / 512 / 1024 | one size, as served |
| landscape Structures | served landscape, turned via `assets/rot/` | **unknown** |
| parallel naming | `BP01-025SSP`, `BP01-001OSR`, `TD01-024TSR-ERR` … | `EBP01-025SSP` confirmed by a known URL; the rest are unknown |

To fill it in, run this anywhere both hosts are reachable:

```
node tools/probe-official-art.mjs out=official-vs-palify.md
# behind an HTTPS proxy:  NODE_USE_ENV_PROXY=1 node tools/probe-official-art.mjs
```

It probes every code in `data/pool-*.json` on both sites and reports dimensions, bytes,
orientation, which codes have no official file, and every image-URL shape on the cardlist page
(`src`, `data-src`, `srcset`). The last one answers whether the cardlist PNG is the biggest copy
the site has. Never hand-edit a mapping from a guess (CLAUDE.md, "never invent card data").

## Before switching anything to it

1. **Measure** (above). If the official PNG is not larger than Palify's 1024 or is no sharper,
   stop: there is nothing to gain.
2. **Size in-world.** `/official/` ignores `w`. Cards are fetched at `w=512` because a 50-card
   deck is 50 resident textures (`roll.js`, `IN_WORLD_WIDTH`). A ~1024-wide official PNG is
   about 4× the VRAM of what ships today. Either accept that, or resize with Cloudflare Image
   Transformations (`fetch(url, { cf: { image: { width, format: 'webp' } } })`). That needs
   transformations enabled on a zone and the official host allowed as a source. It is free for
   5,000 unique transformations a month; 151 pool cards × 3 widths is well under. The docs
   disagree on whether it runs on `*.workers.dev`. Test it on the custom domain first. The
   resize happens outside the isolate, so the 128 MB rule in `docs/WORKER.md` is not what limits
   it. The cache key would then need the width, plus a bump of `OFFICIAL_CACHE_VERSION`.
3. **Landscape.** A landscape official PNG currently falls back to Palify's turned copy. Official
   art for Structures would need its own turned copies, generated the way
   `.github/workflows/rotate-landscape.yml` makes Palify's.
4. **Permission.** No fan-content or image-reuse policy from the publisher was found. Read the
   site's terms before serving its files to other people.
5. **Switch both emitters together.** Change `web/fill.js`'s `artUrl` and `roll.js`'s `toFixed` to
   `/official/` in the same commit, with a new `&v=`. They must stay byte-identical (CLAUDE.md).
   Old cards keep their `/img/` URLs and keep working. Only cards made after the switch use the
   new art. To revert, switch the emitters back. The route can stay.
