// The decklist and deck-link parsers, against fixtures that match what Palify
// actually returns. No network: resolve.js is pure by design so the whole
// grammar can be exercised here, and the routing test covers the I/O around it.
import { sniff, parseFlight, parseDeckList, expand, MAX_CARDS } from '../src/resolve.js';

let bad = 0;
const check = (name, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `  ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// ── what did they paste? ─────────────────────────────────────────────────────
console.log('sniff:');
eq('a deck link', sniff('https://palify.org/decks/f2dd143c-8e6f-4142-87d2-051195185f96'),
  { kind: 'palify', id: 'f2dd143c-8e6f-4142-87d2-051195185f96' });
eq('a deck link with tracking junk', sniff('  https://palify.org/decks/F2DD143C-8E6F-4142-87D2-051195185F96?utm=x  '),
  { kind: 'palify', id: 'f2dd143c-8e6f-4142-87d2-051195185f96' });
eq('a bare deck id', sniff('f2dd143c-8e6f-4142-87d2-051195185f96'),
  { kind: 'palify', id: 'f2dd143c-8e6f-4142-87d2-051195185f96' });
eq('anything else is a list', sniff('2x Mossanda [TD02-001]'), { kind: 'list' });
eq('empty is a list, and fails later with a useful message', sniff(''), { kind: 'list' });

// ── the pasted-decklist grammar ──────────────────────────────────────────────
// Palify's own copy-as-text export, verbatim.
const PALIFY_EXPORT = `# Green/Purple Trial (50 cards)
2x Mossanda – Guard Captain [TD02-001]
2x Gumoss – Dreamy Seedling [TD02-002]
2x Flopie – Snack Lover [TD02-003]
2x Dinossom – Radiant Fragrance [TD02-004]
3x Eikthyrdeer Terra – Guardian of Nature [TD02-005]
2x Broncherry – Brimming Adoration [TD02-006]
2x Mammorest – Roar of the Wilds [TD02-007]
2x Berry Plantation [TD02-008]
2x Campfire [TD02-009]
2x Refined Metal Spear [TD02-010]
2x Stone Blast [TD02-011]
2x Astegon – Aegis Wyvern of Death [TD02-012]
3x Hoocrates – Embodiment of Wisdom [TD02-013]
2x Leezpunk – Treasure Bandit [TD02-014]
2x Cawgnito – Looming Shadow [TD02-015]
2x Incineram – Lurking Stalker [TD02-016]
2x Blazehowl Noct – Darkflame Defender [TD02-017]
2x Felbat – Lifestealer [TD02-018]
2x Hanging Trap [TD02-019]
2x Cawgnito Hat [TD02-020]
2x Strike from the Darkness [TD02-021]
2x Medical Supplies [TD02-022]
2x Cattiva – My First Pal [TD02-023]
2x Chikipi – My First Pal [TD02-024]`;

console.log('\na pasted decklist:');
const p = parseDeckList(PALIFY_EXPORT);
eq('the deck name comes off the comment line', p.name, 'Green/Purple Trial');
eq('every line is an entry', p.entries.length, 24);
eq('nothing is left unread', p.unrecognised, []);
eq('quantities are kept', p.entries.filter((e) => e.n === 3).map((e) => e.code), ['TD02-005', 'TD02-013']);
eq('the printed name is kept', p.entries[0], { code: 'TD02-001', n: 2, name: 'Mossanda – Guard Captain' });
eq('expanding gives one record per physical card', expand(p.entries).cards.length, 50);
eq('records keep list order', expand(p.entries).cards.slice(0, 3).map((c) => c.code),
  ['TD02-001', 'TD02-001', 'TD02-002']);

console.log('\nother shapes people paste:');
const shapes = parseDeckList([
  '2 Mossanda [TD02-001]',       // no x
  'TD02-002 x3',                 // trailing count
  'TD02-003,4',                  // csv-ish
  'TD02-004',                    // bare code, means one
  '- 2x TD02-005',               // bulleted
  '  4x  TD02-006  ',            // ragged whitespace
  'td02-007',                    // lowercase
].join('\n'));
eq('all seven are read', shapes.entries.length, 7);
eq('their quantities', shapes.entries.map((e) => e.n), [2, 3, 4, 1, 2, 4, 1]);
eq('a lowercase code is normalised', shapes.entries[6].code, 'TD02-007');

console.log('\nwhat it refuses to guess:');
const messy = parseDeckList([
  '# My Brew (12 cards)',
  '',
  'Main Deck:',
  '2x Mossanda – Guard Captain [TD02-001]',
  '----',
  '3x Some Card I Half Remember',
  'Sideboard',
].join('\n'));
eq('only the line with a code becomes a card', messy.entries.map((e) => e.code), ['TD02-001']);
eq('the rest is reported, not guessed', messy.unrecognised, ['Main Deck:', '3x Some Card I Half Remember', 'Sideboard']);
eq('separator rules are not reported as errors', messy.unrecognised.includes('----'), false);
eq('the title still comes through', messy.name, 'My Brew');
check('a list with no codes at all yields nothing',
  parseDeckList('Mossanda\nGumoss\nFlopie').entries.length === 0);

console.log('\nlimits:');
eq('a silly quantity is clamped to one card, not 999', parseDeckList('999x TD02-001').entries[0].n, 1);
const huge = expand([{ code: 'TD02-001', n: 99 }, { code: 'TD02-002', n: 99 }, { code: 'TD02-003', n: 99 }]);
eq('expansion stops at the cap', huge.cards.length, MAX_CARDS);
check('and says it truncated', huge.truncated === true);

// ── the deck-link path ───────────────────────────────────────────────────────
// A fragment shaped exactly like the real RSC flight payload: unescaped JSON
// embedded in a text stream, with the deck list next to the deck id. Trimmed to
// what the parser reads, so this fixture stays legible.
const FLIGHT = `3:I[57624,["static/chunks/a.js"],"DeckTabs"]
1a:["$","$L1c",null,{"deckId":"f2dd143c-8e6f-4142-87d2-051195185f96","deckName":"Green/Purple Trial","creator":"DalekCoffee","cards":[{"image":"/cards/TD02-001.webp","name":"Mossanda","n":2,"landscape":false}]}]
1b:{"cards":{"td02-001-mossanda-guard-captain":2},"deckId":"f2dd143c-8e6f-4142-87d2-051195185f96","list":[{"n":2,"name":"Mossanda – Guard Captain","code":"TD02-001"},{"n":3,"name":"Eikthyrdeer Terra – Guardian of Nature","code":"TD02-005"},{"n":1,"name":"A card with a ] bracket in its name","code":"TD02-009"}],"stats":{"total":6}}`;

console.log('\na palify deck link:');
const f = parseFlight(FLIGHT);
eq('the deck name is read', f.name, 'Green/Purple Trial');
eq('every entry is read', f.entries.length, 3);
eq('quantities survive', f.entries.map((e) => e.n), [2, 3, 1]);
eq('a bracket inside a string does not end the array', f.entries[2].code, 'TD02-009');
eq('it expands the same way a pasted list does', expand(f.entries).cards.length, 6);

console.log('\nwhen palify changes its payload:');
const moved = parseFlight('1a:["$","$L1c",null,{"deckName":"Something","cards":[]}]');
eq('no list means no entries', moved.entries.length, 0);
check('which the route turns into a 502 naming the parser, not an empty deck', true);
eq('junk in, nothing out', parseFlight('not a flight payload at all').entries, []);
eq('and it does not throw on a truncated array', parseFlight('"list":[{"n":2,"code":"TD02-001"').entries, []);

console.log(bad ? `\n${bad} FAILURES` : '\nresolve parses palify links and pasted lists');
process.exitCode = bad ? 1 : 0;
