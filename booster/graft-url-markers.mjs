// Repair unmarked `Sync<Uri>` values in a packed package, in place.
//
// A url field is `@` + the url (see urlmarker.mjs). A package built before that
// was understood carries the url without its marker, the field loads as null, and
// the asset silently never appears. The builders are fixed, but a REBUILD is not
// how a fix ships here: `out/ResoPal_Panel.resonitepackage` was hand-packed
// in-world through Moduprint and rebuilding throws that layout away
// (docs/HANDOFF.md, "The one thing that will bite you").
//
// So this grafts. It changes string values and nothing else - no ids, no
// components, no slots, no node positions - which makes it the smallest possible
// edit to a packed file, and it proves that rather than asserting it: the document
// is decoded before and after, walked in lockstep, and the run fails unless every
// single difference is one of the url values it set out to mark.
//
//   node booster/graft-url-markers.mjs pkg=out/ResoPal_Panel.resonitepackage
//   node booster/graft-url-markers.mjs pkg=... check      # report only, write nothing

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { scanUrlFields, isUrlValueField } from './urlmarker.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const codec = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(codec)) throw new Error(`No ${codec}. Set RKL=<knowledge library checkout>.`);
const { frdtToBsonBytes, bsonBytesToFrdt, deserializeBson, serializeBson } = await import(`file://${codec}`);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)];
}));
const PKG = args.pkg || path.join(import.meta.dirname, 'out', 'ResoPal_Panel.resonitepackage');
const CHECK_ONLY = !!args.check;

const original = await readFile(PKG);
const zip = await JSZip.loadAsync(original);
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const oldHash = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
const oldBson = await frdtToBsonBytes(new Uint8Array(await zip.file(`Assets/${oldHash}`).async('uint8array')));
const doc = await deserializeBson(oldBson);

const before = scanUrlFields(doc);
console.log(`${path.basename(PKG)}: ${before.marked.length} url fields marked, ${before.unmarked.length} unmarked`);
for (const u of before.unmarked) console.log(`  unmarked  ${u.field} = ${u.value}`);
if (!before.unmarked.length) { console.log('  nothing to graft'); process.exit(0); }
if (CHECK_ONLY) process.exit(1);

// ── the edit ─────────────────────────────────────────────────────────────────
const expected = new Set();
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && isUrlValueField(k, v.Data) && !v.Data.startsWith('@')) {
      expected.add(`${v.ID}:${v.Data}`);
      v.Data = '@' + v.Data;
    }
    walk(v);
  }
})(doc);

const after = scanUrlFields(doc);
if (after.unmarked.length) throw new Error(`${after.unmarked.length} url fields still unmarked`);

// ── prove nothing else moved ─────────────────────────────────────────────────
// Both documents are walked together along identical paths. Any structural
// difference shows up as a shape mismatch and any value difference has to be one
// of the marks above, or this refuses to write.
const fresh = await deserializeBson(oldBson);
const diffs = [];
(function cmp(a, b, p) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    const av = a && a._bsontype ? String(a) : a, bv = b && b._bsontype ? String(b) : b;
    if (av !== bv) diffs.push({ path: p, from: av, to: bv });
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return diffs.push({ path: p, from: 'array?', to: 'shape changed' });
  if (a._bsontype || b._bsontype) {
    if (String(a) !== String(b)) diffs.push({ path: p, from: String(a), to: String(b) });
    return;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i]))
    return diffs.push({ path: p, from: ka.join(','), to: kb.join(',') });
  for (const k of ka) cmp(a[k], b[k], p ? `${p}.${k}` : k);
})(fresh, doc, '');

console.log(`\n  ${diffs.length} value(s) changed, ${expected.size} intended:`);
for (const d of diffs) console.log(`    ${d.path}\n      ${d.from}\n   -> ${d.to}`);
const unintended = diffs.filter((d) => !(typeof d.to === 'string' && d.to === '@' + d.from));
if (unintended.length) throw new Error(`refusing to write: ${unintended.length} change(s) are not url marks`);
if (diffs.length !== expected.size) throw new Error(`expected ${expected.size} changes, found ${diffs.length}`);

// ── rewrite ──────────────────────────────────────────────────────────────────
// Only the main blob changes, so only its hash and its manifest entry move. Every
// other blob is copied through untouched.
const newFrdt = Buffer.from(await bsonBytesToFrdt(await serializeBson(doc)));
const newHash = sha256(newFrdt);
const out = new JSZip();
for (const [n, f] of Object.entries(zip.files)) {
  if (f.dir || n === 'R-Main.record' || n === `Assets/${oldHash}`) continue;
  out.file(n, await f.async('nodebuffer'));
}
out.file(`Assets/${newHash}`, newFrdt);
record.assetUri = `packdb:///${newHash}`;
record.assetManifest = [
  ...record.assetManifest.filter((e) => e.hash !== oldHash),
  { hash: newHash, bytes: newFrdt.length },
];
out.file('R-Main.record', JSON.stringify(record));
await writeFile(PKG, await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

console.log(`\n  grafted into ${path.basename(PKG)}`);
console.log(`  main blob ${oldHash.slice(0, 12)} -> ${newHash.slice(0, 12)}, every other blob copied through`);
