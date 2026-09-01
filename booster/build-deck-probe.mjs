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
import { cloneNode, allocator, typeMapper } from './splice.mjs';

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
if (args.blank) {
  // A TEMPLATE, not a deck: N cards whose `Card/url` is empty and gets written at
  // runtime. This is what the panel carries, because an importer's card codes
  // arrive over the wire. The count is the deck's ceiling in-world, so it wants to
  // be the template's full size - trimming down happens by destroying the extras.
  const n = Number(args.blank);
  if (!Number.isInteger(n) || n < 1) throw new Error(`blank=${args.blank} must be a positive integer`);
  CODES = Array(n).fill(null);
} else if (args.deck) {
  const d = decks[String(args.deck).toLowerCase()];
  if (!d) throw new Error(`no deck "${args.deck}" in data/decks.json - have ${Object.keys(decks).join(', ')}`);
  CODES = d.cards.flatMap((c) => Array(c.n).fill(c.code));
  if (CODES.length !== d.total) throw new Error(`${d.id} expanded to ${CODES.length}, its own total says ${d.total}`);
} else if (args.variants) {
  // ── the corner probe ───────────────────────────────────────────────────────
  // Four copies of ONE card, differing only in how the front texture is set up,
  // to answer a question that cannot be answered from a package: WHY are the
  // corners square.
  //
  // A Ukilop card's front face is a FLAT 4-VERTEX QUAD - measured off the MeshX,
  // only the 512-triangle edge submesh is rounded - so the whole of the rounded
  // corner comes from the ART'S ALPHA, cut by `BlendMode: Cutout` at 0.72. If the
  // art has no alpha at the width we ask for, no amount of geometry or material
  // will round it.
  //
  //   0  art at w=512,  PreferredProfile sRGB       what the panel ships
  //   1  art at w=512,  PreferredProfile sRGBAlpha  the deck's own profile
  //   2  art at w=1024, PreferredProfile sRGBAlpha  the width the SITE bakes from
  //   3  DefaultBack.png on the FRONT face          a KNOWN-ALPHA control
  //
  // Card 3 is the one that matters most: it is a PNG with transparent corners
  // going through the same mesh, the same material and the same ST remap. If it
  // comes out round and 0-2 do not, the path is sound and the card art is the
  // problem. If it comes out square, the fault is in the path and the art is
  // innocent.
  CODES = Array(4).fill(String(args.variants));
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

/**
 * Bump this to make Resonite refetch every card image.
 *
 * Resonite caches an asset by its URL, in the install, for as long as it likes -
 * a new world does not clear it and neither does a fresh import. So when the bytes
 * behind a URL change, every client that has already seen it keeps the old ones.
 * That is what left landscape cards un-turned after the Worker was fixed: the
 * route was correct, the edge cache was correct, and the headset still had the
 * squashed copy it fetched days earlier.
 *
 * The Worker ignores unknown query parameters and keys its own cache on code and
 * width, so this changes the asset's identity to Resonite without fragmenting
 * anything upstream.
 */
const ART_VERSION = args.artv || '2';

// The four setups the corner probe compares. See `variants=` above.
const VARIANTS = [
  { url: (c) => `${PROXY}/img/${c}?w=512&v=${ART_VERSION}`,  profile: 'sRGB', mask: false,
    say: { what: 'art w=512, sRGB, NO MASK  (the "before" - what was harsh)' } },
  { url: (c) => `${PROXY}/img/${c}?w=512&v=${ART_VERSION}`,  profile: 'sRGBAlpha',
    say: { what: "art w=512, sRGBAlpha, MASKED  (the fix)" } },
  { url: (c) => `${PROXY}/img/${c}?w=1024&v=${ART_VERSION}`, profile: 'sRGBAlpha',
    say: { what: 'art w=1024, sRGBAlpha, MASKED' } },
  { url: () => BACK_URL,                                     profile: 'sRGBAlpha',
    say: { what: 'DefaultBack.png on the front, MASKED (control)' } },
];

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
  if (code === null) continue;                     // a blank template card carries no code
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

// ── id allocation and splicing ───────────────────────────────────────────────
// The rules these encode - the five id-declaration key spellings, cloning a
// self-referencing group in ONE call, exact-string type matching - each cost a
// bug. They live in splice.mjs so the panel builder shares one copy.
const newId = allocator(doc);
const deckTypeIndex = donor ? typeMapper(doc, donor) : null;
const appendedTypes = deckTypeIndex ? deckTypeIndex.appended : [];

/** Clone a GROUP of donor slots into this document, remapping ids and types. */
function cloneDonorSlots(slots) {
  const group = cloneNode({ Children: slots }, newId);
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
  const copy = cloneNode(entry, newId);
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


const report = [];
const variantLegend = [];
CODES.forEach((code, i) => {
  const { scale, offset, col, row } = cellRemap(i);
  const art = code === null ? '' : `${PROXY}/img/${code}?w=${IN_WORLD_WIDTH}&v=${ART_VERSION}`;

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
    if (code === null) throw new Error('blank= needs mode=driven: a static build has no url to write');
    tex = cloneNode(frontTex, newId);
    tex.Data.URL.Data = asUrl(art);
    if (args.variants) {
      const v = VARIANTS[i];
      tex.Data.URL.Data = asUrl(v.url(code));
      tex.Data.PreferredProfile.Data = v.profile;
      variantLegend.push(`  card ${i}  ${v.say.what}`);
    }
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

    // The texture is cloned from THE DECK'S OWN ATLAS TEXTURE, not from the panel
    // card's. The panel's is authored `PreferredProfile: "sRGB"` and the deck's is
    // `"sRGBAlpha"`, and that one field is the difference between a card with
    // rounded corners and a card without: the front face of a Ukilop card is a
    // FLAT 4-VERTEX QUAD - only the 512-triangle edge submesh is rounded - so the
    // whole of the corner comes from the art's alpha, cut at 0.72. A profile that
    // does not carry alpha is a square card, whatever the mesh looks like.
    //
    // Cloning the deck's own texture rather than fixing the one field also means
    // every other setting on it is Ukilop's: `CrunchCompressed`, `MipMapFilter`,
    // `PowerOfTwoAlignThreshold`, the lot. Only the two that MUST differ are
    // changed - the url is driven here, and the wrap mode is clamped below.
    tex = cloneNode(frontTex, newId);
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

  const mat = cloneNode(frontMat, newId);
  mat.Data.Texture.Data = tex.Data.ID;
  mat.Data.TextureScale.Data = scale.map((n) => new Double(n));
  mat.Data.TextureOffset.Data = offset.map((n) => new Double(n));
  mat.Data.BlendMode.Data = 'Cutout';
  mat.Data.AlphaCutoff.Data = new Double(CUTOFF);

  // ── the corner mask ─────────────────────────────────────────────────────────
  // A Ukilop card's FRONT FACE IS A FLAT 4-VERTEX QUAD spanning the whole card -
  // measured off the MeshX, positions x[-0.175,0.175] y[-0.25,0.25]. Only the
  // 528-vertex rim is rounded, and its arc measures 0.01750 m, 5% of the card's
  // width. So the corner of the FACE is not geometry at all: it is whatever the
  // front texture's alpha leaves behind after `BlendMode: Cutout` at 0.72. Ukilop
  // gets away with it because the atlas he is handed already has rounded
  // transparent corners; the deck maker's `radius` slider shapes the RIM.
  //
  // We hand each card a raw card image instead, so nothing guarantees that alpha -
  // and a square corner on the face pokes out past the rounded rim, which is what
  // "harsh corners" is.
  //
  // `UnlitMaterial` has the answer built in and Ukilop's own material already has
  // it half-set: `MaskMode` is `MultiplyAlpha` and `MaskTexture` is null. Point the
  // mask at the DECK'S OWN BACK TEXTURE - `DefaultBack.png`, whose corners decode
  // to alpha 0 against 255 at the centre - and the shader multiplies the art's
  // alpha by it. The corner is then cut whatever the art does.
  //
  // The mask needs the SAME ST as the texture, and that is where the last attempt
  // at this went wrong: the mesh UVs are ATLAS-CELL coordinates, so a mask left at
  // (1,1)/(0,0) samples one cell of a card-sized image and comes out as noise.
  //
  // It cannot make a good card worse: where the art is already transparent the
  // mask is too, and the interior of the mask is opaque.
  // `variants` can switch the mask off, so the probe keeps a "before" to compare.
  if (!args.variants || VARIANTS[i].mask !== false) {
    mat.Data.MaskTexture.Data = backTex.Data.ID;
    mat.Data.MaskScale.Data = scale.map((n) => new Double(n));
    mat.Data.MaskOffset.Data = offset.map((n) => new Double(n));
    mat.Data.MaskMode.Data = 'MultiplyAlpha';
  }
  matHome.push(mat);

  mats[FRONT_SLOT].Data = mat.Data.ID;
  report.push({ i, code: code ?? '(blank)', col, row, scale, offset, landscape: code !== null && landscape.has(code) });
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
console.log(`  mode=${MODE}   ${(bytes.length / 1048576).toFixed(2)} MB   ${CODES.length} cards   ids from ${newId.start.toString(16)}`);
if (appendedTypes.length) {
  console.log(`  ${appendedTypes.length} types appended for the drive chain:`);
  for (const t of appendedTypes) console.log(`      ${t}`);
}
console.log(`  grid ${GRID_COLS}x${GRID_ROWS}, front material = renderer slot ${FRONT_SLOT}` +
  (MODE === 'driven' ? `, url driven from ${URL_VAR}` : ', url written at build time'));
console.log(`  art   ${PROXY}/img/<CODE>?w=${IN_WORLD_WIDTH}&v=${ART_VERSION}` +
  `   (v is the lever that makes Resonite refetch)`);
console.log(`  back  ${BACK_URL}` + (backArg === 'site' ? '   (a second host: expect two access prompts)' : '') +
  (backWasPackdb ? '   [replaced the template placeholder]' : '') + '\n');
if (variantLegend.length) {
  console.log('  the corner probe - four copies of one card, left to right:');
  for (const l of variantLegend) console.log(l);
  console.log('');
  console.log('  card 3 is the CONTROL: a PNG with transparent corners, on the same mesh,');
  console.log('  the same material and the same ST remap. Round there and square on 0-2');
  console.log('  means the path is sound and the card art carries no alpha at that width.');
  console.log('  Square on ALL FOUR means the fault is in the path, not the art.');
  console.log('');
}
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
