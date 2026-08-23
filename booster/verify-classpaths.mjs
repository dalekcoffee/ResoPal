// Check every type the package emits actually exists in Resonite, and that its
// generic argument satisfies the real constraint.
//
// It also checks that no async node is called from a synchronous chain, which
// is the second way this build failed in-world: GET_String and
// RequestHostAccessUrl both derive from AsyncActionNode, an ordinary impulse
// cannot run one, and the chain just stops with no error.
//
// The first reason it exists: the panel emitted
// `WriteDynamicValueVariable<string>`, which cannot exist -
// `WriteDynamicValueVariable<T>` is declared `where T : unmanaged` and string is
// a reference type. The classpath looked perfectly plausible, the package
// validated with zero dangling references, and in-world every button did
// nothing, because the component never resolved and the impulse chain
// dead-ended at a type that was not there.
//
// A wrong classpath fails silently in-world, so "it encoded cleanly" proves very
// little. This is the cheap check that would have caught it: read the decompiled
// source, find each class, and hold its `where` clause against what we passed.
//
//   RKL=/path/to/Resonite-Knowledge-Library node booster/verify-classpaths.mjs [pkg]

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const decodeMjs = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
const DECOMPILED = path.join(RKL, 'decompiled');
if (!existsSync(decodeMjs) || !existsSync(DECOMPILED)) {
  console.error('Need the Knowledge Library (its codec and its decompiled source); set RKL=<path>');
  process.exit(1);
}
const { frdtToBsonBytes, deserializeBson } = await import(`file://${decodeMjs}`);

const pkg = process.argv[2] || path.join(import.meta.dirname, 'out', 'ResoPal_Panel.resonitepackage');
const zip = await JSZip.loadAsync(await readFile(pkg));
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const doc = await deserializeBson(await frdtToBsonBytes(
  await zip.file('Assets/' + record.assetUri.replace('packdb:///', '')).async('uint8array')));

// Everything C# calls a value type in the generics we use. `unmanaged` accepts
// these (and enums); `class` rejects them. Anything else is treated as a
// reference type, which is the safe direction: a false alarm is cheap, a missed
// one costs a VR session.
const VALUE_TYPES = new Set([
  'bool', 'byte', 'sbyte', 'char', 'short', 'ushort', 'int', 'uint', 'long', 'ulong',
  'float', 'double', 'decimal',
  'float2', 'float3', 'float4', 'floatQ', 'float2x2', 'float3x3', 'float4x4',
  'double2', 'double3', 'double4', 'doubleQ',
  'int2', 'int3', 'int4', 'uint2', 'uint3', 'uint4', 'bool2', 'bool3', 'bool4',
  'color', 'colorX', 'Rect', 'BoundingBox', 'TimeSpan', 'DateTime', 'Guid',
]);

// One pass over the assemblies we actually emit from, collecting every class
// declaration and its constraint.
const ASSEMBLIES = ['FrooxEngine', 'ProtoFluxBindings', 'ProtoFlux.Nodes.FrooxEngine', 'ProtoFlux.Nodes.Core'];
const declared = new Map();   // simple name -> [{ generic, constraint, base }]
const enums = new Set();      // enums, and other types the source proves are value types
for (const asm of ASSEMBLIES) {
  const dir = path.join(DECOMPILED, asm);
  if (!existsSync(dir)) continue;
  let out = '';
  try {
    out = execFileSync('grep', ['-rhoE', '^\\s*(public|internal)\\s+(abstract\\s+|sealed\\s+|static\\s+|partial\\s+)*class\\s+[A-Za-z0-9_]+(<[^>]*>)?[^{]*', dir], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch { /* grep exits 1 when nothing matches */ }
  for (const line of out.split('\n')) {
    const m = /class\s+([A-Za-z0-9_]+)(<[^>]*>)?([\s\S]*)$/.exec(line);
    if (!m) continue;
    const [, name, generic, tail] = m;
    const where = /\bwhere\s+[A-Za-z0-9_]+\s*:\s*([^{]*)/.exec(tail);
    // First entry after the colon is the base class (or an interface); good
    // enough to walk a node's ancestry looking for AsyncActionNode.
    const base = /:\s*([A-Za-z0-9_.<>]+)/.exec(where ? tail.slice(0, tail.indexOf('where')) : tail);
    const list = declared.get(name) || [];
    list.push({ asm, generic: !!generic, constraint: where ? where[1].trim() : null, base: base ? base[1] : null });
    declared.set(name, list);
  }
  let enumOut = '';
  try {
    enumOut = execFileSync('grep', ['-rhoE', '^\\s*public\\s+enum\\s+[A-Za-z0-9_]+', dir], { encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch { /* none */ }
  for (const line of enumOut.split('\n')) {
    const m = /enum\s+([A-Za-z0-9_]+)/.exec(line);
    if (m) enums.add(m[1]);
  }
  // Some generic arguments are BCL value types the engine re-exposes, declared
  // nowhere in this source tree - HttpStatusCode, which GET_String reports its
  // result with, is the one this package uses. ProtoFlux's own value wrappers
  // name them: across these assemblies `ValueOutput<T>` and `ValueInput<T>`
  // never hold a reference type (reference ports are ObjectOutput/ObjectInput),
  // so anything inside one is unmanaged whether or not we can see it declared.
  // `Sync<T>` and `ValueArgument<T>` do NOT qualify - `Sync<string>` alone
  // appears 540 times, and admitting it would let `string` pass as unmanaged
  // and silently un-catch the WriteDynamicValueVariable<string> bug this file
  // exists for.
  let wrapOut = '';
  try {
    wrapOut = execFileSync('grep', ['-rhoE', '(ValueOutput|ValueInput)<[A-Za-z0-9_]+>', dir], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch { /* none */ }
  for (const line of wrapOut.split('\n')) {
    const m = /<([A-Za-z0-9_]+)>/.exec(line);
    if (m) enums.add(m[1]);
  }
}

/** Walk a class's ancestry looking for AsyncActionNode. */
function isAsync(name, seen = new Set()) {
  if (!name || seen.has(name)) return false;
  seen.add(name);
  if (/^AsyncActionNode/.test(name)) return true;
  const bare = name.replace(/<.*/, '').split('.').pop();
  if (/^AsyncActionNode/.test(bare)) return true;
  for (const d of declared.get(bare) || []) if (d.base && isAsync(d.base, seen)) return true;
  return false;
}

// `[Asm]Namespace.Outer<Arg>+Nested` -> the pieces we can check.
function parse(classpath) {
  const body = classpath.replace(/^\[[^\]]+\]/, '');
  const nested = body.includes('+') ? body.slice(body.indexOf('+') + 1) : null;
  const outer = nested ? body.slice(0, body.indexOf('+')) : body;
  const lt = outer.indexOf('<');
  const generic = lt >= 0 ? outer.slice(lt + 1, outer.lastIndexOf('>')) : null;
  const dotted = lt >= 0 ? outer.slice(0, lt) : outer;
  return { name: dotted.slice(dotted.lastIndexOf('.') + 1), generic, nested, classpath };
}

// A generic argument may itself be assembly-qualified, e.g.
// `[FrooxEngine]FrooxEngine.IGrabbable`. Only the last segment matters here.
const argName = (a) => {
  const bare = a.replace(/^\[[^\]]+\]/, '');
  return bare.slice(bare.lastIndexOf('.') + 1);
};

let bad = 0, checked = 0;
const problems = [];
console.log(`${path.basename(pkg)}  ${doc.Types.length} types`);

for (const classpath of doc.Types) {
  const t = parse(classpath);
  const decls = declared.get(t.name);
  checked++;
  if (!decls || !decls.length) {
    problems.push([classpath, 'no such class in the decompiled source']);
    continue;
  }
  if (!t.generic) continue;
  // Only single-argument generics are checked; multi-arg ones (ObjectCast<A,B>,
  // ValueWrite<Ctx,T>) would need per-parameter constraints to be meaningful.
  if (t.generic.includes(',')) continue;
  const arg = argName(t.generic);
  const isValue = VALUE_TYPES.has(arg) || enums.has(arg);
  // If ANY declaration of this name accepts the argument, accept it - the same
  // simple name can appear in more than one assembly.
  const ok = decls.some(({ constraint }) => {
    if (!constraint) return true;
    if (/\bunmanaged\b/.test(constraint)) return isValue;
    if (/\bclass\b/.test(constraint)) return !isValue;
    return true;
  });
  if (!ok) {
    const c = decls.map((d) => d.constraint).filter(Boolean).join(' | ');
    problems.push([classpath, `<${arg}> is ${isValue ? 'a value type' : 'a reference type'}, but the class is declared "where T : ${c}"`]);
  }
}

// ── async context ────────────────────────────────────────────────────────────
// An AsyncActionNode cannot be run by an ordinary impulse. The chain has to pass
// through a StartAsyncTask first; without one it reaches the async node and
// silently stops. Walk every impulse edge from the synchronous entry points and
// flag any async node reached without crossing a StartAsyncTask.
const IMPULSE_FIELDS = new Set([
  'Next', 'OnTrue', 'OnFalse', 'OnSuccess', 'OnFailed', 'OnNotFound', 'OnWritten',
  'OnGranted', 'OnDenied', 'OnIgnored', 'OnResponse', 'OnError', 'OnSent',
  'OnTriggered', 'Trigger', 'TaskStart', 'OnStarted', 'OnChanged', 'OnUpdate',
  'OnDone', 'OnReceived', 'LoopStart', 'LoopIteration', 'LoopEnd', 'Calls', 'Target',
]);
const comps = new Map();
(function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach(walk);
  if (n.Type !== undefined && n.Data && n.Data.ID) {
    const i = n.Type?.valueOf ? Number(n.Type) : n.Type;
    comps.set(n.Data.ID, { type: doc.Types[i], data: n.Data });
  }
  for (const v of Object.values(n)) walk(v);
})(doc);

const shortName = (cp) => parse(cp).name;
const outEdges = (c) => {
  const out = [];
  for (const [k, v] of Object.entries(c.data)) {
    if (!IMPULSE_FIELDS.has(k)) continue;
    const d = v && typeof v === 'object' ? v.Data : null;
    if (typeof d === 'string' && comps.has(d)) out.push([k, d]);
  }
  return out;
};

// Entry points that run synchronously. A receiver's OnTriggered is the one this
// package uses; the rest are here so the check keeps working as it grows.
const SYNC_ROOTS = new Set(['DynamicImpulseReceiver', 'OnStart', 'OnLoaded', 'ButtonEvents', 'Update', 'SecondsTimer', 'FireOnTrue', 'FireOnFalse']);
const syncReached = new Set();
const queue = [];
for (const [id, c] of comps) if (SYNC_ROOTS.has(shortName(c.type))) queue.push(id);
while (queue.length) {
  const id = queue.shift();
  if (syncReached.has(id)) continue;
  syncReached.add(id);
  const c = comps.get(id);
  // Crossing a StartAsyncTask puts everything beyond it in an async context.
  if (shortName(c.type) === 'StartAsyncTask') continue;
  for (const [, to] of outEdges(c)) queue.push(to);
}
for (const id of syncReached) {
  const c = comps.get(id);
  const name = shortName(c.type);
  if (SYNC_ROOTS.has(name)) continue;
  if (isAsync(name)) problems.push([c.type, 'is an AsyncActionNode but is reachable from a synchronous impulse without a StartAsyncTask in between']);
}

for (const [cp, why] of problems) { bad++; console.log(`  FAIL ${cp}\n         ${why}`); }
console.log(bad
  ? `\n${bad} problem(s) across ${checked} types`
  : `\nall ${checked} types exist, satisfy their constraints, and every async node runs in an async context`);
process.exitCode = bad ? 1 : 0;
