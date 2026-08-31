// Exercise routing + validation with a stubbed upstream; no network involved.
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const realFetch = globalThis.fetch;
// Trimmed from real RSC payloads captured from palify.org - the surrounding React
// element soup is what the parser has to survive, so keep some of it.
const DECK_FLIGHT = '1:"$Sreact.fragment"\n1a:["$","h1",null,{"className":"font-display","children":"Meow"}]\n'
  + '1b:["$","$L1c",null,{"name":"Meow","cards":{"bp01-053-elizabee":1},"deckId":"66cdf5a2-aa5d-48e6-8bb7-7a3249bfccfc",'
  + '"list":[{"n":1,"name":"Elizabee \u2013 Queen of the Flower Garden","code":"BP01-053"},'
  + '{"n":2,"name":"Katress \u2013 Abyssal Sorcerer","code":"BP01-075"}]}]\n'
  + '1d:["$","$L1e",null,{"deckId":"66cdf5a2","deckName":"Meow","creator":"DalekCoffee"}]\n'
  + '1f:["$","$L20",null,{"stats":{"total":3,"avgCost":5.5}}]\n';
const PROFILE_FLIGHT = '1:"$Sreact.fragment"\n'
  + '11:["$","$L19",null,{"linkPath":"/u/dalek","input":{"kind":"profile","title":"DalekCoffee","handle":"dalek"}}]\n'
  + '1c:["$","h2",null,{"children":"Public decks"}]\n'
  + '1d:["$","div",null,{"children":[["$","$L1f","66cdf5a2-aa5d-48e6-8bb7-7a3249bfccfc",{"href":"/decks/66cdf5a2-aa5d-48e6-8bb7-7a3249bfccfc","className":"rounded-xl",'
  + '"children":[["$","div",null,{"className":"font-display","children":"Meow"}],["$","div",null,{"className":"text-xs","children":[3," cards"]}],'
  + '["$","div",null,{"className":"flex","children":[["$","div","Purple",{"style":{"width":"66.7%","background":"var(--color-el-purple)"}}],["$","div","Green",{"style":{"width":"33.3%"}}]]}]]}],'
  + '["$","$L1f","f2dd143c-8e6f-4142-87d2-051195185f96",{"href":"/decks/f2dd143c-8e6f-4142-87d2-051195185f96","className":"rounded-xl",'
  + '"children":[["$","div",null,{"className":"font-display","children":"Green/Purple Trial"}],["$","div",null,{"className":"text-xs","children":[50," cards"]}]]}]]}]\n';
let lastUpstream = null;
let rotatedExists = false;   // flipped per-case by the landscape suite
// Shaped like the real thing, trimmed to what the code reads. The parsers get
// their own fixtures in resolve.mjs; these exist so the ROUTE can be exercised.
const FLIGHT = '1b:{"deckId":"f2dd143c-8e6f-4142-87d2-051195185f96","deckName":"Green/Purple Trial",'
  + '"list":[{"n":2,"name":"Mossanda","code":"TD02-001"},{"n":3,"name":"Eikthyrdeer Terra","code":"TD02-005"}]}';
const CARDS = JSON.stringify({ count: 2, cards: [
  { code: 'TD02-001', name: 'Mossanda – Guard Captain', rarity: 'TD', landscape: false },
  { code: 'TD02-005', name: 'Eikthyrdeer Terra – Guardian of Nature', rarity: 'TD', landscape: false },
] });
globalThis.fetch = async (u, init) => {
  lastUpstream = { url: String(u), headers: (init && init.headers) || {} };
  if (String(u).includes('/assets/rot/'))
    return rotatedExists ? new Response(new Uint8Array([9,9,9]), { status: 200 })
                         : new Response('not generated yet', { status: 404 });
  if (String(u).includes('/assets/DefaultBack.png')) return new Response(new Uint8Array([7,7]), { status: 200 });
  if (String(u).includes('/cards/w')) return new Response(new Uint8Array([1,2,3]), { status: 200 });
  if (String(u).includes('/api/cards?set=TD02')) return new Response(CARDS, { status: 200 });
  if (String(u).includes('/api/cards?set=')) return new Response(JSON.stringify({ count: 0, cards: [] }), { status: 200 });
  // Two deck fixtures, because two things read them: the flight parser wants the
  // real React soup (DECK_FLIGHT), and /api/resolve's tests want a deck whose
  // cards exist in the TD02 catalogue stub above. Dispatch by deck id so both
  // suites get the one they were written against.
  if (String(u).includes('/decks/f2dd143c')) return new Response(FLIGHT, { status: 200 });
  if (String(u).includes('/decks/')) return new Response(DECK_FLIGHT, { status: 200 });
  if (String(u).includes('/u/')) return new Response(PROFILE_FLIGHT, { status: 200 });
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
  ['/api/pull', 200, null],
  ['/api/pull?format=flat', 200, null],
  ['/api/pull?packs=12', 200, null],
  ['/api/pull?packs=0', 400, null],
  ['/api/pull?packs=13', 400, null],
  ['/api/pull?packs=abc', 400, null],
  ['/api/pull?format=xml', 400, null],
  ['/api/pull?set=BP99', 404, null],
  ['/api/pull?seed=bad%20seed', 400, null],
  ['/api/pull?format=fixed', 200, null],
  ['/api/deck?deck=td02&format=fixed', 200, null],
  ['/api/deck', 200, null],
  ['/api/deck?deck=td02&format=flat', 200, null],
  ['/api/deck?deck=nope', 404, null],
  ['/api/deck?deck=td02&format=xml', 400, null],
  ['/deck/f2dd143c-8e6f-4142-87d2-051195185f96', 200, 'https://palify.org/decks/f2dd143c-8e6f-4142-87d2-051195185f96'],
  ['/deck/not-a-uuid', 400, null],
  ['/profile/dalek', 200, 'https://palify.org/u/dalek'],
  ['/profile/../../etc', 404, null],   // URL() normalises the traversal away before routing
  ['/api/resolve', 400, null],                                   // nothing to resolve
  ['/api/resolve?list=2x%20TD02-001', 200, null],
  ['/api/resolve?list=2x%20TD02-001&format=fixed', 200, null],
  ['/api/resolve?list=2x%20TD02-001&format=xml', 400, null],
  ['/api/resolve?list=Mossanda%0AGumoss', 422, null],            // names, no codes
  ['/api/resolve?list=2x%20ZZ99-001', 422, null],                // code palify does not know
  ['/api/resolve?deck=f2dd143c-8e6f-4142-87d2-051195185f96', 200,
    'https://palify.org/decks/f2dd143c-8e6f-4142-87d2-051195185f96'],
  ['/api/resolve?url=https%3A%2F%2Fpalify.org%2Fdecks%2Ff2dd143c-8e6f-4142-87d2-051195185f96', 200, null],
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

// ── /api/pull contract ────────────────────────────────────────────────────────
// The endpoint is the only roll there is, so the properties the deck bake and the
// in-world spawner rely on get asserted here rather than assumed.
const { default: weights } = await import('../../data/pack-weights.json', { with: { type: 'json' } });
const RANK = weights.rank;
const get = (path) => worker.fetch(new Request('https://w.example' + path, { headers: { Origin: ORIGIN } }), {}, ctx);
const check = (name, ok, detail = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? '  ' + detail : ''}`); };

console.log('\n/api/pull:');
const one = await (await get('/api/pull')).json();
check('7 cards in a pack', one.pulls.length === 7, `got ${one.pulls.length}`);
check('slots are 4C + 2U + 1 HIT',
  JSON.stringify(one.pulls.reduce((a, p) => (a[p.slot] = (a[p.slot] || 0) + 1, a), {})) === '{"HIT":1,"U":2,"C":4}');
check('sorted rarest first',
  one.pulls.every((p, i) => i === 0 || RANK.indexOf(p.rarity) >= RANK.indexOf(one.pulls[i - 1].rarity)),
  one.pulls.map((p) => p.rarity).join(' '));
check('set is labelled BP01', one.set === 'BP01' && one.setName === 'Dawn of Palpagos');
check('reports a seed', typeof one.seed === 'string' && one.seed.length > 0);
check('no unavailable rarities for BP01', one.unavailable === undefined, JSON.stringify(one.unavailable));

const pool = (await import('../../data/pool-bp01.json', { with: { type: 'json' } })).default;
const known = new Set(Object.values(pool.byRarity).flat().map((p) => p.code));
check('every code exists in the Palify snapshot', one.pulls.every((p) => known.has(p.code)));
check('every rarity matches the snapshot',
  one.pulls.every((p) => pool.byRarity[p.rarity].some((x) => x.code === p.code)));

const a = await (await get('/api/pull?seed=a3f19c')).json();
const b = await (await get('/api/pull?seed=a3f19c')).json();
check('same seed, same pull', JSON.stringify(a.pulls) === JSON.stringify(b.pulls));
const c = await (await get('/api/pull?seed=other1')).json();
check('different seed, different pull', JSON.stringify(c.pulls) !== JSON.stringify(a.pulls));

const seeded = await get('/api/pull?seed=a3f19c');
const unseeded = await get('/api/pull');
check('seeded pulls are cacheable', /immutable/.test(seeded.headers.get('cache-control')));
check('unseeded pulls are never cached', unseeded.headers.get('cache-control') === 'no-store');

const flatRes = await get('/api/pull?seed=a3f19c&format=flat');
const flat = await flatRes.text();
check('flat is text/plain', /text\/plain/.test(flatRes.headers.get('content-type')));
const lines = flat.trimEnd().split('\n');
check('flat has one line per card', lines.length === 7, `${lines.length} lines`);
check('flat is code,rarity', lines.every((l) => /^[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4},[A-Z]{1,3}$/.test(l)), lines.join(' | '));
check('flat matches json for the same seed',
  flat.trimEnd() === a.pulls.map((p) => p.code + ',' + p.rarity).join('\n'));

const twelve = await (await get('/api/pull?packs=12&seed=box001')).json();
check('12 packs = 84 cards', twelve.pulls.length === 84, `got ${twelve.pulls.length}`);
check('packs are numbered 1..12', new Set(twelve.pulls.map((p) => p.pack)).size === 12);
check('each pack is independently sorted',
  [...Array(12)].every((_, i) => {
    const p = twelve.pulls.filter((x) => x.pack === i + 1);
    return p.length === 7 && p.every((c, j) => j === 0 || RANK.indexOf(c.rarity) >= RANK.indexOf(p[j - 1].rarity));
  }));

// ── /api/deck: the panel's other source ──────────────────────────────────────
console.log('\n/api/deck:');
const td02 = await (await get('/api/deck?deck=td02&format=flat')).text();
const deckLines = td02.trimEnd().split('\n');
check('td02 expands quantities to 50 physical cards', deckLines.length === 50, `${deckLines.length} lines`);
check('same code,rarity shape as a pull', deckLines.every((l) => /^[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4},[A-Z]{1,3}$/.test(l)), deckLines[0]);
const td02json = await (await get('/api/deck?deck=td02')).json();
check('json agrees with flat', td02json.cards.length === 50 && td02json.cards[0].code === deckLines[0].split(',')[0]);
check('deck is labelled with its set', td02json.set === 'TD02');
const listing = await (await get('/api/deck')).json();
check('listing names every deck', listing.decks.length >= 2 && listing.decks.every((d) => d.id && d.set && d.total > 0));

// ── format=fixed: the shape the in-world decoder depends on ──────────────────
// Every assertion here is something the ProtoFlux side would fail silently on.
console.log('\nformat=fixed:');
const W = 64;
const { IN_WORLD_WIDTH } = await import('../src/roll.js');
const fixedRes = await get('/api/pull?seed=fx&packs=3&format=fixed');
const fixed = await fixedRes.text();
check('announces its record width', fixedRes.headers.get('x-record-width') === String(W));
check('length is an exact multiple of the record width', fixed.length % W === 0, `${fixed.length}`);
check('21 records for 3 packs', fixed.length / W === 21, `${fixed.length / W}`);
const recs = Array.from({ length: fixed.length / W }, (_, i) => fixed.slice(i * W, (i + 1) * W));
check('every record ends in a newline', recs.every((r) => r.endsWith('\n')));
check('every record trims to an absolute art URL',
  recs.every((r) => /^https:\/\/[^\s]+\/img\/[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}\?w=\d+$/.test(r.trim())), recs[0]);
// In-world every card is its own texture - no atlas - so a 50-card deck is 50
// textures resident at once. 512 keeps that near 24 MB instead of 95.
check('and asks for the in-world width, not the bake width',
  recs.every((r) => r.trim().endsWith(`?w=${IN_WORLD_WIDTH}`)) && IN_WORLD_WIDTH === 512);
const fixedFlat = await (await get('/api/pull?seed=fx&packs=3&format=flat')).text();
check('fixed and flat agree card for card, in order',
  recs.map((r) => r.trim().split('/img/')[1].split('?')[0]).join(',') === fixedFlat.trimEnd().split('\n').map((l) => l.split(',')[0]).join(','));
const deckFixed = await (await get('/api/deck?deck=td02&format=fixed')).text();
check('a deck uses the same record width', deckFixed.length === 50 * W, `${deckFixed.length / W} records`);
check('no record is truncated', recs.every((r) => r.trim().length <= W - 1));
// The widest card code in any pool, plus the origin and the width parameter,
// still has to fit - toFixed throws rather than truncate, which would be a card
// silently pointing at the wrong art.
{
  const widest = [...new Set(Object.values(pool.byRarity).flat().map((c) => c.code))]
    .reduce((a, b) => (b.length > a.length ? b : a));
  const longest = `https://resopal-proxy.dalek.workers.dev/img/${widest}?w=${IN_WORLD_WIDTH}`;
  check(`the widest code (${widest}) still fits a record`, longest.length <= W - 1, `${longest.length} of ${W - 1}`);
}

// ── /api/resolve: a pasted link or list, in the same records ─────────────────
console.log('\n/api/resolve:');
const post = (body, qs = '') => worker.fetch(new Request('https://w.example/api/resolve' + qs,
  { method: 'POST', body, headers: { Origin: ORIGIN, 'content-type': 'text/plain' } }), {}, ctx);

const byLink = await (await get('/api/resolve?deck=f2dd143c-8e6f-4142-87d2-051195185f96')).json();
check('a deck link resolves to its cards', byLink.total === 5, JSON.stringify(byLink).slice(0, 120));
check('and carries the deck name', byLink.name === 'Green/Purple Trial');
check('names come from palify, not from the paste', byLink.cards[0].name === 'Mossanda – Guard Captain');
check('so does rarity', byLink.cards.every((c) => c.rarity === 'TD'));

const pasted = await (await post('# Mine (5 cards)\n2x Mossanda [TD02-001]\n3x Eikthyrdeer [TD02-005]')).json();
check('a POSTed decklist resolves the same way', pasted.total === 5);
check('a link and a list agree card for card',
  pasted.cards.map((c) => c.code).join() === byLink.cards.map((c) => c.code).join());
check('the pasted title is kept', pasted.name === 'Mine');

const partial = await (await post('2x Mossanda [TD02-001]\n1x Ghost [ZZ99-001]\nSome line with no code')).json();
check('a code palify does not know is reported, not served', JSON.stringify(partial.unknown) === '["ZZ99-001"]');
check('a line with no code is reported too', JSON.stringify(partial.unrecognised) === '["Some line with no code"]');
check('and the cards it could verify still come back', partial.total === 2);

const rFixed = await post('2x Mossanda [TD02-001]', '?format=fixed');
const rBody = await rFixed.text();
check('fixed records are the same width as a pull', rBody.length === 2 * W, `${rBody.length}`);
check('and count themselves in a header', rFixed.headers.get('x-card-count') === '2');
check('POST is refused anywhere else', (await worker.fetch(
  new Request('https://w.example/api/pull', { method: 'POST', body: 'x', headers: { Origin: ORIGIN } }), {}, ctx)).status === 405);

// ── /deck and /profile: Palify's pages, parsed into JSON ──────────────────────
console.log('\n/deck + /profile:');
const dk = await (await get('/deck/66cdf5a2-aa5d-48e6-8bb7-7a3249bfccfc')).json();
check('a deck comes back as JSON, not a flight payload', Array.isArray(dk.cards));
check('the list survives verbatim, in order',
  JSON.stringify(dk.cards.map((c) => c.code + 'x' + c.n)) === '["BP01-053x1","BP01-075x2"]', JSON.stringify(dk.cards));
check('names come through unescaped', dk.cards[0].name === 'Elizabee \u2013 Queen of the Flower Garden', dk.cards[0].name);
check('total is the sum of the list', dk.total === 3, String(dk.total));
check('deck name and author are read', dk.name === 'Meow' && dk.author === 'DalekCoffee', `${dk.name} / ${dk.author}`);
check('?raw=1 still returns the payload untouched',
  (await (await get('/deck/66cdf5a2-aa5d-48e6-8bb7-7a3249bfccfc?raw=1')).text()) === DECK_FLIGHT);

const pf = await (await get('/profile/dalek')).json();
check('a profile lists its public decks', pf.decks.length === 2, JSON.stringify(pf.decks));
check('each deck carries id, name and count',
  pf.decks[0].id === '66cdf5a2-aa5d-48e6-8bb7-7a3249bfccfc' && pf.decks[0].name === 'Meow' && pf.decks[0].total === 3,
  JSON.stringify(pf.decks[0]));
check('a deck row cannot read the next row\u2019s name', pf.decks[1].name === 'Green/Purple Trial', pf.decks[1].name);
check('the colour bar is read', pf.decks[0].colors.length === 2 && pf.decks[0].colors[0].color === 'Purple',
  JSON.stringify(pf.decks[0].colors));
check('the display name comes from the profile, not the page title', pf.title === 'DalekCoffee', pf.title);

// A payload we cannot read must be an error, never a plausible wrong deck.
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('a page that is not a deck', { status: 200 });
check('an unreadable payload is a 502, not a guess',
  (await get('/deck/66cdf5a2-aa5d-48e6-8bb7-7a3249bfccfc')).status === 502);
// Palify serves a missing deck as 200 + Next's own 404 payload.
globalThis.fetch = async () => new Response('4:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}\n', { status: 200 });
check('a missing deck is a 404, not a 502',
  (await get('/deck/66cdf5a2-aa5d-48e6-8bb7-7a3249bfccfc')).status === 404);
check('a missing profile is a 404 too', (await get('/profile/nobody')).status === 404);
globalThis.fetch = savedFetch;

// ── landscape substitution ───────────────────────────────────────────────────
// TD01-008 is a Structure, and data/pool-td01.json lists it as landscape. Palify
// serves it already-turned against a portrait cell, and no material setting in
// Resonite can turn it back, so the route substitutes a pre-rotated copy.
console.log('\nlandscape printings:');

rotatedExists = true;
const turned = await get('/img/TD01-008?w=512');
check('a landscape code is served the rotated copy',
  lastUpstream.url === 'https://resopal.dalek.coffee/assets/rot/w512/TD01-008.webp', lastUpstream.url);
check('and that copy is cached forever', /immutable/.test(turned.headers.get('cache-control')),
  turned.headers.get('cache-control'));

const upright = await get('/img/TD01-001?w=512');
check('a portrait code is untouched',
  lastUpstream.url === 'https://palify.org/cards/w512/TD01-001.webp', lastUpstream.url);
check('and is still cached forever', /immutable/.test(upright.headers.get('cache-control')));

// The generator reads through this route, so without a bypass a second run would
// read back its own output and turn it twice.
await get('/img/TD01-008?w=512&orig=1');
check('orig=1 bypasses the substitution',
  lastUpstream.url === 'https://palify.org/cards/w512/TD01-008.webp', lastUpstream.url);

// Deploying the route before the images exist must not break a card.
rotatedExists = false;
const missing = await get('/img/TD01-009?w=512');
check('a missing rotated copy falls back to palify rather than 404',
  missing.status === 200 && lastUpstream.url === 'https://palify.org/cards/w512/TD01-009.webp',
  `${missing.status} ${lastUpstream.url}`);
check('and the fallback is NOT cached forever, so it is picked up later',
  !/immutable/.test(missing.headers.get('cache-control')), missing.headers.get('cache-control'));
rotatedExists = true;

// ── the card back ────────────────────────────────────────────────────────────
const back = await get('/back');
check('/back proxies the site copy',
  back.status === 200 && lastUpstream.url === 'https://resopal.dalek.coffee/assets/DefaultBack.png',
  `${back.status} ${lastUpstream.url}`);
check('the back is cached forever', /immutable/.test(back.headers.get('cache-control')));

// Runs last: it deliberately empties the token bucket for this IP.
let sawThrottle = false;
for (let i = 0; i < 80 && !sawThrottle; i++) sawThrottle = (await get('/api/pull')).status === 429;
check('a hammering client eventually gets 429', sawThrottle);

console.log(bad ? `\n${bad} FAILURES` : '\nall routing cases pass');
globalThis.fetch = realFetch;
process.exitCode = bad ? 1 : 0;
