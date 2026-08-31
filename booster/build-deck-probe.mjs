// Build a Ukilop deck whose cards carry their own art, with no atlas.
//
// Two modes, and the difference is the whole point.
//
//   mode=static   each card's StaticTexture2D.URL is written at build time.
//                 Proves the UV remap and nothing else. Drag-tested and CONFIRMED.
//   mode=driven   each card's URL is DRIVEN from a `Card/url` dynamic variable by
//                 the same five-component chain the panel already runs in-world.
//                 This is what the importer needs, because card codes arrive over
//                 the wire and cannot be baked. Default.
//
// ── why per-card art works at all ────────────────────────────────────────────
//
// docs/HANDOFF.md had "a Ukilop deck cannot be textured per card" recorded as
// settled. Every card does own a mesh with its atlas cell baked into the UVs, but
// `UnlitMaterial.TextureScale`/`.TextureOffset` reach the shader as `_Tex_ST`
// (`UpdateMaterial` -> `MaterialUpdateWriter.UpdateST` -> `float4(scale, offset)`)
// and Unity's ST convention samples at `uv * scale + offset`, so the cell scales
// back up to the whole of a per-card texture:
//
//     card i at col = i % 10, row = floor(i / 10) of the 10x7 grid
//       TextureScale = (10, 7)    TextureOffset = (-col, -(6 - row))
//
// Measured, not assumed: meshx.mjs reads submesh 1's UV bounds out of each card's
// MeshX blob and test-deck-probe.mjs asserts the shipped ST against them.
//
// ── where the new components go, and why there ───────────────────────────────
//
// On `Visual (Baked)`, never on `Card`. The deck CHAINS `GetChild` - there are
// eleven of them and three take another `GetChild` as their instance - so it walks
// `Cards -> buffer -> Card` and the child ordering of those slots is load-bearing.
// `Visual (Baked)` is a leaf with no children at all, so nothing existing can
// depend on what it contains. Adding components would be safe anywhere; adding
// SLOTS is only safe here.
//
// The flux chain is CLONED from booster/out/ResoPal_Panel.resonitepackage rather
// than authored. It is the same chain that already loads card art in-world, so its
// member order and port wiring cannot be wrong - the argument that made
// `BoxCollider`/`Grabbable` safe in build-panel.mjs. Only two references are
// re-pointed per card: the GlobalReference to that card's url variable, and the
// drive to that card's texture URL field.
//
//   node booster/build-deck-probe.mjs [mode=driven] [cards=TD01-001,...] [out=...]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { addCredits } from '../tools/credits.mjs';
import { trimToCards } from '../tools/trim.mjs';
import { asUrl } from './urlmarker.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { Int32, Double } = require('bson');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const ROOT = path.resolve(import.meta.dirname, '..');
const RKL = process.env.RKL || path.resolve(ROOT, '..', 'Resonite-Knowledge-Library');
const codec = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(codec)) throw new Error(
  `No ${codec}.\nClone the Resonite Knowledge Library and point RKL at it:\n` +
  `  RKL=/path/to/Resonite-Knowledge-Library node booster/build-deck-probe.mjs\n`);
const { frdtToBsonBytes, bsonBytesToFrdt, deserializeBson, serializeBson } = await import(`file://${codec}`);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)];
}));

const MODE = args.mode || 'driven';
if (!['driven', 'static'].includes(MODE)) throw new Error(`mode must be driven or static, got ${MODE}`);
const PROXY = args.proxy || process.env.PROXY || 'https://resopal-proxy.dalek.workers.dev';
const IN_WORLD_WIDTH = 512;                       // worker/src/roll.js IN_WORLD_WIDTH
// `deck=td01` builds a REAL trial deck out of data/decks.json rather than a
// handful of codes. That matters for more than realism: three cards only ever
// occupy row 0 of the 10x7 grid, where the row term of the offset is at its
// default, so a wrong `-(6 - row)` would look perfect. Forty-eight cards span
// rows 0 to 4 and would not.
//
// A duplicate gets its own cell - `2x Grizzbolt` occupies two - because the atlas
// is laid out in deck-list order and the mesh UVs follow it (docs/PIPELINE.md).
const decks = JSON.parse(await readFile(path.join(ROOT, 'data', 'decks.json'), 'utf8')).decks;
let CODES;
if (args.deck) {
  const d = decks[String(args.deck).toLowerCase()];
  if (!d) throw new Error(`no deck "${args.deck}" in data/decks.json - have ${Object.keys(decks).join(', ')}`);
  CODES = d.cards.flatMap((c) => Array(c.n).fill(c.code));
  if (CODES.length !== d.total) throw new Error(`${d.id} expanded to ${CODES.length}, its own total says ${d.total}`);
} else {
  CODES = String(args.cards || 'TD01-001,TD01-002,TD01-003').split(',').map((s) => s.trim()).filter(Boolean);
}
const SRC = args.src || path.join(ROOT, 'data', 'template.resonitepackage');
const DONOR = args.donor || path.join(ROOT, 'booster', 'out', 'ResoPal_Panel.resonitepackage');
const OUT = args.out || path.join(ROOT, 'booster', 'out', 'ResoPal_DeckProbe.resonitepackage');

// The card back. Every Palworld card has the same one, so it is a single shared
// texture and a single shared material - the ONE thing on a card that is not
// per-card. Ukilop's export ships a placeholder; this replaces it.
//
//   back=site    (default) straight off the site. Works with no deploy, but it is
//                a second host, so Resonite asks for a second host permission.
//   back=proxy   through the Worker's /back route: same origin as the card art, so
//                one prompt for the whole deck. Needs the Worker deployed first.
//   back=<url>   anything else is used verbatim.
const BACK_SITE = 'https://resopal.dalek.coffee/assets/DefaultBack.png';
const backArg = args.back || 'site';
const BACK_URL = backArg === 'site' ? BACK_SITE : backArg === 'proxy' ? `${PROXY}/back` : backArg;

const GRID_COLS = 10, GRID_ROWS = 7;              // baked into the mesh UVs; see docs/PIPELINE.md
const CUTOFF = 0.72;                              // docs/PIPELINE.md "White rim on card corners"
const CARD_SPACE = 'Card';                        // Ukilop's own space, already on every card slot
const URL_VAR = `${CARD_SPACE}/url`;

// Never invent card data: every code is checked against the committed pool snapshots.
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

/** ST that turns card slot `i`'s atlas cell back into the whole of its own texture. */
export function cellRemap(i, cols = GRID_COLS, rows = GRID_ROWS) {
  const col = i % cols, row = Math.floor(i / cols);
  return { scale: [cols, rows], offset: [-col, -(rows - 1 - row)], col, row };
}

const loadDoc = async (file) => {
  const zip = await JSZip.loadAsync(await readFile(file));
  const record = JSON.parse(await zip.file('R-Main.record').async('string'));
  const hash = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
  const doc = await deserializeBson(await frdtToBsonBytes(new Uint8Array(await zip.file(`Assets/${hash}`).async('uint8array'))));
  return { zip, record, hash, doc };
};

const { zip, record, hash: oldFrdt, doc } = await loadDoc(SRC);
const donor = MODE === 'driven' ? (await loadDoc(DONOR)).doc : null;

const nm = (s) => String(s?.Name?.Data ?? '');
const kids = (s) => s.Children ?? [];
const idx = (v) => (v && typeof v === 'object') ? (v.value ?? v.valueOf?.()) : v;
const typeName = (e, d = doc) => String(d.Types?.[idx(e?.Type)] ?? '');

// ── id allocation ────────────────────────────────────────────────────────────
// Deck Maker ids are `0000xxxx-0000-...`, allocated sequentially. New ones go
// strictly above the high-water mark, with a gap so probe ids read as probe ids.
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
let next = high + 0x1000;
const newId = () => `${(++next).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;

/**
 * A key whose value DECLARES an id rather than referencing one. There is more than
 * one spelling and missing any of them duplicates an id: `ID` on components and
 * fields, `persistent-ID` on a component's persistence flag, `Persistent-ID` and
 * `ParentReference` on slots, and a `<name>-ID` form for a type's private fields -
 * `UnlitMaterial` alone carries `_shader-ID`, `_unlit-ID`, `_unlitBillboard-ID`
 * and `__legacyZWrite-ID`. Remapping only `ID`/`persistent-ID` left every material
 * clone sharing the original's `_unlit-ID`. See docs/PIPELINE.md.
 */
export const isDeclarationKey = (k) => k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k);

// A deep clone that leaves BSON's typed wrappers alone: they are immutable and only
// ever replaced wholesale, so sharing them is safe. A structural clone loses them.
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
 * Clone any node - a component entry or a whole slot subtree - giving every id
 * declared inside it a fresh one and rewriting the references that point at those.
 * A reference OUT of the clone is left pointing where it pointed, so the caller
 * decides what to re-point.
 */
function cloneNode(node) {
  const copy = dclone(node);
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

// ── type mapping, by exact string ────────────────────────────────────────────
// Never by substring. `UnlitMaterial` is a substring of `UI_UnlitMaterial` and
// `GlobalReference<IValue<string>>` of nothing the deck has - it carries
// `GlobalReference<Slot>`, a different type. This is the same trap as CLAUDE.md's
// "a classpath is a path, not a name", one level down.
const appendedTypes = [];
function deckTypeIndex(donorTypeIndex) {
  const name = String(donor.Types[donorTypeIndex]);
  let i = doc.Types.indexOf(name);
  if (i < 0) {
    i = doc.Types.length;
    doc.Types.push(name);
    appendedTypes.push(name);
    const v = donor.TypeVersions?.[name];
    if (v !== undefined) (doc.TypeVersions ??= {})[name] = v;
  }
  return i;
}

/**
 * Clone a GROUP of donor slots as one unit, remapping ids and type indices.
 *
 * As one unit, because the chain's slots reference each other: the
 * `StringToAbsoluteURI` on "as a Uri" takes its `Input` from the
 * `ObjectValueSource` on "CARD/url -> texture". Cloning each slot with its own id
 * map leaves those cross-slot references pointing at the DONOR's ids - and since
 * the deck's own ids occupy the same low range, they land on real but unrelated
 * components. Nothing dangles, nothing fails validation, and the graph is wired to
 * the wrong things. test-deck-probe.mjs caught exactly that.
 */
function cloneDonorSlots(slots) {
  const group = cloneNode({ Children: slots });
  for (const s of group.Children) {
    (function remap(x) {
      for (const c of x.Components?.Data ?? []) c.Type = new Int32(deckTypeIndex(idx(c.Type)));
      for (const ch of x.Children ?? []) remap(ch);
    })(s);
  }
  return group.Children;
}

/** Clone a donor component entry into this document. */
function cloneDonorComp(entry) {
  const copy = cloneNode(entry);
  copy.Type = new Int32(deckTypeIndex(idx(entry.Type)));
  return copy;
}

// ── locate the pieces ────────────────────────────────────────────────────────
const rootKids = kids(doc.Object);
const assetsSlot = rootKids.find((c) => nm(c) === 'Assets');
const surface = rootKids.find((c) => nm(c).startsWith('Surface'));   // the slot is named "Surface/cards"
const cardsParent = kids(surface)[0];

// The three material slots on every card's MeshRenderer are edge / front / back,
// matched to the mesh's three submeshes and named by the deck's own
// `Deck/Material*` reference variables. Submesh 1 covers a single atlas cell.
const FRONT_SLOT = 1;
const varRef = (name) => assetsSlot.Components.Data
  .find((c) => c?.Data?.VariableName?.Data === name)?.Data?.Reference?.Data;
const frontMatId = varRef('Deck/MaterialFront');
if (!frontMatId) throw new Error('Deck/MaterialFront not found - is this a Deck Maker export?');
const frontMat = assetsSlot.Components.Data.find((c) => c?.Data?.ID === frontMatId);
const frontTex = doc.Assets.find((a) => a?.Data?.ID === frontMat.Data.Texture.Data);
if (!frontTex) throw new Error(`front material's Texture is not in doc.Assets`);

// ── the back: one texture, one material, shared by every card ────────────────
// Its submesh has UV [0,1] against a 1x1 atlas, so unlike the front it needs no
// ST remap - only a texture to point at. The URL is written at build time, so it
// takes the `@` marker that a Sync<Uri> requires; without it the field loads as
// null and the back is blank. See urlmarker.mjs.
const backMatId = varRef('Deck/MaterialBack');
if (!backMatId) throw new Error('Deck/MaterialBack not found - is this a Deck Maker export?');
const backMat = assetsSlot.Components.Data.find((c) => c?.Data?.ID === backMatId);
const backTex = doc.Assets.find((a) => a?.Data?.ID === backMat.Data.Texture.Data);
if (!backTex) throw new Error(`back material's Texture is not in doc.Assets`);

const backWasPackdb = String(backTex.Data.URL.Data ?? '').includes('packdb:///');
backTex.Data.URL.Data = asUrl(BACK_URL);
backTex.Data.WrapModeU.Data = 'Clamp';
backTex.Data.WrapModeV.Data = 'Clamp';
// Match the front. The back face is a flat quad too - the rounded corners come
// from the alpha cutout, not from geometry - and DefaultBack.png carries its
// corner transparency in a palette tRNS chunk.
backMat.Data.BlendMode.Data = 'Cutout';
backMat.Data.AlphaCutoff.Data = new Double(CUTOFF);

// ── the donor chain (driven mode) ────────────────────────────────────────────
// From the panel's card template: the url variable, the texture, and the three
// named slots holding the five flux components that turn one into the other.
let donorParts = null;
if (MODE === 'driven') {
  const dnm = (s) => String(s?.Name?.Data ?? '');
  function find(o, pred) {
    if (pred(o)) return o;
    for (const c of o.Children ?? []) { const r = find(c, pred); if (r) return r; }
    return null;
  }
  const card = find(donor.Object, (s) => (s.Components?.Data ?? []).some((c) =>
    /\.DynamicVariableSpace$/.test(typeName(c, donor)) && c.Data.SpaceName?.Data === 'CARD'));
  if (!card) throw new Error(`no CARD template slot in the donor ${DONOR}`);
  const comp = (re) => card.Components.Data.find((c) => re.test(typeName(c, donor)));
  const chain = ['CARD/url -> texture', 'as a Uri', 'drive the texture URL']
    .map((n) => { const s = (card.Children ?? []).find((c) => dnm(c) === n);
                  if (!s) throw new Error(`donor card has no "${n}" slot`); return s; });
  donorParts = {
    urlVar: comp(/\.DynamicValueVariable<string>$/),
    texture: comp(/\.StaticTexture2D$/),
    chain,
  };
  if (!donorParts.urlVar || !donorParts.texture) throw new Error('donor card is missing its url variable or texture');
}

// ── trim, then give each card its own art ────────────────────────────────────
const trimmed = trimToCards(doc, CODES.length);

/**
 * Move each card's position flux inside the card, so the card is self-contained.
 *
 * A card's stack position is driven by a `proxy` slot under `/Assets`, one per
 * card - outside the card. That is why `DuplicateSlot` alone was never enough for
 * an importer: the copy arrives with no driver and sits at the origin.
 *
 * Moving proxy `i` to be a child of buffer `i` fixes it, and the reference split
 * says why it is safe. Of proxy 0's eight external references, TWO point into its
 * own buffer subtree - the card slot it reads `IndexOfChild` on, and the
 * `SmoothTransform.TargetPosition` it drives - and `DuplicateSlot` rewires exactly
 * those to the copy. The other SIX point at shared deck machinery (`add/remove
 * handling`, the `Cards` parent, shared constant sources) and it leaves those
 * alone, which is also what is wanted: every card should read the same machinery.
 *
 * The buffer already carries a `DestroyProxy` aimed at that proxy, so destroying a
 * card still takes its flux with it once the proxy is its child - Ukilop built the
 * link, this only shortens it.
 *
 * Runs AFTER the trim, which asserts `/Assets` still holds one proxy per card.
 */
function relocateProxies() {
  const buffers = kids(cardsParent);
  const proxies = kids(assetsSlot);
  if (proxies.length !== buffers.length)
    throw new Error(`${proxies.length} proxies for ${buffers.length} cards - relocate must run after the trim`);

  // Pair each proxy with the buffer it drives, by the DestroyProxy that names it,
  // never by index: /Assets order matching card order is an assumption, and this
  // reads the link Ukilop actually wrote.
  const byProxyId = new Map(proxies.map((p) => [p.ID, p]));
  let moved = 0;
  for (const buffer of buffers) {
    const dp = (buffer.Components?.Data ?? []).find((c) => /\.DestroyProxy$/.test(typeName(c)));
    if (!dp) throw new Error(`card buffer ${buffer.ID} has no DestroyProxy naming its flux`);
    const target = dp.Data.DestroyTarget.Data;
    const proxy = byProxyId.get(target);
    if (!proxy) throw new Error(`buffer ${buffer.ID} points at ${target}, which is not a /Assets proxy`);
    (buffer.Children ??= []).push(proxy);
    byProxyId.delete(target);
    moved++;
  }
  if (byProxyId.size) throw new Error(`${byProxyId.size} proxies belong to no card`);
  assetsSlot.Children = [];
  return moved;
}

const relocated = args.selfcontained === '1' || args.selfcontained === true ? relocateProxies() : 0;

const report = [];
CODES.forEach((code, i) => {
  const { scale, offset, col, row } = cellRemap(i);
  const art = `${PROXY}/img/${code}?w=${IN_WORLD_WIDTH}`;

  // buffer -> Card -> Visual (Baked) carries the MeshRenderer.
  const cardSlot = kids(kids(cardsParent)[i])[0];
  const visual = kids(cardSlot)[0];
  const renderer = visual.Components.Data.find((c) => /\.MeshRenderer$/.test(typeName(c)));
  if (!renderer) throw new Error(`card ${i} has no MeshRenderer`);
  const mats = renderer.Data.Materials.Data;
  if (mats.length !== 3) throw new Error(`card ${i} has ${mats.length} material slots, expected 3`);
  if (mats[FRONT_SLOT].Data !== frontMatId)
    throw new Error(`card ${i} slot ${FRONT_SLOT} is not the shared front material`);

  let tex, matHome;
  if (MODE === 'static') {
    // Texture in doc.Assets and material on /Assets, matching the template's own
    // layout. `asUrl` is not cosmetic: a Sync<Uri> value is `@` + the url and the
    // field loads as null without it. See urlmarker.mjs.
    tex = cloneNode(frontTex);
    tex.Data.URL.Data = asUrl(art);
    doc.Assets.push(tex);
    matHome = assetsSlot.Components.Data;
  } else {
    // Everything the card needs lives on the card, so the card is self-contained
    // and a future DuplicateSlot carries all of it.
    // Two clone calls, deliberately. The chain's three slots go together so their
    // cross-references remap consistently; the container shell is a SEPARATE call,
    // because a slot passed twice in one group shares one id map and both copies
    // come out carrying identical ids.
    const [home] = cloneDonorSlots([donorParts.chain[0]]);
    const fluxSlots = cloneDonorSlots(donorParts.chain);
    home.Name.Data = 'art';
    home.Components.Data = [];
    home.Children = [];
    (visual.Children ??= []).push(home);

    tex = cloneDonorComp(donorParts.texture);
    tex.Data.URL.Data = null;                            // driven, never written here
    const urlVar = cloneDonorComp(donorParts.urlVar);
    urlVar.Data.VariableName.Data = URL_VAR;
    urlVar.Data.Value.Data = art;                        // a PLAIN STRING - no @ marker
    home.Components.Data.push(tex, urlVar);

    // The five flux components, in their three named slots, re-pointed at this
    // card's own variable and its own texture.
    for (const s of fluxSlots) home.Children.push(s);
    const flux = fluxSlots.flatMap((s) => s.Components.Data);
    const globalRef = flux.find((c) => /\.GlobalReference</.test(typeName(c)));
    const driveProxy = flux.find((c) => /FieldDriveBase<Uri>\+Proxy$/.test(typeName(c)));
    if (!globalRef || !driveProxy) throw new Error('cloned chain lost its GlobalReference or drive proxy');
    globalRef.Data.Reference.Data = urlVar.Data.Value.ID;
    driveProxy.Data.Drive.Data = tex.Data.URL.ID;
    matHome = home.Components.Data;
  }

  // The atlas texture is Repeat, which is right when every UV is interior to a
  // sheet. A per-card texture is sampled to the edge of [0,1], so filtering reaches
  // past it and Repeat wraps opaque art into the rounded corners the alpha cutout
  // exists to remove.
  tex.Data.WrapModeU.Data = 'Clamp';
  tex.Data.WrapModeV.Data = 'Clamp';

  const mat = cloneNode(frontMat);
  mat.Data.Texture.Data = tex.Data.ID;
  mat.Data.TextureScale.Data = scale.map((n) => new Double(n));
  mat.Data.TextureOffset.Data = offset.map((n) => new Double(n));
  mat.Data.BlendMode.Data = 'Cutout';
  mat.Data.AlphaCutoff.Data = new Double(CUTOFF);
  matHome.push(mat);

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
record.name = args.name || `ResoPal deck probe (${MODE}) - per-card art, no atlas`;
record.assetManifest = [
  ...record.assetManifest.filter((e) => !gone.has(e.hash)),
  { hash: newFrdtHash, bytes: newFrdt.length },
];
out.file('R-Main.record', JSON.stringify(record));

await mkdir(path.dirname(OUT), { recursive: true });
const bytes = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(OUT, bytes);

console.log(`\n✓ ${OUT}`);
console.log(`  mode=${MODE}   ${(bytes.length / 1048576).toFixed(2)} MB   ${CODES.length} cards   ids from ${(high + 0x1001).toString(16)}`);
if (appendedTypes.length) {
  console.log(`  ${appendedTypes.length} types appended for the drive chain:`);
  for (const t of appendedTypes) console.log(`      ${t}`);
}
console.log(`  grid ${GRID_COLS}x${GRID_ROWS}, front material = renderer slot ${FRONT_SLOT}` +
  (MODE === 'driven' ? `, url driven from ${URL_VAR}` : ', url written at build time'));
if (relocated) console.log(`  ${relocated} card driver proxies moved inside their own card - DuplicateSlot carries them now`);
console.log(`  back  ${BACK_URL}` + (backArg === 'site' ? '   (a second host: expect two access prompts)' : '') +
  (backWasPackdb ? '   [replaced the template placeholder]' : '') + '\n');
// A full deck is too long to list a card at a time; print the row boundaries,
// which is where the offset arithmetic is actually worth eyeballing.
const rows = [...new Set(report.map((r) => r.row))];
if (report.length > 12) {
  for (const row of rows) {
    const inRow = report.filter((r) => r.row === row);
    const a = inRow[0], z = inRow[inRow.length - 1];
    console.log(`  row ${row}: cards ${a.i}-${z.i}  cols ${a.col}-${z.col}` +
      `  offset ${JSON.stringify(a.offset)} .. ${JSON.stringify(z.offset)}`);
  }
  console.log(`  ${report.length} cards over ${rows.length} row(s) of the ${GRID_ROWS}-row grid`);
} else {
  for (const r of report) {
    console.log(`  card ${r.i}  ${r.code.padEnd(10)} cell(col ${r.col}, row ${r.row})` +
      `  scale ${JSON.stringify(r.scale)}  offset ${JSON.stringify(r.offset)}`);
  }
}
const sideways = report.filter((r) => r.landscape);
if (sideways.length) {
  console.log(`\n  ** ${sideways.length} landscape printing(s) will render SIDEWAYS: ` +
    `${[...new Set(sideways.map((r) => r.code))].join(', ')}`);
  console.log(`     _Tex_ST can flip an axis but not swap two, so this needs a rotated`);
  console.log(`     variant from the Worker or pre-rotated art on the site.`);
}
console.log();
