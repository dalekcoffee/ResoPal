// Check the panel that carries a deck template.
//
// The risk in a cross-document splice is not that it fails - it is that it
// succeeds into a document that is subtly wrong: an id used twice, an asset the
// tree no longer reaches, a mesh whose blob was left behind. None of those show up
// until Resonite renders nothing.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import JSZip from 'jszip';

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const decodeMjs = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(decodeMjs)) { console.error('Need the Knowledge Library for its codec; set RKL=<path>'); process.exit(1); }
const { frdtToBsonBytes, deserializeBson, serializeBson } = await import(`file://${decodeMjs}`);

const pkg = process.argv[2] || path.join(import.meta.dirname, 'out', 'ResoPal_Panel_Deck.resonitepackage');
const raw = await readFile(pkg);
const zip = await JSZip.loadAsync(raw);
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const mainHash = record.assetUri.replace(/^@?packdb:\/\/\//, '');
const bson = await frdtToBsonBytes(await zip.file('Assets/' + mainHash).async('uint8array'));
const doc = await deserializeBson(bson);

const num = (v) => (v && typeof v === 'object' && v._bsontype ? Number(v) : v);
const nm = (s) => String(s?.Name?.Data ?? '');
const kids = (s) => s.Children ?? [];
const typeName = (e) => String(doc.Types?.[num(e?.Type)] ?? '');

let bad = 0;
const check = (n, ok, d = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${!ok && d ? '  ' + d : ''}`); };
const note = (s) => console.log(`  note ${s}`);
console.log(`${path.basename(pkg)}  (${(raw.length / 1048576).toFixed(2)} MB)\n`);

// ── the panel is still a panel ───────────────────────────────────────────────
console.log('the panel survived the graft:');
const rootKids = kids(doc.Object);
// The HOLDER is switched off and the DECK inside it is on. `DuplicateSlot` copies
// `Active` verbatim, so a template that is itself inactive duplicates into an
// inactive deck and nothing in the spawn chain turns it back on - the card
// template solves it the same way, and this used to have it the other way round.
const holder = rootKids.find((s) => nm(s) === 'Deck template');
check('the deck template is there', !!holder);
check('the HOLDER is inactive, so the template stays out of sight',
  holder?.Active?.Data === false, String(holder?.Active?.Data));
const deckSlot = kids(holder ?? {})[0];
check('and the DECK inside it is ACTIVE, or every duplicate would be invisible',
  deckSlot?.Active?.Data === true, String(deckSlot?.Active?.Data));
for (const want of ['Card template', 'Cards', 'credits']) {
  check(`the panel still has its "${want}"`, rootKids.some((s) => nm(s) === want),
    rootKids.map(nm).join(', '));
}
const canvases = [];
(function w(s) { for (const c of s.Components?.Data ?? []) if (/UIX\.Canvas$/.test(typeName(c))) canvases.push(nm(s)); for (const c of kids(s)) w(c); })(doc.Object);
check('the panel canvas is intact', canvases.length >= 1, `${canvases.length} canvases`);

// ── the deck is a whole deck ─────────────────────────────────────────────────
console.log('\nthe deck came over whole:');
const surface = kids(deckSlot ?? {}).find((s) => nm(s).startsWith('Surface'));
const cardsParent = kids(surface ?? {})[0];
const cards = kids(cardsParent ?? {});
const deckAssets = kids(deckSlot ?? {}).find((s) => nm(s) === 'Assets');
check('it has its card stack', cards.length > 0, `${cards.length} cards`);
check('and one driver proxy per card', kids(deckAssets ?? {}).length === cards.length,
  `${kids(deckAssets ?? {}).length} proxies vs ${cards.length} cards`);
check('and its logix', kids(deckSlot ?? {}).some((s) => nm(s) === 'logixs'));
note(`${cards.length} cards`);

// ── the two things the importer reaches for ──────────────────────────────────
// Both are silent failures if they are missing: a null template reference makes
// the deck button duplicate nothing, and a missing variable makes the spread
// write land on no space at all. Neither shows up as a dangling reference.
{
  const spread = (surface?.Components?.Data ?? []).find((c) => /DynamicField<bool>/.test(typeName(c)));
  check('Surface/cards exposes the spread toggle as a variable',
    String(spread?.Data?.VariableName?.Data ?? '') === 'InnerDeck/spread',
    String(spread?.Data?.VariableName?.Data));
  // It must point at the BooleanValueDriver's State - the field the search button
  // writes. `grid X` and `grid Y` look like the spread's inputs and are not: both
  // are driven outputs of ChildrenCount, so writing them does nothing.
  const state = (surface?.Components?.Data ?? []).find((c) => /BooleanValueDriver<floatQ>/.test(typeName(c)));
  check('and it is bound to the toggle the search button writes',
    !!state && String(spread?.Data?.TargetField?.Data) === String(state.Data.State.ID));

  let refs = 0, bound = 0;
  (function w(sl) {
    if (nm(sl) === 'the deck template')
      for (const c of sl.Components?.Data ?? [])
        if (/GlobalReference<\[FrooxEngine\]FrooxEngine\.Slot>/.test(typeName(c))) {
          refs++;
          if (String(c.Data.Reference?.Data ?? '') === String(deckSlot?.ID)) bound++;
        }
    for (const c of kids(sl)) w(c);
  })(doc.Object);
  check('the importer has a deck-template reference', refs > 0, `${refs} found`);
  check('and it points at the deck, not at the holder or at nothing', refs > 0 && bound === refs,
    `${bound}/${refs} bound`);
}

// Every card must still reach a mesh, a material and a texture that exist here.
const assetById = new Map((doc.Assets ?? []).map((a) => [a.Data.ID, a]));
const matById = new Map((deckAssets?.Components?.Data ?? []).map((c) => [c.Data.ID, c]));
let meshOk = 0, matOk = 0, texOk = 0, artOk = 0;
for (const buffer of cards) {
  const visual = kids(kids(buffer)[0] ?? {})[0];
  const r = (visual?.Components?.Data ?? []).find((c) => /\.MeshRenderer$/.test(typeName(c)));
  if (!r) continue;
  if (assetById.has(r.Data.Mesh.Data)) meshOk++;
  const art = kids(visual).find((c) => nm(c) === 'art');
  const local = art ? (function all(s, o = []) { o.push(...(s.Components?.Data ?? [])); for (const c of kids(s)) all(c, o); return o; })(art) : [];
  const mat = matById.get(r.Data.Materials.Data[1].Data) ?? local.find((c) => c.Data.ID === r.Data.Materials.Data[1].Data);
  if (mat) { matOk++;
    const tex = assetById.get(mat.Data.Texture.Data) ?? local.find((c) => c.Data.ID === mat.Data.Texture.Data);
    if (tex) texOk++;
  }
  if (local.some((c) => c.Data?.VariableName?.Data === 'Card/url')) artOk++;
}
check('every card still resolves its mesh', meshOk === cards.length, `${meshOk}/${cards.length}`);
check('every card still resolves its front material', matOk === cards.length, `${matOk}/${cards.length}`);
check('every card still resolves its texture', texOk === cards.length, `${texOk}/${cards.length}`);
check('every card still carries its Card/url', artOk === cards.length, `${artOk}/${cards.length}`);

// ── the document holds together ──────────────────────────────────────────────
console.log('\nthe document holds together:');
const GUID = /^[0-9a-f]{8}-0000-0000-0000-000000000000$/;
const NULL_GUID = '00000000-0000-0000-0000-000000000000';
const isDecl = (k) => k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k);
const declared = new Map(), referenced = new Set(), packdb = new Set();
(function w(o) {
  if (Array.isArray(o)) return o.forEach(w);
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') {
      if (GUID.test(v)) { if (isDecl(k)) declared.set(v, (declared.get(v) || 0) + 1); else referenced.add(v); }
      if (v.startsWith('@packdb:///')) packdb.add(v.slice(11));
    } else w(v);
  }
})(doc);
const dupes = [...declared].filter(([, n]) => n > 1).map(([i]) => i);
const dangling = [...referenced].filter((r) => r !== NULL_GUID && !declared.has(r));
check('every id is declared exactly once', dupes.length === 0, `${dupes.length}: ${dupes.slice(0, 3).join(', ')}`);
check('no reference dangles', dangling.length === 0, `${dangling.length}: ${dangling.slice(0, 3).join(', ')}`);
note(`${declared.size} ids, ${referenced.size} references`);

const blobs = new Set(Object.keys(zip.files).filter((n) => n.startsWith('Assets/')).map((n) => n.slice(7)));
const missing = [...packdb].filter((h) => !blobs.has(h));
// The stripped template ships placeholders the bake fills in; those are inherited,
// not introduced, so the bar is that the deck's MESHES all arrived.
const meshHashes = new Set();
for (const a of doc.Assets ?? []) if (/StaticMesh$/.test(typeName(a)))
  meshHashes.add(String(a.Data.URL.Data).replace(/^@?packdb:\/\/\//, ''));
check('every mesh blob came across', [...meshHashes].every((h) => blobs.has(h)),
  `${[...meshHashes].filter((h) => !blobs.has(h)).length} missing of ${meshHashes.size}`);
note(`${packdb.size} packdb references, ${blobs.size} blobs, ${missing.length} left to the bake`);

const manifest = new Set(record.assetManifest.map((e) => e.hash));
check('the manifest lists nothing absent', [...manifest].every((m) => blobs.has(m)),
  `${[...manifest].filter((m) => !blobs.has(m)).length} ghosts`);
check('assetUri resolves', blobs.has(mainHash));
check('BSON round-trips byte-identical', Buffer.from(await serializeBson(doc)).equals(Buffer.from(bson)));

console.log(bad ? `\n${bad} FAILED\n` : '\npanel + deck verified\n');
process.exit(bad ? 1 : 0);
