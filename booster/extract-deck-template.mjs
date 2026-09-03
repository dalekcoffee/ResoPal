#!/usr/bin/env node
/**
 * Lift the v1.0 deck template out of the panel and write it as a standalone package.
 *
 * The panel carries a `Deck template` subtree that it duplicates and fills on every
 * import. The site has to produce the SAME deck, so it takes the same subtree rather
 * than growing its own copy - the two paths then stay identical by construction
 * instead of by discipline, which is the reason the panel and a standalone deck
 * drifted apart the first time (docs/PANEL-V1.md, "credits").
 *
 * Extraction rather than a build, because this deck is Deck Maker's holder with
 * Sharkmake's DeckReader card in every buffer and neither is ours to author. It is
 * moved, never rebuilt.
 *
 * ── what makes this safe ─────────────────────────────────────────────────────
 *
 * The subtree keeps the panel's ids. They are already unique inside that document,
 * and a document that no longer contains anything else cannot collide with them, so
 * nothing is remapped and nothing can be remapped WRONG. splice.mjs exists for the
 * opposite direction - moving a subtree INTO a populated document - and is not
 * needed here.
 *
 * Two tables do have to shrink, and both are pruned by reachability, never by name:
 *
 *   Types    a component's `Type` is an INDEX into it, so dropping an entry
 *            renumbers every index above it. Collected from the kept components and
 *            assets, then remapped in one pass.
 *   Assets   assets reference each other (FontChain -> StaticFont,
 *            material -> SpriteProvider), so reachability is iterated to a fixpoint.
 *            CLAUDE.md's reference-counting rule, one document up: the walk that
 *            only looked at `doc.Object` deleted MainFont and broke every button.
 *
 *   node booster/extract-deck-template.mjs [panel=out/ResoPal_Panel_v1.0.resonitepackage]
 *                                          [out=data/template.resonitepackage]
 *                                          [name="ResoPal deck template v1.0"]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { Int32 } = require('bson');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const ROOT = path.resolve(import.meta.dirname, '..');
const RKL = process.env.RKL || path.resolve(ROOT, '..', 'Resonite-Knowledge-Library');
const codec = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(codec)) throw new Error(
  `No ${codec}.\nClone the Resonite Knowledge Library and point RKL at it:\n` +
  `  RKL=/path/to/Resonite-Knowledge-Library node booster/extract-deck-template.mjs\n`);
const { frdtToBsonBytes, bsonBytesToFrdt, deserializeBson, serializeBson } = await import(`file://${codec}`);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)];
}));
const PANEL = args.panel || path.join(ROOT, 'booster', 'out', 'ResoPal_Panel_v1.0.resonitepackage');
// Straight to the file the site fetches. There is no strip step any more:
// tools/strip_template.mjs existed to throw away the placeholder atlas, the
// placeholder back and the fallback fonts that patch.js replaced on every bake, and
// a v1.0 template has none of those - the reachability prune below is the strip.
const OUT = args.out || path.join(ROOT, 'data', 'template.resonitepackage');
const NAME = args.name || 'ResoPal deck template v1.0';

const num = (v) => (v && typeof v === 'object' && v._bsontype ? Number(v) : v);
const nm = (s) => String(s?.Name?.Data ?? '');
const kid = (s, n) => (s.Children ?? []).find((c) => nm(c) === n);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── read the panel ───────────────────────────────────────────────────────────
const raw = await readFile(PANEL);
const zip = await JSZip.loadAsync(raw);
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const oldFrdt = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
const doc = await deserializeBson(await frdtToBsonBytes(await zip.file(`Assets/${oldFrdt}`).async('uint8array')));

const holder = kid(doc.Object, 'Deck template');
if (!holder) throw new Error(`no "Deck template" slot under ${nm(doc.Object)}`);
if ((holder.Children ?? []).length !== 1)
  throw new Error(`"Deck template" holds ${(holder.Children ?? []).length} children, expected exactly 1`);
const deck = holder.Children[0];
if (nm(deck) !== 'Deck') throw new Error(`the deck template's root is named "${nm(deck)}", expected "Deck"`);

// The subtree is parked inside the panel: the holder is inactive and the deck sits
// at the panel's shoulder, turned side-on. A standalone package is spawned wherever
// the importer drops it, so the pose is reset rather than carried - a template that
// arrives rotated is a template every caller has to correct.
deck.Position.Data = [0, 0, 0].map((v) => new (require('bson').Double)(v));
deck.Rotation.Data = [0, 0, 0, 1].map((v) => new (require('bson').Double)(v));
if (deck.Active.Data !== true) throw new Error('the deck template root is inactive; a standalone deck must be active');

// ── prune the asset table by reachability ────────────────────────────────────
// Everything the kept OBJECT graph names, then everything those assets name, until
// nothing new appears. An asset reached only by the panel's own UI drops out.
const assetById = new Map((doc.Assets ?? []).map((a) => [a.Data.ID, a]));
const idsIn = (node) => {
  const out = new Set();
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') { if (GUID.test(v)) out.add(v); }
      else w(v);
    }
  })(node);
  return out;
};

const reachable = new Set();
let frontier = idsIn(deck);
while (frontier.size) {
  const next = new Set();
  for (const id of frontier) {
    const a = assetById.get(id);
    if (!a || reachable.has(id)) continue;
    reachable.add(id);
    for (const ref of idsIn(a)) if (assetById.has(ref) && !reachable.has(ref)) next.add(ref);
  }
  frontier = next;
}
const keptAssets = (doc.Assets ?? []).filter((a) => reachable.has(a.Data.ID));
const droppedAssets = (doc.Assets ?? []).filter((a) => !reachable.has(a.Data.ID));
if (!keptAssets.length) throw new Error('reachability kept no assets at all - the walk is wrong');

// ── the new document ─────────────────────────────────────────────────────────
const out = {
  VersionNumber: doc.VersionNumber,
  FeatureFlags: doc.FeatureFlags,
  Types: doc.Types,
  TypeVersions: doc.TypeVersions,
  Object: deck,
  Assets: keptAssets,
};
if (out.FeatureFlags === undefined) delete out.FeatureFlags;
if (out.TypeVersions === undefined) delete out.TypeVersions;

// ── prune and remap the type table ───────────────────────────────────────────
// `Type` is an index, so a dropped entry silently renumbers everything above it and
// every component comes back as the wrong class. Collect first, remap second, and
// only ever through the map built here.
const usedIdx = new Set();
(function w(o) {
  if (Array.isArray(o)) return o.forEach(w);
  if (!o || typeof o !== 'object') return;
  if (o.Type !== undefined && o.Data && o.Data.ID) usedIdx.add(num(o.Type));
  for (const v of Object.values(o)) w(v);
})(out);

const oldTypes = doc.Types;
const keptTypes = [...usedIdx].sort((a, b) => a - b);
const remap = new Map(keptTypes.map((oldI, newI) => [oldI, newI]));
out.Types = keptTypes.map((i) => oldTypes[i]);
if (out.TypeVersions) {
  const keepNames = new Set(out.Types.map(String));
  out.TypeVersions = Object.fromEntries(
    Object.entries(out.TypeVersions).filter(([n]) => keepNames.has(n)));
}
let retyped = 0;
(function w(o) {
  if (Array.isArray(o)) return o.forEach(w);
  if (!o || typeof o !== 'object') return;
  if (o.Type !== undefined && o.Data && o.Data.ID) {
    const to = remap.get(num(o.Type));
    if (to === undefined) throw new Error(`type index ${num(o.Type)} was never collected`);
    o.Type = new Int32(to);
    retyped++;
  }
  for (const v of Object.values(o)) w(v);
})(out);

// ── assert before writing ────────────────────────────────────────────────────
// A dangling reference here is a card that silently loses its art or a drive that
// binds to nothing, and neither says anything in-world.
const declKey = (k) => k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k);
const declared = new Set(), referenced = new Set();
(function w(o) {
  if (Array.isArray(o)) return o.forEach(w);
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && GUID.test(v)) (declKey(k) ? declared : referenced).add(v);
    else w(v);
  }
})(out);
// ParentReference is rebuilt from the nesting on import, so a stale one is expected
// and harmless; every other reference has to resolve.
const parentRefs = new Set();
(function w(o) {
  if (Array.isArray(o)) return o.forEach(w);
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'ParentReference' && typeof v === 'string') parentRefs.add(v);
    else w(v);
  }
})(out);
const dangling = [...referenced].filter((id) => !declared.has(id) && !parentRefs.has(id));
if (dangling.length) throw new Error(
  `${dangling.length} dangling reference(s) after extraction, first: ${dangling[0]}`);

const cards = kid(kid(deck, 'Surface/cards'), 'Cards');
const proxies = (kid(deck, 'Assets').Children ?? []).filter((c) => nm(c) === 'proxy');
if (!cards) throw new Error('no Surface/cards -> Cards slot in the extracted deck');
if (cards.Children.length !== proxies.length) throw new Error(
  `${cards.Children.length} buffers but ${proxies.length} /Assets driver proxies - they are 1:1`);
if (!kid(deck, 'credits')) throw new Error('the extracted deck carries no /credits slot');

// ── write ────────────────────────────────────────────────────────────────────
const newFrdt = Buffer.from(await bsonBytesToFrdt(await serializeBson(out)));
const newFrdtHash = sha256(newFrdt);

// Only the blobs the kept assets still name. Everything else was the panel's UI.
const keepHashes = new Set();
for (const a of keptAssets) {
  const u = a.Data?.URL?.Data;
  if (typeof u === 'string' && u.includes('packdb:///'))
    keepHashes.add(u.replace(/^@?packdb:\/\/\//, ''));
}
const outZip = new JSZip();
let carried = 0, dropped = 0;
for (const [n, f] of Object.entries(zip.files)) {
  if (f.dir || n === 'R-Main.record') continue;
  const m = /^(Assets|Metadata)\/([0-9a-f]{64})/.exec(n);
  if (m && !keepHashes.has(m[2])) { dropped++; continue; }
  if (!m) { dropped++; continue; }          // the old main blob and anything unrecognised
  outZip.file(n, await f.async('nodebuffer'));
  carried++;
}
outZip.file(`Assets/${newFrdtHash}`, newFrdt);

record.assetUri = `packdb:///${newFrdtHash}`;
record.name = NAME;
record.assetManifest = [
  ...record.assetManifest.filter((e) => keepHashes.has(e.hash)),
  { hash: newFrdtHash, bytes: newFrdt.length },
];
outZip.file('R-Main.record', JSON.stringify(record));

await mkdir(path.dirname(OUT), { recursive: true });
const bytes = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(OUT, bytes);

console.log(`\n✓ ${OUT}`);
console.log(`  ${(raw.length / 1048576).toFixed(2)} MB panel -> ${(bytes.length / 1048576).toFixed(2)} MB template`);
console.log(`  buffers ${cards.Children.length}  /Assets driver proxies ${proxies.length}  (1:1)`);
console.log(`  types ${oldTypes.length} -> ${out.Types.length}   components retyped ${retyped}`);
console.log(`  assets ${(doc.Assets ?? []).length} -> ${keptAssets.length}   blobs carried ${carried}, dropped ${dropped}`);
console.log(`  dangling references: 0\n`);
if (droppedAssets.length) {
  const byType = {};
  for (const a of droppedAssets) {
    const t = String(oldTypes[num(a.Type)]).replace(/^\[[^\]]+\]/, '').split('.').pop();
    byType[t] = (byType[t] || 0) + 1;
  }
  console.log(`  dropped assets: ${Object.entries(byType).map(([t, n]) => `${t}x${n}`).join(', ')}\n`);
}
