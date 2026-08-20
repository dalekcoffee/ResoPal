// Exercise routing + validation with a stubbed upstream; no network involved.
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const realFetch = globalThis.fetch;
let lastUpstream = null;
globalThis.fetch = async (u, init) => {
  lastUpstream = { url: String(u), headers: (init && init.headers) || {} };
  if (String(u).includes('/cards/w')) return new Response(new Uint8Array([1,2,3]), { status: 200 });
  if (String(u).includes('/decks/') || String(u).includes('/u/')) return new Response('flight-payload', { status: 200 });
  return new Response('nope', { status: 404 });
};
const { default: worker } = await import('../src/index.js');
const ctx = { waitUntil: () => {} };
const ORIGIN = 'https://resopal.dalek.coffee';

const cases = [
  ['/health', 200, null],
  ['/img/TD01-001', 200, 'https://palify.org/cards/w1024/TD01-001.webp'],
  ['/img/td01-001.webp', 200, 'https://palify.org/cards/w1024/TD01-001.webp'],
  ['/img/BP01-001SSP?w=512', 200, 'https://palify.org/cards/w512/BP01-001SSP.webp'],
  ['/img/TD01-001?w=9999', 400, null],
  ['/img/..%2F..%2Fetc%2Fpasswd', 400, null],
  ['/img/EVIL$CODE', 400, null],
  ['/deck/f2dd143c-8e6f-4142-87d2-051195185f96', 200, 'https://palify.org/decks/f2dd143c-8e6f-4142-87d2-051195185f96'],
  ['/deck/not-a-uuid', 400, null],
  ['/profile/dalek', 200, 'https://palify.org/u/dalek'],
  ['/profile/../../etc', 404, null],   // URL() normalises the traversal away before routing
  ['/nope', 404, null],
];
let bad = 0;
for (const [path, want, upstream] of cases) {
  lastUpstream = null;
  const res = await worker.fetch(new Request('https://w.example' + path, { headers: { Origin: ORIGIN } }), {}, ctx);
  const okStatus = res.status === want;
  const okUp = upstream === null || (lastUpstream && lastUpstream.url === upstream);
  const okCors = res.headers.get('access-control-allow-origin') === ORIGIN;
  if (!okStatus || !okUp || !okCors) bad++;
  console.log(`  ${okStatus && okUp && okCors ? 'ok  ' : 'FAIL'} ${String(res.status).padEnd(4)} ${path}`);
  if (!okUp) console.log(`        expected upstream ${upstream}, got ${lastUpstream && lastUpstream.url}`);
  if (!okCors) console.log(`        CORS header was ${res.headers.get('access-control-allow-origin')}`);
}
// RSC header must actually be sent, or Palify returns HTML
await worker.fetch(new Request('https://w.example/deck/f2dd143c-8e6f-4142-87d2-051195185f96'), {}, ctx);
console.log('  RSC header sent:', lastUpstream.headers.RSC === '1' ? 'yes' : 'NO  <-- broken');
// unknown origin must not be echoed back
const r = await worker.fetch(new Request('https://w.example/health', { headers: { Origin: 'https://evil.example' } }), {}, ctx);
console.log('  unknown origin ->', r.headers.get('access-control-allow-origin'), r.headers.get('access-control-allow-origin') === ORIGIN ? '(not echoed, good)' : '(ECHOED - bad)');
console.log(bad ? `\n${bad} FAILURES` : '\nall routing cases pass');
globalThis.fetch = realFetch;
