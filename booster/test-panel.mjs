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
check('five buttons', buttons.length === 5, String(buttons.length));
check('every button has an impulse trigger', triggers.length === buttons.length);
check('every button tints an Image on its own slot', buttons.every((b) => {
  const drivers = arg(b, 'ColorDrivers') || [];
  if (drivers.length !== 1) return false;
  const f = byField.get(drivers[0].ColorDrive.Data);
  return f && short(f.comp.type) === 'Image' && f.name === 'Tint' && f.comp.slot === b.slot;
}));
check('every button carries a caption', buttons.every((b) =>
  (b.slot.Children || []).some((c) => (c.Components?.Data || []).some((x) => short(TYPES[num(x.Type)]) === 'Text'))));

// ── 2. pressing a button reaches the graph ───────────────────────────────────
console.log(`${NEWLINE}buttons -> graph:`);
const receivers = compsOfType('DynamicImpulseReceiver');
check('one receiver per button', receivers.length === 5, String(receivers.length));
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
  return n === 5;
}));

let check_async_seen = false;
const allWrites = compsOfType('WriteDynamicObjectVariable<string>');
// A receiver fires a URL write; the request's own impulse outputs fire the
// event writes that report which branch ran. Only the first kind is a button.
const writes = allWrites.filter((w) => receivers.some((r) => arg(r, 'OnTriggered') === w.id));
check('every receiver triggers a URL write', receivers.every((r) =>
  short(byComp.get(arg(r, 'OnTriggered'))?.type) === 'WriteDynamicObjectVariable<string>'));
check('five distinct URLs, one per button',
  new Set(writes.map((w) => arg(byComp.get(arg(w, 'Value')), 'Value'))).size === 5, String(writes.length));
check('exactly one GET, shared by every button', compsOfType('GET_String').length === 1);
check('every write continues into the request', writes.every((w) => {
  const nxt = byComp.get(arg(w, 'OnSuccess'));
  if (!nxt) return false;
  // Writes join one trunk relay so the gate takes a single incoming wire.
  let after = nxt;
  // write -> trunk relay -> StartAsyncTask -> the gate. The async wrapper is not
  // optional: GET_String and RequestHostAccessUrl are both AsyncActionNode and an
  // ordinary impulse cannot run one.
  if (short(after.type) === 'ContinuationRelay') after = byComp.get(arg(after, 'Next'));
  check_async_seen = check_async_seen || short(after?.type) === 'StartAsyncTask';
  if (short(after?.type) === 'StartAsyncTask') after = byComp.get(arg(after, 'TaskStart'));
  return after && (short(after.type) === 'If' || short(after.type) === 'GET_String');
}));
check('the request runs inside a StartAsyncTask', check_async_seen);
const driver = compsOfType('DynamicValueVariableDriver<string>')[0];
const target = driver && byField.get(arg(driver, 'Target'));
check('the chosen URL is driven into the request',
  !!target && target.name === 'Value' && short(target.comp.type) === 'ValueObjectInput<string>');
check('driver and variable agree on a name',
  arg(driver, 'VariableName') === arg(compsOfType('DynamicValueVariable<string>')[0], 'VariableName'));

// ── 3. evaluate the parse graph the way the runtime would ────────────────────
const memo = new Map();
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
    case 'GET_String': r = body; break;
    default: throw new Error(`no evaluator for ${t}`);
  }
  memo.set(key, r);
  return r;
}

// Cards in layout order, each paired with the two drives that feed it.
const cardsSlot = (doc.Object.Children || []).find((s) => nm(s) === 'Cards');
const cards = (cardsSlot.Children || []).map((s) => {
  const rend = (s.Components?.Data || []).find((c) => short(TYPES[num(c.Type)]) === 'MeshRenderer');
  const mat = byComp.get((rend.Data.Materials?.Data || [])[0]?.Data);
  return { texId: arg(mat, 'Texture'), activeField: s.Active.ID };
});
const urlDrive = new Map(), onDrive = new Map();
for (const c of byComp.values()) {
  if (short(c.type) === 'FieldDriveBase<Uri>+Proxy') urlDrive.set(arg(c, 'Drive'), byComp.get(arg(c, 'Node')));
  if (short(c.type) === 'FieldDriveBase<bool>+Proxy') onDrive.set(arg(c, 'Drive'), byComp.get(arg(c, 'Node')));
}

console.log(`${NEWLINE}cards:`);
check('70 card slots', cards.length === 70, String(cards.length));
check('every card has its own texture', new Set(cards.map((c) => c.texId)).size === 70);
const urlNodeFor = cards.map((c) => urlDrive.get(byComp.get(c.texId).data.URL.ID));
const onNodeFor = cards.map((c) => onDrive.get(c.activeField));
check('every card has a URL drive', urlNodeFor.every(Boolean));
check('every card has a visibility drive', onNodeFor.every(Boolean));

globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { default: worker } = await import('../worker/src/index.js');
const fetchFlat = async (p) => (await worker.fetch(new Request('https://w.example' + p), {}, { waitUntil() {} })).text();
const PROXY = 'https://resopal-proxy.dalek.workers.dev';

function scenario(name, body, expect) {
  memo.clear();
  const W = 64;
  const recs = Array.from({ length: body.length / W }, (_, i) => body.slice(i * W, (i + 1) * W).trim());
  const urls = urlNodeFor.map((n) => evalRef(arg(n, 'Value'), body));
  memo.clear();
  const on = onNodeFor.map((n) => evalRef(arg(n, 'Value'), body));
  const visible = on.filter(Boolean).length;
  check(`${name}: ${expect} cards visible`, visible === expect, String(visible));
  check(`${name}: the visible ones are the first ${expect}`,
    on.slice(0, expect).every(Boolean) && on.slice(expect).every((x) => !x));
  check(`${name}: each visible card shows its own record's art`,
    recs.every((r, i) => urls[i] === r),
    `first want ${recs[0]} got ${urls[0]}`);
}

console.log(`${NEWLINE}live responses:`);
const pull1 = await fetchFlat('/api/pull?seed=panel1&format=fixed');
scenario('1 booster', pull1, 7);
scenario('3 boosters', await fetchFlat('/api/pull?seed=panel3&packs=3&format=fixed'), 21);
scenario('10 boosters', await fetchFlat('/api/pull?seed=panelX&packs=10&format=fixed'), 70);
scenario('green/purple deck', await fetchFlat('/api/deck?deck=td02&format=fixed'), 50);
scenario('red/blue deck', await fetchFlat('/api/deck?deck=td01&format=fixed'), 48);

memo.clear();
check('an empty response shows no cards', onNodeFor.map((n) => evalRef(arg(n, 'Value'), '')).every((x) => !x));
// GET_String writes the exception message into Content when a request fails.
const errBody = 'The remote name could not be resolved';
memo.clear();
const onErr = onNodeFor.map((n) => evalRef(arg(n, 'Value'), errBody));
check('a short error string lights at most the first card', onErr.slice(1).every((x) => !x));

// ── 4. the status line says something useful ─────────────────────────────────
console.log(`${NEWLINE}status line:`);
const strProxies = [...byComp.values()].filter((c) => short(c.type) === 'FieldDriveBase<string>+Proxy');
check('three Texts are driven: status, URL and last event', strProxies.length === 3, String(strProxies.length));
const evalProxy = (p, body) => { memo.clear(); try { return String(evalRef(arg(byComp.get(arg(p, 'Node')), 'Value'), body)); } catch { return null; } };

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
const evtWrites = allWrites.filter((w) => !writes.includes(w));
check('every event write targets ResoPal/event', evtWrites.length >= 1 &&
  evtWrites.every((w) => String(arg(byComp.get(arg(w, 'Path')), 'Value')) === 'ResoPal/event'));

// Every way this graph can stop has to end up on that line. A terminal impulse
// left null is a dead end with nothing anywhere to say it happened - which is
// exactly what "I approved host access and then nothing happened" looks like
// from inside the world.
const evtIds = new Set(evtWrites.map((w) => w.id));
const terminals = [
  ...compsOfType('GET_String').flatMap((g) => ['OnResponse', 'OnError', 'OnDenied'].map((f) => [`GET ${f}`, arg(g, f)])),
  ...compsOfType('RequestHostAccessUrl').flatMap((a) => ['OnDenied', 'OnIgnored'].map((f) => [`prompt ${f}`, arg(a, f)])),
  ...writes.flatMap((w) => ['OnNotFound', 'OnFailed'].map((f) => [`URL write ${f}`, arg(w, f)])),
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

// The two canvases exist and the one a human reads is small. That is the whole
// point of the split: 500 decoder nodes in the same canvas as the control logic
// is unreadable no matter how well it is laid out.
const canvasSlots = (doc.Object.Children || []).filter((s) => String(s.Tag?.Data ?? '') === 'Moduprint.ProtoFlux');
check('two Moduprint canvases', canvasSlots.length === 2, String(canvasSlots.length));
const control = canvasSlots.find((s) => nm(s).includes('control'));
const decoders = canvasSlots.find((s) => nm(s).includes('decoder'));
check('one is named for the control logic, one for the decoders', !!control && !!decoders);

const nodesOf = (c) => (c.Children || []).filter((s) => nm(s) !== 'Meta: Comments');
check('the control canvas is small enough to read', nodesOf(control).length <= 70, `${nodesOf(control).length} nodes`);
check('the decoders are the bulk, and are elsewhere', nodesOf(decoders).length > nodesOf(control).length * 4);

// Comment zones: present on both canvases, every one titled.
for (const c of [control, decoders]) {
  const meta = (c.Children || []).find((s) => nm(s) === 'Meta: Comments');
  check(`${nm(c)}: has a Meta: Comments slot`, !!meta);
  check(`${nm(c)}: tagged for Moduprint`, String(meta?.Tag?.Data ?? '') === 'Moduprint.Meta/ColinTheCat.Comments');
  const rects = (meta?.Components?.Data || []).filter((x) => /float3x3/.test(short(TYPES[num(x.Type)])));
  const labels = (meta?.Components?.Data || []).filter((x) => /DynamicValueVariable<string>/.test(short(TYPES[num(x.Type)])));
  check(`${nm(c)}: every zone has a title`, rects.length > 0 && rects.length === labels.length, `${rects.length} rects, ${labels.length} labels`);
  check(`${nm(c)}: no title is blank`, labels.every((l) => String(l.Data.Value?.Data ?? '').trim().length > 0));
}

// Nodes must clear a real node visual. The first build spaced them at about a
// third of one and unpacked into a heap.
for (const c of [control, decoders]) {
  const p = nodesOf(c).map((s) => (s.Position.Data || []).map(num));
  let clashes = 0;
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++)
      if (Math.abs(p[i][0] - p[j][0]) < 0.30 && Math.abs(p[i][1] - p[j][1]) < 0.22) clashes++;
  check(`${nm(c)}: no two nodes overlap a node visual`, clashes === 0, `${clashes} pairs`);
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
            offenders.push(`${from.name} -> ${to.name} crosses ${mid.name}`);
      }
    }
  return offenders;
}
// HARD on the canvas humans read.
const controlThrough = throughNodes(control);
check('Flux - control: no wire runs through a node box', controlThrough.length === 0,
  `${controlThrough.length}: ${controlThrough.slice(0, 3).join(' | ')}`);
// SOFT on the generated one. Routing 70 identical clusters to standard needs a
// relay chain per bus line - about 140 extra relays for a canvas nobody is meant
// to read. Reported so the number cannot quietly grow; the real fix is to run the
// library's own router.mjs over it rather than hand-placing.
const decoderThrough = throughNodes(decoders);
console.log(`  note ${nm(decoders)}: ${decoderThrough.length} bus wires cross a cluster (generated, not hand-routed)`);

// Relays: no producer should carry a huge fan. Before the relay banks the
// response and the record width were wired to seventy consumers each.
const fan = new Map();
for (const c of byComp.values())
  for (const [k, v] of Object.entries(c.data)) {
    const d = v && typeof v === 'object' ? v.Data : null;
    if (typeof d === 'string' && byComp.has(d) && k !== 'Node') fan.set(d, (fan.get(d) || 0) + 1);
  }
const worst = [...fan.entries()].sort((a, b) => b[1] - a[1])[0];
const worstType = worst && short(byComp.get(worst[0]).type);
check('no producer fans out past a dozen consumers', worst[1] <= 12, `${worstType} fans to ${worst[1]}`);
const relays = [...byComp.values()].filter((c) => /Relay/.test(short(c.type)));
check('the graph uses relays to distribute', relays.length >= 20, `${relays.length} relays`);
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
