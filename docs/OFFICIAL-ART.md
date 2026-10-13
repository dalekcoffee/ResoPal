# Official-site card art

Status: **route built, not deployed, not used by anything. Measured 2026-10-13: the official
art is 400 px wide, smaller than Palify's, so the switch is off (see "Measured" below).** Palify remains the only art source
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

## Measured: the official art is smaller than Palify's

**Verdict: do not switch.** Probed 2026-10-13 against all 256 codes in `data/pool-*.json`
(`tools/probe-official-art.mjs`). The official cardlist PNG is 400 px wide, so it is smaller
than Palify's 512 that ships today, let alone its 1024. Step 1 below says stop, so this
stops here. The route stays built and unused.

| | Palify `/cards/w1024/` (what `/img/` uses) | Official cardlist PNG |
|---|---|---|
| format | WebP | PNG (`image/png`) |
| size | 1024×1431 portrait, 1024×732 landscape | **400×559** portrait, **400×286** landscape (236/237 found) |
| bytes, mean of the 237 found | 162 KB | 95 KB |
| largest copy | `/cards/<CODE>.webp` is 1600×2236 (BP01-001); `w1536`/`w2048` 404 | the cardlist page's server HTML links no card images (they load by script), so no bigger copy was found |
| landscape Structures | served landscape, turned via `assets/rot/` | served landscape too (33 codes: the same set as Palify's), so `/official/` falls back for all of them |
| coverage | all 256 | 237/256. 404s: `PR-002`…`PR-009` and their `S` copies (16), `SOUL-001`, `SOUL-002`, `TD01-024TSR-ERR` |
| headers | | no `access-control-allow-origin`, no `cache-control`, `last-modified` Jul 2026 |

The one exception is `TD01-024TSR`: 1117×1560 (411 KB), slightly larger than Palify's 1024×1430.
One card does not justify the switch. Parallel naming (`E<SET>/E<CODE>.png`) held for every
other parallel in the pool, so the mapping in `worker/src/official.js` is right as far as it goes.

To re-run it, use any machine that can reach both hosts:

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
