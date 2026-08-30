// Check the built deck probe, against the meshes rather than against the builder.
//
// The claim under test is arithmetic on geometry: that a card's front-face UVs,
// pushed through its material's `TextureScale`/`TextureOffset`, land exactly on
// the whole of its own texture. So the test does not re-derive the offsets from
// the card index - that would only prove the builder agrees with itself. It
// decodes each card's real MeshX blob, reads submesh 1's UV corners, applies the
// ST the package actually carries, and asserts the result is the unit square.
//
// If the sign of the V offset were wrong, or rows counted from the wrong edge,
// this fails. That is the whole point: docs/PIPELINE.md's atlas contract is prose,
// and prose is what the landscape-rotation bug was checked against twice.
//
//   RKL=/path/to/Resonite-Knowledge-Library node booster/test-deck-probe.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { readMeshX, submeshUVBounds } from './meshx.mjs';
import { scanUrlFields } from './urlmarker.mjs';

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const decodeMjs = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(decodeMjs)) { console.error('Need the Knowledge Library for its codec; set RKL=<path>'); process.exit(1); }
const { frdtToBsonBytes, deserializeBson, serializeBson } = await import(`file://${decodeMjs}`);

const pkg = process.argv[2] || path.join(import.meta.dirname, 'out', 'ResoPal_DeckProbe.resonitepackage');
const raw = await readFile(pkg);
const zip = await JSZip.loadAsync(raw);
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const mainHash = record.assetUri.replace(/^@?packdb:\/\/\//, '');
const bson = await frdtToBsonBytes(await zip.file('Assets/' + mainHash).async('uint8array'));
const doc = await deserializeBson(bson);

const num = (v) => (v && typeof v === 'object' && v._bsontype ? Number(v) : v);
const f2 = (a) => a.map(num);
const short = (t) => String(t).replace(/^\[[^\]]+\]/, '').split('.').pop();
const nm = (s) => String(s?.Name?.Data ?? '');
const kids = (s) => s.Children ?? [];
const typeName = (e) => String(doc.Types?.[num(e?.Type)] ?? '');

let bad = 0;
const check = (n, ok, d = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${!ok && d ? '  ' + d : ''}`); };
const note = (s) => console.log(`  note ${s}`);

console.log(`${path.basename(pkg)}  (${raw.length} bytes)\n`);

// ── locate ───────────────────────────────────────────────────────────────────
const rootKids = kids(doc.Object);
const assetsSlot = rootKids.find((c) => nm(c) === 'Assets');
const surface = rootKids.find((c) => nm(c).startsWith('Surface'));
const cardsParent = kids(surface)[0];
const cardSlots = kids(cardsParent);
const FRONT_SLOT = 1;

const assetById = new Map(doc.Assets.map((a) => [a.Data.ID, a]));
const matById = new Map(assetsSlot.Components.Data.map((c) => [c.Data.ID, c]));
const meshBlob = async (id) => {
  const a = assetById.get(id);
  const hash = String(a.Data.URL.Data).replace(/^@?packdb:\/\/\//, '');
  return Buffer.from(await zip.file(`Assets/${hash}`).async('uint8array'));
};

console.log('the deck still looks like a deck:');
check('cards and their driver proxies stay 1:1', kids(assetsSlot).length === cardSlots.length,
  `${kids(assetsSlot).length} proxies vs ${cardSlots.length} cards`);
check('GridFrames follows the card count',
  JSON.stringify(doc).includes(`"GridFrames"`) && (() => {
    let ok = true;
    (function w(o) {
      if (Array.isArray(o)) return o.forEach(w);
      if (!o || typeof o !== 'object') return;
      if (o.GridSize && o.GridFrames && f2(o.GridSize.Data)[0] > 1) ok = ok && num(o.GridFrames.Data) === cardSlots.length;
      for (const k in o) w(o[k]);
    })(doc.Object);
    return ok;
  })());
check('the credits are still there', (() => {
  const c = rootKids.find((s) => nm(s) === 'credits');
  return c && kids(c).length === 3 && kids(c).some((s) => nm(s).includes('Ukilop')) &&
    kids(c).some((s) => nm(s).includes('Palify')) && kids(c).some((s) => nm(s).includes('ResoPal'));
})());

// ── the claim ────────────────────────────────────────────────────────────────
console.log('\nevery card samples the whole of its own texture:');
const EPS = 1e-4;
const seenMat = new Set(), seenTex = new Set(), seenUrl = new Set();

for (let i = 0; i < cardSlots.length; i++) {
  const visual = kids(kids(kids(cardsParent)[i])[0])[0];
  const renderer = visual.Components.Data.find((c) => /MeshRenderer/.test(typeName(c)));
  const mats = renderer.Data.Materials.Data.map((m) => m.Data);

  const mat = matById.get(mats[FRONT_SLOT]);
  if (!mat) { check(`card ${i} front material is on /Assets`, false, mats[FRONT_SLOT]); continue; }

  const [sx, sy] = f2(mat.Data.TextureScale.Data);
  const [ox, oy] = f2(mat.Data.TextureOffset.Data);
  const mesh = readMeshX(await meshBlob(renderer.Data.Mesh.Data));
  const { minU, maxU, minV, maxV } = submeshUVBounds(mesh, FRONT_SLOT);

  // Unity's _MainTex_ST convention, which is what MaterialUpdateWriter.UpdateST
  // packs: sampled = uv * scale + offset.
  const u0 = minU * sx + ox, u1 = maxU * sx + ox;
  const v0 = minV * sy + oy, v1 = maxV * sy + oy;
  const unit = Math.abs(u0) < EPS && Math.abs(u1 - 1) < EPS && Math.abs(v0) < EPS && Math.abs(v1 - 1) < EPS;

  check(`card ${i}: cell UV -> the unit square`, unit,
    `got u [${u0.toFixed(4)}, ${u1.toFixed(4)}] v [${v0.toFixed(4)}, ${v1.toFixed(4)}]`);

  // Distinctness is the other half: the right maths on a shared material would
  // give every card the same art and still pass the check above.
  seenMat.add(mats[FRONT_SLOT]);
  const tex = assetById.get(mat.Data.Texture.Data);
  seenTex.add(mat.Data.Texture.Data);
  seenUrl.add(String(tex?.Data?.URL?.Data ?? ''));

  check(`card ${i}: edge and back materials untouched`,
    mats[0] !== mats[FRONT_SLOT] && mats[2] !== mats[FRONT_SLOT] && mats.length === 3);
  check(`card ${i}: art is a marked http url at the in-world width`,
    /^@https?:\/\/\S+\/img\/[A-Z0-9-]+\?w=512$/.test(String(tex?.Data?.URL?.Data ?? '')),
    String(tex?.Data?.URL?.Data));
  check(`card ${i}: its texture clamps rather than repeats`,
    tex?.Data?.WrapModeU?.Data === 'Clamp' && tex?.Data?.WrapModeV?.Data === 'Clamp',
    `${tex?.Data?.WrapModeU?.Data}/${tex?.Data?.WrapModeV?.Data}`);
  check(`card ${i}: front face is Cutout at 0.72`,
    mat.Data.BlendMode.Data === 'Cutout' && Math.abs(num(mat.Data.AlphaCutoff.Data) - 0.72) < 1e-9,
    `${mat.Data.BlendMode.Data} @ ${num(mat.Data.AlphaCutoff.Data)}`);
}

check('no two cards share a front material', seenMat.size === cardSlots.length, `${seenMat.size} distinct`);
check('no two cards share a texture', seenTex.size === cardSlots.length, `${seenTex.size} distinct`);
check('no two cards share an art url', seenUrl.size === cardSlots.length, `${seenUrl.size} distinct`);

// The edge and back stay shared - per-card materials are for the front only.
const edges = new Set(), backs = new Set();
for (let i = 0; i < cardSlots.length; i++) {
  const r = kids(kids(kids(cardsParent)[i])[0])[0].Components.Data.find((c) => /MeshRenderer/.test(typeName(c)));
  edges.add(r.Data.Materials.Data[0].Data); backs.add(r.Data.Materials.Data[2].Data);
}
check('all cards still share one edge material', edges.size === 1);
check('all cards still share one back material', backs.size === 1);

// ── package integrity ────────────────────────────────────────────────────────
// Measured against the SOURCE template rather than against zero, because
// data/template.resonitepackage is a stripped export: tools/strip_template.mjs
// drops the placeholder atlas, the placeholder back and the fallback fonts but
// deliberately leaves the document untouched, so it ships six `@packdb:///`
// references with no blob and two blobs outside the manifest. Those are the bake's
// to fill in. Asserting absolute zero here would fail on a package that is fine;
// what matters is that the probe adds none of its own.
//
// Id integrity IS absolute: under the declaration rule below the stock template
// has zero dangling references and zero duplicates, so anything here is ours.
console.log('\nthe package holds together:');

const GUID = /^[0-9a-f]{8}-0000-0000-0000-000000000000$/;
const NULL_GUID = '00000000-0000-0000-0000-000000000000';
const isDeclarationKey = (k) => k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k);

function survey(doc, zip, record) {
  const declared = new Map(), referenced = new Set(), packdb = new Set();
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') {
        if (GUID.test(v)) {
          if (isDeclarationKey(k)) declared.set(v, (declared.get(v) || 0) + 1);
          else referenced.add(v);
        }
        if (v.startsWith('@packdb:///')) packdb.add(v.slice(11));
      } else w(v);
    }
  })(doc);
  const blobs = new Set(Object.keys(zip.files).filter((n) => n.startsWith('Assets/')).map((n) => n.slice(7)));
  const manifest = new Set(record.assetManifest.map((e) => e.hash));
  return {
    declared, referenced, packdb, blobs, manifest,
    dangling: new Set([...referenced].filter((r) => r !== NULL_GUID && !declared.has(r))),
    dupes: [...declared].filter(([, n]) => n > 1).map(([i]) => i),
    missingBlob: new Set([...packdb].filter((h) => !blobs.has(h))),
    unlisted: new Set([...blobs].filter((b) => !manifest.has(b))),
    ghosts: new Set([...manifest].filter((m) => !blobs.has(m))),
  };
}

const here = survey(doc, zip, record);

const srcPath = process.env.TEMPLATE || path.join(import.meta.dirname, '..', 'data', 'template.resonitepackage');
const srcZip = await JSZip.loadAsync(await readFile(srcPath));
const srcRecord = JSON.parse(await srcZip.file('R-Main.record').async('string'));
const srcDoc = await deserializeBson(await frdtToBsonBytes(
  await srcZip.file('Assets/' + String(srcRecord.assetUri).replace(/^@?packdb:\/\/\//, '')).async('uint8array')));
const base = survey(srcDoc, srcZip, srcRecord);

// The rule earns its own assertion: if the stock template ever stops being clean
// under it, the rule is wrong and every check below is measuring nothing.
check('the declaration rule reads the stock template as clean',
  base.dangling.size === 0 && base.dupes.length === 0,
  `template: ${base.dangling.size} dangling, ${base.dupes.length} duplicated`);

check('every id is declared exactly once', here.dupes.length === 0, here.dupes.slice(0, 3).join(', '));
check('no reference dangles', here.dangling.size === 0, [...here.dangling].slice(0, 3).join(', '));
note(`${here.declared.size} ids declared, ${here.referenced.size} referenced`);

const added = (a, b) => [...a].filter((x) => !b.has(x));
check('adds no packdb reference without a blob', added(here.missingBlob, base.missingBlob).length === 0,
  added(here.missingBlob, base.missingBlob).slice(0, 3).join(', '));
check('adds no blob the manifest does not list', added(here.unlisted, base.unlisted).length === 0,
  added(here.unlisted, base.unlisted).slice(0, 3).join(', '));
check('the manifest lists nothing that is not there', here.ghosts.size === 0, [...here.ghosts].slice(0, 3).join(', '));

// A Sync<Uri> value is `@` + the url. Without the marker the field loads as null,
// which is exactly how three blank cards got shipped. The stock template carries
// 62 of these and misses none, so it is the oracle for the rule as well.
const urls = scanUrlFields(doc), baseUrls = scanUrlFields(srcDoc);
check('the stock template marks every url it has', baseUrls.unmarked.length === 0 && baseUrls.marked.length > 0,
  `${baseUrls.marked.length} marked, ${baseUrls.unmarked.length} unmarked`);
check('every url field carries its @ marker', urls.unmarked.length === 0,
  urls.unmarked.slice(0, 3).map((u) => `${u.field}=${u.value}`).join(', '));
note(`${urls.marked.length} url fields, all marked`);
check('assetUri resolves to a present blob', here.blobs.has(mainHash));
note(`${here.packdb.size} packdb references over ${here.blobs.size} blobs` +
  ` (${base.missingBlob.size} placeholders the bake fills in, inherited)`);

// Every card's own art and geometry must resolve, whatever the inherited gaps are.
let cardBlobs = 0;
for (let i = 0; i < cardSlots.length; i++) {
  const r = kids(kids(kids(cardsParent)[i])[0])[0].Components.Data.find((c) => /MeshRenderer/.test(typeName(c)));
  const meshHash = String(assetById.get(r.Data.Mesh.Data).Data.URL.Data).replace(/^@?packdb:\/\/\//, '');
  if (here.blobs.has(meshHash)) cardBlobs++;
}
check('every card mesh blob is present', cardBlobs === cardSlots.length, `${cardBlobs}/${cardSlots.length}`);
check('BSON round-trips byte-identical', Buffer.from(await serializeBson(doc)).equals(Buffer.from(bson)));

console.log(bad ? `\n${bad} FAILED\n` : '\ndeck probe verified\n');
process.exit(bad ? 1 : 0);
