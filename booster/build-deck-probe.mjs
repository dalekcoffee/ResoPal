// Probe: can a Ukilop deck card be textured from its OWN image, with no atlas?
//
// docs/HANDOFF.md records "a Ukilop deck cannot be textured per card" as settled:
// every card owns a mesh with its atlas cell baked into the UVs, so card slot i
// shows cell i and nowhere else. The measurement is right; the conclusion missed
// one field. `UnlitMaterial` carries `TextureScale`/`TextureOffset`, which reach
// the shader as `_Tex_ST` (UnlitMaterial.UpdateMaterial -> MaterialUpdateWriter
// .UpdateST -> `float4(scale, offset)`), and Unity's ST convention samples at
// `uv * scale + offset`. So a cell can be blown back up to the whole texture:
//
//     card i sits at col = i % 10, row = floor(i / 10) of a 10x7 grid
//     its front UVs span [col/10, (col+1)/10] x [1-(row+1)/7, 1-row/7]
//     => TextureScale  = (10, 7)
//        TextureOffset = (-col, -(6 - row))
//
// Those UV spans are measured, not assumed: `_meshx.mjs` decodes the MeshX blob
// of each card mesh and reads submesh 1's UV bounding box. Card 0 came back at
// u [0, 0.1] v [0.857, 1], card 51 at u [0.1, 0.2] v [0.143, 0.286] - exactly
// col 1 / row 5. See docs/PIPELINE.md "The atlas contract".
//
// This probe isolates that one variable and nothing else. Three cards, three
// real card codes, art URLs written at BUILD time, no ProtoFlux anywhere. Drag
// it in and look:
//
//   each card shows its own card, right way up   -> the remap works
//   each card shows a sliver / the wrong crop    -> the offset formula is wrong
//   every card shows the same art                -> the materials did not split
//
// The card materials are CLONES of the template's own front material rather than
// components authored from scratch, because a clone cannot get its member order
// or its field set wrong - the same reason booster/build-panel.mjs clones
// BoxCollider and Grabbable rather than emitting them. Only URL, Texture and the
// two ST fields are touched.
//
//   node booster/build-deck-probe.mjs [cards=TD01-001,TD01-002,TD01-003] [out=...]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { addCredits } from '../tools/credits.mjs';
import { trimToCards } from '../tools/trim.mjs';

// The FrDT/BSON codec is the Knowledge Library's, not this repo's - the same one
// build-panel.mjs takes its ProtoFlux encoder from, found the same way.
const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const codec = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(codec)) throw new Error(
  `No ${codec}.\nClone the Resonite Knowledge Library and point RKL at it:\n` +
  `  RKL=/path/to/Resonite-Knowledge-Library node booster/build-deck-probe.mjs\n`);
const { frdtToBsonBytes, bsonBytesToFrdt, deserializeBson, serializeBson } = await import(`file://${codec}`);

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { Int32, Double } = require('bson');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const ROOT = path.resolve(import.meta.dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)];
}));

const PROXY = args.proxy || process.env.PROXY || 'https://resopal-proxy.dalek.workers.dev';
const IN_WORLD_WIDTH = 512;                       // worker/src/roll.js IN_WORLD_WIDTH
const CODES = String(args.cards || 'TD01-001,TD01-002,TD01-003').split(',').map((s) => s.trim()).filter(Boolean);
const SRC = args.src || path.join(ROOT, 'data', 'template.resonitepackage');
const OUT = args.out || path.join(ROOT, 'booster', 'out', 'ResoPal_DeckProbe.resonitepackage');

// The grid is baked into the mesh UVs and cannot move; see docs/PIPELINE.md.
const GRID_COLS = 10, GRID_ROWS = 7;
const CUTOFF = 0.72;                              // docs/PIPELINE.md "White rim on card corners"

// Card codes are never invented here: every one is checked against the committed
// pool snapshots, which is what CLAUDE.md's "Never invent card data" asks for.
const pools = await Promise.all(['bp01', 'td01', 'td02'].map(async (s) =>
  JSON.parse(await readFile(path.join(ROOT, 'data', `pool-${s}.json`), 'utf8'))));
const known = new Set(), landscape = new Set();
for (const p of pools) {
  for (const c of p.landscape ?? []) landscape.add(c);
  for (const tier of Object.values(p.byRarity ?? {})) for (const c of tier) known.add(c.code);
}
for (const code of CODES) {
  if (!known.has(code)) throw new Error(`${code} is not in any data/pool-*.json - verify it before using it`);
}

/**
 * TextureScale / TextureOffset that turn card slot `i`'s atlas cell back into
 * the whole of its own texture. Derived above, and asserted against the meshes
 * themselves by test-deck-probe.mjs.
 */
export function cellRemap(i, cols = GRID_COLS, rows = GRID_ROWS) {
  const col = i % cols, row = Math.floor(i / cols);
  return { scale: [cols, rows], offset: [-col, -(rows - 1 - row)], col, row };
}

// ── load ─────────────────────────────────────────────────────────────────────
const zip = await JSZip.loadAsync(await readFile(SRC));
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const oldFrdt = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
const doc = await deserializeBson(await frdtToBsonBytes(new Uint8Array(await zip.file(`Assets/${oldFrdt}`).async('uint8array'))));

const nm = (s) => String(s?.Name?.Data ?? '');
const kids = (s) => s.Children ?? [];
const typeName = (a) => {
  const t = a?.Type; const i = (t && typeof t === 'object') ? (t.value ?? t.valueOf?.()) : t;
  return String(doc.Types?.[i] ?? '');
};

// ── id allocation ────────────────────────────────────────────────────────────
// Ids in a Deck Maker export are `0000xxxx-0000-...`, allocated sequentially.
// New ones go strictly above the high-water mark so nothing can collide with a
// live reference. Every id in the document is counted, assets included.
let high = 0;
(function w(o) {
  if (Array.isArray(o)) return o.forEach(w);
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'string') {
      const m = /^([0-9a-f]{8})-0000-0000-0000-000000000000$/.exec(v);
      if (m) high = Math.max(high, parseInt(m[1], 16));   // references included: they name real ids
    } else w(v);
  }
})(doc);
let next = high + 0x1000;                          // a clear gap, so probe ids read as probe ids
const newId = () => `${(++next).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;

// A deep clone that leaves BSON's typed wrappers alone. They are immutable and
// we only ever replace them wholesale, so sharing the instances is safe; running
// them through a structural clone is what would lose their type.
const dclone = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dclone);
  const c = v.constructor?.name;
  if (c === 'Int32' || c === 'Double' || c === 'Long' || c === 'Binary' || c === 'Date') return v;
  const o = {};
  for (const [k, val] of Object.entries(v)) o[k] = dclone(val);
  return o;
};

/**
 * A key whose value DECLARES an id, rather than referencing one.
 *
 * There is more than one spelling and missing any of them duplicates an id. The
 * save format uses `ID` on components and fields, `persistent-ID` on a
 * component's persistence flag, `Persistent-ID` and `ParentReference` on slots
 * (2084 of each in the stock template - one pair per slot), and a `<name>-ID`
 * form for a type's private fields: `UnlitMaterial` alone carries `_shader-ID`,
 * `_unlit-ID`, `_unlitBillboard-ID` and `__legacyZWrite-ID`. Cloning while only
 * remapping `ID`/`persistent-ID` left every material clone sharing the original's
 * `_unlit-ID` - two duplicated ids that test-deck-probe.mjs caught.
 *
 * Everything else that looks like a guid is a reference. Checked: under this rule
 * data/template.resonitepackage has zero dangling references and zero duplicate
 * declarations, which is what makes it usable as an assertion.
 */
export const isDeclarationKey = (k) => k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k);

/**
 * Clone a component or asset entry, giving every id DECLARED inside the clone a
 * fresh one and rewriting references that point at those. A reference out of the
 * clone (a material's Texture, say) is left pointing where it pointed, so the
 * caller can decide what to repoint.
 */
function cloneEntry(entry) {
  const copy = dclone(entry);
  const map = new Map();
  (function declare(o) {
    if (Array.isArray(o)) return o.forEach(declare);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && isDeclarationKey(k) && !map.has(v)) map.set(v, newId());
      else declare(v);
    }
  })(copy);
  (function rewrite(o) {
    if (Array.isArray(o)) return o.forEach(rewrite);
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string' && map.has(v)) o[k] = map.get(v);
      else rewrite(v);
    }
  })(copy);
  return copy;
}

// ── locate the pieces ────────────────────────────────────────────────────────
const rootKids = kids(doc.Object);
const assetsSlot = rootKids.find((c) => nm(c) === 'Assets');
const surface = rootKids.find((c) => nm(c).startsWith('Surface'));   // the slot is named "Surface/cards"
const cardsParent = kids(surface)[0];

// The three material slots on every card's MeshRenderer are, in order,
// edge / front / back - matched to the mesh's three submeshes and named by the
// deck's own `Deck/MaterialEdge`, `Deck/MaterialFront`, `Deck/MaterialBack`
// reference variables. Submesh 1 is the one whose UVs cover a single atlas cell.
const FRONT_SLOT = 1;
const varRef = (name) => assetsSlot.Components.Data
  .find((c) => c?.Data?.VariableName?.Data === name)?.Data?.Reference?.Data;
const frontMatId = varRef('Deck/MaterialFront');
if (!frontMatId) throw new Error('Deck/MaterialFront not found - is this a Deck Maker export?');

const frontMat = assetsSlot.Components.Data.find((c) => c?.Data?.ID === frontMatId);
if (!frontMat) throw new Error(`Deck/MaterialFront points at ${frontMatId}, which is not on /Assets`);
const frontTexId = frontMat.Data.Texture.Data;
const frontTex = doc.Assets.find((a) => a?.Data?.ID === frontTexId);
if (!frontTex) throw new Error(`front material's Texture ${frontTexId} is not in doc.Assets`);

// ── trim to the probe's card count, then give each card its own art ──────────
const trimmed = trimToCards(doc, CODES.length);

const report = [];
CODES.forEach((code, i) => {
  const { scale, offset, col, row } = cellRemap(i);

  // Its own texture, straight off the image proxy at the in-world width.
  const tex = cloneEntry(frontTex);
  tex.Data.URL.Data = `${PROXY}/img/${code}?w=${IN_WORLD_WIDTH}`;
  doc.Assets.push(tex);

  // Its own material: same everything, pointed at that texture, with the cell
  // blown back up to the full image.
  const mat = cloneEntry(frontMat);
  mat.Data.Texture.Data = tex.Data.ID;
  mat.Data.TextureScale.Data = scale.map((n) => new Double(n));
  mat.Data.TextureOffset.Data = offset.map((n) => new Double(n));
  mat.Data.BlendMode.Data = 'Cutout';
  mat.Data.AlphaCutoff.Data = new Double(CUTOFF);
  assetsSlot.Components.Data.push(mat);

  // buffer -> Card -> Visual (Baked) carries the MeshRenderer.
  const renderer = kids(kids(kids(cardsParent)[i])[0])[0].Components.Data
    .find((c) => /MeshRenderer/.test(typeName(c)));
  if (!renderer) throw new Error(`card ${i} has no MeshRenderer`);
  const mats = renderer.Data.Materials.Data;
  if (mats.length !== 3) throw new Error(`card ${i} has ${mats.length} material slots, expected 3`);
  if (mats[FRONT_SLOT].Data !== frontMatId)
    throw new Error(`card ${i} slot ${FRONT_SLOT} is ${mats[FRONT_SLOT].Data}, not the shared front material`);
  mats[FRONT_SLOT].Data = mat.Data.ID;

  report.push({ i, code, col, row, scale, offset, landscape: landscape.has(code) });
});

addCredits(doc);

// ── write ────────────────────────────────────────────────────────────────────
const newFrdt = Buffer.from(await bsonBytesToFrdt(await serializeBson(doc)));
const newFrdtHash = sha256(newFrdt);

const drop = new Set([`Assets/${oldFrdt}`, 'R-Main.record', ...trimmed.map((h) => `Assets/${h}`)]);
const out = new JSZip();
for (const [n, f] of Object.entries(zip.files)) {
  if (f.dir || drop.has(n)) continue;
  out.file(n, await f.async('nodebuffer'));
}
out.file(`Assets/${newFrdtHash}`, newFrdt);

const gone = new Set([oldFrdt, ...trimmed]);
record.assetUri = `packdb:///${newFrdtHash}`;
record.name = args.name || 'ResoPal deck probe - per-card art, no atlas';
record.assetManifest = [
  ...record.assetManifest.filter((e) => !gone.has(e.hash)),
  { hash: newFrdtHash, bytes: newFrdt.length },
];
out.file('R-Main.record', JSON.stringify(record));

await mkdir(path.dirname(OUT), { recursive: true });
const bytes = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(OUT, bytes);

console.log(`\n✓ ${OUT}`);
console.log(`  ${(bytes.length / 1048576).toFixed(2)} MB   ${CODES.length} cards   ids from ${(high + 0x1001).toString(16)}`);
console.log(`  grid ${GRID_COLS}x${GRID_ROWS}, front material = renderer slot ${FRONT_SLOT}\n`);
for (const r of report) {
  console.log(`  card ${r.i}  ${r.code.padEnd(10)} cell(col ${r.col}, row ${r.row})` +
    `  scale ${JSON.stringify(r.scale)}  offset ${JSON.stringify(r.offset)}` +
    (r.landscape ? '   ** landscape: expect it sideways, see the note in this file **' : ''));
}
console.log();
