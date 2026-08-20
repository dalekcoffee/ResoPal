/**
 * ResoPal image + data proxy.
 *
 * Exists for one reason: Palify sends no CORS headers. A browser can display a
 * cross-origin image but not read its pixels, and baking a card atlas is exactly
 * pixel reading - see docs/WORKER.md. This Worker re-serves the same bytes with
 * the headers that make them readable.
 *
 * It deliberately does NOT bake anything. An 8192x8192 RGBA bitmap is 256 MiB
 * against a Worker's 128 MB ceiling; the bake stays in the browser.
 */

const ALLOWED = [
  'https://resopal.dalek.coffee',
  'http://localhost:8000', 'http://127.0.0.1:8000',   // local dev
];

// Whitelist both, or this is an open proxy for the entire internet.
const CODE = /^[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}$/;
const WIDTHS = new Set(['256', '512', '1024']);
const HANDLE = /^[A-Za-z0-9_.-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UPSTREAM = 'https://palify.org';

function cors(request) {
  const origin = request.headers.get('Origin');
  return {
    'access-control-allow-origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

const fail = (status, msg, h) => new Response(JSON.stringify({ error: msg }), {
  status, headers: { ...h, 'content-type': 'application/json' },
});

/** Card art. Immutable upstream, so cache it at the edge effectively forever. */
async function image(request, ctx, code, width, h) {
  if (!CODE.test(code)) return fail(400, 'bad card code', h);
  if (!WIDTHS.has(width)) return fail(400, 'width must be 256, 512 or 1024', h);

  const cache = caches.default;
  const key = new Request(`https://resopal-cache.invalid/img/${width}/${code}`, { method: 'GET' });
  let hit = await cache.match(key);

  if (!hit) {
    const upstream = await fetch(`${UPSTREAM}/cards/w${width}/${code}.webp`, {
      cf: { cacheEverything: true, cacheTtl: 31536000 },
    });
    if (!upstream.ok) return fail(upstream.status === 404 ? 404 : 502, `upstream ${upstream.status} for ${code}`, h);
    hit = new Response(upstream.body, {
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
    // the first user to import a card pays for it; everyone after is served here
    ctx.waitUntil(cache.put(key, hit.clone()));
  }

  return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...h } });
}

/**
 * Palify deck and profile pages are Next.js routes, not an API. The only
 * machine-readable form is the RSC flight payload, requested with `RSC: 1`.
 *
 * This returns that payload as-is. The parser belongs here rather than in the
 * browser - the format is undocumented and will change without warning, and when
 * it does you want to fix one Worker, not ship a new front end - but it has to be
 * written against a real response first. Fetch this route once and build from what
 * it actually returns.
 */
async function flight(path, h, maxAge) {
  const upstream = await fetch(`${UPSTREAM}${path}`, {
    headers: { 'RSC': '1', 'accept': 'text/x-component', 'user-agent': 'ResoPal/1.0 (+https://resopal.dalek.coffee)' },
  });
  if (!upstream.ok) return fail(upstream.status === 404 ? 404 : 502, `upstream ${upstream.status} for ${path}`, h);
  return new Response(upstream.body, {
    headers: { ...h, 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
  });
}

export default {
  async fetch(request, env, ctx) {
    const h = cors(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: h });
    if (request.method !== 'GET') return fail(405, 'GET only', h);

    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/' || p === '/health')
      return new Response(JSON.stringify({ ok: true, service: 'resopal-proxy' }), {
        headers: { ...h, 'content-type': 'application/json' },
      });

    let m;
    if ((m = p.match(/^\/img\/([^/]+)$/)))
      return image(request, ctx, decodeURIComponent(m[1]).replace(/\.webp$/i, '').toUpperCase(),
        url.searchParams.get('w') || '1024', h);

    if ((m = p.match(/^\/deck\/([^/]+)$/))) {
      if (!UUID.test(m[1])) return fail(400, 'bad deck id', h);
      return flight(`/decks/${m[1]}`, h, 300);            // decks get edited
    }

    if ((m = p.match(/^\/profile\/([^/]+)$/))) {
      if (!HANDLE.test(m[1])) return fail(400, 'bad handle', h);
      return flight(`/u/${m[1]}`, h, 300);
    }

    return fail(404, 'no such route', h);
  },
};
