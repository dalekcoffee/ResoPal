#!/usr/bin/env node
/**
 * Fill the v1.0 template with TD02 and check the result against the deck the panel
 * produces.
 *
 * `booster/out/ResoPal_TD02_Deck_v1.0.resonitepackage` is the oracle: a finished
 * 50-card deck in the target format, and `data/decks.json`'s td02 expands to
 * exactly its card order. So "does the site produce the right thing" is a question
 * with a real answer here, not a judgement call.
 *
 * The reference deck is a hand capture, so it differs from builder output in two
 * known, deliberate ways. Both are asserted rather than tolerated:
 *
 *   art URL      the capture carries `?w=1024` and no cache-bust; the Worker (and
 *                therefore the panel) uses `?w=512&v=2`. The site follows the
 *                Worker - see web/fill.js.
 *   DATA space   the capture leaves Sharkmake's variable space on DATATEMPLATE;
 *                the panel's template hoists it onto Card so a write addressed at
 *                the Card can find it. The site ships the panel's shape.
 *
 *   node web/test-fill.mjs [template=../data/template.resonitepackage]
 *                          [reference=../booster/out/ResoPal_TD02_Deck_v1.0.resonitepackage]
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// brotli-wasm's ESM entry is the WEB build: it fetches its .wasm relative to its own
// module URL, and Node's fetch has no file: handler. web/frdt.js imports it that way
// ON PURPOSE - in a browser that is exactly right - so the test serves file: rather
// than the source being bent to suit the test.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.startsWith('file:')) {
    const body = readFileSync(fileURLToPath(url));
    return new Response(body, { headers: { 'content-type': 'application/wasm' } });
  }
  return realFetch(input, init);
};

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)];
}));
const TEMPLATE = args.template || path.join(ROOT, 'data', 'template.resonitepackage');
const REFERENCE = args.reference || path.join(ROOT, 'booster', 'out', 'ResoPal_TD02_Deck_v1.0.resonitepackage');

const { fillDeck, artUrlFor, backUrlFor, DEFAULT_PROXY } = await import('./fill.js');
const { frdtToDoc } = await import('./frdt.js');

let bad = 0;
const check = (name, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? '   ' + detail : ''}`);
};

const num = (v) => (v && typeof v === 'object' && v._bsontype ? Number(v) : v);
const nm = (s) => String(s?.Name?.Data ?? '');
const kid = (s, n) => (s.Children ?? []).find((c) => nm(c) === n);
const shortType = (t) => String(t).replace(/^\[[^\]]+\]/, '').split('.').pop();
const typeOf = (doc, c) => shortType(doc.Types[num(c.Type)]);
const compsOf = (doc, slot, type) => (slot.Components?.Data ?? []).filter((c) => typeOf(doc, c) === type);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function open(file) {
  const zip = await JSZip.loadAsync(await readFile(file));
  const record = JSON.parse(await zip.file('R-Main.record').async('string'));
  const hash = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
  return { zip, record, doc: await frdtToDoc(await zip.file(`Assets/${hash}`).async('uint8array')) };
}

// ── build one ────────────────────────────────────────────────────────────────
const decks = JSON.parse(await readFile(path.join(ROOT, 'data', 'decks.json'), 'utf8')).decks;
const td02 = decks.td02;
const CODES = td02.cards.flatMap((c) => Array(c.n).fill(c.code));
if (CODES.length !== td02.total) throw new Error(`td02 expanded to ${CODES.length}, its own total says ${td02.total}`);

console.log(`\ntemplate  ${path.relative(ROOT, TEMPLATE)}`);
console.log(`reference ${path.relative(ROOT, REFERENCE)}`);
console.log(`\nfilling ${CODES.length} cards:`);
const built = await fillDeck(await (await readFile(TEMPLATE)).buffer, {
  codes: CODES, name: 'ResoPal TD02', log: (m) => console.log(m),
});
const outBytes = Buffer.from(await built.blob.arrayBuffer());
const outPath = path.join(ROOT, 'booster', 'out', '_test-fill-td02.resonitepackage');
await (await import('node:fs/promises')).writeFile(outPath, outBytes);

const A = await open(outPath);          // what the site now produces
const B = await open(REFERENCE);        // the deck the panel produces

// ── the deck the site produced ───────────────────────────────────────────────
console.log('\nstructure:');
const deckA = A.doc.Object;
const cardsA = kid(kid(deckA, 'Surface/cards'), 'Cards');
const proxiesA = (kid(deckA, 'Assets').Children ?? []).filter((c) => nm(c) === 'proxy');
check('root slot is "Deck"', nm(deckA) === 'Deck', nm(deckA));
check(`${CODES.length} buffers`, cardsA.Children.length === CODES.length, String(cardsA.Children.length));
check(`${CODES.length} /Assets driver proxies (1:1)`, proxiesA.length === CODES.length, String(proxiesA.length));
check('/credits present', !!kid(deckA, 'credits'));

const sizeA = compsOf(A.doc, deckA, 'DynamicValueVariable<float3>')[0];
const cardSize = sizeA.Data.Value.Data.map(num);
check('Deck/cardSize = 0.176022, 0.2464308, 0.0013',
  cardSize[0].toFixed(6) === '0.176022' && cardSize[1].toFixed(7) === '0.2464308' && cardSize[2] === 0.0013,
  JSON.stringify(cardSize));
check('deck root scale is 1,1,1', deckA.Scale.Data.map(num).every((v) => v === 1),
  JSON.stringify(deckA.Scale.Data.map(num)));

// ── per-card data ────────────────────────────────────────────────────────────
console.log('\ncards:');
const readCard = (doc, buffer) => {
  const card = kid(buffer, 'Card');
  const data = kid(card, 'DATATEMPLATE');
  const vars = {};
  for (const c of compsOf(doc, data, 'DynamicValueVariable<string>')) vars[c.Data.VariableName.Data] = c.Data.Value.Data;
  const tex = compsOf(doc, kid(card, 'Template'), 'StaticTexture2D')[0];
  const idx = compsOf(doc, card, 'DynamicValueVariable<int>').find((c) => c.Data.VariableName.Data === 'Card/index');
  const vis = kid(kid(card, 'Visual (Baked)'), 'Visual');
  const spaces = compsOf(doc, card, 'DynamicVariableSpace').map((c) => c.Data.SpaceName.Data);
  return {
    ...vars, texURL: tex.Data.URL.Data, index: idx ? num(idx.Data.Value.Data) : null,
    scale: card.Scale.Data.map(num), visScale: vis.Scale.Data.map(num), spaces,
    z: num(buffer.Position.Data[2]),
    target: compsOf(doc, buffer, 'SmoothTransform')[0].Data.TargetPosition.Data.map(num),
  };
};
const rowsA = cardsA.Children.map((b) => readCard(A.doc, b));

check('NAME is the card code, in deck order',
  rowsA.every((r, i) => r.NAME === CODES[i]),
  JSON.stringify(rowsA.slice(0, 3).map((r) => r.NAME)));
check('FRONT is the w=512&v=2 art url, plain (no "@")',
  rowsA.every((r, i) => r.FRONT === artUrlFor(CODES[i]) && !r.FRONT.startsWith('@')),
  rowsA[0].FRONT);
check('BACK is one shared url for every card, plain',
  new Set(rowsA.map((r) => r.BACK)).size === 1 && rowsA[0].BACK === backUrlFor(DEFAULT_PROXY),
  rowsA[0].BACK);
check('Template.URL is the same art, MARKED with "@"',
  rowsA.every((r, i) => r.texURL === '@' + artUrlFor(CODES[i])),
  rowsA[0].texURL);
check('Card/index runs 0..n-1 in buffer order',
  rowsA.every((r, i) => r.index === i), JSON.stringify(rowsA.slice(0, 3).map((r) => r.index)));
check('the DATA space is hoisted onto Card',
  rowsA.every((r) => r.spaces.includes('DATA')), JSON.stringify(rowsA[0].spaces));
check('card slot scale is 0.495', rowsA.every((r) => r.scale.every((v) => v === 0.495)),
  JSON.stringify(rowsA[0].scale));
check('inner Visual y is 7.5036 (card thickness)',
  rowsA.every((r) => r.visScale[1].toFixed(4) === '7.5036'), String(rowsA[0].visScale[1]));

// ── stack geometry ───────────────────────────────────────────────────────────
console.log('\nstack:');
const step = cardSize[2];
const wantZ = (i) => (i - (CODES.length - 1) / 2) * step;
const close = (a, b) => Math.abs(a - b) < 1e-9;
check('buffer z = (i - (n-1)/2) x step', rowsA.every((r, i) => close(r.z, wantZ(i))),
  `${rowsA[0].z} vs ${wantZ(0)}`);
check('SmoothTransform.TargetPosition follows the buffer',
  rowsA.every((r, i) => close(r.target[2], wantZ(i)) && r.target[0] === 0 && r.target[1] === 0),
  JSON.stringify(rowsA[0].target));
check('the stack is centred on the holder',
  close(rowsA[0].z, -rowsA[rowsA.length - 1].z), `${rowsA[0].z} .. ${rowsA[rowsA.length - 1].z}`);

// ── url marking across the whole document ────────────────────────────────────
console.log('\nurl marking:');
const URL_FIELD = /(^|[a-z])URL$/i;
const marked = [], unmarked = [], plainStrings = [];
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.Data === 'string'
        && URL_FIELD.test(k) && v.Data !== '' && !GUID.test(v.Data)) {
      (v.Data.startsWith('@') ? marked : unmarked).push(`${k}=${v.Data}`);
    }
    walk(v);
  }
})(A.doc);
for (const r of rowsA) { if (r.FRONT.startsWith('@') || r.BACK.startsWith('@')) plainStrings.push(r.FRONT); }
check('every Uri field carries the marker', unmarked.length === 0, unmarked.slice(0, 2).join(', '));
check('no string variable carries the marker', plainStrings.length === 0, plainStrings[0] || '');
console.log(`       (${marked.length} marked Uri fields)`);

// ── references resolve ───────────────────────────────────────────────────────
console.log('\nreferences:');
const declKey = (k) => k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k);
const declared = new Set(), referenced = new Set(), parentRefs = new Set();
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && GUID.test(v)) {
      if (k === 'ParentReference') parentRefs.add(v);
      else if (declKey(k)) declared.add(v);
      else referenced.add(v);
    } else walk(v);
  }
})(A.doc);
const dangling = [...referenced].filter((id) => !declared.has(id) && !parentRefs.has(id));
check('0 dangling references', dangling.length === 0, `${dangling.length}, first ${dangling[0]}`);

// ── against the reference deck ───────────────────────────────────────────────
console.log('\nagainst the panel-produced deck:');
const hist = (doc) => {
  const h = new Map();
  (function w(s) {
    for (const c of (s.Components?.Data ?? [])) { const t = typeOf(doc, c); h.set(t, (h.get(t) || 0) + 1); }
    for (const k of (s.Children ?? [])) w(k);
  })(doc.Object);
  return h;
};
const hA = hist(A.doc), hB = hist(B.doc);
const keys = [...new Set([...hA.keys(), ...hB.keys()])].sort();
// The panel's template carries ONE component the capture does not: the
// `InnerDeck/spread` hook the panel writes to after filling the holder. Without it
// the write lands nowhere and the deck stays stacked. The hoisted DATA space is NOT
// in this table - hoisting MOVES the space from DATATEMPLATE to Card, so the count
// is unchanged and only the placement differs.
const expectedDiff = new Map([['DynamicField<bool>', 1]]);
const diffs = keys.filter((k) => (hA.get(k) || 0) - (hB.get(k) || 0) !== (expectedDiff.get(k) || 0));
check('component counts match the reference deck (modulo the InnerDeck/spread hook)',
  diffs.length === 0, diffs.map((k) => `${k} ${hA.get(k) || 0}v${hB.get(k) || 0}`).join(', '));


const rowsB = kid(kid(B.doc.Object, 'Surface/cards'), 'Cards').Children.map((b) => readCard(B.doc, b));
// The two documented divergences, asserted from both sides so neither can drift
// into being accidental.
const surfaceA = kid(A.doc.Object, 'Surface/cards');
const spread = compsOf(A.doc, surfaceA, 'DynamicField<bool>')
  .find((c) => c.Data.VariableName.Data === 'InnerDeck/spread');
check('carries the InnerDeck/spread hook the panel writes to', !!spread);
check('the reference capture leaves its DATA space on DATATEMPLATE',
  !rowsB[0].spaces.includes('DATA')
  && compsOf(B.doc, kid(kid(kid(kid(B.doc.Object, 'Surface/cards'), 'Cards').Children[0], 'Card'), 'DATATEMPLATE'),
    'DynamicVariableSpace').some((c) => c.Data.SpaceName.Data === 'DATA'),
  JSON.stringify(rowsB[0].spaces));
check('same card order as the reference deck', rowsA.every((r, i) => r.NAME === rowsB[i].NAME));
check('same shared back url as the reference deck', rowsA[0].BACK === rowsB[0].BACK,
  `${rowsA[0].BACK} vs ${rowsB[0].BACK}`);
check('same stack geometry as the reference deck',
  rowsA.every((r, i) => close(r.z, rowsB[i].z)), `${rowsA[0].z} vs ${rowsB[0].z}`);
check('art url deliberately differs (w=512&v=2, not the capture\'s w=1024)',
  rowsA[0].FRONT !== rowsB[0].FRONT && rowsA[0].FRONT.includes('w=512&v=2'),
  `${rowsA[0].FRONT} vs ${rowsB[0].FRONT}`);

// ── the edge mesh, by hash ───────────────────────────────────────────────────
// Two bakes exist with identical 528-vertex topology, one rounded and one square.
// The panel shipped the wrong one for weeks with all the right numbers beside it.
console.log('\nassets:');
const EDGE = 'b3dad283682331b737812b46df1ec0f9f1407786e590b1249d313c2799300a9a';
const meshUrls = (doc) => (doc.Assets ?? [])
  .filter((a) => shortType(doc.Types[num(a.Type)]) === 'StaticMesh')
  .map((a) => String(a.Data.URL?.Data ?? '').replace(/^@?packdb:\/\/\//, ''));
check('filler "Edge (Baked)" mesh is the rounded bake', meshUrls(A.doc).includes(EDGE),
  JSON.stringify(meshUrls(A.doc)));
check('no atlas: nothing per-card is an asset',
  (A.doc.Assets ?? []).length === (await open(TEMPLATE)).doc.Assets.length,
  `${(A.doc.Assets ?? []).length} assets`);

const tmplSize = (await readFile(TEMPLATE)).length;
console.log(`\n  template ${(tmplSize / 1048576).toFixed(2)} MB -> deck ${(outBytes.length / 1048576).toFixed(2)} MB`
  + `   (${CODES.length} cards, no art embedded)`);

console.log(bad ? `\n${bad} FAILED\n` : '\nall checks passed\n');
process.exit(bad ? 1 : 0);
