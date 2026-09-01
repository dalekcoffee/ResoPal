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
import { DECK_POSITION, DECK_ROTATION } from './deck-import.mjs';

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

// THE POSE LIVES HERE, not on the `Decks` slot the duplicates are parented under.
// `Slot.Duplicate(parent, keepGlobalTransform = true)` - the default the ProtoFlux
// node takes - keeps the TEMPLATE's world transform and merely re-parents, so the
// parent's own pose never enters into it. The holder above must stay at identity
// too, or it would add to this.
{
  const num = (v) => Number(v);
  const hp = (holder?.Position?.Data || []).map(num), hr = (holder?.Rotation?.Data || []).map(num);
  check('the holder adds nothing to the pose',
    hp.every((v) => Math.abs(v) < 1e-6) && Math.abs(hr[3] - 1) < 1e-6);
  const p = (deckSlot?.Position?.Data || []).map(num), r = (deckSlot?.Rotation?.Data || []).map(num);
  check('and the deck root carries the pose a duplicate will inherit',
    DECK_POSITION.every((v, i) => Math.abs(p[i] - v) < 1e-6) &&
    DECK_ROTATION.every((v, i) => Math.abs(r[i] - v) < 1e-6),
    `pos ${p.map((v) => v.toFixed(3))} rot ${r.map((v) => v.toFixed(3))}`);
  // Euler(-90,-90,-90) through floatQ.EulerRad, checked so a hand-edited value
  // cannot quietly stop being a rotation.
  check('which is a unit quaternion', Math.abs(Math.hypot(...DECK_ROTATION) - 1) < 1e-6);
  // The export's own 0.91 was saved-in-world residue, not an authored size.
  check('and scale 1, not the 0.91 the export carried',
    (deckSlot?.Scale?.Data || []).map(num).every((v) => Math.abs(v - 1) < 1e-6));
}
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

// ── the card's tag against the deck's own whitelist ──────────────────────────
// Read the filter OUT OF THE DECK rather than restating "Card" here, because the
// two have to agree and only one of them is ours. Every
// `GrabbableReceiverSurface.GetReceiveDistance` opens with
// `TagFilter.ValidateTag(grabbable.Slot)`, which in Whitelist mode is
// `slot.Tag != null && List.Contains(slot.Tag)` - so a card whose tag is not in
// the list is refused before position or collider are even considered, and the
// deck can never be handed one back. This is a separate gate from the Snapper's
// keyword: keyword is what a playmat's SnapTarget whitelists, tag is what a deck's
// receiver surface whitelists.
{
  // The exact classpath, not a substring: the deck's flux carries
  // `OnGrabbableReceiverSurfaceReceived` nodes and `GlobalRef<...>`s that all
  // contain the name and none of which is a surface. Matching loosely found ten
  // and called eight of them a refusal.
  const SURFACE = '[FrooxEngine]FrooxEngine.GrabbableReceiverSurface';
  const surfaces = [];
  (function w(sl) {
    for (const c of sl.Components?.Data ?? [])
      if (typeName(c) === SURFACE) surfaces.push(c);
    for (const c of kids(sl)) w(c);
  })(doc.Object);
  check('the deck has its receiver surfaces', surfaces.length > 0, `${surfaces.length}`);

  let card = null;
  (function w(sl) { if (nm(sl) === 'card') card = sl; for (const c of kids(sl)) w(c); })(doc.Object);
  const tag = card?.Tag?.Data == null ? null : String(card.Tag.Data);
  check('the imported card template carries a tag at all', tag !== null && tag !== '',
    JSON.stringify(tag));

  const accepts = (f) => {
    const list = (f?.List?.Data ?? []).map((e) => String(e?.Data ?? e));
    const listed = tag !== null && list.includes(tag);
    return String(f?.Mode?.Data) === 'Blacklist' ? !listed : listed;
  };
  const refused = surfaces.filter((s) => !accepts(s.Data.TagFilter));
  check('and every one of the deck\'s surfaces would accept it', refused.length === 0,
    `${refused.length}/${surfaces.length} would refuse tag ${JSON.stringify(tag)}`);
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
// A STOCK card carrying `Card/url` means the template came from
// `build-deck-probe.mjs`, which bakes the per-card art chain into all 52. The
// shipping template is a plain Deck Maker export and has none, which is correct:
// the importer destroys every stock card and puts the panel's own in their place,
// and those carry their own `CARD/url`. So this is reported, not required.
note(artOk === cards.length ? 'stock cards carry Card/url (a probe-built template)'
  : `stock cards carry no Card/url (${artOk}/${cards.length}) - a plain export, which the importer replaces`);

// What the importer DOES need from the stock cards is that they can be thrown
// away cleanly. Ukilop built the hook: each buffer carries a DestroyProxy aimed at
// that card's driver proxy in `/Deck/Assets`, so destroying the buffer takes its
// flux with it and the two lists stay the same length. The deck indexes `Assets`
// by POSITION, so a card destroyed without its proxy would silently shift every
// later card's flux onto the wrong card.
{
  const withProxy = cards.filter((b) =>
    (b.Components?.Data ?? []).some((c) => /\.DestroyProxy$/.test(typeName(c)) && c.Data.DestroyTarget?.Data));
  check('every stock card can be destroyed with its flux', withProxy.length === cards.length,
    `${withProxy.length}/${cards.length} buffers carry a DestroyProxy`);
  check('and there is one driver proxy per card to destroy',
    kids(deckAssets ?? {}).length === cards.length);
}

// A packdb reference with no blob behind it is a font that does not load or a
// texture that does not, and in-world that is text off its button and untextured
// card edges. `strip_template.mjs` drops the fallback fonts and the placeholder
// atlas because the WEBSITE's patch.js replaces both; nothing replaces them here.
{
  const have = new Set(Object.keys(zip.files).filter((n) => n.startsWith('Assets/')).map((n) => n.slice(7)));
  const want = new Set();
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (!o || typeof o !== 'object') return;
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && v.startsWith('@packdb:///')) want.add(v.slice(11));
      else w(v);
    }
  })(doc);
  const absent = [...want].filter((h) => !have.has(h));
  check('every packdb reference has its blob - no stripped fonts, no stripped atlas',
    absent.length === 0, `${absent.length} of ${want.size} missing`);
}

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
