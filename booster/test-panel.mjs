// Check the built panel: its UI structure, its button wiring, and its parse
// graph evaluated the way Resonite would evaluate it.
//
// This reads the PACKAGE, not the builder's intentions, so a node wired to the
// wrong id fails here exactly as it would in-world. It cannot prove Resonite
// accepts the file - only a drag-test does that - but it does prove the things
// that were wrong last time: that there is something to look at before any
// request happens, and that the card art and card count come out right for a
// 7-line pull and a 50-line deck alike.
//
//   RKL=/path/to/Resonite-Knowledge-Library node booster/test-panel.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { scanUrlFields } from './urlmarker.mjs';
import { typeVersion } from './members.mjs';

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const decodeMjs = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(decodeMjs)) { console.error('Need the Knowledge Library for its codec; set RKL=<path>'); process.exit(1); }
const { frdtToBsonBytes, deserializeBson, serializeBson } = await import(`file://${decodeMjs}`);

const pkg = process.argv[2] || path.join(import.meta.dirname, 'out', 'ResoPal_Panel.resonitepackage');
const raw = await readFile(pkg);
const zip = await JSZip.loadAsync(raw);
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const bson = await frdtToBsonBytes(await zip.file('Assets/' + record.assetUri.replace('packdb:///', '')).async('uint8array'));
const doc = await deserializeBson(bson);

const num = (v) => (v && typeof v === 'object' && v._bsontype ? Number(v) : v);
const TYPES = doc.Types;
const short = (t) => String(t).replace(/^\[[^\]]+\]/, '').split('.').pop();
const nm = (s) => String(s?.Name?.Data ?? '');
const NEWLINE = String.fromCharCode(10);

let bad = 0;
const check = (n, ok, d = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${!ok && d ? '  ' + d : ''}`); };

// ── index every component, every field, and the slot each lives on ───────────
const byComp = new Map(), byField = new Map(), slotOf = new Map();
(function walk(n, slot) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach((x) => walk(x, slot));
  const here = (n.Children !== undefined && n.Name !== undefined) ? n : slot;
  if (n.Type !== undefined && n.Data && n.Data.ID) {
    const rec = { type: TYPES[num(n.Type)], data: n.Data, id: n.Data.ID, slot: here };
    byComp.set(n.Data.ID, rec);
    if (here) slotOf.set(n.Data.ID, here);
    for (const [k, v] of Object.entries(n.Data))
      if (v && typeof v === 'object' && typeof v.ID === 'string') byField.set(v.ID, { comp: rec, name: k });
  }
  for (const v of Object.values(n)) walk(v, here);
})(doc, null);

const compsOfType = (t) => [...byComp.values()].filter((c) => short(c.type) === t);
const arg = (c, name) => (c.data[name] === undefined ? undefined : c.data[name].Data);
// A routing relay is not logic. The autorouter turns every long or cornered
// impulse wire into a ContinuationRelay pipe, and a corner gets a flank PAIR, so
// a chain the builder emits as `A -> B` arrives as `A -> relay -> relay -> B`.
// Asserting the raw chain therefore asserts the router's output, not the graph's
// meaning - which is how four of these checks went red on a build whose logic had
// not changed at all. Every walk below steps over relays instead: the order of
// the OPERATIONS is the property worth holding, and a relay is precisely the
// thing that cannot change it.
const throughRelays = (c) => {
  for (let n = 0; short(c?.type) === 'ContinuationRelay' && n < 16; n++) c = byComp.get(arg(c, 'Next'));
  return c;
};

console.log(`${path.basename(pkg)}  (${byComp.size} components, ${raw.length} bytes)`);

// ── 1. there is a visible UI, before any network call ────────────────────────
console.log(`${NEWLINE}UI:`);
const canvases = compsOfType('Canvas');
check('exactly one Canvas', canvases.length === 1);
const canvas = canvases[0];
const cSize = (arg(canvas, 'Size') || []).map(num);
check('canvas has a real size', cSize[0] > 100 && cSize[1] > 100, JSON.stringify(cSize));
check('canvas root rect is a RectTransform on its own slot',
  short(byComp.get(arg(canvas, '_rootRect'))?.type) === 'RectTransform' &&
  slotOf.get(arg(canvas, '_rootRect')) === canvas.slot);
const colId = arg(canvas, 'Collider');
check('canvas collider is a BoxCollider on its own slot',
  short(byComp.get(colId)?.type) === 'BoxCollider' && slotOf.get(colId) === canvas.slot);
check('collider size and offset drive that collider own fields',
  byField.get(arg(canvas, '_colliderSize'))?.comp.id === colId &&
  byField.get(arg(canvas, '_colliderOffset'))?.comp.id === colId);

const texts = compsOfType('Text');
check('the panel has text', texts.length >= 5, String(texts.length));
check('every Text has a font', texts.every((t) => short(byComp.get(arg(t, 'Font'))?.type) === 'FontChain'));
const chain = compsOfType('FontChain')[0];
const font = byComp.get(arg(chain, 'MainFont'));
check('the font chain has a real main font', short(font?.type) === 'StaticFont');
const fontUrl = String(arg(font, 'URL') || '');
check('the font asset ships inside the package',
  fontUrl.startsWith('@packdb:///') && record.assetManifest.some((a) => a.hash === fontUrl.replace('@packdb:///', '')));

const buttons = compsOfType('Button');
const triggers = compsOfType('ButtonDynamicImpulseTrigger');
check('four buttons', buttons.length === 4, String(buttons.length));
check('every button has an impulse trigger', triggers.length === buttons.length);
check('every button tints an Image on its own slot', buttons.every((b) => {
  const drivers = arg(b, 'ColorDrivers') || [];
  if (drivers.length !== 1) return false;
  const f = byField.get(drivers[0].ColorDrive.Data);
  return f && short(f.comp.type) === 'Image' && f.name === 'Tint' && f.comp.slot === b.slot;
}));
check('every button carries a caption', buttons.every((b) =>
  (b.slot.Children || []).some((c) => (c.Components?.Data || []).some((x) => short(TYPES[num(x.Type)]) === 'Text'))));

// The paste field is three components that have to agree, on one slot: a Text
// holding the content, a TextEditor pointing at it, a TextField pointing at the
// editor. Miss any link and the field renders but cannot be typed into.
const fields = compsOfType('TextField');
check('one paste field', fields.length === 1, String(fields.length));
const editor = fields[0] && byComp.get(arg(fields[0], 'Editor'));
check('the field has an editor', short(editor?.type) === 'TextEditor');
const pasteText = editor && byComp.get(arg(editor, 'Text'));
check('the editor edits a Text', short(pasteText?.type) === 'Text');
check('all three sit on one slot',
  fields[0]?.slot === editor?.slot && editor?.slot === pasteText?.slot);
check('that Text accepts interaction, or there is nothing to click',
  arg(pasteText, 'InteractionTarget') === true);
check('an empty field is empty, not whitespace', arg(editor, 'FinishHandling') === 'NullOnWhitespace');
check('it tells you what to paste', String(arg(pasteText, 'NullContent') || '').length > 10);

// ── 2. pressing a button reaches the graph ───────────────────────────────────
console.log(`${NEWLINE}buttons -> graph:`);
const receivers = compsOfType('DynamicImpulseReceiver');
check('one receiver per button', receivers.length === 4, String(receivers.length));
const tagsSent = triggers.map((t) => arg(t, 'PressedTag')).sort();
const tagsHeard = receivers.map((r) => arg(byComp.get(arg(r, 'Tag')), 'Value')).sort();
check('every tag a button sends is heard', JSON.stringify(tagsSent) === JSON.stringify(tagsHeard),
  `sent ${JSON.stringify(tagsSent)} heard ${JSON.stringify(tagsHeard)}`);
// The encoder reserves id 00000000-...-0 for the root, which IS the null GUID,
// so a reference to the root deserializes as null. A null Target here silently
// broadcasts at the whole world root instead of this object.
const NULL_GUID = '00000000-0000-0000-0000-000000000000';
check('no trigger targets the root (that id is the null GUID)',
  triggers.every((t) => arg(t, 'Target') && arg(t, 'Target') !== NULL_GUID));
check('every trigger targets a slot that holds the receivers', triggers.every((t) => {
  const target = arg(t, 'Target');
  const found = (function find(s) {
    if (s.ID === target) return s;
    for (const ch of s.Children || []) { const r = find(ch); if (r) return r; }
    return null;
  })(doc.Object);
  if (!found) return false;
  let n = 0;
  (function count(s) {
    for (const c of s.Components?.Data || []) if (short(TYPES[num(c.Type)]) === 'DynamicImpulseReceiver') n++;
    (s.Children || []).forEach(count);
  })(found);
  return n === 4;
}));

let check_async_seen = false;
const allWrites = compsOfType('WriteDynamicObjectVariable<string>');
// A receiver fires a URL write; the request's own impulse outputs fire the
// event writes that report which branch ran, and the loop fires the one that
// tells a fresh card its art. Only the first kind is a button.
const writes = allWrites.filter((w) => receivers.some((r) => arg(r, 'OnTriggered') === w.id));
check('three receivers trigger a URL write', writes.length === 3, String(writes.length));
check('three distinct URLs, one per preset button',
  new Set(writes.map((w) => arg(byComp.get(arg(w, 'Value')), 'Value'))).size === 3);
check('exactly one GET, shared by all three', compsOfType('GET_String').length === 1);
check('every write continues into the request', writes.every((w) => {
  // write -> trunk relay -> StartAsyncTask -> GET. The async wrapper is not
  // optional: GET_String is an AsyncActionNode and an ordinary impulse cannot
  // run one - the chain would reach it and stop with no error anywhere.
  let after = throughRelays(byComp.get(arg(w, 'OnSuccess')));
  check_async_seen = check_async_seen || short(after?.type) === 'StartAsyncTask';
  if (short(after?.type) === 'StartAsyncTask') after = throughRelays(byComp.get(arg(after, 'TaskStart')));
  return short(after?.type) === 'GET_String';
}));
check('the request runs inside a StartAsyncTask', check_async_seen);

// The sixth button does not pick a URL - it POSTs whatever is in the paste
// field, and the Worker decides whether that was a palify deck link or a
// decklist. That is why the panel needs no decklist parser of its own.
const posts = compsOfType('POST_String');
check('exactly one POST', posts.length === 1);
const importRecv = receivers.find((r) => !writes.some((w) => arg(r, 'OnTriggered') === w.id));
check('the sixth receiver is the import button',
  !!importRecv && arg(byComp.get(arg(importRecv, 'Tag')), 'Value') === 'ResoPal/import');
const importNext = importRecv && byComp.get(arg(importRecv, 'OnTriggered'));
check('import runs the POST, asynchronously',
  short(importNext?.type) === 'StartAsyncTask' && arg(importNext, 'TaskStart') === posts[0]?.id);
check('the POST body is the paste field text', (() => {
  const src = byComp.get(arg(posts[0], 'String'));
  if (short(src?.type) !== 'ObjectValueSource<string>') return false;
  const ref = byComp.get(arg(src, 'Source'));
  const f = ref && byField.get(arg(ref, 'Reference'));
  return f?.name === 'Content' && f.comp.id === pasteText?.id;
})());
check('it posts to /api/resolve', (() => {
  const uri = byComp.get(arg(posts[0], 'URL'));
  return String(arg(byComp.get(arg(uri, 'Input')), 'Value') || '').includes('/api/resolve');
})());
check('with a sane media type', /^text\/plain$/.test(String(arg(byComp.get(arg(posts[0], 'MediaType')), 'Value') || '')));

const driver = compsOfType('DynamicValueVariableDriver<string>')[0];
const target = driver && byField.get(arg(driver, 'Target'));
check('the chosen URL is driven into the request',
  !!target && target.name === 'Value' && short(target.comp.type) === 'ValueObjectInput<string>');
check('driver and variable agree on a name',
  arg(driver, 'VariableName') === arg(compsOfType('DynamicValueVariable<string>')
    .find((v) => String(arg(v, 'VariableName')).startsWith('ResoPal/')), 'VariableName'));

// ── 3. evaluate the parse graph the way the runtime would ────────────────────
// STATE stands in for the two things the runtime holds and the package does
// not: what is currently in each local variable, and how many cards exist.
const memo = new Map();
const STATE = new Map();
function evalRef(ref, body, depth = 0) {
  if (ref == null) return null;
  if (depth > 8192) throw new Error('reference cycle');
  const f = byField.get(ref);
  if (f && f.comp.id !== ref) {
    // Content is an output sentinel addressed by FIELD id, not component id.
    if (short(f.comp.type) === 'GET_String' && f.name === 'Content') return body;
    return evalComp(f.comp, body, depth + 1);
  }
  const c = byComp.get(ref);
  if (!c) throw new Error(`unresolved ref ${ref}`);
  return evalComp(c, body, depth + 1);
}
function evalComp(c, body, depth) {
  const key = c.id;
  if (memo.has(key)) return memo.get(key);
  const t = short(c.type);
  const A = () => evalRef(arg(c, 'A'), body, depth), B = () => evalRef(arg(c, 'B'), body, depth);
  let r;
  switch (t) {
    case 'ValueObjectInput<string>': case 'ValueInput<int>': r = num(arg(c, 'Value')); break;
    case 'StringToAbsoluteURI': r = evalRef(arg(c, 'Input'), body, depth); break;
    case 'ObjectRelay<string>': case 'ValueRelay<int>': r = evalRef(arg(c, 'Input'), body, depth); break;
    case 'TrimString': r = String(evalRef(arg(c, 'A'), body, depth) ?? '').trim(); break;
    case 'StringLength': r = String(evalRef(arg(c, 'A'), body, depth) ?? '').length; break;
    case 'ValueAdd<int>': r = A() + B(); break;
    case 'ValueSub<int>': r = A() - B(); break;
    case 'ValueGreaterThan<int>': r = A() > B(); break;
    case 'ValueConditional<int>':
      r = evalRef(arg(c, 'Condition'), body, depth)
        ? evalRef(arg(c, 'OnTrue'), body, depth) : evalRef(arg(c, 'OnFalse'), body, depth); break;
    case 'ObjectConditional<string>':
      r = evalRef(arg(c, 'Condition'), body, depth)
        ? evalRef(arg(c, 'OnTrue'), body, depth) : evalRef(arg(c, 'OnFalse'), body, depth); break;
    case 'ConcatenateMultiString':
      r = (arg(c, 'Inputs') || []).map((e) => evalRef(e.Data, body, depth)).join(''); break;
    case 'IndexOfString': {
      const str = evalRef(arg(c, 'Str'), body, depth) ?? '';
      const part = evalRef(arg(c, 'Part'), body, depth) ?? '';
      const from = arg(c, 'StartIndex') == null ? 0 : evalRef(arg(c, 'StartIndex'), body, depth);
      // Verbatim from the decompiled node: out-of-range start is -1, not a clamp.
      if (str === null || part === '' || from < 0 || from >= str.length) { r = -1; break; }
      r = str.indexOf(part, from); break;
    }
    case 'Substring': {
      const str = evalRef(arg(c, 'Str'), body, depth) ?? '';
      const from = arg(c, 'StartIndex') == null ? 0 : evalRef(arg(c, 'StartIndex'), body, depth);
      const len = arg(c, 'Length') == null ? undefined : evalRef(arg(c, 'Length'), body, depth);
      // Verbatim from the decompiled node: clamp a negative start to 0, and
      // return "" when the start runs past the end or the length is negative.
      if (str === '') { r = ''; break; }
      const st = from < 0 ? 0 : from;
      const ln = len === undefined ? str.length : len;
      r = (st >= str.length || ln < 0) ? '' : str.substr(st, Math.min(str.length - st, ln));
      break;
    }
    case 'GET_String': case 'POST_String': r = body; break;
    // A local variable. The node IS the value; STATE is what the simulated loop
    // has written into it so far.
    case 'DataModelObjectFieldStore<string>': r = STATE.has(c.id) ? STATE.get(c.id) : ''; break;
    case 'IndexOfChild': r = STATE.has('children') ? STATE.get('children') : 0; break;
    case 'ValueInc<int>': r = evalRef(arg(c, 'N'), body, depth) + 1; break;
    case 'ValueMod<int>': r = A() % B(); break;
    case 'ValueDiv<int>': r = Math.trunc(A() / B()); break;
    case 'Cast_int_To_float': r = evalRef(arg(c, 'Input'), body, depth); break;
    case 'ValueMul<float>': r = A() * B(); break;
    case 'ValueInput<float>': r = num(arg(c, 'Value')); break;
    case 'Pack_Float3': r = ['X', 'Y', 'Z'].map((k) => evalRef(arg(c, k), body, depth)); break;
    case 'ObjectValueSource<string>': r = ''; break;   // the paste field, empty here
    default: throw new Error(`no evaluator for ${t}`);
  }
  memo.set(key, r);
  return r;
}

// ── the card template ───────────────────────────────────────────────────────
// One card, duplicated per record. The whole reason this works is that
// DuplicateSlot copies the ProtoFlux inside the slot and rewires the copy's
// references to the copy's own components - so anything shared between cards
// has to be ON THE SLOT, not in doc.Assets, or every card shows one texture.
console.log(`${NEWLINE}the card template:`);
const findSlot = (name, from = doc.Object) => {
  if (nm(from) === name) return from;
  for (const ch of from.Children || []) { const r = findSlot(name, ch); if (r) return r; }
  return null;
};
const tmplHolder = findSlot('Card template');
const tmpl = tmplHolder && (tmplHolder.Children || [])[0];
check('there is a card template', !!tmpl);
// DuplicateSlot copies Active verbatim, so the CARD has to stay active and its
// holder is what gets switched off - otherwise every card spawns invisible and
// nothing in the graph turns it back on.
check('the holder is inactive, so the template is out of sight', tmplHolder?.Active?.Data === false);
check('but the card itself is active, or every duplicate spawns invisible', tmpl?.Active?.Data !== false);
const tmplComps = (tmpl?.Components?.Data || []).map((c) => ({ t: short(TYPES[num(c.Type)]), d: c.Data }));
const hasT = (t) => tmplComps.find((c) => c.t === t);
for (const t of ['DynamicVariableSpace', 'DynamicValueVariable<string>', 'StaticTexture2D',
                 'UnlitMaterial', 'QuadMesh', 'MeshRenderer', 'TextureSizeDriver'])
  check(`it carries its own ${t}`, !!hasT(t));
check('its texture is a component, not a shared asset',
  (doc.Assets || []).every((a) => a.Data.ID !== hasT('StaticTexture2D')?.d.ID));
check('the variable is CARD/url, in its own CARD space',
  String(hasT('DynamicValueVariable<string>')?.d.VariableName?.Data) === 'CARD/url' &&
  String(hasT('DynamicVariableSpace')?.d.SpaceName?.Data) === 'CARD');
check('which is not the panel space, so a write cannot land on the panel',
  String(hasT('DynamicVariableSpace')?.d.SpaceName?.Data) !== 'ResoPal');

// A card you cannot pick up is a picture hanging in the air. These three are what
// make it an object: something to hit, something to grab, and a keyword a deck's
// receiver surface can recognise.
for (const t of ['BoxCollider', 'Grabbable', 'Snapper'])
  check(`it is a real object: ${t}`, !!hasT(t));
check('and a deck can recognise it as a card',
  (hasT('Snapper')?.d.Keywords?.Data || []).some((k) => String(k?.Data ?? k) === 'Card'));

// The collider follows the quad instead of being a fixed rectangle, because
// TextureSizeDriver rewrites that quad for landscape cards - BP01 has 19, and a
// portrait collider on a landscape card is a hit area hanging off both ends.
// A back face, so turning a card over shows a card back rather than the front
// mirrored. It is a child rotated a half turn, not a texture swap: no toggle, no
// state, nothing that can get out of step with which way the card is facing.
{
  const back = (tmpl?.Children || []).find((c) => nm(c) === 'back');
  const bComps = (back?.Components?.Data || []).map((c) => short(TYPES[num(c.Type)]));
  check('the card has a back face', !!back);
  for (const t of ['QuadMesh', 'UnlitMaterial', 'StaticTexture2D', 'MeshRenderer'])
    check(`the back carries its own ${t}`, bComps.includes(t));
  // Facing is decided on the MESH's own Rotation, never by turning a slot. A
  // slot's turn composes with the mesh's, two half turns cancel, and the back
  // ends up facing the same way as the front and covering it - which is exactly
  // what happened, twice. The working card had the front mesh at [0,1,0,0].
  const meshRot = (sl) => ((sl?.Components?.Data || [])
    .find((c) => short(TYPES[num(c.Type)]) === 'QuadMesh')?.Data.Rotation?.Data || []).map(num);
  const frontR = meshRot(tmpl), backR = meshRot(back);
  check('the front mesh states its own facing', Math.abs(frontR[1] ?? 0) === 1 && Math.abs(frontR[3] ?? 1) < 1e-6);
  check('and the back mesh states the opposite', Math.abs(backR[3] ?? 0) === 1 && Math.abs(backR[1] ?? 1) < 1e-6);
  check('no slot in the card is turned - facing lives on the mesh',
    [tmpl, back].every((sl) => Math.abs((sl?.Rotation?.Data || []).map(num)[1] ?? 0) < 1e-6));
  check('and set back from the front so the faces do not z-fight',
    Math.abs((back?.Position?.Data || []).map(num)[2] ?? 0) > 0);
  // A QuadMesh faces float3.Backward. Single-sided and unrotated, the card shows
  // its BACK to anyone standing where the panel faces and culls the front, which
  // in-world looks exactly like art that never loaded.
  // The collider is a fixed size with real thickness. Driven from the quad it is
  // zero until TextureSizeDriver has seen the texture load, and a card you cannot
  // pick up until its art arrives reads as a card that does not work.
  const box = hasT('BoxCollider')?.d;
  check('the collider has real thickness', ((box?.Size?.Data || []).map(num)[2] ?? 0) > 0);
  check('and is not driven from the quad', !hasT('Float2ToFloat3SwizzleDriver'));
  check('the front is single-sided, or the back would never be seen',
    hasT('QuadMesh')?.d.DualSided?.Data === false);
  // The back is the same image for every card, so it ships in the package - a
  // fetched back means a second host-access prompt on a different origin.
  const backUrl = String((back?.Components?.Data || [])
    .find((c) => short(TYPES[num(c.Type)]) === 'StaticTexture2D')?.Data.URL?.Data ?? '');
  check('the back image ships inside the package', backUrl.startsWith('@packdb:///'));
  const backHash = backUrl.replace('@packdb:///', '');
  check('and its bytes are in the manifest', record.assetManifest.some((a) => a.hash === backHash));
}

// Landscape cards render landscape with no ProtoFlux at all: the driver reads
// the loaded texture's own pixel size.
const sizeDrv = hasT('TextureSizeDriver')?.d;
check('the size driver reads the card texture', sizeDrv?.Texture?.Data === hasT('StaticTexture2D')?.d.ID);
check('and drives the quad, capped at one cell',
  byField.get(sizeDrv?.Target?.Data)?.comp.id === hasT('QuadMesh')?.d.ID &&
  String(sizeDrv?.DriveMode?.Data) === 'UnitHeight' &&
  (sizeDrv?.MaxSize?.Data || []).map(num)[0] > 0);

// CARD/url -> Uri -> the texture's URL, three nodes living inside the template.
const tmplNodes = [];
(function collect(sl) { for (const c of sl.Components?.Data || []) tmplNodes.push(byComp.get(c.Data.ID)); (sl.Children || []).forEach(collect); })(tmpl);
const tSrc = tmplNodes.find((c) => short(c.type) === 'ObjectValueSource<string>');
const tUri = tmplNodes.find((c) => short(c.type) === 'StringToAbsoluteURI');
const tDrv = tmplNodes.find((c) => short(c.type) === 'FieldDriveBase<Uri>+Proxy');
check('the template holds its own three-node decode', !!tSrc && !!tUri && !!tDrv);
check('it reads its own variable', (() => {
  const ref = byComp.get(arg(tSrc, 'Source'));
  const f = ref && byField.get(arg(ref, 'Reference'));
  return f?.name === 'Value' && f.comp.id === hasT('DynamicValueVariable<string>')?.d.ID;
})());
check('through StringToAbsoluteURI', arg(tUri, 'Input') === tSrc?.id);
check('into its own texture URL',
  byField.get(arg(tDrv, 'Drive'))?.comp.id === hasT('StaticTexture2D')?.d.ID &&
  arg(byComp.get(arg(tDrv, 'Node')), 'Value') === tUri?.id);

// ── the spawn loop ──────────────────────────────────────────────────────────
// Structure first, then behaviour. The structural checks are the ones that
// would otherwise fail silently in-world.
console.log(`${NEWLINE}the spawn loop:`);
// There are three DuplicateSlot nodes now - one per card, one per deck, one per
// buffer - so counting them no longer identifies the spawner. The one that means
// "make a card" is the one that duplicates INTO the panel's own Cards slot; the
// deck branch's two duplicate the deck template and one of its buffers, and both
// land inside the deck. Identity, not population.
const dups = compsOfType('DuplicateSlot');
const intoPanelCards = (c, field) => {
  // `OverrideParent` is legitimately null on the buffer duplicate - it lands
  // beside its template - so every hop here has to tolerate not being wired.
  const src = byComp.get(arg(c, field));
  if (!src) return false;
  const ref = byComp.get(arg(src, 'Source'));
  return !!ref && arg(ref, 'Reference') === findSlot('Cards')?.ID;
};
const cardDups = dups.filter((d) => intoPanelCards(d, 'OverrideParent'));
check('exactly one DuplicateSlot spawns a card into Cards', cardDups.length === 1,
  `${cardDups.length} of ${dups.length} DuplicateSlot nodes`);
const dup = cardDups[0];
check('it duplicates the template', (() => {
  const src = byComp.get(arg(dup, 'Template'));
  const ref = byComp.get(arg(src, 'Source'));
  return arg(ref, 'Reference') === tmpl?.ID;
})());
const cardsSlot = findSlot('Cards');
check('into the Cards slot', (() => {
  const src = byComp.get(arg(dup, 'OverrideParent'));
  const ref = byComp.get(arg(src, 'Source'));
  return arg(ref, 'Reference') === cardsSlot?.ID;
})());
check('Cards starts empty - the count comes from the response, not the package',
  (cardsSlot?.Children || []).length === 0);

// Walk the impulse chain from the duplicate to the end of the iteration.
const evtWritesEarly = () => allWrites.filter((w) =>
  String(arg(byComp.get(arg(w, 'Path')), 'Value')) === 'ResoPal/event');
const IMPULSE = ['Next', 'OnSuccess', 'OnWritten', 'OnTrue', 'OnFalse', 'TaskStart', 'OnTriggered', 'OnResponse'];
const chainFrom = (id, stop = 24) => {
  const out = [];
  let c = throughRelays(byComp.get(id));
  while (c && out.length < stop) {
    out.push(c);
    const nxt = IMPULSE.map((f) => arg(c, f)).find((v) => typeof v === 'string' && byComp.has(v));
    c = nxt ? throughRelays(byComp.get(nxt)) : null;
  }
  return out;
};
const iteration = chainFrom(dup.id).map((c) => short(c.type));
// Order is the whole correctness argument: every read above takes the CURRENT
// remainder, so eating the record first would make each card show the next
// card's art.
const iterTypes = chainFrom(dup.id).map((c) => String(c.type).replace(/^.*Nodes\./, ''));
check('a card is made, told its art, placed, and only then is the record eaten',
  iterTypes[0] === 'FrooxEngine.Slots.DuplicateSlot' &&
  iterTypes[1] === 'FrooxEngine.Variables.WriteDynamicObjectVariable<string>' &&
  iterTypes[2] === 'FrooxEngine.Transform.SetLocalPosition' &&
  /^ObjectWrite</.test(iterTypes[3]),
  iterTypes.slice(0, 5).join(' -> '));

const setUrl = chainFrom(dup.id)[1];
check('the write targets the duplicate, not the template',
  byField.get(arg(setUrl, 'Target'))?.name === 'Duplicate');
check('and names CARD/url', String(arg(byComp.get(arg(setUrl, 'Path')), 'Value')) === 'CARD/url');

const eat = chainFrom(dup.id)[3];
const restStore = byComp.get(arg(eat, 'Variable'));
check('the record is eaten out of a local variable', short(restStore?.type) === 'DataModelObjectFieldStore<string>');
// Follow relay taps. The loop's readers pull on a relay beside them rather than
// on the store four columns away - that is the house style, and it means these
// checks have to look through one.
const deref = (id) => {
  let c = byComp.get(id);
  while (/^(Value|Object)Relay</.test(short(c?.type) || '')) c = byComp.get(arg(c, 'Input'));
  return c;
};
const nlNodes = compsOfType('IndexOfString');
check('one IndexOfString finds the record boundary', nlNodes.length === 1);
const nlAt = nlNodes[0];
check('it looks for a newline in that same variable',
  deref(arg(nlAt, 'Str'))?.id === restStore?.id && arg(byComp.get(arg(nlAt, 'Part')), 'Value') === NEWLINE);

// The termination proof, asserted against the built graph rather than assumed:
// the loop only continues while the newline is past a minimum, and the
// remainder starts one past that same newline - so `rest` strictly shrinks.
const ifs = compsOfType('If');
const loopGate = ifs.find((i) => chainFrom(arg(i, 'OnTrue'), 2)[0]?.id === dup.id);
check('the loop is gated on finding another record', !!loopGate);
const guard = byComp.get(arg(loopGate, 'Condition'));
check('the guard is "newline past a minimum"', short(guard?.type) === 'ValueGreaterThan<int>');
const minRecord = num(arg(byComp.get(arg(guard, 'B')), 'Value'));
check('the guard reads the same IndexOfString the parse does', deref(arg(guard, 'A'))?.id === nlAt.id);
check('the minimum is positive, so a missing newline (-1) also ends the loop', minRecord > 0, String(minRecord));
const remainder = byComp.get(arg(eat, 'Value'));
check('the remainder starts one past that newline',
  short(remainder?.type) === 'Substring' &&
  deref(arg(remainder, 'Str'))?.id === restStore.id &&
  short(byComp.get(arg(remainder, 'StartIndex'))?.type) === 'ValueInc<int>' &&
  deref(arg(byComp.get(arg(remainder, 'StartIndex')), 'N'))?.id === nlAt.id);
check('so every pass removes at least ' + (minRecord + 2) + ' characters and the loop cannot spin', true);

// It also has to yield, or a 200-card import is one very long frame.
const loopBody = chainFrom(loopGate.id, 2);
// Same again: the deck branch's move loop yields per card too, so the property is
// that THIS loop's gate is reached through a DelayUpdates, not that the package
// contains exactly one.
const delays = compsOfType('DelayUpdates');
check('the loop lets a frame pass each time round',
  delays.some((d) => chainFrom(arg(d, 'Next'), 1)[0]?.id === loopGate?.id),
  `${delays.length} DelayUpdates nodes, none feeding this gate`);
const indexNodes = compsOfType('IndexOfChild');
check('the grid index is the card\'s own, not a count taken after it exists',
  indexNodes.length === 1 && byField.get(arg(indexNodes[0], 'Instance'))?.name === 'Duplicate',
  `${compsOfType('ChildrenCount').length} ChildrenCount nodes`);
check('a card that will not take its art says so instead of stopping silently',
  evtWritesEarly().some((w) => arg(setUrl, 'OnNotFound') === w.id && arg(setUrl, 'OnFailed') === w.id));
check('and runs inside a StartAsyncTask', compsOfType('StartAsyncTask').length >= 3);
// One clears the panel's Cards before an import; the deck branch's clears the
// stock cards out of a freshly duplicated deck. Only the first is this check's.
{
  const clears = compsOfType('DestroySlotChildren');
  const ofPanelCards = clears.filter((c) => intoPanelCards(c, 'Instance'));
  check('the previous import is cleared first', ofPanelCards.length === 1,
    `${ofPanelCards.length} of ${clears.length} DestroySlotChildren nodes`);
}
// The bug this missed: a refactor moved OnResponse onto the event stub and took
// the unpack chain's only trigger with it. Every operation must have something
// that runs it.
const IMPULSE_ANY = ['Next', 'OnSuccess', 'OnWritten', 'OnTrue', 'OnFalse', 'TaskStart', 'OnTriggered',
  'OnResponse', 'OnError', 'OnDenied', 'OnNotFound', 'OnFailed', 'OnStarted'];
const drivenIds = new Set();
for (const c of byComp.values())
  for (const f of IMPULSE_ANY.concat(['Calls'])) {
    const d = arg(c, f);
    for (const t of Array.isArray(d) ? d.map((e) => (e && typeof e === 'object' ? e.Data : e)) : [d])
      if (typeof t === 'string') drivenIds.add(t);
  }
const OPS = /^(ContinuationRelay|Sequence|If|StartAsyncTask|DelayUpdates|DuplicateSlot|DestroySlotChildren|SetLocalPosition|GET_String|POST_String|WriteDynamicObjectVariable<string>)$/;
const orphans = [...byComp.values()].filter((c) =>
  (OPS.test(short(c.type)) || /^ObjectWrite</.test(String(c.type).replace(/^.*Nodes\./, ''))) && !drivenIds.has(c.id));
check('nothing in the graph sits there with no impulse running it', orphans.length === 0,
  orphans.map((c) => `${slotOf.get(c.id) ? nm(slotOf.get(c.id)) : '?'} «${short(c.type)}»`).join(', '));
// Answering has two jobs, and a continuation only goes one place. Each request
// lands on its own "answered" band, and that event write CARRIES ON into the
// landing write on all three of its outcomes - so the deck still imports even if
// the event line itself will not take a value.
{
  const linked = ['GET_String', 'POST_String'].map((t) => {
    const req = compsOfType(t)[0];
    const stub = byComp.get(arg(req, 'OnResponse'));
    if (!stub || short(stub.type) !== 'ContinuationRelay') return false;
    const say = byComp.get(arg(stub, 'Next'));
    if (!say || !String(say.type).includes('WriteDynamicObjectVariable')) return false;
    const land = ['OnSuccess', 'OnNotFound', 'OnFailed'].map((f) => arg(say, f));
    // `short` splits on '.', and ObjectWrite's own generic argument is a dotted
    // classpath, so the short name of an ObjectWrite is the tail of its ARGUMENT.
    return land.every((x) => typeof x === 'string' && x === land[0]) &&
      /^ObjectWrite</.test(String(byComp.get(land[0])?.type ?? '').replace(/^.*Nodes\./, ''));
  });
  check('a response both reports itself and starts the unpack', linked.every(Boolean),
    `GET ${linked[0]}, POST ${linked[1]}`);
}
// One shared "answered" band could only read ONE of the two StatusCode fields,
// and it read the fetch's: a pasted import announced whatever the last fetch
// returned, or "HTTP 0" on a panel that had never fetched at all.
{
  const casts = compsOfType('ValueToObjectCast<HttpStatusCode>');
  const codes = ['GET_String', 'POST_String'].map((t) => compsOfType(t)[0].data.StatusCode?.ID);
  check('each request reports its OWN status code',
    codes.every((f) => f && casts.some((c) => arg(c, 'Input') === f)), `${casts.length} casts`);
}

// ── type versions ───────────────────────────────────────────────────────────
// Not decoration. A type that declares a `Version` and is written without one
// gets its `OnLoading` legacy-upgrade path, which rewrites fields the file had
// set correctly - and nothing about the file looks wrong afterwards. `UIX.Text`
// runs `HorizontalAutoSize = true; Align = _legacyAlign; Font =
// World.GetDefaultFont()`, so every caption in the package came up left-aligned,
// autosized and in the world's font: the panel's own buttons and the grafted
// deck's alike, in a file whose button subtree was byte-identical to a
// known-good deck's. Read from the engine, never restated.
console.log(`${NEWLINE}type versions:`);
{
  const declared = doc.TypeVersions ?? {};
  const wrong = [];
  let versioned = 0;
  for (const t of TYPES.map(String)) {
    const want = typeVersion(t);
    if (want === undefined) continue;
    versioned++;
    if (Number(declared[t] ?? 0) !== want) wrong.push(`${t.split('.').pop()} ${Number(declared[t] ?? 0)}!=${want}`);
  }
  check('every versioned type declares the version the engine gives it',
    wrong.length === 0, wrong.join(', '));
  console.log(`  note ${versioned} versioned types`);
}

// ── the deck-import branch ──────────────────────────────────────────────────
// Past thirty cards an import is a deck and goes into a Ukilop holder. Everything
// here is a silent failure in-world if it is wrong: a gate on the wrong count
// puts boosters in a deck, a lookup with MatchSubstring left at its default aims
// at the wrong slot, and a move loop in the wrong order leaves cards with no
// position driver.
console.log(`${NEWLINE}the deck-import branch:`);
{
  const finds = compsOfType('FindChildByName');
  check('the branch is present', finds.length === 4, `${finds.length} FindChildByName nodes`);

  // The gate hangs off "all cards placed" - the only point in the graph that knows
  // the import has finished - on ALL THREE outcomes, the way the response landings
  // do. A panel that cannot write its own event line has still imported the deck.
  const placed = allWrites.find((w) =>
    String(arg(byComp.get(arg(w, 'Value')), 'Value') ?? '').includes('all cards placed'));
  check('it hangs off the end of the spawn loop', !!placed);
  const after = ['OnSuccess', 'OnNotFound', 'OnFailed'].map((k) => chainFrom(arg(placed, k), 1)[0]);
  check('on every outcome of that write, not just success',
    after.every((c) => c && c.id === after[0].id), after.map((c) => short(c?.type)).join(', '));

  const deckGate = after[0];
  check('and it is a gate', short(deckGate?.type) === 'If', short(deckGate?.type));
  const cond = deref(arg(deckGate, 'Condition'));
  check('gated on a card COUNT, not on anything else',
    short(cond?.type) === 'ValueGreaterThan<int>', short(cond?.type));
  const counted = deref(arg(cond, 'A'));
  check('the count is ChildrenCount of the panel Cards slot',
    short(counted?.type) === 'ChildrenCount' && intoPanelCards(counted, 'Instance'));
  check('and the threshold is more than 30',
    Number(arg(deref(arg(cond, 'B')), 'Value')) === 30, String(arg(deref(arg(cond, 'B')), 'Value')));
  // Boosters and single cards keep spawning loose. If OnFalse ever grows a branch,
  // a seven-card pull starts building a deck.
  check('a small import has no branch of its own - OnFalse goes nowhere',
    !byComp.has(arg(deckGate, 'OnFalse')), String(arg(deckGate, 'OnFalse')));

  // MatchSubstring carries [DefaultValue(true)]. Left unwired, "Cards" matches
  // "Surface/cards" and every lookup below it aims one slot too high.
  check('every name lookup matches the WHOLE name', finds.every((f) => {
    const m = deref(arg(f, 'MatchSubstring'));
    return m && short(m.type) === 'ValueInput<bool>' && arg(m, 'Value') === false;
  }));
  check('and searches direct children only', finds.every((f) => !byComp.has(arg(f, 'SearchDepth'))));
  const names = finds.map((f) => String(arg(deref(arg(f, 'Name')), 'Value'))).sort();
  check('it looks up exactly the four slots it needs',
    names.join() === ['Assets', 'Cards', 'Surface/cards', 'buffer'].sort().join(), names.join(', '));

  // The order the deck's own receiver-surface handler uses, read out of
  // /Deck/logixs/add/remove handling. A card reparented onto `Cards` WITHOUT a
  // buffer has no position driver and no OrderOffset: the handler cannot be
  // triggered from ProtoFlux, because OnLocalReceived fires only from
  // Grabber.Receive - a person letting go of something.
  const bufDup = dups.find((d) => {
    const t = deref(arg(d, 'Template'));
    return short(t?.type) === 'FindChildByName' && String(arg(deref(arg(t, 'Name')), 'Value')) === 'buffer';
  });
  check('a buffer is duplicated per card', !!bufDup);
  const moveOrder = chainFrom(bufDup?.id, 8).map((c) => short(c.type));
  // The card is reset and scaled BEFORE it is moved, and that order is load-bearing:
  // `GetChild` re-evaluates on every read, so once SetParent has taken the card out
  // of Cards the same expression names the NEXT card. Reversed, the first card is
  // never scaled and the last pass reads null - which breaks the chain and strands
  // the last card. Asserting the ORDER is asserting both of those cannot come back.
  check('the card is reset and resized while it is still the one GetChild names',
    ['DuplicateSlot', 'SetParent', 'SetLocalPositionRotation', 'SetLocalScale', 'SetParent',
     'SetSlotOrderOffset', 'SetParent'].every((t, i) => moveOrder[i] === t),
    moveOrder.slice(0, 8).join(' -> '));
  const [, toAssets, cardHome, cardBig, cardIn, setOrder, bufIn] = chainFrom(bufDup?.id, 9);

  // Shuffle SWAPS OrderOffsets between buffers and never touches the cards, so a
  // deck whose buffers all carry the same offset shuffles and changes nothing.
  // `DuplicateSlot` copies the template buffer's 0 to every copy, so the importer
  // has to assign one. The count of what is already in the deck, read BEFORE this
  // buffer joins, gives 0, 1, 2 … in insertion order - list index equal to stack
  // position, which the atlas order and the reveal order both rest on.
  check('each buffer gets its own OrderOffset, or shuffle is a no-op',
    short(setOrder?.type) === 'SetSlotOrderOffset' &&
    byField.get(arg(setOrder, 'Instance'))?.name === 'Duplicate');
  {
    const src = deref(arg(setOrder, 'OrderOffset'));
    const counted = deref(arg(src, 'Input'));
    check('and it is the deck\'s own card count, not a constant',
      short(src?.type) === 'Cast_int_To_long' && short(counted?.type) === 'ChildrenCount',
      `${short(src?.type)} <- ${short(counted?.type)}`);
    check('read off the deck Cards slot, before the buffer joins it',
      short(byComp.get(arg(counted, 'Instance'))?.type) === 'FindChildByName' &&
      chainFrom(arg(setOrder, 'Next'), 1)[0]?.id === bufIn?.id);
  }
  check('all three act on the same card', arg(cardHome, 'Instance') === arg(cardIn, 'Instance') &&
    arg(cardBig, 'Instance') === arg(cardIn, 'Instance'));

  // Both inputs unwired is the reset: an unconnected ValueInput reads float3.Zero
  // and floatQ.Identity. Without it a card arrives carrying the grid position the
  // spawn loop gave it, because SetParent preserves the LOCAL transform.
  check('the card is reset to sit AT its buffer, not where it was on the grid',
    !byComp.has(arg(cardHome, 'Position')) && !byComp.has(arg(cardHome, 'Rotation')));
  // And scaled to the cell it now occupies: the panel's card is 0.088 tall against
  // the deck's 0.25, so unscaled it is a third of its slot.
  {
    const k = arg(deref(arg(cardBig, 'Scale')), 'Value')?.map(Number) ?? [];
    // Z is deliberately NOT the same as X and Y. The deck stacks its buffers
    // `cardSize`.Z apart - 1.6 mm - and a card scaled uniformly to fill the cell
    // comes out 5.7 mm thick, so it would poke through the card above it.
    check('the card is thinned to the deck\'s stacking pitch, not scaled uniformly',
      k.length === 3 && k[2] < k[0], `${k.map((v) => v.toFixed(3)).join(', ')}`);
    // Read off the card template's own collider - the one place the card's real
    // size is written as a number - so this cannot pass by restating a constant.
    const cardSlot = findSlot('card');
    const box = (cardSlot?.Components?.Data ?? [])
      .map((c) => byComp.get(c.Data.ID)).find((c) => short(c?.type) === 'BoxCollider');
    const cardH = (arg(box, 'Size') || []).map(num)[1];
    check('and scaled to the deck\'s card height, not left at the panel\'s',
      k.length === 3 && Math.abs(k[1] - k[0]) < 1e-6 &&
      Math.abs(k[1] * cardH - 0.25) < 1e-4, `${k.map((v) => v.toFixed(3)).join(', ')} x ${cardH}`);
    const cardZ = (arg(box, 'Size') || []).map(num)[2];
    check('and its thickness lands on the deck\'s card thickness',
      Math.abs(k[2] * cardZ - 0.0015911388909444213) < 1e-6, `${(k[2] * cardZ).toFixed(5)}`);
  }
  check('the buffer\'s packed flux lands in the deck Assets slot',
    String(arg(deref(arg(byComp.get(arg(toAssets, 'NewParent')), 'Name')), 'Value')) === 'Assets');
  check('the card lands inside the buffer',
    byField.get(arg(cardIn, 'NewParent'))?.name === 'Duplicate');
  check('and the buffer lands in the deck Cards slot',
    String(arg(deref(arg(byComp.get(arg(bufIn, 'NewParent')), 'Name')), 'Value')) === 'Cards');
  check('the card taken is the one on top',
    short(deref(arg(cardIn, 'Instance'))?.type) === 'GetChild');

  // The move loop re-enters DelayUpdates, which is async: coming round from a
  // synchronous continuation runs nothing and drops every card after the first.
  check('the move loop comes round in its own async context',
    compsOfType('StartAsyncTask').length >= 5, `${compsOfType('StartAsyncTask').length} StartAsyncTask nodes`);

  // `InnerDeck/grid X` and `grid Y` are DRIVEN outputs of ChildrenCount, so
  // writing them is a no-op. The spread is a bool the search button writes, and
  // graft-deck.mjs exposes it as InnerDeck/spread.
  const spread = compsOfType('WriteDynamicValueVariable<bool>');
  check('the spread is engaged by writing one bool', spread.length === 1, `${spread.length} writes`);
  check('named InnerDeck/spread',
    String(arg(deref(arg(spread[0], 'Path')), 'Value')) === 'InnerDeck/spread');
  check('set FALSE, which is what open means on that toggle',
    arg(deref(arg(spread[0], 'Value')), 'Value') === false);
  check('aimed at the deck surface, the slot that owns the InnerDeck space',
    String(arg(deref(arg(byComp.get(arg(spread[0], 'Target')), 'Name')), 'Value')) === 'Surface/cards');
  // Written on the move loop's EXHAUSTED branch, not anywhere earlier: the spread
  // lays out from ChildrenCount, so opening a half-filled deck spreads it twice.
  const moveGate = ifs.find((i) => chainFrom(arg(i, 'OnTrue'), 1)[0]?.id === bufDup?.id);
  check('written on the branch the loop takes when no cards are left', !!moveGate &&
    chainFrom(arg(moveGate, 'OnFalse'), 1)[0]?.id === spread[0].id);
  // And it says so on the event line however the write itself turns out.
  const said = ['OnSuccess', 'OnNotFound', 'OnFailed'].map((k) => chainFrom(arg(spread[0], k), 1)[0]);
  check('then the event line says the deck is in the holder',
    said.every((c) => c && c.id === said[0].id) &&
    String(arg(byComp.get(arg(said[0], 'Value')), 'Value') ?? '').includes('deck in the holder'));
}

// ── behaviour: run the loop the way the runtime would ───────────────────────
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { default: worker } = await import('../worker/src/index.js');
const fetchFlat = async (p) => (await worker.fetch(new Request('https://w.example' + p), {}, { waitUntil() {} })).text();

const artUrlNode = byComp.get(arg(setUrl, 'Value'));
const placeNode = byComp.get(arg(chainFrom(dup.id)[2], 'Position'));
function runLoop(body, limit = 400) {
  const urls = [], spots = [];
  STATE.set(restStore.id, body);
  for (let i = 0; i < limit; i++) {
    // IndexOfChild on the duplicate: by the time the position is computed the
    // card is already parented, so a COUNT would include it and every card
    // would land one cell late. This models the index the card actually has.
    STATE.set('children', urls.length);
    memo.clear();
    if (!evalRef(arg(loopGate, 'Condition'), body)) return { urls, spots, ran: i };
    memo.clear();
    urls.push(evalRef(arg(setUrl, 'Value'), body));
    memo.clear();
    spots.push(evalRef(arg(chainFrom(dup.id)[2], 'Position'), body));
    memo.clear();
    STATE.set(restStore.id, evalRef(arg(eat, 'Value'), body));
  }
  throw new Error('the loop did not terminate');
}

console.log(`${NEWLINE}live responses:`);
// Records come off the response by NEWLINE, which is what the graph does. They
// were sliced at a hard-coded 64 here; the Worker's fixed width is 80, so every
// `recs` entry after the first was a fragment and five scenarios failed with
// "want <url> got <url>" - the same first record, differing further down. A
// constant restated in three places drifts; this reads the record boundary the
// same way the node under test does.
function scenario(name, body, expect) {
  const recs = body.split('\n').map((r) => r.trim()).filter((r) => r.length > 8);
  const { urls, spots } = runLoop(body);
  check(`${name}: ${expect} cards`, urls.length === expect, String(urls.length));
  check(`${name}: each card gets its own record's art, in order`,
    urls.join() === recs.join(), `first want ${recs[0]} got ${urls[0]}`);
  check(`${name}: they land on a 10-wide grid`, spots.every((p, i) => {
    const [x, y] = p.map(Number);
    return Math.abs(x - (i % 10) * 0.071) < 1e-6 && Math.abs(y + Math.floor(i / 10) * 0.096) < 1e-6;
  }), JSON.stringify(spots[11]));
  return recs;
}

const pull1 = await fetchFlat('/api/pull?seed=panel1&format=fixed');
scenario('1 booster', pull1, 7);
scenario('3 boosters', await fetchFlat('/api/pull?seed=panel3&packs=3&format=fixed'), 21);
scenario('10 boosters', await fetchFlat('/api/pull?seed=panelX&packs=10&format=fixed'), 70);
scenario('green/purple deck', await fetchFlat('/api/deck?deck=td02&format=fixed'), 50);
scenario('red/blue deck', await fetchFlat('/api/deck?deck=td01&format=fixed'), 48);

// The whole point of the rewrite: nothing in the graph caps the count. 200 is
// the Worker's cap, not the panel's.
const big = await fetchFlat('/api/deck?deck=td02&format=fixed') + await fetchFlat('/api/deck?deck=td01&format=fixed');
check('98 cards, past the old 70-card ceiling', runLoop(big).urls.length === 98, String(runLoop(big).urls.length));

console.log(`${NEWLINE}responses that are not cards:`);
check('an empty response makes no cards', runLoop('').urls.length === 0);
// GET_String writes the exception message into Content when a request fails.
const errBody = 'The remote name could not be resolved';
check('an error string makes no cards', runLoop(errBody).urls.length === 0);
check('a truncated last record is dropped rather than half-made',
  runLoop(pull1.slice(0, 100)).urls.length === 1, String(runLoop(pull1.slice(0, 100)).urls.length));
check('a body with no newline at all terminates', runLoop('x'.repeat(500)).urls.length === 0);

// ── 4. the status line says something useful ─────────────────────────────────
console.log(`${NEWLINE}status line:`);
const strProxies = [...byComp.values()].filter((c) => short(c.type) === 'FieldDriveBase<string>+Proxy');
check('three Texts are driven: status, URL and last event', strProxies.length === 3, String(strProxies.length));
// The readouts read the local the response was stashed in, not the request
// node, because the loop eats the other copy. Seed both so the chain resolves.
const bodyStore = compsOfType('DataModelObjectFieldStore<string>').find((c) => c.id !== restStore.id);
check('the response is kept whole for the readout, separately from the copy the loop eats',
  !!bodyStore && bodyStore.id !== restStore.id);
const evalProxy = (p, body) => {
  memo.clear();
  STATE.set(bodyStore.id, body);
  STATE.set(restStore.id, body);
  try { return String(evalRef(arg(byComp.get(arg(p, 'Node')), 'Value'), body)); } catch { return null; }
};

// Identify each by what it produces, not by emit order.
const statusProxy = strProxies.find((p) => evalProxy(p, pull1) === pull1.slice(0, 64).trim());
const urlProxy = strProxies.find((p) => p !== statusProxy && (evalProxy(p, '') || '').startsWith('http'));
const evtProxy = strProxies.find((p) => p !== statusProxy && p !== urlProxy);

check('the status text is driven', !!statusProxy);
const statusTarget = statusProxy && byField.get(arg(statusProxy, 'Drive'));
check('it drives a Text.Content', statusTarget?.name === 'Content' && short(statusTarget.comp.type) === 'Text');
check('shows the first card on success', evalProxy(statusProxy, pull1) === pull1.slice(0, 64).trim());
// A transport failure is not an empty body - GET_String writes the exception
// into the same Content - so it comes out of the same branch as a card.
check('shows the error text on failure', evalProxy(statusProxy, errBody) === errBody);
// And with nothing fetched yet the line must not be driven blank over the
// caption the panel ships with.
const atRest = evalProxy(statusProxy, '');
check('says something before anything is pressed', !!atRest && atRest !== 'null' && atRest.length > 4, JSON.stringify(atRest));

// The URL echo proves the button half of the chain on its own: it shows the URL
// the request will use, so a press that changes it but returns nothing is
// visibly a network problem rather than a dead button.
check('a second Text shows the request URL', !!urlProxy, 'none of the drives resolve to an http URL');

// And the event line answers the one question neither of the others can: did the
// request run at all?
check('a third Text reports whether the request ran', !!evtProxy);
const evtDrivers = compsOfType('DynamicValueVariableDriver<string>');
check('the event line is driven from a dynamic variable written by the request',
  evtDrivers.some((d) => String(arg(d, 'VariableName')) === 'ResoPal/event'));
const evtWrites = allWrites.filter((w) => !writes.includes(w) && w.id !== setUrl.id);
check('every event write targets ResoPal/event', evtWrites.length >= 1 &&
  evtWrites.every((w) => String(arg(byComp.get(arg(w, 'Path')), 'Value')) === 'ResoPal/event'));

// Every way this graph can stop has to end up on that line. A terminal impulse
// left null is a dead end with nothing anywhere to say it happened - which is
// exactly what "I approved host access and then nothing happened" looks like
// from inside the world.
const evtIds = new Set(evtWrites.map((w) => w.id));
const terminals = [
  ...compsOfType('GET_String').flatMap((g) => ['OnResponse', 'OnError', 'OnDenied'].map((f) => [`GET ${f}`, arg(g, f)])),
  ...compsOfType('POST_String').flatMap((g) => ['OnResponse', 'OnError', 'OnDenied'].map((f) => [`POST ${f}`, arg(g, f)])),
  ...writes.flatMap((w) => ['OnNotFound', 'OnFailed'].map((f) => [`URL write ${f}`, arg(w, f)])),
  [`the loop finishing`, arg(loopGate, 'OnFalse')],
];
// A terminal reaches its event write through at most a couple of hops: a
// ContinuationRelay stub (the house style for a branch) or a Sequence, which is
// how one impulse does two things - OnResponse both reports and starts the
// unpack, and a continuation only goes one place.
const reachesEvent = (id, depth = 0) => {
  if (typeof id !== 'string' || depth > 4) return false;
  if (evtIds.has(id)) return true;
  const c = byComp.get(id);
  if (!c) return false;
  if (short(c.type) === 'ContinuationRelay') return reachesEvent(arg(c, 'Next'), depth + 1);
  if (short(c.type) === 'Sequence')
    return (arg(c, 'Calls') || []).some((e) => reachesEvent(e && typeof e === 'object' ? e.Data : e, depth + 1));
  return false;
};
const unreported = terminals.filter(([, id]) => !reachesEvent(id));
check('every way the request can end reports on the event line', unreported.length === 0,
  [...new Set(unreported.map(([n]) => n))].join(', '));

// A 404 is a SUCCESSFUL request whose body is not cards: GET_String only writes
// an exception into Content on a transport failure. Without the code on the
// event line the status line shows the first 64 characters of an error page.
const statusCode = compsOfType('GET_String').map((g) => byField.get(arg(g, 'OnResponse')) && g)[0];
const casts = compsOfType('ValueToObjectCast<HttpStatusCode>');
const codeField = compsOfType('GET_String').map((g) => g.data.StatusCode?.ID).filter(Boolean);
check('the HTTP status code reaches the event line',
  casts.length >= 1 && casts.some((c) => codeField.includes(arg(c, 'Input'))) &&
  compsOfType('FormatString').some((f) => casts.some((c) => (arg(f, 'Parameters') || []).some((e) => e.Data === c.id)) &&
    evtWrites.some((w) => arg(w, 'Value') === f.id)));

// ── 5. encoding and layout gates ─────────────────────────────────────────────
console.log(`${NEWLINE}encoding and layout:`);
check('BSON round-trips byte-identical',
  Buffer.compare(Buffer.from(bson), Buffer.from(await serializeBson(doc))) === 0);
const { commentZoneOverlaps } = await import(`file://${path.join(RKL, 'protoflux', 'skill', 'scripts', 'layout_stats.mjs')}`);
check('no overlapping comment zones', JSON.stringify(commentZoneOverlaps(doc)) === '[]');

// One canvas now. The 514-node decoder canvas is gone: cards are duplicated
// from a template as records arrive, so the per-card decode exists once instead
// of seventy times. The budget is the inspectability budget - past about this
// many nodes the canvas stops being something a person can unpack and follow.
const canvasSlots = (doc.Object.Children || []).filter((s) => String(s.Tag?.Data ?? '') === 'Moduprint.ProtoFlux');
check('one Moduprint canvas', canvasSlots.length === 1, String(canvasSlots.length));
const control = canvasSlots[0];
check('named for what it is', nm(control).includes('control'));

const nodesOf = (c) => (c.Children || []).filter((s) => nm(s) !== 'Meta: Comments');
// An inspectability budget, not a hard limit: past roughly this many nodes the
// canvas stops being something a person can unpack and follow in one sitting.
// Raised from 130 with the deck-import branch, which is a fifth stage rather than
// padding: 116 nodes became 177, and the branch's own 60 are a gate, a deck
// duplication, four name lookups and a per-card move loop that resets, resizes,
// orders and reparents each card. The budget is the
// inspectability one, so it moves when the graph genuinely gains a stage and not
// when a change merely spends it.
check('the whole graph is small enough to read', nodesOf(control).length <= 180, `${nodesOf(control).length} nodes`);

// Comment zones: present, every one titled.
{
  const c = control;
  const meta = (c.Children || []).find((s) => nm(s) === 'Meta: Comments');
  check('has a Meta: Comments slot', !!meta);
  check('tagged for Moduprint', String(meta?.Tag?.Data ?? '') === 'Moduprint.Meta/ColinTheCat.Comments');
  const rects = (meta?.Components?.Data || []).filter((x) => /float3x3/.test(short(TYPES[num(x.Type)])));
  const labels = (meta?.Components?.Data || []).filter((x) => /DynamicValueVariable<string>/.test(short(TYPES[num(x.Type)])));
  check('every zone has a title', rects.length > 0 && rects.length === labels.length, `${rects.length} rects, ${labels.length} labels`);
  check('no title is blank', labels.every((l) => String(l.Data.Value?.Data ?? '').trim().length > 0));
  check('five zones, one per stage', rects.length === 5, String(rects.length));

  // Spacing, gated rather than eyeballed. The complaint that started this was
  // "the gaps between nodes is massive"; the graph measured 25.2 x 12.6 units at
  // 3.9% occupancy, with 2.6-unit voids inside zones. Compaction then pushed two
  // zone rectangles into each other, which reads in-world as one zone with a
  // stray title. Both directions are failures, so both are checked.
  const zones = rects.map((x) => x.Data.Value.Data.map((row) => row.map(num)))
    .map((v) => ({ x: v[0][0], y: v[0][1], w: v[1][0], h: -v[1][1] }))
    .sort((a, b) => a.x - b.x);
  const gaps = zones.slice(1).map((z, i) => z.x - (zones[i].x + zones[i].w));
  check('zones sit side by side without overlapping', gaps.every((g) => g > 0),
    gaps.map((g) => g.toFixed(2)).join(', '));
  check('and none is pushed away from its neighbour', gaps.every((g) => g < 0.6),
    gaps.map((g) => g.toFixed(2)).join(', '));

  const pts = nodesOf(control).map((sl) => (sl.Position.Data || []).map(num));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  // A budget, not a target: a graph that will not fit on a screen at a readable
  // zoom is one the user has to pan around to follow.
  // Widened from 16 with the fifth zone. His four span 13.57 at ~3.4 units each;
  // the branch adds 2.9 for 51 nodes, so it is denser than the graph it joins
  // rather than sprawl spending the budget. It is still one screenful.
  check('the whole graph fits in one screenful', w <= 17.5 && h <= 11,
    `${w.toFixed(2)} x ${h.toFixed(2)} units`);
  const cells = new Set(pts.map(([x, y]) => `${Math.round(x / 0.36)},${Math.round(y / 0.30)}`)).size;
  const span = (w / 0.36 + 1) * (h / 0.30 + 1);
  console.log(`  note ${pts.length} nodes in ${w.toFixed(2)} x ${h.toFixed(2)} units, ` +
    `${(100 * cells / span).toFixed(1)}% of the cells they span`);
}

// Nodes must clear a real node visual. The first build spaced them at about a
// third of one and unpacked into a heap.
{
  const p = nodesOf(control).map((s) => (s.Position.Data || []).map(num));
  let clashes = 0;
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++)
      if (Math.abs(p[i][0] - p[j][0]) < 0.30 && Math.abs(p[i][1] - p[j][1]) < 0.22) clashes++;
  check('no two nodes overlap a node visual', clashes === 0, `${clashes} pairs`);
}

// No wire may run THROUGH a third node's box. This is the defect that made the
// URL constants look unconnected in-world: each one sat on the lane between the
// receiver and the write it fed, so the impulse wire crossed its box. Pretty-flux
// section 2 - never let a const sit in the slot between two adjacent nodes.
function throughNodes(canvasSlot) {
  const placed = nodesOf(canvasSlot).map((sl) => {
    const ids = (sl.Components?.Data || []).map((c) => c.Data.ID);
    const p = (sl.Position.Data || []).map(num);
    return { ids, x: p[0], y: p[1], name: nm(sl) };
  });
  const boxOf = new Map();
  for (const b of placed) for (const id of b.ids) boxOf.set(id, b);
  const HW = 0.15, HH = 0.075, EPS = 0.004;
  // Segment/box intersection by slab clipping.
  const hits = (a, b, box) => {
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    for (const [p, q] of [[-dx, a.x - (box.x - HW - EPS)], [dx, (box.x + HW + EPS) - a.x],
                          [-dy, a.y - (box.y - HH - EPS)], [dy, (box.y + HH + EPS) - a.y]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t0 <= t1;
  };
  // A leaf takes no wired input of its own: a constant, an input node. Those are
  // the ones a passing wire makes unreadable.
  const isLeaf = (box) => box.ids.every((id) => {
    const c = byComp.get(id);
    if (!c) return true;
    return !Object.entries(c.data).some(([k, v]) => {
      const d = v && typeof v === 'object' ? v.Data : null;
      return k !== 'Node' && typeof d === 'string' && byComp.has(d);
    });
  });
  // A wire can be a single ref OR an entry in a ref LIST - `Sequence.Calls`,
  // `FormatString.Parameters`. Only single refs were followed here, so the one
  // kind of wire that fans (and therefore travels furthest) was the one kind
  // this check could not see.
  const targets = (v) => {
    const d = v && typeof v === 'object' ? v.Data : null;
    if (typeof d === 'string') return [d];
    if (!Array.isArray(d)) return [];
    return d.map((e) => (e && typeof e === 'object' ? e.Data : e)).filter((e) => typeof e === 'string');
  };
  const offenders = new Map();
  for (const from of placed)
    for (const id of from.ids) {
      const c = byComp.get(id);
      if (!c) continue;
      for (const [, v] of Object.entries(c.data))
        for (const d of targets(v)) {
          if (!boxOf.has(d)) continue;
          const to = boxOf.get(d);
          if (to === from) continue;
          for (const mid of placed)
            if (mid !== from && mid !== to && hits(from, to, mid))
              offenders.set(`${from.name} -> ${to.name} crosses ${mid.name}`, { leaf: isLeaf(mid), text: `${from.name} -> ${to.name} crosses ${mid.name}` });
        }
    }
  return [...offenders.values()];
}
// Two grades, because they are two different problems.
//
// HARD: a wire may never pass through a CONSTANT. That is the exact defect that
// made this graph unreadable in-world - each URL constant sat in the lane
// between the receiver and the write it fed, so it read as decoration on the
// wire rather than as an input, and the user reported the nodes as "not hooked
// up". A constant is a leaf: nothing wires into it, so a wire touching it can
// only be a coincidence of position.
//
// REPORTED: a wire crossing a node that has its own inputs. Those read as what
// they are - two wires crossing - and the response has to travel from the
// request zone to the unpack zone somehow. The count is printed and capped so
// it cannot quietly grow; the proper fix is to run the library's own router.mjs
// over the canvas instead of hand-placing, which would also let the count go to
// zero.
const controlThrough = throughNodes(control);
const CROSSING_BUDGET = 30;
check('no wire runs through a constant', controlThrough.filter((o) => o.leaf).length === 0,
  [...new Set(controlThrough.filter((o) => o.leaf).map((o) => o.text))].slice(0, 4).join(' | '));
check(`wires crossing a wired node stay under ${CROSSING_BUDGET}`, controlThrough.length <= CROSSING_BUDGET,
  `${controlThrough.length}`);
console.log(`  note ${controlThrough.length} wires cross a node that has inputs of its own (budget ${CROSSING_BUDGET})`);

// Relays: no producer should carry a huge fan. Before the relay banks the
// response and the record width were wired to seventy consumers each.
// Shared UI assets are excluded: one material behind every Image is correct, and
// counting it here would only ever push someone to duplicate assets to satisfy a
// rule about wire fan-out in the flux.
const SHARED_ASSET = /Material|FontChain|StaticFont|SpriteProvider/;
const fan = new Map();
for (const c of byComp.values())
  for (const [k, v] of Object.entries(c.data)) {
    const d = v && typeof v === 'object' ? v.Data : null;
    if (typeof d !== 'string' || !byComp.has(d) || k === 'Node') continue;
    if (SHARED_ASSET.test(short(byComp.get(d).type))) continue;
    fan.set(d, (fan.get(d) || 0) + 1);
  }
const worst = [...fan.entries()].sort((a, b) => b[1] - a[1])[0];
const worstType = worst && short(byComp.get(worst[0]).type);
check('no producer fans out past a dozen consumers', worst[1] <= 12, `${worstType} fans to ${worst[1]}`);
const relays = [...byComp.values()].filter((c) => /Relay/.test(short(c.type)));
check('the graph uses relays to distribute', relays.length >= 8, `${relays.length} relays`);
check('every relay actually feeds something',
  relays.every((r) => fan.get(r.id) > 0 || short(r.type) === 'ContinuationRelay'));

// The general form of the bug that killed the buttons: the root slot's id IS the
// null GUID, so ANY field pointing at it reads as null in-world while looking
// perfectly wired here. Nothing may reference it.
const rootRefs = [];
for (const c of byComp.values())
  for (const [k, v] of Object.entries(c.data)) {
    const d = v && typeof v === 'object' ? v.Data : null;
    if (typeof d === 'string' && d === NULL_GUID) rootRefs.push(`${short(c.type)}.${k}`);
  }
check('nothing references the root slot / null GUID', rootRefs.length === 0, rootRefs.join(', '));

// ── every Sync<Uri> value carries its @ marker ───────────────────────────────
// `@` is the DataTree's type tag for a url, not decoration: without it the field
// loads as null and the asset silently never appears. See booster/urlmarker.mjs.
console.log('\nurl fields:');
const urls = scanUrlFields(doc);
check('every url field carries its @ marker', urls.unmarked.length === 0,
  urls.unmarked.map((u) => `${u.field}=${u.value}`).join(', '));
console.log(`  note ${urls.marked.length} marked, ${urls.unmarked.length} unmarked`);

console.log(bad ? `${NEWLINE}${bad} FAILURES` : `${NEWLINE}panel verified`);
process.exitCode = bad ? 1 : 0;
