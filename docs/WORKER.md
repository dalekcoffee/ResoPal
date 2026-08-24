# The Cloudflare Worker

ResoPal is a static site on GitHub Pages. It needs exactly one piece of server-side help, for one
reason: **Palify sends no CORS headers** (measured — see `PALIFY-API.md`).

That single fact drives everything below.

## Why a proxy is unavoidable

A browser will happily *display* a cross-origin image in an `<img>`. It will not let you *read* it.
Drawing a cross-origin image onto a canvas taints that canvas, and every pixel-reading call then
throws a `SecurityError`:

```js
const img = new Image();
img.src = 'https://palify.org/cards/w1024/BP01-001.webp';   // renders fine
ctx.drawImage(img, 0, 0);
canvas.toBlob(...)      // SecurityError: tainted canvas
ctx.getImageData(...)   // SecurityError: tainted canvas
```

Setting `img.crossOrigin = 'anonymous'` does not help — it makes the browser *require*
`Access-Control-Allow-Origin` on the response, and Palify doesn't send one, so the image fails to
load at all.

Baking an atlas is precisely pixel reading: alpha-solidify, resize, composite, re-encode. So the
card bytes must arrive from an origin that permits reading them. That is the whole job.

The same applies to deck data: `palify.org/decks/<uuid>` is a Next.js page, not an API. The only
machine-readable form is the RSC flight payload, fetched with an `RSC: 1` header — also blocked by
CORS from the browser.

## What must NOT go in the Worker

**The bake stays in the browser.** This is not a preference, it's a hard limit:

- Workers cap out at **128 MB of memory** per isolate.
- One 8192 × 8192 RGBA bitmap is `8192 × 8192 × 4` = **256 MiB**, twice the ceiling, before you
  count the ~50 decoded source images or the ~12 MB output package.

CPU time is the second wall: the free plan allows 10 ms per invocation, and even the paid plan's
30 s would be tight for 50 image decodes plus a full-resolution composite plus a WebP encode.

The browser has no such limits. An 8192² canvas is well inside Chrome's area cap, `toBlob` encodes
WebP natively, and the package codec's dependencies (`bson`, `brotli-wasm`, `jszip`) all run in a
browser. Every heavy step already works there.

**So: the Worker moves bytes. The browser does the work.** No VPS, no container, no build server.

## Routes

### `GET /img/:code?w=1024`

Proxy one card image and attach CORS headers.

- Whitelist `w` to `256 | 512 | 1024`; whitelist `:code` to `^[A-Z0-9-]{3,20}$`. Without this you
  have built an open proxy for the whole internet.
- Cache aggressively. Card art is immutable — Palify already serves
  `cache-control: public, max-age=31536000, immutable`. Use the Cache API so the *first* user to
  import a card fetches it from Palify and every user after that is served from Cloudflare's edge.
  This is the single biggest thing you can do to be kind to Palify's servers.

### `GET /deck/:uuid` and `GET /profile/:handle`

Fetch the Palify page with `RSC: 1`, parse the flight payload, return clean JSON. Built —
`worker/src/flight.js`, written against real payloads (a deck page is ~81–109 KB, a profile ~28 KB).

Keep the parsing here rather than in the browser — the flight format is undocumented and will
change without warning. When it breaks you want to fix one Worker, not ship a new front end.
`?raw=1` returns the payload untouched, which is how the parser gets rewritten when that day comes.

Cache these for minutes, not a year; decks get edited.

Two behaviours that are not optional:

- **A payload that will not parse is a 502.** Never a fallback, never a partial deck. A wrong deck
  that looks right is the worst outcome this project has — the site shipped for a while doing
  exactly that, quietly serving its demo deck for every import.
- **A missing page arrives as HTTP 200.** Palify serves a deleted, private or nonexistent deck as
  200 with Next.js's own 404 payload, so the not-found check reads the body for the
  `NEXT_HTTP_ERROR_FALLBACK;404` digest and answers 404. Do not match on the string
  `404: This page could not be found.` — every Next.js page carries it in an unrendered slot,
  including perfectly good decks.

### `GET /cards`

The catalogue. **Consider not building this route** — the catalogue changes only when a set drops,
so committing a `data/cards.json` snapshot to the repo is simpler, faster, and free. Add a route
only if you want it to refresh without a commit.

### `GET /pull` (later)

Server-side pack rolls for the ripper, per `PULL-API.md`. This is the one route that genuinely
*must* be server-side — client-side rolls are editable in devtools. Not needed for the importer.

## Sketch

```js
const ALLOWED = 'https://resopal.dalek.coffee';
const CODE = /^[A-Z0-9-]{3,20}$/;
const WIDTHS = new Set(['256', '512', '1024']);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = {
      'access-control-allow-origin': ALLOWED,
      'access-control-allow-methods': 'GET,OPTIONS',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const img = url.pathname.match(/^\/img\/([^/]+)$/);
    if (img) {
      const code = decodeURIComponent(img[1]).replace(/\.webp$/, '');
      const w = url.searchParams.get('w') || '1024';
      if (!CODE.test(code) || !WIDTHS.has(w)) return new Response('bad request', { status: 400 });

      const cache = caches.default;
      const key = new Request(`https://cache.resopal/img/${w}/${code}`, req);
      let hit = await cache.match(key);
      if (!hit) {
        const up = await fetch(`https://palify.org/cards/w${w}/${code}.webp`);
        if (!up.ok) return new Response('upstream ' + up.status, { status: 502, headers: cors });
        hit = new Response(up.body, {
          headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable' },
        });
        ctx.waitUntil(cache.put(key, hit.clone()));
      }
      return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...cors } });
    }

    return new Response('not found', { status: 404, headers: cors });
  },
};
```

Then in the front end, every card image — both the thumbnails and the bake source — goes through
the Worker, and the bake source sets `crossOrigin = 'anonymous'` so the canvas stays clean.

## Cost

Free tier is 100,000 requests/day. A 50-card deck import is ~50 image requests, so roughly 2,000
imports a day before you hit it — and cached responses are served from the edge without touching
Palify. Workers have no egress charge. This will not cost money at ResoPal's scale.

## The no-Worker path

Worth knowing, because it can ship today:

**File upload needs no backend at all.** A `.txt`/`.csv` exported from Palify is read locally with
`FileReader`, and if card art were vendored into the repo it would be same-origin — no CORS, no
tainted canvas, no proxy. A complete, working v1 with zero server.

The catch is the art. Vendoring the full catalogue means committing every printing to the repo
(GitHub Pages allows 1 GB), and it goes stale when a set drops. Against that: it removes all load
from Palify permanently, which the proxy only reduces.

The URL-paste path cannot be done statically under any arrangement — it is per-user dynamic data
behind an undocumented payload format. That needs the Worker.

A reasonable order: ship file upload first, add the Worker for URL convenience second.
