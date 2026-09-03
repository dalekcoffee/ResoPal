// Deck in, .resonitepackage out - with nothing composited.
//
// This replaces the atlas half of bake.js. A v1.0 card takes its face from a
// texture it fetches itself, so an exporter's whole job per card is to write three
// strings - a name and two art URLs - and let the card wire itself up in-world
// (docs/PIPELINE.md).
//
// The sequence below is deliberately the same one the panel's flux performs at
// runtime - clone the template, drop the spare buffers, write each card's art -
// because a deck built here and a deck spawned by the panel have to be the same
// object. They drifted once already, over credits, and the fix was to make them
// share a source rather than to keep them in step by hand.
//
// ── what is NOT here, and why ────────────────────────────────────────────────
//
// No canvas, no ImageBitmap, no atlas, no card back bytes. The site never reads a
// pixel on this path, which also means the CORS and canvas-tainting rules that
// governed the bake do not apply to it: nothing is drawn, so nothing can taint.
// (The sheet export in compose.js still draws, and still needs them.)
//
// The package is correspondingly small - the deck template and nothing per-card -
// so a player's inventory holds a deck, not a deck plus a 50-card atlas.

import JSZip from 'jszip';
import { Int32, Double } from 'bson';
import { frdtToDoc, docToFrdt } from './frdt.js';
import { asUrl, scanUrlFields } from '../booster/urlmarker.mjs';
import { DECK_CREDITS, verifyCredits } from './credits-v1.js';

/**
 * In-world art is served at 512px, not the 1024 the site used to bake from, and
 * `v` is what makes Resonite refetch.
 *
 * Both MUST match worker/src/roll.js (IN_WORLD_WIDTH, and the `&v=` in toFixed).
 * The panel receives its card URLs from that Worker; the site writes its own. If
 * the two disagree, the same card is two different assets to Resonite and a player
 * who owns both decks pays for both.
 *
 * The reference deck committed at booster/out/ResoPal_TD02_Deck_v1.0.resonitepackage
 * carries `?w=1024` and no `v` - it is a hand capture, not builder output. Do not
 * copy its URL shape.
 */
export const IN_WORLD_WIDTH = 512;
export const ART_VERSION = 2;
export const DEFAULT_PROXY = 'https://resopal-proxy.dalek.workers.dev';

export const artUrlFor = (code, proxy = DEFAULT_PROXY) =>
  `${proxy}/img/${code}?w=${IN_WORLD_WIDTH}&v=${ART_VERSION}`;
export const backUrlFor = (proxy = DEFAULT_PROXY) => `${proxy}/back`;

const num = v => (v && typeof v === 'object' && v._bsontype ? Number(v) : v);
const nm = s => String(s?.Name?.Data ?? '');
const kid = (s, n) => (s.Children ?? []).find(c => nm(c) === n);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const shortType = t => String(t).replace(/^\[[^\]]+\]/, '').split('.').pop();
const compsOf = (doc, slot, type) =>
  (slot.Components?.Data ?? []).filter(c => shortType(doc.Types[num(c.Type)]) === type);
const oneComp = (doc, slot, type, where) => {
  const found = compsOf(doc, slot, type);
  if (found.length !== 1) throw new Error(`${where}: expected exactly one ${type}, found ${found.length}`);
  return found[0];
};

/** Every asset id the object graph still names. Used to prove a trim orphaned nothing. */
function assetRefsIn(node, assetIds) {
  const out = new Set();
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') { if (GUID.test(v) && assetIds.has(v)) out.add(v); }
      else w(v);
    }
  })(node);
  return out;
}

/**
 * Locate the parts of a v1.0 deck and prove the template is the shape we think.
 *
 * Everything here is checked rather than assumed, because every one of these has a
 * failure that is silent in-world: a buffer list that has drifted from its driver
 * list lays the deck out wrong, and a card whose DATA space sits somewhere else
 * takes its art write and drops it on the floor.
 */
export function readTemplate(doc) {
  const deck = doc.Object;
  if (nm(deck) !== 'Deck') throw new Error(`template root is "${nm(deck)}", expected "Deck"`);

  const surface = kid(deck, 'Surface/cards');
  if (!surface) throw new Error('no "Surface/cards" slot under the deck root');
  const cards = kid(surface, 'Cards');
  if (!cards) throw new Error('no "Cards" slot under Surface/cards');

  const assetsSlot = kid(deck, 'Assets');
  if (!assetsSlot) throw new Error('no "Assets" slot under the deck root');
  const proxies = (assetsSlot.Children ?? []).filter(c => nm(c) === 'proxy');
  if (proxies.length !== (assetsSlot.Children ?? []).length)
    throw new Error(`/Assets holds ${(assetsSlot.Children ?? []).length} children but only ${proxies.length} are "proxy" slots`
      + ' - trimming by index would remove the wrong thing');
  if (proxies.length !== cards.Children.length)
    throw new Error(`${cards.Children.length} buffers but ${proxies.length} /Assets driver proxies - they are 1:1`);

  // z of Deck/cardSize IS the per-card step; the holder lays buffers out by it.
  const size = oneComp(doc, deck, 'DynamicValueVariable<float3>', 'deck root');
  if (size.Data.VariableName.Data !== 'Deck/cardSize')
    throw new Error(`deck root float3 variable is "${size.Data.VariableName.Data}", expected "Deck/cardSize"`);
  const step = num(size.Data.Value.Data[2]);
  if (!(step > 0)) throw new Error(`Deck/cardSize z is ${step}, which cannot be a card step`);

  return { deck, cards, assetsSlot, buffers: cards.Children.length, step };
}

/** The three strings and the seeded texture that make one card. */
function writeCard(doc, buffer, i, { code, front, back }) {
  const card = kid(buffer, 'Card');
  if (!card) throw new Error(`buffer ${i} has no "Card" child`);

  // The DATA space is hoisted onto Card, not left on DATATEMPLATE where Sharkmake's
  // original card puts it. That is what lets a write ADDRESSED AT THE CARD find it -
  // dynamic-variable lookup only ever walks UP - and it is how the panel writes art.
  // A template with the space still on DATATEMPLATE takes the panel's write and
  // silently discards it, so this is checked, not assumed.
  const spaces = compsOf(doc, card, 'DynamicVariableSpace').map(c => c.Data.SpaceName.Data);
  if (!spaces.includes('DATA'))
    throw new Error(`buffer ${i}: Card carries no "DATA" variable space (has ${JSON.stringify(spaces)})`
      + ' - the hoisted space is what makes DATA/FRONT addressable at the Card');

  const data = kid(card, 'DATATEMPLATE');
  if (!data) throw new Error(`buffer ${i}: Card has no DATATEMPLATE child`);
  const vars = new Map();
  for (const c of compsOf(doc, data, 'DynamicValueVariable<string>')) vars.set(c.Data.VariableName.Data, c);
  for (const want of ['NAME', 'FRONT', 'BACK'])
    if (!vars.has(want)) throw new Error(`buffer ${i}: DATATEMPLATE has no "${want}" variable`);

  // Strings, so the URLs go in PLAIN. An `@` here renders as text.
  vars.get('NAME').Data.Value.Data = code;
  vars.get('FRONT').Data.Value.Data = front;
  vars.get('BACK').Data.Value.Data = back;

  // A Uri field, so this one is marked. It is a DRIVEN field - the DATA/FRONT chain
  // overwrites it once the drivers run - and seeding it only decides what shows in
  // the moment before they do. Left at the template's value, every card in a fresh
  // import flashes the template's card.
  const tmpl = kid(card, 'Template');
  if (!tmpl) throw new Error(`buffer ${i}: Card has no Template child`);
  oneComp(doc, tmpl, 'StaticTexture2D', `buffer ${i} Template`).Data.URL.Data = asUrl(front);

  // Read from outside the deck by the play board, never from within it. The panel
  // leaves this at the template's value because its For loop has no index to write;
  // the site does have one, and the reference deck carries 0..n-1 in buffer order.
  const idx = compsOf(doc, card, 'DynamicValueVariable<int>')
    .find(c => c.Data.VariableName.Data === 'Card/index');
  if (idx) idx.Data.Value.Data = new Int32(i);
}

/**
 * template : ArrayBuffer of the v1.0 deck template (data/template.resonitepackage)
 * codes    : card codes in deck order, one entry per physical card
 * Returns a Blob of the finished package.
 */
export async function fillDeck(template, { codes, proxy = DEFAULT_PROXY, name, log = () => {} }) {
  if (!Array.isArray(codes) || !codes.length) throw new Error('fillDeck needs at least one card code');

  const zip = await JSZip.loadAsync(template);
  const record = JSON.parse(await zip.file('R-Main.record').async('string'));
  const oldFrdt = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
  const doc = await frdtToDoc(await zip.file(`Assets/${oldFrdt}`).async('uint8array'));

  const { deck, cards, assetsSlot, buffers, step } = readTemplate(doc);
  const N = codes.length;
  if (N > buffers) throw new Error(
    `${N} cards, but the template holds ${buffers}. `
    + 'A deck cannot grow past its template: re-export a larger holder, and raise the panel with it.');

  const assetIds = new Set((doc.Assets ?? []).map(a => a.Data.ID));
  const before = assetRefsIn(deck, assetIds);

  // ── trim ───────────────────────────────────────────────────────────────────
  // Whole buffers, never emptied ones: each carries DestroyWithoutChildren and an
  // empty buffer deletes itself on import, so "empty the template then fill it"
  // arrives as a deck with nothing to put cards into.
  //
  // The two lists are 1:1 BY POSITION - the deck reaches into /Assets by index - so
  // they are sliced together or not at all.
  cards.Children = cards.Children.slice(0, N);
  assetsSlot.Children = assetsSlot.Children.slice(0, N);
  log(`  buffers ${buffers} -> ${N}   /Assets driver proxies ${buffers} -> ${N}`);

  // Nothing per-card is an asset in a v1.0 deck: one mesh and one back serve every
  // card, and the art is a URL. So a trim must orphan NOTHING, and if it ever does,
  // the template has changed shape and this file has to change with it.
  const after = assetRefsIn(deck, assetIds);
  const orphaned = [...before].filter(id => !after.has(id));
  if (orphaned.length) throw new Error(
    `trimming to ${N} orphaned ${orphaned.length} asset(s) - a v1.0 deck shares every card asset, `
    + 'so this means the template is no longer the shape fill.js expects');

  // ── write the cards ────────────────────────────────────────────────────────
  const back = backUrlFor(proxy);
  codes.forEach((code, i) => writeCard(doc, cards.Children[i], i, { code, front: artUrlFor(code, proxy), back }));
  log(`  ${N} cards written  art ${artUrlFor(codes[0], proxy)}`);
  log(`  one shared back  ${back}`);

  // ── re-lay the stack ───────────────────────────────────────────────────────
  // The holder DRIVES each buffer's TargetPosition from IndexOfChild, so this is
  // seeding rather than layout: it decides where the deck sits for the frame before
  // the drivers run. Seeded wrong, a fresh import visibly springs into shape.
  const z0 = (N - 1) / 2;
  cards.Children.forEach((buffer, i) => {
    const z = (i - z0) * step;
    buffer.Position.Data = [0, 0, z].map(v => new Double(v));
    const smooth = oneComp(doc, buffer, 'SmoothTransform', `buffer ${i}`);
    smooth.Data.TargetPosition.Data = [0, 0, z].map(v => new Double(v));
  });
  log(`  stack z ${(-z0 * step).toFixed(5)} .. ${(z0 * step).toFixed(5)}  step ${step}`);

  // ── audit ──────────────────────────────────────────────────────────────────
  // A bare https:// in a Uri field deserialises to null on import, silently, and
  // the card renders white with nothing logged anywhere. Twenty lines, and it
  // catches the whole class.
  const { marked, unmarked } = scanUrlFields(doc);
  if (unmarked.length) throw new Error(
    `${unmarked.length} Uri field(s) without the "@" marker, first: ${unmarked[0].field}=${unmarked[0].value}`);
  log(`  Uri fields marked: ${marked.length}, unmarked: 0`);

  verifyCredits(doc);
  log(`  /credits verified: ${DECK_CREDITS.length} slots`);

  // ── write ──────────────────────────────────────────────────────────────────
  const newFrdt = await docToFrdt(doc);
  const newFrdtHash = await sha256(newFrdt);

  const out = new JSZip();
  for (const [n, f] of Object.entries(zip.files)) {
    if (f.dir || n === 'R-Main.record' || n === `Assets/${oldFrdt}`) continue;
    out.file(n, await f.async('uint8array'));
  }
  out.file(`Assets/${newFrdtHash}`, newFrdt);

  record.assetUri = `packdb:///${newFrdtHash}`;
  if (name) record.name = name;
  record.assetManifest = [
    ...record.assetManifest.filter(e => e.hash !== oldFrdt),
    { hash: newFrdtHash, bytes: newFrdt.length },
  ];
  out.file('R-Main.record', JSON.stringify(record));

  return { blob: await out.generateAsync({ type: 'blob', compression: 'DEFLATE' }), cards: N };
}

async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
