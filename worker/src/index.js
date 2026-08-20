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
 *
 * It also owns /api/pull - the booster roll. That one IS compute, but it is a
 * few hundred bytes of arithmetic, and it has to live somewhere neither the
 * player's devtools nor the in-world tool can reach.
 */
import { weights, poolBP01, decks } from './data.js';
import { rollPacks, toFlat, toFixed, newSeed, RECORD_WIDTH } from './roll.js';

// Sets that can be rolled. Adding BP02 is: snapshot its pool with
// tools/fetch-pool.mjs, add its weights to data/pack-weights.json, add a line here.
const POOLS = { BP01: poolBP01 };

// Fixed-format records carry whole URLs, so the Worker decides where art comes
// from. The in-world tool then needs one address, not two.
const artBase = (url) => `${url.origin}/img/`;

const ALLOWED = [
  'https://resopal.dalek.coffee',
  'http://localhost:8000', 'http://127.0.0.1:8000',   // local dev
];

// Whitelist both, or this is an open proxy for the entire internet.
const CODE = /^[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}$/;
const WIDTHS = new Set(['256', '512', '1024']);
const HANDLE = /^[A-Za-z0-9_.-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SET = /^[A-Z][A-Z0-9]{1,5}$/;
const SEED = /^[A-Za-z0-9_.:-]{1,64}$/;

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
 * Per-IP throttle.
 *
 * Honest about what it is: this counts inside ONE isolate, and Cloudflare runs
 * many. It slows a lazy loop from a single client; it is not a guarantee, and a
 * determined spammer spread across colos walks straight past it. That is an
 * acceptable trade for a fan tool with nothing behind it worth stealing - the
 * roll is stateless, and a re-roll costs the player nothing but their own time.
 * The real fix, if abuse ever shows up, is Cloudflare's Rate Limiting binding or
 * a Durable Object; both need account config this Worker deliberately avoids.
 */
const BUCKET = new Map();
const RATE = { burst: 30, perMinute: 30 };
function throttled(ip) {
  const now = Date.now();
  const b = BUCKET.get(ip) || { tokens: RATE.burst, at: now };
  b.tokens = Math.min(RATE.burst, b.tokens + ((now - b.at) / 60000) * RATE.perMinute);
  b.at = now;
  if (BUCKET.size > 5000) BUCKET.clear();      // isolates are short-lived; never let this grow
  if (b.tokens < 1) { BUCKET.set(ip, b); return true; }
  b.tokens -= 1;
  BUCKET.set(ip, b);
  return false;
}

/**
 * GET /api/pull - roll booster packs. See docs/PULL-API.md.
 *
 * Two formats because there are two very different callers. `json` is for the
 * website. `flat` is `code,rarity` one per line, for ProtoFlux, which has no
 * JSON parser and takes strings apart one IndexOfString at a time - that format
 * is not a convenience, it is the only pleasant option in-world.
 *
 * Cards come back RAREST FIRST within each pack. The deck bake lays the atlas
 * out in list order, so list order is stack order: rarest on top, commons at the
 * bottom. Flipped over in-world that reads bottom-up - commons first, hit last.
 */
function pull(request, url, h) {
  const q = url.searchParams;
  const setCode = (q.get('set') || 'BP01').toUpperCase();
  const format = q.get('format') || 'json';
  const packsRaw = q.get('packs') || '1';
  const seedRaw = q.get('seed');

  if (!SET.test(setCode) || !POOLS[setCode]) return fail(404, `no pool for set ${setCode}`, h);
  if (!['json', 'flat', 'fixed'].includes(format)) return fail(400, 'format must be json, flat or fixed', h);
  if (!/^\d{1,2}$/.test(packsRaw)) return fail(400, 'packs must be a number', h);
  const packs = Number(packsRaw);
  if (packs < 1 || packs > 12) return fail(400, 'packs must be 1-12', h);
  if (seedRaw !== null && !SEED.test(seedRaw)) return fail(400, 'bad seed', h);

  const ip = request.headers.get('CF-Connecting-IP') || 'anon';
  if (throttled(ip)) return fail(429, 'slow down', { ...h, 'retry-after': '60' });

  // A pinned seed is a pure function of its inputs, so it can be cached hard;
  // an unpinned one must never be, or two players share a "random" pack.
  const seed = seedRaw ?? newSeed();
  const cacheControl = seedRaw !== null
    ? 'public, max-age=31536000, immutable'
    : 'no-store';

  let rolled;
  try {
    rolled = rollPacks({ pool: POOLS[setCode], weights, setCode, packs, seed });
  } catch (e) {
    return fail(500, String(e.message || e), h);
  }

  if (format === 'flat' || format === 'fixed') {
    let body;
    try { body = format === 'flat' ? toFlat(rolled.pulls) : toFixed(rolled.pulls, artBase(url)); }
    catch (e) { return fail(500, String(e.message || e), h); }
    return new Response(body, {
      headers: { ...h, 'content-type': 'text/plain; charset=utf-8', 'cache-control': cacheControl,
        'x-record-width': String(RECORD_WIDTH) },
    });
  }

  const body = {
    set: setCode,
    setName: weights.sets[setCode]?.name ?? null,
    packs,
    seed,
    generated: new Date().toISOString(),
    pulls: rolled.pulls,
    best: rolled.best,
  };
  // Only present when the weights ask for a rarity the pool cannot supply. It is
  // in the response rather than swallowed because silently substituting another
  // rarity would change the odds without anyone noticing.
  if (rolled.unavailable.length) body.unavailable = rolled.unavailable;

  return new Response(JSON.stringify(body), {
    headers: { ...h, 'content-type': 'application/json', 'cache-control': cacheControl },
  });
}

/**
 * GET /api/deck - a committed deck list, in the same shape as a pull.
 *
 * The in-world panel carries no deck of its own; it asks for one. Serving decks
 * in the SAME `code,rarity` flat format as /api/pull means the ProtoFlux side has
 * one parser instead of two, and a deck and a booster differ only in how many
 * lines come back.
 *
 * Quantities are expanded: a 4-of appears as four lines, because the panel spawns
 * one card per line and a physical deck has four of that card.
 */
function deck(request, url, h) {
  const id = (url.searchParams.get('deck') || '').toLowerCase();
  const format = url.searchParams.get('format') || 'json';

  if (!['json', 'flat', 'fixed'].includes(format)) return fail(400, 'format must be json, flat or fixed', h);
  if (id === '') {
    // No id: list what there is, so the panel can populate itself rather than
    // hardcoding which decks exist.
    const list = Object.values(decks.decks).map((d) => ({ id: d.id, set: d.set, name: d.name, total: d.total }));
    return new Response(
      format === 'flat' ? list.map((d) => `${d.id},${d.set},${d.total},${d.name}`).join('\n') + '\n' : JSON.stringify({ decks: list }),
      { headers: { ...h, 'content-type': format === 'flat' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'public, max-age=3600' } });
  }
  if (!/^[a-z0-9-]{1,32}$/.test(id) || !decks.decks[id]) return fail(404, `no deck ${id}`, h);

  const d = decks.decks[id];
  const cards = d.cards.flatMap((c) => Array.from({ length: c.n }, () => ({ code: c.code, base: c.code, rarity: c.rarity })));
  const headers = { ...h, 'cache-control': 'public, max-age=3600' };

  if (format === 'flat' || format === 'fixed') {
    let body;
    try { body = format === 'flat' ? toFlat(cards) : toFixed(cards, artBase(url)); }
    catch (e) { return fail(500, String(e.message || e), h); }
    return new Response(body, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8', 'x-record-width': String(RECORD_WIDTH) } });
  }
  return new Response(JSON.stringify({ deck: d.id, set: d.set, name: d.name, total: d.total, cards }),
    { headers: { ...headers, 'content-type': 'application/json' } });
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

    if (p === '/api/pull') return pull(request, url, h);
    if (p === '/api/deck') return deck(request, url, h);

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
