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
import { sniff, parseFlight, parseDeckList, expand, MAX_CARDS } from './resolve.js';

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
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
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
 * Palify's card catalogue for one set, code -> { name, rarity, landscape }.
 *
 * Fetched rather than committed, because `data/pool-*.json` only covers the sets
 * ResoPal rolls and a pasted deck can name any of them. Cached at the edge for a
 * day and memoised per isolate, so a 50-card deck costs one upstream request.
 *
 * This is what makes "never invent card data" enforceable at runtime: a code the
 * catalogue does not know is reported, not served.
 */
const CATALOGUE = new Map();
async function catalogue(setCode, ctx) {
  if (CATALOGUE.has(setCode)) return CATALOGUE.get(setCode);
  const cache = caches.default;
  const key = new Request(`https://resopal-cache.invalid/cards/${setCode}`);
  let hit = await cache.match(key);
  if (!hit) {
    const upstream = await fetch(`${UPSTREAM}/api/cards?set=${encodeURIComponent(setCode)}`, {
      cf: { cacheEverything: true, cacheTtl: 86400 },
      headers: { 'user-agent': 'ResoPal/1.0 (+https://resopal.dalek.coffee)' },
    });
    if (!upstream.ok) return null;
    hit = new Response(await upstream.text(), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' },
    });
    ctx.waitUntil(cache.put(key, hit.clone()));
  }
  let json;
  try { json = await hit.json(); } catch { return null; }
  const map = new Map();
  for (const c of json?.cards || [])
    if (typeof c?.code === 'string')
      map.set(c.code, { name: c.name ?? null, rarity: c.rarity ?? null, landscape: !!c.landscape });
  CATALOGUE.set(setCode, map);
  return map;
}

/**
 * GET|POST /api/resolve - "here is what I pasted, give me a deck".
 *
 * The input is a Palify deck link, a bare deck id, or a pasted decklist, and the
 * caller does not have to say which - `sniff()` decides. Output is the same
 * records `/api/pull` and `/api/deck` already serve, so the in-world side keeps
 * one parser and a booster, a committed deck and someone's own brew all arrive
 * looking identical.
 *
 * POST exists because ProtoFlux cannot put a 2 KB decklist in a query string.
 * GET exists because the site can, and because `?deck=<uuid>` is cacheable.
 *
 * Every code is checked against Palify's catalogue before it is served. Codes it
 * does not recognise come back under `unknown` and lines with no code at all
 * under `unrecognised`; neither is guessed at. Two phantom cards have already
 * reached production here from a decklist nobody verified.
 */
async function resolve(request, url, h, ctx, input) {
  const format = url.searchParams.get('format') || 'json';
  if (!['json', 'flat', 'fixed'].includes(format)) return fail(400, 'format must be json, flat or fixed', h);
  const text = String(input || '').slice(0, 64 * 1024);
  if (!text.trim()) return fail(400, 'nothing to resolve: pass a palify deck link, a deck id, or a decklist', h);

  const ip = request.headers.get('CF-Connecting-IP') || 'anon';
  if (throttled(ip)) return fail(429, 'slow down', { ...h, 'retry-after': '60' });

  const what = sniff(text);
  let parsed, source;
  if (what.kind === 'palify') {
    const upstream = await fetch(`${UPSTREAM}/decks/${what.id}`, {
      headers: { 'RSC': '1', 'accept': 'text/x-component', 'user-agent': 'ResoPal/1.0 (+https://resopal.dalek.coffee)' },
    });
    if (!upstream.ok) return fail(upstream.status === 404 ? 404 : 502, `palify returned ${upstream.status} for deck ${what.id}`, h);
    parsed = parseFlight(await upstream.text());
    source = { kind: 'palify', id: what.id, url: `${UPSTREAM}/decks/${what.id}` };
    // An empty list here means Palify changed its payload, not that the deck is
    // empty. Say which, because the fix is a one-line change in resolve.js.
    if (!parsed.entries.length)
      return fail(502, 'palify returned a deck page this parser could not read - the page format has changed', h);
  } else {
    parsed = parseDeckList(text);
    source = { kind: 'list' };
  }

  // Validate against the real catalogue, one fetch per set named in the list.
  const sets = [...new Set(parsed.entries.map((e) => e.code.split('-')[0]))].filter((x) => SET.test(x));
  if (sets.length > 6) return fail(400, 'that list names too many sets to be a deck', h);
  const found = new Map();
  for (const set of sets) {
    const cat = await catalogue(set, ctx);
    if (cat) for (const [code, card] of cat) found.set(code, card);
  }

  const unknown = [];
  const good = [];
  for (const e of parsed.entries) {
    const card = found.get(e.code);
    if (!card) { unknown.push(e.code); continue; }
    good.push({ ...e, name: card.name ?? e.name, rarity: card.rarity, landscape: card.landscape });
  }
  if (!good.length)
    return fail(422, unknown.length
      ? `none of those ${unknown.length} card codes exist in palify's catalogue`
      : 'no card codes found - a line only counts if it carries one, like [TD02-001]', h);

  const { cards, truncated } = expand(good);
  for (const c of cards) c.rarity = good.find((g) => g.code === c.code)?.rarity ?? 'C';

  const headers = { ...h, 'cache-control': what.kind === 'palify' ? 'public, max-age=300' : 'no-store' };
  if (format === 'flat' || format === 'fixed') {
    let body;
    try { body = format === 'flat' ? toFlat(cards) : toFixed(cards, artBase(url)); }
    catch (e) { return fail(500, String(e.message || e), h); }
    return new Response(body, {
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8',
        'x-record-width': String(RECORD_WIDTH), 'x-card-count': String(cards.length) },
    });
  }

  const body = { source, name: parsed.name, total: cards.length, cards };
  if (unknown.length) body.unknown = unknown;
  if (parsed.unrecognised.length) body.unrecognised = parsed.unrecognised;
  if (truncated) body.truncated = MAX_CARDS;
  return new Response(JSON.stringify(body), { headers: { ...headers, 'content-type': 'application/json' } });
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
    // POST exists for exactly one route. ProtoFlux has POST_String and no way to
    // put a 2 KB decklist in a query string, so a pasted list arrives as a body.
    if (request.method === 'POST') {
      const path = new URL(request.url).pathname.replace(/\/+$/, '');
      if (path !== '/api/resolve') return fail(405, 'POST is only accepted at /api/resolve', h);
      return resolve(request, new URL(request.url), h, ctx, await request.text());
    }
    if (request.method !== 'GET') return fail(405, 'GET or POST', h);

    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/' || p === '/health')
      return new Response(JSON.stringify({ ok: true, service: 'resopal-proxy' }), {
        headers: { ...h, 'content-type': 'application/json' },
      });

    if (p === '/api/pull') return pull(request, url, h);
    if (p === '/api/deck') return deck(request, url, h);
    if (p === '/api/resolve') return resolve(request, url, h, ctx, url.searchParams.get('deck') || url.searchParams.get('url') || url.searchParams.get('list') || '');

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
