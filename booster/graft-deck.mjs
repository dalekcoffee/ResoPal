#!/usr/bin/env node
/**
 * Put a deck template inside the panel, so the importer has something to fill.
 *
 * The panel spawns loose cards today. A deck import needs a real Ukilop deck to
 * duplicate and write into, and that deck has to travel inside the panel package -
 * there is nothing to fetch it from at runtime.
 *
 * It is spliced at the document level rather than built by build-panel.mjs,
 * because the deck is a foreign document: its ids and its `Types` table are local
 * to itself, its meshes are `@packdb:///` blobs in its own zip, and the encoder
 * builds `Types` from its own map. splice.mjs carries the rules that make moving
 * a subtree between two documents safe.
 *
 * The deck arrives INACTIVE and at its full card count. Trimming happens in-world
 * by destroying the extras, which is the supported way to change a deck's size:
 * each card's buffer carries a `DestroyProxy` that removes its `/Assets` driver
 * with it, so the two lists stay in step. Moving those drivers instead - to make a
 * card duplicable - was tried and broke grabbing, because the deck reaches into
 * `/Assets` by position (docs/HANDOFF.md).
 *
 * ── THE SHIPPING PATH, as of 2026-08-31 ─────────────────────────────────────
 * This was marked "not the shipping path" on the grounds that the deck is 3763
 * components and 1992 flux slots against the panel's 228 and 119, so grafting it
 * buries the owner's clean canvas under someone else's flux. That reading was of
 * the canvas COUNT, and it is wrong about what he actually sees: the deck's flux
 * lives in `Deck/logixs` and 52 packed `Assets/proxy` slots, none of which is a
 * Moduprint canvas. The panel still has exactly one canvas after this runs, still
 * with his 116 nodes plus the branch, and `test-graft-deck.mjs` gates that.
 *
 * The other half of the objection was real and is fixed here: the template used to
 * arrive INACTIVE, so its nodes bound to nothing and read as red - "the flux is
 * severely broken again". It now arrives ACTIVE inside an INACTIVE HOLDER, which
 * is what the card template already does and what `DuplicateSlot` requires:
 * `slot.Duplicate()` copies `Active` verbatim, so duplicating an inactive deck
 * gives an inactive deck and nothing in the spawn chain turns it back on.
 *
 *   node booster/graft-deck.mjs [panel=out/ResoPal_Panel.resonitepackage]
 *                               [deck=out/ResoPal_DeckTemplate.resonitepackage]
 *                               [out=out/ResoPal_Panel_Deck.resonitepackage]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cloneNode, allocator, typeMapper } from './splice.mjs';
import { DECK_POSITION, DECK_ROTATION } from './deck-import.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { Int32, Long, Double } = require('bson');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const ROOT = path.resolve(import.meta.dirname, '..');
const RKL = process.env.RKL || path.resolve(ROOT, '..', 'Resonite-Knowledge-Library');
const codec = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(codec)) throw new Error(`No ${codec}. Set RKL=<knowledge library checkout>.`);
const { frdtToBsonBytes, bsonBytesToFrdt, deserializeBson, serializeBson } = await import(`file://${codec}`);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)];
}));
const PANEL = args.panel || path.join(import.meta.dirname, 'out', 'ResoPal_Panel.resonitepackage');
// The deck the owner confirmed good in-world, run through `build-deck-probe.mjs`
// so that every one of its 52 cards carries its OWN front material, texture and
// `Card/url` drive chain instead of sharing the atlas.
//
// `npm run template:deck` makes it, out of `data/deck-template.resonitepackage`.
//
// Two earlier defaults were wrong for reasons worth keeping:
//
//  * `data/template.resonitepackage` is a Deck Maker export run through
//    `tools/strip_template.mjs`, which drops the fallback fonts and the
//    placeholder atlas because the WEBSITE's `patch.js` replaces both on every
//    bake. Nothing replaces them on the in-world path, so the grafted deck
//    shipped with five packdb references and no blobs behind them: four
//    StaticFonts and the atlas. In-world that is text off its button and
//    untextured card edges. The source has to be a WHOLE deck.
//
//  * The raw whole deck, with no probe pass, was right only while the importer
//    spawned its own cards and moved them in - "the importer destroys all 52,
//    so per-card art is wasted". It does not any more. The 52 cards ARE the
//    imported deck now, and the per-card art is the whole point.
const DECK = args.deck || path.join(import.meta.dirname, 'out', 'ResoPal_DeckTemplate.resonitepackage');
if (!existsSync(DECK)) throw new Error(
  `No ${DECK}.\nIt is a build output, not a committed file - make it first:\n` +
  `  npm run template:deck\n`);
const OUT = args.out || path.join(import.meta.dirname, 'out', 'ResoPal_Panel_Deck.resonitepackage');
const SLOT_NAME = args.name || 'Deck template';

const load = async (file) => {
  const zip = await JSZip.loadAsync(await readFile(file));
  const record = JSON.parse(await zip.file('R-Main.record').async('string'));
  const hash = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
  const doc = await deserializeBson(await frdtToBsonBytes(new Uint8Array(await zip.file(`Assets/${hash}`).async('uint8array'))));
  return { zip, record, hash, doc };
};

const panel = await load(PANEL);
const deck = await load(DECK);
const fmtExported = `pos [${(deck.doc.Object.Position?.Data ?? []).map(Number).map((v) => v.toFixed(2)).join(', ')}] scale ${Number((deck.doc.Object.Scale?.Data ?? [1])[0]).toFixed(2)}`;

const nm = (s) => String(s?.Name?.Data ?? '');
const idx = (v) => (v && typeof v === 'object') ? (v.value ?? v.valueOf?.()) : v;

const newId = allocator(panel.doc);
const mapType = typeMapper(panel.doc, deck.doc);

// ── the assets it brings ─────────────────────────────────────────────────────
// ── the deck, cloned whole ───────────────────────────────────────────────────
// A deck's meshes, fonts and textures live in `doc.Assets`, a flat list beside the
// slot tree, and the tree references them by id. So the tree and the assets have
// to be cloned in ONE call: cloning them separately gives each its own id map, the
// same asset comes out with two different ids, and every renderer ends up pointing
// at the copy nobody kept. Nothing dangles and no card has a mesh.
const wholeDoc = cloneNode({ Object: deck.doc.Object, Assets: deck.doc.Assets }, newId);
(function remapAll(s) {
  for (const c of s.Components?.Data ?? []) c.Type = new Int32(mapType(idx(c.Type)));
  for (const ch of s.Children ?? []) remapAll(ch);
})(wholeDoc.Object);
for (const a of wholeDoc.Assets) a.Type = new Int32(mapType(idx(a.Type)));

// ── the spread toggle, exposed as a variable ─────────────────────────────────
// `InnerDeck/grid X` and `grid Y` are DRIVEN outputs of `ChildrenCount(Cards)`,
// not inputs - writing them does nothing (see deck-import.mjs for the
// measurement). What actually opens the search spread is
// `BooleanValueDriver<floatQ>.State` on `/Deck/Surface/cards`, a plain field the
// search button's own flux writes, and there is no variable on it for the
// importer to reach. One `DynamicField<bool>` gives it one, using the same idiom
// the deck already uses to expose `InnerDeck/SmoothSpeed` on every buffer.
const findSlot = (s, name) => nm(s) === name ? s
  : (s.Children ?? []).reduce((f, c) => f || findSlot(c, name), null);
const surface = findSlot(wholeDoc.Object, 'Surface/cards');
if (!surface) throw new Error('no Surface/cards in the deck template');
const typeName = (c) => String(panel.doc.Types[idx(c.Type)]);
const stateDriver = (surface.Components?.Data ?? []).find((c) => /BooleanValueDriver<floatQ>/.test(typeName(c)));
if (!stateDriver) throw new Error('no BooleanValueDriver<floatQ> on Surface/cards - the spread toggle moved');
const SPREAD_VAR = 'InnerDeck/spread';
const dynFieldType = '[FrooxEngine]FrooxEngine.DynamicField<bool>';
let dfIndex = panel.doc.Types.indexOf(dynFieldType);
if (dfIndex < 0) { dfIndex = panel.doc.Types.length; panel.doc.Types.push(dynFieldType); }
surface.Components.Data.push({
  Type: new Int32(dfIndex),
  Data: {
    ID: newId(), 'persistent-ID': newId(),
    UpdateOrder: { ID: newId(), Data: new Int32(0) },
    Enabled: { ID: newId(), Data: true },
    VariableName: { ID: newId(), Data: SPREAD_VAR },
    TargetField: { ID: newId(), Data: String(stateDriver.Data.State.ID) },
    OverrideOnLink: { ID: newId(), Data: false },
  },
});

// ── in, alive, behind an inactive holder ─────────────────────────────────────
// The DECK stays active and its HOLDER is switched off, exactly as the card
// template is. `DuplicateSlot` copies `Active` verbatim: hand it an inactive deck
// and the copy is invisible too, with nothing downstream to turn it on.
wholeDoc.Object.Name.Data = 'Deck';
// ── overwrite the transform it was exported with ─────────────────────────────
// A Deck Maker export carries the world transform the object had in the session
// it was saved from. The template here came out at
//   pos [-20.2569, 2.1762, 10.5210]  rot ~[-0.19,-0.23,-0.59,0.75]  scale 0.91
// so the first in-world import put the deck twenty metres away, rotated, at 0.91 -
// "the deck is far away from me". The Deck Maker itself measures
// pos [-28.68, 2.59, 26.38] scale 0.91, from a different session, which is what
// says the 0.91 is the same saved-in-world residue as the position rather than an
// authored size: `Deck/cardSize` is written at 0.175 x 0.25 and means metres at
// scale 1.
//
// THE ROOT IS WHERE THE POSE HAS TO GO. `Slot.Duplicate(parent, keepGlobalTransform
// = true)` - and the ProtoFlux node takes that default - so a duplicate keeps THIS
// slot's world transform and is merely re-parented. Posing the `Decks` slot the
// duplicates land under does nothing at all; it was tried. The holder above is
// therefore zeroed too, so this transform IS the deck's pose in panel space.
wholeDoc.Object.Position.Data = DECK_POSITION.map((v) => new Double(v));
wholeDoc.Object.Rotation.Data = DECK_ROTATION.map((v) => new Double(v));
wholeDoc.Object.Scale.Data = [1, 1, 1].map((v) => new Double(v));
const holder = {
  ID: newId(),
  Components: { ID: newId(), Data: [] },
  Name: { ID: newId(), Data: SLOT_NAME }, Tag: { ID: newId(), Data: null },
  Active: { ID: newId(), Data: false }, 'Persistent-ID': newId(),
  // Zero: the deck's own root carries the pose, and the holder must not add to
  // it. Hiding the template behind an offset is unnecessary - the holder is
  // inactive, so nothing under it renders.
  Position: { ID: newId(), Data: [0, 0, 0].map((v) => new Double(v)) },
  Rotation: { ID: newId(), Data: [0, 0, 0, 1].map((v) => new Double(v)) },
  Scale: { ID: newId(), Data: [1, 1, 1].map((v) => new Double(v)) },
  OrderOffset: { ID: newId(), Data: Long.fromNumber(0) },
  ParentReference: null, Children: [wholeDoc.Object],
};

(panel.doc.Object.Children ??= []).push(holder);
panel.doc.Assets = [...(panel.doc.Assets ?? []), ...wholeDoc.Assets];

// ── point the importer at it ─────────────────────────────────────────────────
// `graft-deck-import.mjs` emits the branch with its deck-template reference left
// null, because the id the deck lands on does not exist until this runs. Filling
// it in is the one thing that joins the two grafts, and it is a hard error rather
// than a warning: a null reference here is a panel whose deck button duplicates
// nothing, silently, which is exactly the class of failure this repo keeps paying
// for. Running only `graft-deck-import.mjs` and stopping is fine - the branch is
// inert until a template exists - but a build that gets here must connect.
let bound = 0;
(function bind(s) {
  if (nm(s) === 'the deck template')
    for (const c of s.Components?.Data ?? [])
      if (/GlobalReference<\[FrooxEngine\]FrooxEngine\.Slot>/.test(typeName(c)) && !c.Data.Reference.Data) {
        c.Data.Reference.Data = String(wholeDoc.Object.ID); bound++;
      }
  for (const c of s.Children ?? []) bind(c);
})(panel.doc.Object);

// ── the blobs those assets point at ──────────────────────────────────────────
const wanted = new Set();
(function w(o) {
  if (Array.isArray(o)) return o.forEach(w);
  if (!o || typeof o !== 'object') return;
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v.startsWith('@packdb:///')) wanted.add(v.slice(11));
    else w(v);
  }
})({ Object: wholeDoc.Object, Assets: wholeDoc.Assets });

const have = new Set(Object.keys(panel.zip.files).filter((n) => n.startsWith('Assets/')).map((n) => n.slice(7)));
const carried = [], absent = [];
for (const hash of wanted) {
  if (have.has(hash)) continue;                       // already in the panel, shared
  const blob = deck.zip.file(`Assets/${hash}`);
  if (!blob) { absent.push(hash); continue; }         // a stripped placeholder; the bake fills it
  carried.push({ hash, bytes: await blob.async('nodebuffer'),
                 meta: deck.zip.file(`Metadata/${hash}.bitmap`) });
}

// ── write ────────────────────────────────────────────────────────────────────
const newFrdt = Buffer.from(await bsonBytesToFrdt(await serializeBson(panel.doc)));
const newHash = sha256(newFrdt);

const out = new JSZip();
for (const [n, f] of Object.entries(panel.zip.files)) {
  if (f.dir || n === 'R-Main.record' || n === `Assets/${panel.hash}`) continue;
  out.file(n, await f.async('nodebuffer'));
}
for (const c of carried) {
  out.file(`Assets/${c.hash}`, c.bytes);
  if (c.meta) out.file(`Metadata/${c.hash}.bitmap`, await c.meta.async('nodebuffer'));
}
out.file(`Assets/${newHash}`, newFrdt);

panel.record.assetUri = `packdb:///${newHash}`;
panel.record.name = args.recordName || 'ResoPal Panel';
panel.record.assetManifest = [
  ...panel.record.assetManifest.filter((e) => e.hash !== panel.hash),
  ...carried.map((c) => ({ hash: c.hash, bytes: c.bytes.length })),
  { hash: newHash, bytes: newFrdt.length },
];
out.file('R-Main.record', JSON.stringify(panel.record));

await mkdir(path.dirname(OUT), { recursive: true });
const bytes = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(OUT, bytes);

const cards = (() => {
  const surface = (wholeDoc.Object.Children ?? []).find((c) => nm(c).startsWith('Surface'));
  return ((surface?.Children ?? [])[0]?.Children ?? []).length;
})();

console.log(`\n✓ ${OUT}`);
console.log(`  ${(bytes.length / 1048576).toFixed(2)} MB  (panel ${(await readFile(PANEL)).length / 1048576 | 0}+ MB, deck folded in)`);
console.log(`  "${SLOT_NAME}" holder inactive, deck active, ${cards} cards, ids from ${newId.start.toString(16)}`);
console.log(`  ${SPREAD_VAR} bound to the spread toggle; ${bound} importer reference(s) pointed at the deck`);
console.log(`  deck posed at [${DECK_POSITION.join(', ')}] rot [${DECK_ROTATION.map((v) => v.toFixed(3)).join(', ')}] scale 1 (it exported at ${fmtExported})`);
console.log(`  ${mapType.appended.length} types appended, ${carried.length} blobs carried, ${absent.length} left to the bake`);
console.log(`  ${wholeDoc.Assets.length} asset entries folded into doc.Assets\n`);
