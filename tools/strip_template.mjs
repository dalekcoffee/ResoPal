// Shrink a baked Deck Maker export into the template the website ships.
//
// A raw export is ~21 MB, but most of that is data patch.js throws away on every
// single bake: the fallback font chain, plus the placeholder atlas and card back
// that get swapped out. Stripping them offline once means the site downloads a
// few MB instead of twenty before it can build anything.
//
//   node strip_template.mjs src=DeckRounded.resonitepackage out=template.resonitepackage
//
// The doc is left untouched - patch.js still runs its own font strip and texture
// swap, they just find less to do. Only the ZIP payloads and the manifest entries
// for them are removed. Metadata/*.bitmap sidecars are KEPT: patch.js reads the
// old ones to build the new ones.

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { frdtToBsonBytes, deserializeBson } from './decode.mjs';
const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const OLD_ATLAS = '971a5f8b1153061fc65a30f2a00dfc1ea5f305d3f1629a84bda31afece70766c';
const OLD_BACK  = '1456016c0996fa34c066751023d63ca055136dfc73e8de53e2e18051ec2f5632';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; }));
const zip = await JSZip.loadAsync(await readFile(args.src));
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const frdt = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
const doc = await deserializeBson(await frdtToBsonBytes(new Uint8Array(await zip.file(`Assets/${frdt}`).async('uint8array'))));

// same scan patch.mjs uses: every StaticFont in a FallbackFonts chain is dead weight
const keep = new Set(), drop = new Set();
(function scan(o) {
  if (Array.isArray(o)) return o.forEach(scan);
  if (o && typeof o === 'object') {
    if (o.MainFont && o.FallbackFonts) {
      keep.add(o.MainFont.Data);
      for (const f of (o.FallbackFonts.Data || [])) drop.add(f.Data);
    }
    for (const k in o) scan(o[k]);
  }
})(doc);
for (const k of keep) drop.delete(k);

const blobs = new Set([OLD_ATLAS, OLD_BACK]);
for (const a of (doc.Assets || [])) {
  const id = a.Data && a.Data.ID;
  if (id && drop.has(id)) {
    const u = a.Data.URL && a.Data.URL.Data;
    if (u) blobs.add(String(u).replace(/^@?packdb:\/\/\//, ''));
  }
}

const out = new JSZip();
let removed = 0, freed = 0;
for (const [name, f] of Object.entries(zip.files)) {
  if (f.dir) continue;
  const hash = name.startsWith('Assets/') ? name.slice(7) : null;
  if (hash && blobs.has(hash)) {
    freed += (await f.async('uint8array')).length; removed++;
    continue;                                   // Metadata/<hash>.bitmap is NOT touched
  }
  if (name === 'R-Main.record') continue;
  out.file(name, await f.async('nodebuffer'));
}
record.assetManifest = record.assetManifest.filter(e => !blobs.has(e.hash));
out.file('R-Main.record', JSON.stringify(record));

const bytes = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(args.out, bytes);
const before = (await readFile(args.src)).length;
console.log(`  dropped ${removed} asset blobs (${(freed / 1048576).toFixed(2)}MB uncompressed): ${drop.size} fallback fonts + placeholder atlas + placeholder back`);
console.log(`  ${args.src} ${(before / 1048576).toFixed(2)}MB -> ${args.out} ${(bytes.length / 1048576).toFixed(2)}MB`);
