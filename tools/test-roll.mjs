// The roll, end to end: the Worker's odds, the site's offline fallback, and the
// ordering contract the deck bake depends on.
//
// The site's logic lives inside index.html's component script, so this pulls that
// block out and runs it directly. Keeping a copy of the roll here for testability
// would create a second source of truth, which is the exact thing
// worker/src/roll.js exists to prevent.
//
//   node tools/test-roll.mjs
import fs from 'node:fs';
const h = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = h.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
globalThis.window = { innerWidth: 1440, addEventListener() {} };
globalThis.document = { addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.fetch = async () => { throw new Error('offline'); };
globalThis.DCLogic = class { setState(p) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); } forceUpdate() {} };

const mod = await import('data:text/javascript;base64,' + Buffer.from(
  js + '\nexport { Component, POOL, SET, STACK_RAREST_FIRST, RANK, CARDS };'
).toString('base64'));

const { Component, POOL, SET, STACK_RAREST_FIRST, RANK } = mod;
const pool = JSON.parse(fs.readFileSync(new URL('../data/pool-bp01.json', import.meta.url), 'utf8'));
const weights = JSON.parse(fs.readFileSync(new URL('../data/pack-weights.json', import.meta.url), 'utf8'));
const HUE = { Red: '#dd9c9c', Blue: '#9dc2dd', Green: '#a3ccae', Purple: '#c2a3e2', Colorless: '#cfc7a8' };

const c = new Component();
// mimic what componentDidMount does once the two files land
Object.keys(POOL).forEach(k => delete POOL[k]);
for (const [r, list] of Object.entries(pool.byRarity))
  POOL[r] = list.map(e => ({ p: e.code, b: e.base, name: (pool.base[e.base] || {}).name, hue: HUE[(pool.base[e.base] || {}).color] || '#cfc7a8' }));
const set = weights.sets[SET], g = weights.globalBonus.value, pb = set.perPackBonus || {};
const hit = {}; Object.keys(set.hitSlot).forEach(k => hit[k] = set.hitSlot[k] * (k === 'R' ? 1 : (pb[k] || 1) * g));
c.rank = weights.rank;
c.weights = { slots: set.slots, hitSlot: hit, glow: weights.celebrate.glow, big: weights.celebrate.big, name: set.name };

let bad = 0;
const check = (n, ok, d = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${!ok && d ? '  ' + d : ''}`); };

console.log(`site (offline fallback), SET=${SET} STACK_RAREST_FIRST=${STACK_RAREST_FIRST}`);
const known = new Set(Object.values(pool.byRarity).flat().map(p => p.code));
let tally = {};
for (let i = 0; i < 20000; i++) {
  const pack = c.rollLocal();
  if (pack.length !== 7) { check('pack size', false, String(pack.length)); break; }
  if (!pack.every(x => known.has(x.code))) { check('codes real', false); break; }
  for (let k = 1; k < pack.length; k++)
    if (c.rankOf(pack[k].rarity) > c.rankOf(pack[k - 1].rarity)) { check('reveal order is least-rare-first', false, pack.map(x => x.rarity).join(' ')); i = 1e9; break; }
  tally[pack[6].rarity] = (tally[pack[6].rarity] || 0) + 1;
}
check('20k local packs: 7 real cards, least-rare first', bad === 0);

// the hit is the LAST card revealed
check('hit slot is the final reveal', Object.keys(tally).every(r => c.rankOf(r) <= c.rankOf('R')), JSON.stringify(tally));

// export ordering: rows() must invert it to rarest-first
const pack = c.rollLocal();
c.state.fromPulls = true; c.state.binder = pack; c.state.variants = {}; c.state.discarded = {}; c.state.imgBudget = 60;
const rows = c.rows(c.state);
check('export row count', rows.length >= 1);
const order = rows.map(r => r.rarity);
check('export is rarest first', order.every((r, i) => i === 0 || c.rankOf(r) >= c.rankOf(order[i - 1])), order.join(' '));
check('reveal order is the reverse of export order',
  c.rankOf(pack[0].rarity) >= c.rankOf(order[0]));

// ── the online path: the site must consume the Worker's own output ────────────
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { default: worker } = await import('../worker/src/index.js');
globalThis.fetch = async (u) => worker.fetch(new Request(new URL(String(u), 'https://resopal.dalek.coffee')), {}, { waitUntil() {} });

console.log('\nsite <- Worker:');
const c2 = new Component();
c2.rank = weights.rank; c2.weights = c.weights;
await c2.fillPacks(3);
await new Promise(r => setTimeout(r, 50));
check('queued 3 server packs', (c2.packQueue || []).length === 3, String((c2.packQueue || []).length));
const served = c2.rollPack();
check('served pack has 7 cards', served.length === 7, String(served.length));
check('served pack is least-rare first (reveal order)',
  served.every((x, i) => i === 0 || c2.rankOf(x.rarity) <= c2.rankOf(served[i - 1].rarity)), served.map(x => x.rarity).join(' '));
check('served cards carry names from the pool', served.every(x => x.name && x.name !== x.base));
check('served cards are not marked local', served.every(x => !x.local));
check('server pack carries its seed', served.every(x => typeof x.seed === 'string' && x.seed.length));

console.log(bad ? `\n${bad} FAILURES` : '\nsite roll + ordering pass');
process.exitCode = bad ? 1 : 0;
