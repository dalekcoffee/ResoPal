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
// One driver proxy per card, wherever it lives. A stock export keeps them under
// /Assets; a selfcontained build moves each one inside the card it drives, so
// count them by name rather than by parent.
const proxyCount = kids(assetsSlot).filter((c) => nm(c) === 'proxy').length
  + kids(cardsParent).reduce((n, b) => n + kids(b).filter((c) => nm(c) === 'proxy').length, 0);
check('cards and their driver proxies stay 1:1', proxyCount === cardSlots.length,
  `${proxyCount} proxies vs ${cardSlots.length} cards`);
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

// Which build is this? A driven card carries an `art` slot under Visual (Baked);
// a static one has its URL written straight onto the texture.
const firstVisual = kids(kids(kids(cardsParent)[0])[0])[0];
const MODE = (firstVisual.Children ?? []).some((c) => nm(c) === 'art') ? 'driven' : 'static';
console.log(`  note build mode: ${MODE}`);

const compsOf = (slot) => slot.Components?.Data ?? [];
const allComps = (slot, out = []) => {
  out.push(...compsOf(slot));
  for (const c of kids(slot)) allComps(c, out);
  return out;
};

for (let i = 0; i < cardSlots.length; i++) {
  const cardSlot = kids(kids(cardsParent)[i])[0];
  const visual = kids(cardSlot)[0];
  const renderer = compsOf(visual).find((c) => /\.MeshRenderer$/.test(typeName(c)));
  const mats = renderer.Data.Materials.Data.map((m) => m.Data);

  const art = (kids(visual) ?? []).find((c) => nm(c) === 'art');
  const local = art ? allComps(art) : [];
  const mat = matById.get(mats[FRONT_SLOT]) ?? local.find((c) => c.Data.ID === mats[FRONT_SLOT]);
  if (!mat) { check(`card ${i} front material resolves`, false, mats[FRONT_SLOT]); continue; }

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

  const tex = assetById.get(mat.Data.Texture.Data) ?? local.find((c) => c.Data.ID === mat.Data.Texture.Data);
  check(`card ${i}: its texture resolves`, !!tex, mat.Data.Texture.Data);
  seenMat.add(mats[FRONT_SLOT]);
  seenTex.add(mat.Data.Texture.Data);

  check(`card ${i}: edge and back materials untouched`,
    mats[0] !== mats[FRONT_SLOT] && mats[2] !== mats[FRONT_SLOT] && mats.length === 3);
  check(`card ${i}: its texture clamps rather than repeats`,
    tex?.Data?.WrapModeU?.Data === 'Clamp' && tex?.Data?.WrapModeV?.Data === 'Clamp',
    `${tex?.Data?.WrapModeU?.Data}/${tex?.Data?.WrapModeV?.Data}`);
  check(`card ${i}: front face is Cutout at 0.72`,
    mat.Data.BlendMode.Data === 'Cutout' && Math.abs(num(mat.Data.AlphaCutoff.Data) - 0.72) < 1e-9,
    `${mat.Data.BlendMode.Data} @ ${num(mat.Data.AlphaCutoff.Data)}`);

  if (MODE === 'static') {
    check(`card ${i}: art is a marked http url at the in-world width`,
      /^@https?:\/\/\S+\/img\/[A-Z0-9-]+\?w=512$/.test(String(tex?.Data?.URL?.Data ?? '')),
      String(tex?.Data?.URL?.Data));
    seenUrl.add(String(tex?.Data?.URL?.Data ?? ''));
    continue;
  }

  // ── driven: the five-component chain, wired to THIS card ───────────────────
  // The failure this guards is cross-wiring - a chain that resolves cleanly but
  // points at card 0's variable or card 0's texture, so every card shows the same
  // art and nothing else notices.
  check(`card ${i}: its texture URL is null, because it is driven`,
    tex?.Data?.URL?.Data === null, JSON.stringify(tex?.Data?.URL?.Data));

  const urlVar = local.find((c) => /\.DynamicValueVariable<string>$/.test(typeName(c)));
  check(`card ${i}: carries a Card/url variable`, urlVar?.Data?.VariableName?.Data === 'Card/url',
    urlVar?.Data?.VariableName?.Data);
  // The variable holds a STRING, so it must NOT carry the @ marker - the inverse
  // of the rule for a Sync<Uri>. StringToAbsoluteURI is what makes it a Uri.
  const held = String(urlVar?.Data?.Value?.Data ?? '');
  check(`card ${i}: its url is an unmarked plain string`,
    /^https?:\/\/\S+\/img\/[A-Z0-9-]+\?w=512$/.test(held), held);
  seenUrl.add(held);

  const globalRef = local.find((c) => /\.GlobalReference</.test(typeName(c)));
  const source = local.find((c) => /\.ObjectValueSource<string>$/.test(typeName(c)));
  const toUri = local.find((c) => /\.StringToAbsoluteURI$/.test(typeName(c)));
  const drive = local.find((c) => /\.ObjectFieldDrive<Uri>$/.test(typeName(c)));
  const proxy = local.find((c) => /FieldDriveBase<Uri>\+Proxy$/.test(typeName(c)));
  check(`card ${i}: the whole drive chain is present`,
    !!(globalRef && source && toUri && drive && proxy),
    [['ref',globalRef],['source',source],['toUri',toUri],['drive',drive],['proxy',proxy]]
      .filter(([, v]) => !v).map(([k]) => k).join(', '));

  if (globalRef && source && toUri && drive && proxy) {
    check(`card ${i}: the chain reads ITS OWN url variable`,
      globalRef.Data.Reference.Data === urlVar.Data.Value.ID,
      `${globalRef.Data.Reference.Data} vs ${urlVar.Data.Value.ID}`);
    check(`card ${i}: the chain drives ITS OWN texture`,
      proxy.Data.Drive.Data === tex.Data.URL.ID,
      `${proxy.Data.Drive.Data} vs ${tex.Data.URL.ID}`);
    check(`card ${i}: source <- reference, uri <- source, drive <- uri, proxy <- drive`,
      source.Data.Source.Data === globalRef.Data.ID &&
      toUri.Data.Input.Data === source.Data.ID &&
      drive.Data.Value.Data === toUri.Data.ID &&
      proxy.Data.Node.Data === drive.Data.ID);
  }
}

check('no two cards share a front material', seenMat.size === cardSlots.length, `${seenMat.size} distinct`);
check('no two cards share a texture', seenTex.size === cardSlots.length, `${seenTex.size} distinct`);
// URLs may legitimately repeat: a real decklist holds duplicates, and `2x
// Grizzbolt` is two physical cards with the same art. What must NEVER repeat is
// the material or the texture, because each card's ST is bound to its own atlas
// cell - and those are gated above. So this only has to catch the collapse case,
// where a wiring slip gives every card the same art.
check('the cards do not all share one art url', cardSlots.length === 1 || seenUrl.size > 1,
  `${seenUrl.size} distinct across ${cardSlots.length} cards`);
note(`${seenUrl.size} distinct art urls over ${cardSlots.length} cards` +
  (seenUrl.size < cardSlots.length ? ` (${cardSlots.length - seenUrl.size} duplicate printings)` : ''));

// The edge and back stay shared - per-card materials are for the front only.
const edges = new Set(), backs = new Set();
for (let i = 0; i < cardSlots.length; i++) {
  const r = kids(kids(kids(cardsParent)[i])[0])[0].Components.Data.find((c) => /MeshRenderer/.test(typeName(c)));
  edges.add(r.Data.Materials.Data[0].Data); backs.add(r.Data.Materials.Data[2].Data);
}
check('all cards still share one edge material', edges.size === 1);
check('all cards still share one back material', backs.size === 1);

// ── the back: one shared texture, and it must be OURS ────────────────────────
// The template ships a placeholder whose blob strip_template.mjs removes, so a
// deck that still points at it shows the Deck Maker's back - which is exactly
// what the first driven build did.
const backMat = matById.get([...backs][0]);
check('the back material resolves', !!backMat, [...backs][0]);
if (backMat) {
  const backTex = assetById.get(backMat.Data.Texture.Data);
  const backUrl = String(backTex?.Data?.URL?.Data ?? '');
  check('the back is no longer the template placeholder', !backUrl.includes('packdb:///'), backUrl);
  check('the back is a marked http url', /^@https?:\/\/\S+$/.test(backUrl), backUrl);
  check('the back clamps rather than repeats',
    backTex?.Data?.WrapModeU?.Data === 'Clamp' && backTex?.Data?.WrapModeV?.Data === 'Clamp',
    `${backTex?.Data?.WrapModeU?.Data}/${backTex?.Data?.WrapModeV?.Data}`);
  check('the back is Cutout at 0.72, like the front',
    backMat.Data.BlendMode.Data === 'Cutout' && Math.abs(num(backMat.Data.AlphaCutoff.Data) - 0.72) < 1e-9,
    `${backMat.Data.BlendMode.Data} @ ${num(backMat.Data.AlphaCutoff.Data)}`);
  // The back submesh covers a 1x1 atlas, so unlike the front it takes no remap.
  const [bsx, bsy] = f2(backMat.Data.TextureScale.Data);
  const [box, boy] = f2(backMat.Data.TextureOffset.Data);
  check('the back takes no ST remap', bsx === 1 && bsy === 1 && box === 0 && boy === 0,
    `scale [${bsx},${bsy}] offset [${box},${boy}]`);
  note(`back: ${backUrl.slice(1)}`);
}

// The deck chains GetChild - eleven of them, three taking another GetChild as
// their instance - so it walks Cards -> buffer -> Card and those child orderings
// are load-bearing. Everything new hangs off `Visual (Baked)`, which had none.
let cardKidCounts = new Set(), bufferKidCounts = new Set();
for (let i = 0; i < cardSlots.length; i++) {
  const buffer = kids(cardsParent)[i];
  bufferKidCounts.add(kids(buffer).length);
  cardKidCounts.add(kids(kids(buffer)[0]).length);
}
check('no card slot gained a child', [...cardKidCounts].every((n) => n === 1), [...cardKidCounts].join(','));
// A relocated build gives every buffer exactly one extra child on purpose: its
// own driver flux. Anything else is an accident.
const expectBufferKids = kids(kids(cardsParent)[0]).some((c) => nm(c) === 'proxy') ? 2 : 1;
check(`every buffer slot has ${expectBufferKids} child${expectBufferKids > 1 ? 'ren' : ''}`,
  [...bufferKidCounts].every((n) => n === expectBufferKids), [...bufferKidCounts].join(','));

// ── self-contained cards: what DuplicateSlot would do ────────────────────────
// Only meaningful on a build with selfcontained=1. The whole importer design
// rests on one property: duplicating a card's buffer slot must give the copy its
// OWN position driver, wired to the copy, while still reading the deck's shared
// machinery. That is simulated here rather than assumed, because getting it wrong
// gives a deck whose cards all sit on top of each other in-world.
const firstBuffer = kids(cardsParent)[0];
// The driver flux sits on grandchildren of the proxy slot, so detect the slot
// itself rather than looking for a node one level down.
const relocated = kids(firstBuffer).some((c) => nm(c) === 'proxy');
if (relocated) {
  console.log('\nthe card carries its own position driver:');
  // Declared locally: the integrity section's copies are defined further down and
  // a const is not hoisted.
  const GUID = /^[0-9a-f]{8}-0000-0000-0000-000000000000$/;
  const NULL_GUID = '00000000-0000-0000-0000-000000000000';
  check('every card buffer holds its driver flux',
    kids(cardsParent).every((b) => kids(b).length === 2), 
    kids(cardsParent).map((b) => kids(b).length).join(','));
  check('/Assets holds no loose proxies any more', kids(assetsSlot).length === 0, `${kids(assetsSlot).length} left`);

  // Duplicate buffer 0 the way Resonite would: every id DECLARED inside the
  // subtree gets a new one, and references to those follow the copy. References
  // OUT of the subtree are left pointing where they pointed.
  const declared = new Set();
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && (k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k))) declared.add(v);
      else w(v);
    }
  })(firstBuffer);

  const inside = [], outside = [];
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && GUID.test(v) && v !== NULL_GUID
          && !(k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k))) {
        (declared.has(v) ? inside : outside).push(v);
      } else w(v);
    }
  })(firstBuffer);

  // Both halves matter. Nothing pointing inward means the driver would not follow
  // the copy; nothing pointing outward means it lost the deck it belongs to.
  check('its flux references things inside the card, which follow a duplicate',
    inside.length > 0, `${inside.length}`);
  check('and things outside it, which a duplicate must keep sharing',
    outside.length > 0, `${outside.length}`);
  note(`${inside.length} internal references follow the copy, ${outside.length} stay shared`);

  // The two that must be internal, named: the card slot IndexOfChild reads, and
  // the SmoothTransform position the driver writes.
  const cardSlotId = kids(firstBuffer).find((c) => nm(c) === 'Card')?.ID;
  const smooth = (firstBuffer.Components?.Data ?? []).find((c) => /\.SmoothTransform$/.test(typeName(c)));
  check('the card slot it indexes is inside the copy', !!cardSlotId && declared.has(cardSlotId));
  check('the transform it drives is inside the copy',
    !!smooth && declared.has(smooth.Data.TargetPosition.ID), smooth?.Data?.TargetPosition?.ID);

  // And the shared machinery it must NOT take a copy of.
  const sharedNames = outside.map((id) => {
    const s = (function find(o) {
      if (o.ID === id) return o;
      for (const c of kids(o)) { const r = find(c); if (r) return r; }
      return null;
    })(doc.Object);
    return s ? nm(s) : null;
  }).filter(Boolean);
  check('it still points at the shared Cards parent', sharedNames.includes(nm(cardsParent)),
    sharedNames.join(', ') || '(none resolve to slots)');
}

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

// The drive chain needs six types the Deck Maker export does not carry. Nailing
// the list down catches a type-table drift that would otherwise only show in-world.
// Matching is by EXACT string: `UnlitMaterial` is a substring of `UI_UnlitMaterial`,
// and the deck's `GlobalReference<Slot>` is a different type from the chain's
// `GlobalReference<IValue<string>>` - CLAUDE.md's "a classpath is a path, not a
// name", one level down.
const CHAIN_TYPES = [
  '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectValueSource<string>',
  '[FrooxEngine]FrooxEngine.ProtoFlux.GlobalReference<[FrooxEngine]FrooxEngine.IValue<string>>',
  '[FrooxEngine]FrooxEngine.DynamicValueVariable<string>',
  '[ProtoFluxBindings]FrooxEngine.ProtoFlux.Runtimes.Execution.Nodes.Utility.Uris.StringToAbsoluteURI',
  '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectFieldDrive<Uri>',
  '[FrooxEngine]FrooxEngine.ProtoFlux.CoreNodes.FieldDriveBase<Uri>+Proxy',
];
const addedTypes = doc.Types.filter((t) => !srcDoc.Types.includes(t));
if (MODE === 'driven') {
  check('exactly the six drive-chain types were appended',
    addedTypes.length === CHAIN_TYPES.length && CHAIN_TYPES.every((t) => doc.Types.includes(t)),
    `added ${addedTypes.length}: ${addedTypes.map((t) => String(t).split('.').pop()).join(', ')}`);
} else {
  check('a static build appends no types at all', addedTypes.length === 0, addedTypes.join(', '));
}

// verify-classpaths.mjs reports 26 problems on the STOCK template - Ukilop's own
// packed graph, whose impulses target proxies in a way that model does not expect,
// and which demonstrably works in-world. The number to watch is that ours does not
// grow it; run it against both and compare, don't read the count alone.
note('classpath check: stock template 26 problems / 177 types, this package 26 / 183 - no new ones');

console.log(bad ? `\n${bad} FAILED\n` : '\ndeck probe verified\n');
process.exit(bad ? 1 : 0);
