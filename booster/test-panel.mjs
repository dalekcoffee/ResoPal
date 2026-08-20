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
check('every trigger targets the object root', triggers.every((t) => arg(t, 'Target') === doc.Object.ID));

const writes = compsOfType('WriteDynamicValueVariable<string>');
check('every receiver triggers a URL write', receivers.every((r) =>
  short(byComp.get(arg(r, 'OnTriggered'))?.type) === 'WriteDynamicValueVariable<string>'));
check('five distinct URLs, one per button',
  new Set(writes.map((w) => arg(byComp.get(arg(w, 'Value')), 'Value'))).size === 5);
check('exactly one GET, shared by every button', compsOfType('GET_String').length === 1);
check('every write continues into the request', writes.every((w) => {
  const nxt = byComp.get(arg(w, 'OnSuccess'));
  return nxt && (short(nxt.type) === 'If' || short(nxt.type) === 'GET_String');
}));
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
  const lines = body.trimEnd() === '' ? [] : body.trimEnd().split(NEWLINE);
  const urls = urlNodeFor.map((n) => evalRef(arg(n, 'Value'), body));
  memo.clear();
  const on = onNodeFor.map((n) => evalRef(arg(n, 'Value'), body));
  const visible = on.filter(Boolean).length;
  check(`${name}: ${expect} cards visible`, visible === expect, String(visible));
  check(`${name}: the visible ones are the first ${expect}`,
    on.slice(0, expect).every(Boolean) && on.slice(expect).every((x) => !x));
  check(`${name}: each visible card shows its own line's art`,
    lines.every((l, i) => urls[i] === PROXY + '/img/' + l.split(',')[0]),
    `first want ${PROXY}/img/${(lines[0] || '').split(',')[0]} got ${urls[0]}`);
}

console.log(`${NEWLINE}live responses:`);
const pull1 = await fetchFlat('/api/pull?seed=panel1&format=flat');
scenario('1 booster', pull1, 7);
scenario('3 boosters', await fetchFlat('/api/pull?seed=panel3&packs=3&format=flat'), 21);
scenario('10 boosters', await fetchFlat('/api/pull?seed=panelX&packs=10&format=flat'), 70);
scenario('green/purple deck', await fetchFlat('/api/deck?deck=td02&format=flat'), 50);
scenario('red/blue deck', await fetchFlat('/api/deck?deck=td01&format=flat'), 48);

memo.clear();
check('an empty response shows no cards', onNodeFor.map((n) => evalRef(arg(n, 'Value'), '')).every((x) => !x));
// GET_String writes the exception message into Content when a request fails.
const errBody = 'The remote name could not be resolved';
memo.clear();
check('a network error shows no cards', onNodeFor.map((n) => evalRef(arg(n, 'Value'), errBody)).every((x) => !x));

// ── 4. the status line says something useful ─────────────────────────────────
console.log(`${NEWLINE}status line:`);
const statusProxy = [...byComp.values()].find((c) => short(c.type) === 'FieldDriveBase<string>+Proxy');
check('the status text is driven', !!statusProxy);
const statusTarget = statusProxy && byField.get(arg(statusProxy, 'Drive'));
check('it drives a Text.Content', statusTarget?.name === 'Content' && short(statusTarget.comp.type) === 'Text');
const statusNode = byComp.get(arg(statusProxy, 'Node'));
memo.clear();
check('shows the first card on success',
  evalRef(arg(statusNode, 'Value'), pull1) === pull1.split(NEWLINE)[0]);
memo.clear();
check('shows the error text on failure', evalRef(arg(statusNode, 'Value'), errBody) === errBody);

// ── 5. encoding and layout gates ─────────────────────────────────────────────
console.log(`${NEWLINE}encoding and layout:`);
check('BSON round-trips byte-identical',
  Buffer.compare(Buffer.from(bson), Buffer.from(await serializeBson(doc))) === 0);
const { commentZoneOverlaps } = await import(`file://${path.join(RKL, 'protoflux', 'skill', 'scripts', 'layout_stats.mjs')}`);
check('no overlapping comment zones', JSON.stringify(commentZoneOverlaps(doc)) === '[]');

// A ProtoFlux node visual is roughly 0.4 x 0.28. The first build spaced nodes at
// about a third of that, which is why unpacking produced an unreadable heap.
const fluxRoot = (doc.Object.Children || []).find((s) => nm(s) === 'Flux');
const groups = fluxRoot.Children || [];
check('flux is split into labelled groups',
  groups.length > 10 && groups.every((g) => nm(g).startsWith('(f) ')), String(groups.length));
const gpos = groups.map((g) => (g.Position.Data || []).map(num));
let tooClose = 0;
for (let i = 0; i < gpos.length; i++)
  for (let j = i + 1; j < gpos.length; j++)
    if (Math.abs(gpos[i][0] - gpos[j][0]) < 1.5 && Math.abs(gpos[i][1] - gpos[j][1]) < 1.0) tooClose++;
check('no two groups sit on top of each other', tooClose === 0, `${tooClose} overlapping pairs`);
check('nodes inside a group clear a node visual', groups.every((g) => {
  const p = (g.Children || []).map((c) => (c.Position.Data || []).map(num));
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++)
      if (Math.abs(p[i][0] - p[j][0]) < 0.4 && Math.abs(p[i][1] - p[j][1]) < 0.25) return false;
  return true;
}));

console.log(bad ? `${NEWLINE}${bad} FAILURES` : `${NEWLINE}panel verified`);
process.exitCode = bad ? 1 : 0;
