// Browser port of tools/patch.mjs. Swaps the two textures into a baked Deck
// Maker template, forces the card materials to Cutout, strips the unused
// fallback fonts, trims to N cards and builds the /credits slot.
//
// Every structural assumption is asserted. It fails loudly rather than emitting
// a package that imports wrong.

import JSZip from 'jszip';
import { frdtToDoc, docToFrdt } from './frdt.js';
import { trimToCards } from './trim.js';
import { addCredits } from './credits.js';

const OLD_ATLAS = '971a5f8b1153061fc65a30f2a00dfc1ea5f305d3f1629a84bda31afece70766c';
const OLD_BACK  = '1456016c0996fa34c066751023d63ca055136dfc73e8de53e2e18051ec2f5632';
const TEX_FRONT = '000000c5-0000-0000-0000-000000000000';
const TEX_BACK  = '00000057-0000-0000-0000-000000000000';
const CUTOFF = 0.72;

const enc = new TextEncoder();

async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * template : ArrayBuffer of a baked Deck Maker .resonitepackage
 * front/back : {bytes: Uint8Array, width, height}
 * Returns a Blob of the finished package.
 */
export async function patchPackage(template, { front, back, cards, name, edgeTint, log = () => {} }) {
  const zip = await JSZip.loadAsync(template);
  const record = JSON.parse(await zip.file('R-Main.record').async('string'));
  const oldFrdt = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
  const doc = await frdtToDoc(await zip.file(`Assets/${oldFrdt}`).async('uint8array'));

  // ---------- texture swaps ----------
  const swaps = [];
  for (const [oldHash, tex] of [[OLD_ATLAS, front], [OLD_BACK, back]]) {
    const newHash = await sha256(tex.bytes);
    const sidecar = JSON.parse(await zip.file(`Metadata/${oldHash}.bitmap`).async('string'));
    sidecar.assetIdenfitier = newHash;           // (sic) the field really is spelled this way
    sidecar.baseFormat = 'webp';
    sidecar.width = tex.width;
    sidecar.height = tex.height;
    swaps.push({ oldHash, newHash, bytes: tex.bytes, sidecar: enc.encode(JSON.stringify(sidecar)) });
    log(`  tex ${oldHash.slice(0, 8)} -> ${newHash.slice(0, 8)}  ${tex.width}x${tex.height}  ${(tex.bytes.length / 1048576).toFixed(2)}MB`);
  }

  // ---------- font strip: keep MainFont, drop fallbacks ----------
  const keepFonts = new Set(), dropFonts = new Set();
  (function scan(o) {
    if (Array.isArray(o)) return o.forEach(scan);
    if (o && typeof o === 'object') {
      if (o.MainFont && o.FallbackFonts) {
        keepFonts.add(o.MainFont.Data);
        for (const f of (o.FallbackFonts.Data || [])) dropFonts.add(f.Data);
        o.FallbackFonts.Data = [];               // clear the chain
      }
      for (const k in o) scan(o[k]);
    }
  })(doc);
  for (const k of keepFonts) dropFonts.delete(k);
  log(`  fonts: keeping ${keepFonts.size} main, dropping ${dropFonts.size} fallback`);

  const fontBlobs = new Set();
  const keptAssets = [];
  for (const a of (doc.Assets || [])) {
    const id = a.Data && a.Data.ID;
    if (id && dropFonts.has(id)) {
      const u = a.Data.URL && a.Data.URL.Data;
      if (u) fontBlobs.add(String(u).replace(/^@?packdb:\/\/\//, ''));
      continue;
    }
    keptAssets.push(a);
  }
  doc.Assets = keptAssets;
  log(`  font blobs removed: ${fontBlobs.size}`);

  // ---------- URL swap + material fixes ----------
  let urlHits = 0, blend = 0, cut = 0, edgeHits = 0;
  const targets = new Set([TEX_FRONT, TEX_BACK]);
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) if (k === 'Data' && typeof o[k] === 'string')
      for (const s of swaps) if (o[k].includes(s.oldHash)) { o[k] = o[k].replace(s.oldHash, s.newHash); urlHits++; }
    if (o.BlendMode && o.Texture && typeof o.Texture.Data === 'string' && targets.has(o.Texture.Data)) {
      // Opaque discards alpha outright, which squares off the rounded corners.
      // Cutout over Alpha: 50 stacked cards would other­wise fight the sorter.
      if (o.BlendMode.Data === 'Opaque') o.BlendMode.Data = 'Cutout';
      if (o.BlendMode.Data === 'Cutout') blend++;
      // plain JS number, NOT a BSON Double: assigning a Double here silently no-ops
      if (o.AlphaCutoff && o.AlphaCutoff.Data != null) { o.AlphaCutoff.Data = CUTOFF; cut++; }
    }
    if (edgeTint && o.TintColor && o.TextureScale && Array.isArray(o.TextureScale.Data)) {
      const ts = o.TextureScale.Data.map(v => (v && typeof v === 'object' && 'value' in v) ? v.value : Number(v));
      if (ts[1] > 10 && Array.isArray(o.TintColor.Data)) {     // the 100x-tiled edge stripe material
        for (let i = 0; i < 3; i++) o.TintColor.Data[i] = edgeTint[i];
        edgeHits++;
      }
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(doc);
  log(`  URL refs=${urlHits}  Cutout materials=${blend}  AlphaCutoff->${CUTOFF} on ${cut}  edgeTint=${edgeHits}`);
  if (urlHits !== swaps.length) throw new Error(`expected ${swaps.length} URL refs, got ${urlHits}`);
  if (cut < 1) throw new Error('AlphaCutoff never applied');
  if (blend < 2) throw new Error(`expected both card materials to end as Cutout, got ${blend}`);

  const trimmed = cards ? trimToCards(doc, cards, log) : [];
  addCredits(doc, log);

  const newFrdt = await docToFrdt(doc);
  const newFrdtHash = await sha256(newFrdt);

  // ---------- rebuild ----------
  const drop = new Set([`Assets/${oldFrdt}`, 'R-Main.record',
    ...swaps.flatMap(s => [`Assets/${s.oldHash}`, `Metadata/${s.oldHash}.bitmap`]),
    ...[...fontBlobs].map(h => `Assets/${h}`), ...trimmed.map(h => `Assets/${h}`)]);

  const out = new JSZip();
  for (const [n, f] of Object.entries(zip.files)) {
    if (f.dir || drop.has(n)) continue;
    out.file(n, await f.async('uint8array'));
  }
  for (const s of swaps) { out.file(`Assets/${s.newHash}`, s.bytes); out.file(`Metadata/${s.newHash}.bitmap`, s.sidecar); }
  out.file(`Assets/${newFrdtHash}`, newFrdt);

  const gone = new Set([oldFrdt, ...swaps.map(s => s.oldHash), ...fontBlobs, ...trimmed]);
  record.assetUri = `packdb:///${newFrdtHash}`;
  if (name) record.name = name;
  record.assetManifest = [...record.assetManifest.filter(e => !gone.has(e.hash)),
    ...swaps.map(s => ({ hash: s.newHash, bytes: s.bytes.length })),
    { hash: newFrdtHash, bytes: newFrdt.length }];
  out.file('R-Main.record', JSON.stringify(record));

  return out.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
