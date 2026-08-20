// Snapshot a set's pull pool from Palify's catalogue.
//
// The roll needs one thing the deck importer never did: for each rarity, which
// printings can appear at that rarity. That is derivable from the catalogue but
// only from the catalogue - CLAUDE.md's "never invent card data" exists because
// two phantom codes once reached production from a hand-written placeholder list.
//
// Palify ask that responses be cached (docs/PALIFY-API.md). Committing this
// snapshot means a player rolling a pack makes zero Palify metadata requests -
// the site and the Worker both read the committed file.
//
//   node tools/fetch-pool.mjs                     # BP01 -> data/pool-bp01.json
//   node tools/fetch-pool.mjs set=BP02
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const SET = (args.set || 'BP01').toUpperCase();
const UA = 'ResoPal/1.0 (+https://resopal.dalek.coffee)';
const out = args.out || path.join(import.meta.dirname, '..', 'data', `pool-${SET.toLowerCase()}.json`);

const res = await fetch(`https://palify.org/api/cards?set=${SET}`, { headers: { 'user-agent': UA } });
if (!res.ok) throw new Error(`palify returned ${res.status} for set=${SET}`);
const { count, cards } = await res.json();
if (!Array.isArray(cards) || !cards.length) throw new Error(`no cards for set=${SET}`);

// Index by PRINTING rarity, not base-card rarity. A card's base printing and its
// alt-art printings sit at different rarities, and the pack rolls a rarity then
// picks a printing at it - so `BP01-001` (RR) and `BP01-001SSP` (SSP) are two
// separate entries pointing at the same base card.
const byRarity = {}, base = {}, landscape = [];
for (const c of cards) {
  base[c.code] = { name: c.name, color: c.color, type: c.type };
  if (c.landscape) landscape.push(c.code);
  for (const p of c.printings || []) {
    // `variant: false` marks the base printing - the default art selection.
    (byRarity[p.rarity] ||= []).push({ code: p.code, base: c.code, variant: !!p.variant });
  }
}
for (const r of Object.keys(byRarity)) byRarity[r].sort((a, b) => a.code.localeCompare(b.code));

const snapshot = {
  $comment: `Pull pool for ${SET}, snapshotted from Palify. Regenerate with tools/fetch-pool.mjs - never hand-edit card codes.`,
  set: SET,
  name: cards[0].set,
  source: `https://palify.org/api/cards?set=${SET}`,
  fetched: new Date().toISOString().slice(0, 10),
  cards: count,
  // Palify marks these landscape; they need the same 90-degree clockwise turn the
  // atlas gives them (docs/PIPELINE.md). Alt-art printings of a landscape card are
  // landscape too - the flag lives on the base card, so resolve through `base`.
  landscape: landscape.sort(),
  byRarity,
  base,
};

await writeFile(out, JSON.stringify(snapshot, null, 2) + '\n');
const tally = Object.entries(byRarity).map(([r, l]) => `${r}=${l.length}`).sort().join(' ');
console.log(`${out}\n  ${count} cards  ${Object.values(byRarity).reduce((t, l) => t + l.length, 0)} printings  ${landscape.length} landscape\n  ${tally}`);
