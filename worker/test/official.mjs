// /official/ - the opt-in official-site art route - with a stubbed upstream; no
// network. The point of most of these is what /official/ does NOT change: every
// way the official copy can be unusable must end in exactly what /img/ serves.
const keys = [];
globalThis.caches = { default: {
  match: async (k) => { keys.push(String(k.url ?? k)); return null; },
  put: async () => {},
} };

/** A minimal but real PNG signature + IHDR, so pngSize has a header to read. */
function png(w, h) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);
  b.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12);
  dv.setUint32(16, w); dv.setUint32(20, h);
  return b;
}
/** Same for WebP, so the Palify fallback's own landscape check still has bytes. */
function webp(w, h) {
  const b = new Uint8Array(40);
  const put = (o, s) => b.set([...s].map((c) => c.charCodeAt(0)), o);
  put(0, 'RIFF'); put(8, 'WEBP'); put(12, 'VP8 ');
  const dv = new DataView(b.buffer);
  dv.setUint32(4, 32, true); dv.setUint32(16, 20, true);
  b.set([0x9d, 0x01, 0x2a], 23);
  dv.setUint16(26, w, true); dv.setUint16(28, h, true);
  return b;
}

// What the stubbed official site does, per case.
let official = 'portrait';   // portrait | landscape | 404 | 503 | html | throw
let palifyLandscape = false;
let fetched = [];
globalThis.fetch = async (u) => {
  u = String(u);
  fetched.push(u);
  if (u.startsWith('https://en.palworld-official-cardgame.com/')) {
    if (official === 'throw') throw new TypeError('network down');
    if (official === '404') return new Response('not found', { status: 404 });
    if (official === '503') return new Response('busy', { status: 503 });
    if (official === 'html') return new Response('<!doctype html><title>oops</title>', { status: 200 });
    return new Response(official === 'landscape' ? png(1800, 1287) : png(1287, 1800), { status: 200 });
  }
  if (u.includes('/assets/rot/')) return new Response(webp(732, 1024), { status: 200 });
  if (u.includes('palify.org/cards/w')) return new Response(palifyLandscape ? webp(1024, 732) : webp(732, 1024), { status: 200 });
  return new Response('nope', { status: 404 });
};

const { default: worker } = await import('../src/index.js');
const { pngSize } = await import('../src/png.js');
const { officialUrl } = await import('../src/official.js');
const { RECORD_WIDTH, IN_WORLD_WIDTH } = await import('../src/roll.js');
const { webpSize } = await import('../src/webp.js');

const ctx = { waitUntil: () => {} };
const ORIGIN = 'https://resopal.dalek.coffee';
const get = (path) => { fetched = []; return worker.fetch(new Request('https://w.example' + path, { headers: { Origin: ORIGIN } }), {}, ctx); };
let bad = 0;
const check = (name, ok, detail = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? '  ' + detail : ''}`); };
const bytes = async (r) => new Uint8Array(await r.clone().arrayBuffer());

console.log('png header:');
check('reads a portrait IHDR', JSON.stringify(pngSize(png(1287, 1800))) === '{"width":1287,"height":1800}');
check('reads a landscape IHDR', JSON.stringify(pngSize(png(1800, 1287))) === '{"width":1800,"height":1287}');
check('a WebP is not a PNG', pngSize(webp(732, 1024)) === null);
check('HTML is not a PNG', pngSize(new TextEncoder().encode('<!doctype html><html><body>404</body></html>')) === null);
check('a truncated header is not a PNG', pngSize(png(10, 10).slice(0, 20)) === null);
check('zero dimensions are not a PNG', pngSize(png(0, 10)) === null);

console.log('\nfilename mapping:');
const BASE = 'https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist';
check('TD02-002 -> ETD02/ETD02-002.png', officialUrl('TD02-002') === `${BASE}/ETD02/ETD02-002.png`);
check('BP01-025SSP -> EBP01/EBP01-025SSP.png', officialUrl('BP01-025SSP') === `${BASE}/EBP01/EBP01-025SSP.png`);
check('SS01-001 -> ESS01/ESS01-001.png', officialUrl('SS01-001') === `${BASE}/ESS01/ESS01-001.png`);

console.log('\n/official/ serves the official PNG when it can:');
official = 'portrait';
let r = await get('/official/TD02-002?w=512');
check('200', r.status === 200, String(r.status));
check('fetched from the official site', fetched[0] === `${BASE}/ETD02/ETD02-002.png`, fetched.join(' '));
check('and never touched palify', !fetched.some((u) => u.includes('palify.org')), fetched.join(' '));
check('served as image/png', r.headers.get('content-type') === 'image/png', r.headers.get('content-type'));
check('labelled official', r.headers.get('x-art-source') === 'official');
check('cached forever', /immutable/.test(r.headers.get('cache-control')));
check('CORS for the site', r.headers.get('access-control-allow-origin') === ORIGIN);
check('the bytes are the official PNG, untouched', pngSize(await bytes(r))?.width === 1287);
check('its edge cache key is its own namespace, not /img/',
  /^https:\/\/resopal-cache\.invalid\/official\/v\d+\/TD02-002$/.test(keys.at(-1)), keys.at(-1));
r = await get('/official/td02-002.png');
check('lowercase and a .png suffix normalise like /img/ does', fetched[0] === `${BASE}/ETD02/ETD02-002.png`, fetched.join(' '));
r = await get('/official/TD02-002.webp');
check('and so does a .webp suffix', fetched[0] === `${BASE}/ETD02/ETD02-002.png`, fetched.join(' '));

console.log('\n/official/ validates exactly like /img/:');
check('a bad code is 400', (await get('/official/EVIL$CODE')).status === 400);
check('a traversal is 400', (await get('/official/..%2F..%2Fetc%2Fpasswd')).status === 400);
check('a bad width is 400', (await get('/official/TD02-002?w=9999')).status === 400);
check('and neither reached any upstream', (await get('/official/EVIL$CODE'), fetched.length === 0));

console.log('\nevery unusable official copy falls back to exactly what /img/ serves:');
for (const [mode, why, transient] of [['404', 'official 404', false], ['503', 'official 503', true],
  ['throw', 'fetch failed', true], ['html', 'official copy is not a PNG', false]]) {
  official = mode;
  r = await get('/official/TD02-002?w=512');
  const got = webpSize(await bytes(r));
  check(`${mode}: still 200`, r.status === 200, String(r.status));
  check(`${mode}: palify's w512 copy`, fetched.includes('https://palify.org/cards/w512/TD02-002.webp') && got?.width === 732,
    fetched.join(' '));
  check(`${mode}: labelled palify, with the reason`,
    r.headers.get('x-art-source') === 'palify' && r.headers.get('x-art-fallback') === why,
    `${r.headers.get('x-art-source')} / ${r.headers.get('x-art-fallback')}`);
  check(`${mode}: ${transient ? 'NOT cached forever - the official copy may come back' : 'cached like /img/'}`,
    transient ? !/immutable/.test(r.headers.get('cache-control')) : /immutable/.test(r.headers.get('cache-control')),
    r.headers.get('cache-control'));
  check(`${mode}: CORS for the site`, r.headers.get('access-control-allow-origin') === ORIGIN);
}

// A landscape official PNG cannot be turned anywhere (no rotated official copies
// exist, and Resonite cannot rotate a texture), so it takes the Palify path -
// which for a landscape Palify card means the pre-turned copy.
official = 'landscape'; palifyLandscape = true;
r = await get('/official/TD01-008?w=512');
check('landscape official -> palify path', r.headers.get('x-art-fallback') === 'landscape', r.headers.get('x-art-fallback'));
check('and gets the pre-turned PORTRAIT copy',
  fetched.includes('https://resopal.dalek.coffee/assets/rot/w512/TD01-008.webp') && webpSize(await bytes(r))?.height === 1024,
  fetched.join(' '));
palifyLandscape = false;

console.log('\n/img/ is untouched:');
official = 'portrait';
r = await get('/img/TD02-002?w=512');
check('/img/ still fetches palify', fetched[0] === 'https://palify.org/cards/w512/TD02-002.webp', fetched.join(' '));
check('and never the official site', !fetched.some((u) => u.includes('palworld-official-cardgame')), fetched.join(' '));
check('/img/ still webp', r.headers.get('content-type') === 'image/webp');
check('/img/ cache key unchanged', keys.at(-1) === 'https://resopal-cache.invalid/img/v2/512/TD02-002', keys.at(-1));
check('/img/ carries no x-art-source', r.headers.get('x-art-source') === null);

console.log('\nfits the fixed-width record, if a caller is ever switched over:');
// The panel decodes art URLs at RECORD_WIDTH and that width is baked into every
// panel already spawned - an /official/ URL that does not fit cannot be used.
const pools = await Promise.all(['bp01', 'td01', 'td02'].map(async (s) =>
  JSON.parse(await (await import('node:fs/promises')).readFile(new URL(`../../data/pool-${s}.json`, import.meta.url), 'utf8'))));
const codes = JSON.stringify(pools).match(/[A-Z]{2}\d{2}-\d{3}[A-Z]*(?:-ERR)?/g);
const longest = codes.reduce((a, b) => (b.length > a.length ? b : a));
const url = `https://resopal-proxy.dalek.workers.dev/official/${longest}?w=${IN_WORLD_WIDTH}&v=99`;
check(`longest pool code (${longest}) fits: ${url.length} <= ${RECORD_WIDTH - 1}`, url.length <= RECORD_WIDTH - 1);

console.log(bad ? `\n${bad} FAILURES` : '\nall /official/ cases pass');
if (bad) process.exitCode = 1;
