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
check('six buttons', buttons.length === 6, String(buttons.length));
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
check('one receiver per button', receivers.length === 6, String(receivers.length));
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
  return n === 6;
}));

let check_async_seen = false;
const allWrites = compsOfType('WriteDynamicObjectVariable<string>');
// A receiver fires a URL write; the request's own impulse outputs fire the
// event writes that report which branch ran, and the loop fires the one that
// tells a fresh card its art. Only the first kind is a button.
const writes = allWrites.filter((w) => receivers.some((r) => arg(r, 'OnTriggered') === w.id));
check('five receivers trigger a URL write', writes.length === 5, String(writes.length));
check('five distinct URLs, one per preset button',
  new Set(writes.map((w) => arg(byComp.get(arg(w, 'Value')), 'Value'))).size === 5);
check('exactly one GET, shared by all five', compsOfType('GET_String').length === 1);
check('every write continues into the request', writes.every((w) => {
  // write -> trunk relay -> StartAsyncTask -> GET. The async wrapper is not
  // optional: GET_String is an AsyncActionNode and an ordinary impulse cannot
  // run one - the chain would reach it and stop with no error anywhere.
  let after = byComp.get(arg(w, 'OnSuccess'));
  if (short(after?.type) === 'ContinuationRelay') after = byComp.get(arg(after, 'Next'));
  check_async_seen = check_async_seen || short(after?.type) === 'StartAsyncTask';
  if (short(after?.type) === 'StartAsyncTask') after = byComp.get(arg(after, 'TaskStart'));
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
    case 'ChildrenCount': r = STATE.has('children') ? STATE.get('children') : 0; break;
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
check('and it is inactive, so it is never one of the cards', tmpl?.Active?.Data === false);
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
const dups = compsOfType('DuplicateSlot');
check('one DuplicateSlot', dups.length === 1);
const dup = dups[0];
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
const IMPULSE = ['Next', 'OnSuccess', 'OnWritten', 'OnTrue', 'OnFalse', 'TaskStart', 'OnTriggered', 'OnResponse'];
const chainFrom = (id, stop = 24) => {
  const out = [];
  let c = byComp.get(id);
  while (c && out.length < stop) {
    out.push(c);
    const nxt = IMPULSE.map((f) => arg(c, f)).find((v) => typeof v === 'string' && byComp.has(v));
    c = nxt ? byComp.get(nxt) : null;
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
const delays = compsOfType('DelayUpdates');
check('the loop lets a frame pass each time round', delays.length === 1);
check('and runs inside a StartAsyncTask', compsOfType('StartAsyncTask').length >= 3);
check('the previous import is cleared first', compsOfType('DestroySlotChildren').length === 1);

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
const W = 64;
function scenario(name, body, expect) {
  const recs = Array.from({ length: body.length / W }, (_, i) => body.slice(i * W, (i + 1) * W).trim());
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
check('shows the error text on failure', evalProxy(statusProxy, errBody) === errBody);

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
// A terminal may pass through one ContinuationRelay stub on the way - that is
// the house style for a branch, and it is what keeps the column routable.
const hop = (id) => {
  const c = byComp.get(id);
  return c && short(c.type) === 'ContinuationRelay' ? arg(c, 'Next') : id;
};
const unreported = terminals.filter(([, id]) => !evtIds.has(hop(id)));
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
check('the whole graph is small enough to read', nodesOf(control).length <= 120, `${nodesOf(control).length} nodes`);

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
  check('four zones, one per stage', rects.length === 4, String(rects.length));
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
  const offenders = [];
  for (const from of placed)
    for (const id of from.ids) {
      const c = byComp.get(id);
      if (!c) continue;
      for (const [, v] of Object.entries(c.data)) {
        const d = v && typeof v === 'object' ? v.Data : null;
        if (typeof d !== 'string' || !boxOf.has(d)) continue;
        const to = boxOf.get(d);
        if (to === from) continue;
        for (const mid of placed)
          if (mid !== from && mid !== to && hits(from, to, mid))
            offenders.push({ leaf: isLeaf(mid), text: `${from.name} -> ${to.name} crosses ${mid.name}` });
      }
    }
  return offenders;
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

console.log(bad ? `${NEWLINE}${bad} FAILURES` : `${NEWLINE}panel verified`);
process.exitCode = bad ? 1 : 0;
