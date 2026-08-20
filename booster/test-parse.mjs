// Evaluate the spawner's parse graph the way Resonite would, and check it lands
// on the right seven URLs.
//
// This is the closest thing to a test that exists for authored ProtoFlux. It does
// NOT prove Resonite accepts the file - only a VR drag-test does that - but it
// does prove the arithmetic, which is where an authored parser actually goes
// wrong: an off-by-one in a line offset produces a URL that is silently wrong,
// and a wrong texture URL fails without an error (docs/BOOSTER.md).
//
// It reads the built package, not the builder's intentions, so it catches a node
// that was wired to the wrong id as readily as a bad index.
//
//   node booster/test-parse.mjs [path.resonitepackage]

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import JSZip from 'jszip';

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const decodeMjs = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(decodeMjs)) { console.error(`Need the Knowledge Library for its codec; set RKL=<path>`); process.exit(1); }
const { frdtToBsonBytes, deserializeBson } = await import(`file://${decodeMjs}`);

const pkg = process.argv[2] || path.join(import.meta.dirname, 'out', 'ResoPal_Booster_BP01.resonitepackage');
const zip = await JSZip.loadAsync(await readFile(pkg));
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const doc = await deserializeBson(await frdtToBsonBytes(
  await zip.file('Assets/' + record.assetUri.replace('packdb:///', '')).async('uint8array')));

const num = (v) => (v && typeof v === 'object' && v._bsontype ? Number(v) : v);
const TYPES = doc.Types;

// ── index every component and every field ────────────────────────────────────
const byComp = new Map();     // component id -> { type, data }
const byField = new Map();    // field id     -> { comp, name }
(function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach(walk);
  if (n.Type !== undefined && n.Data && n.Data.ID) {
    const type = TYPES[num(n.Type)];
    const rec = { type, data: n.Data, id: n.Data.ID };
    byComp.set(n.Data.ID, rec);
    for (const [k, v] of Object.entries(n.Data))
      if (v && typeof v === 'object' && typeof v.ID === 'string') byField.set(v.ID, { comp: rec, name: k });
  }
  for (const v of Object.values(n)) walk(v);
})(doc);

const short = (t) => String(t).replace(/^\[[^\]]+\]/, '').split('.').pop();
const arg = (c, name) => (c.data[name] === undefined ? undefined : c.data[name].Data);

// ── evaluate a reference, exactly as the runtime would ───────────────────────
// A ref is either a COMPONENT id (the node's own value output) or a FIELD id (a
// named output sentinel, like GET_String.Content). That distinction is the
// addressing rule; conflating the two is the classic silent failure, so the
// evaluator honours it rather than papering over it.
function evalRef(ref, body, depth = 0) {
  if (ref == null) return null;
  if (depth > 64) throw new Error('reference cycle');
  const asField = byField.get(ref);
  if (asField && asField.comp.id !== ref) {
    const { comp, name } = asField;
    if (short(comp.type) === 'GET_String' && name === 'Content') return body;   // the response body
    if (comp.data.ID === ref) return evalComp(comp, body, depth + 1);
    return evalComp(comp, body, depth + 1);
  }
  const c = byComp.get(ref);
  if (!c) throw new Error(`unresolved ref ${ref}`);
  return evalComp(c, body, depth + 1);
}

function evalComp(c, body, depth) {
  const t = short(c.type);
  const A = () => evalRef(arg(c, 'A'), body, depth);
  const B = () => evalRef(arg(c, 'B'), body, depth);
  switch (t) {
    case 'ValueObjectInput<string>':
    case 'ValueInput<int>':      return num(arg(c, 'Value'));
    case 'StringToAbsoluteURI':  return evalRef(arg(c, 'Input'), body, depth);
    case 'ValueAdd<int>':        return A() + B();
    case 'ValueSub<int>':        return A() - B();
    case 'ValueGreaterThan<int>':return A() > B();
    case 'ObjectConditional<string>':
      return evalRef(arg(c, 'Condition'), body, depth) ? evalRef(arg(c, 'OnTrue'), body, depth) : evalRef(arg(c, 'OnFalse'), body, depth);
    case 'ConcatenateMultiString':
      return (arg(c, 'Inputs') || []).map((e) => evalRef(e.Data, body, depth)).join('');
    case 'IndexOfString': {
      const str = evalRef(arg(c, 'Str'), body, depth) ?? '';
      const part = evalRef(arg(c, 'Part'), body, depth) ?? '';
      const from = arg(c, 'StartIndex') == null ? 0 : evalRef(arg(c, 'StartIndex'), body, depth);
      return str.indexOf(part, from);
    }
    case 'Substring': {
      const str = evalRef(arg(c, 'Str'), body, depth) ?? '';
      const from = arg(c, 'StartIndex') == null ? 0 : evalRef(arg(c, 'StartIndex'), body, depth);
      const len = arg(c, 'Length') == null ? undefined : evalRef(arg(c, 'Length'), body, depth);
      if (from < 0 || from > str.length) return '';
      return len === undefined ? str.slice(from) : str.substr(from, Math.max(0, len));
    }
    case 'GET_String':           return body;
    default: throw new Error(`no evaluator for ${t}`);
  }
}

// ── find the seven URL drives, in stack order ────────────────────────────────
const drives = [];
for (const c of byComp.values()) {
  if (short(c.type) !== 'FieldDriveBase<Uri>+Proxy') continue;
  const node = byComp.get(arg(c, 'Node'));
  drives.push({ proxy: c, node, target: arg(c, 'Drive') });
}
// Order them by the card slot each drives, walking the Cards subtree so the test
// checks the order the player actually sees rather than emit order.
const nm = (s) => String(s?.Name?.Data ?? '');
const cardsSlot = (doc.Object.Children || []).find((s) => nm(s) === 'Cards');
const texOrder = [];
(function collect(s) {
  for (const c of s.Components?.Data || []) {
    const type = TYPES[num(c.Type)];
    if (short(type) === 'MeshRenderer') {
      const matId = (c.Data.Materials?.Data || [])[0]?.Data;
      const mat = byComp.get(matId);
      if (mat) texOrder.push(arg(mat, 'Texture'));
    }
  }
  (s.Children || []).forEach(collect);
})(cardsSlot);

let bad = 0;
const check = (n, ok, d = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${!ok && d ? '  ' + d : ''}`); };

console.log(`${path.basename(pkg)}  (${byComp.size} components, ${drives.length} URL drives)`);
check('seven cards', texOrder.length === 7, String(texOrder.length));
check('seven URL drives', drives.length === 7, String(drives.length));
check('every drive targets a distinct StaticTexture2D.URL',
  new Set(drives.map((d) => d.target)).size === 7 &&
  drives.every((d) => { const f = byField.get(d.target); return f && short(f.comp.type) === 'StaticTexture2D' && f.name === 'URL'; }));

// Map each card slot (in stack order) to the drive that feeds its texture.
const driveForTexture = new Map();
for (const d of drives) {
  const f = byField.get(d.target);
  driveForTexture.set(f.comp.id, d);
}
const ordered = texOrder.map((texId) => driveForTexture.get(texId));
check('every card in stack order has a drive', ordered.every(Boolean));

// ── the real thing: a live response from the Worker ──────────────────────────
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const { default: worker } = await import('../worker/src/index.js');
const res = await worker.fetch(new Request('https://w.example/api/pull?seed=parsetest&format=flat'), {}, { waitUntil() {} });
const body = await res.text();
const lines = body.trimEnd().split('\n');
console.log('\n  response:\n' + lines.map((l) => '    ' + l).join('\n'));

const PROXY = 'https://resopal-proxy.dalek.workers.dev';
const got = ordered.map((d) => evalRef(arg(d.node, 'Value'), body));
const want = lines.map((l) => PROXY + '/img/' + l.split(',')[0]);
console.log('\n  parsed:');
got.forEach((u, i) => console.log(`    card ${i + 1}  ${u}`));
check('all seven URLs match the response, in stack order', JSON.stringify(got) === JSON.stringify(want),
  '\n        want ' + JSON.stringify(want) + '\n        got  ' + JSON.stringify(got));

// Long codes (BP01-001SSP) and short ones (BP01-011) must both survive, since the
// substring length is computed rather than fixed.
const mixed = 'BP01-001SSP,SSP\nSOUL-002,SSS\nBP01-011,C\nBP01-012,C\nBP01-013,C\nBP01-081,C\nBP01-085,U\n';
const mixedGot = ordered.map((d) => evalRef(arg(d.node, 'Value'), mixed));
check('variable-length codes parse', JSON.stringify(mixedGot) ===
  JSON.stringify(mixed.trimEnd().split('\n').map((l) => PROXY + '/img/' + l.split(',')[0])),
  JSON.stringify(mixedGot));

// Before the response lands, Content is empty. Every card must show the fallback
// rather than an empty URL, which would load nothing and never say why.
const empty = ordered.map((d) => evalRef(arg(d.node, 'Value'), ''));
check('empty response falls back on every card', empty.every((u) => u.includes('/img/') && !u.endsWith('/img/')), JSON.stringify(empty[0]));

// A truncated response must not produce a wrong card - only the lines that
// actually arrived may resolve.
const partial = lines.slice(0, 3).join('\n') + '\n';
const part = ordered.map((d) => evalRef(arg(d.node, 'Value'), partial));
check('truncated response resolves only the lines it has',
  part.slice(0, 3).every((u, i) => u === want[i]) && part.slice(3).every((u) => !want.slice(3).includes(u)),
  JSON.stringify(part));

console.log(bad ? `\n${bad} FAILURES` : '\nparse graph verified against a live pull');
process.exitCode = bad ? 1 : 0;
