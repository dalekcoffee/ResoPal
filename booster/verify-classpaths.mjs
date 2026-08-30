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
import { memberOrder, isFluxNode, memberKinds, isOperation } from './members.mjs';

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

// A class NAME existing somewhere is not the same as the classpath existing.
// `[ProtoFluxBindings]...Nodes.StartAsyncTask` passed every check here for three
// builds; the class it was answered with lives at
// `...Nodes.FrooxEngine.Async.StartAsyncTask`, three namespaces away. No loader
// resolves the path we wrote, so the request nodes and the whole spawn loop came
// up red in-world with nothing able to run them - and the graph still validated,
// still had zero dangling references, and still passed the async-context check,
// because every one of those looked the class up by its leaf name too.
//
// `[Asm]A.B.C` lives at `decompiled/Asm/A/B/C.cs`. Nothing else counts.
const namespaced = (classpath) => {
  const m = /^\[([^\]]+)\](.+)$/.exec(String(classpath));
  if (!m || !ASSEMBLIES.includes(m[1])) return true;      // not ours to place
  const rest = m[2].split('+')[0].replace(/<.*$/, '');
  return existsSync(path.join(DECOMPILED, m[1], ...rest.split('.')) + '.cs');
};

for (const classpath of doc.Types) {
  const t = parse(classpath);
  const decls = declared.get(t.name);
  checked++;
  if (!decls || !decls.length) {
    problems.push([classpath, 'no such class in the decompiled source']);
    continue;
  }
  if (!namespaced(classpath)) {
    const where = (() => {
      try {
        return execFileSync('find', [DECOMPILED, '-name', `${t.name}.cs`], { encoding: 'utf8' })
          .split('\n').filter(Boolean).map((f) => f.replace(DECOMPILED + '/', '')).slice(0, 3).join(', ');
      } catch { return '(nowhere)'; }
    })();
    problems.push([classpath,
      `no class at THIS namespace - the name exists, but only at: ${where || '(nowhere)'}`]);
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

// ── member order ─────────────────────────────────────────────────────────────
// The check that would have caught the whole-package failure: the panel encoded
// cleanly, validated with zero dangling references, and in-world every node was
// red with wires on the wrong ports.
//
// `If` went out as {Condition, OnTrue, OnFalse}; the class declares
// {OnTrue, OnFalse, Condition}. `GET_String` declares `Content` LAST, because it
// comes from a subclass after the base's impulses, and emitting it fifth shifted
// every impulse output by one - which is exactly what "the request is connected
// to things but nothing calls it" looks like from inside the world.
//
// Resonite writes its own packages in declaration order. So do we now, and a
// drift fails the build. A ProtoFlux node must also declare EVERY member: they
// are all ports, and a port that is not in the file is a port the graph cannot
// resolve.
const emitted = new Map();
(function walk(n, kind) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach((x) => walk(x, kind));
  if (n.Type !== undefined && n.Data && n.Data.ID) {
    const t = doc.Types[Number(n.Type)];
    const keys = Object.keys(n.Data).filter((k) => k !== 'ID');
    const k = keys[0] === 'persistent' ? 'asset' : 'component';
    if (!emitted.has(t + '|' + k)) emitted.set(t + '|' + k, keys);
  }
  for (const v of Object.values(n)) walk(v, kind);
})(doc);

for (const [key, got] of emitted) {
  const i = key.lastIndexOf('|');
  const cp = key.slice(0, i), kind = key.slice(i + 1);
  const want = memberOrder(cp, kind);
  if (!want) continue;
  const wantHere = want.filter((w) => got.includes(w));
  if (JSON.stringify(got) !== JSON.stringify(wantHere))
    problems.push([cp, `members are out of declared order\n           emitted ${JSON.stringify(got)}\n           declared ${JSON.stringify(wantHere)}`]);
  if (isFluxNode(cp)) {
    const absent = want.filter((w) => !got.includes(w));
    if (absent.length)
      problems.push([cp, `is a ProtoFlux node missing ports ${JSON.stringify(absent)} - every member is a port, and one that is not in the file cannot be resolved`]);
  }
}

// ── port kinds ───────────────────────────────────────────────────────────────
// A wire is only correct if the two ends are the same kind of thing. The binding
// class says which each member is: `SyncRef<INodeOperation>` is an impulse and
// must land on a node that can be RUN; `SyncRef<INode*Output<T>>` is a data
// input and must land on something that produces a value - never on an action
// node's own component id, which carries nothing. A named output such as
// `GET_String.Content` is addressed by its FIELD id, and that is the difference
// this check exists to hold.
for (const [id, c] of comps) {
  const kinds = memberKinds(c.type);
  if (!kinds.size) continue;
  for (const [k, v] of Object.entries(c.data)) {
    const kind = kinds.get(k);
    if (!kind) continue;
    const d = v && typeof v === 'object' ? v.Data : null;
    if (kind === 'output') {
      if (d != null) problems.push([c.type, `writes into its own output "${k}" - an output exists to be addressed by field id, not assigned`]);
      continue;
    }
    if (typeof d !== 'string') continue;
    const target = comps.get(d);
    if (kind === 'impulse') {
      if (!target) problems.push([c.type, `impulse "${k}" points at a field, not a node - only a node can be run`]);
      else if (!isOperation(target.type)) problems.push([c.type, `impulse "${k}" points at ${shortName(target.type)}, which is not an operation and cannot be run`]);
    } else if (kind === 'data' && target && isOperation(target.type)) {
      problems.push([c.type, `data input "${k}" points at the ACTION node ${shortName(target.type)} by component id; an action node's component id carries no value - a named output has to be addressed by its field id`]);
    }
  }
}

// ── orphans ──────────────────────────────────────────────────────────────────
// Every operation must have something that RUNS it. This is the check that was
// missing when a refactor moved `GET_String.OnResponse` onto the event stub and
// took the unpack chain's only trigger with it: the graph still validated, the
// wires were all type-correct, and in-world a third of the canvas sat there with
// nothing driving it.
//
// A continuation only goes ONE place, so an impulse output that has to do two
// things needs a Sequence. Losing that is silent.
const runnable = new Set();
for (const [id, c] of comps) if (isOperation(c.type)) runnable.add(id);
const driven = new Set();
for (const [, c] of comps) {
  const kinds = memberKinds(c.type);
  for (const [k, v] of Object.entries(c.data)) {
    if (kinds.get(k) !== 'impulse') continue;
    const d = v && typeof v === 'object' ? v.Data : null;
    for (const t of Array.isArray(d) ? d.map((e) => (e && typeof e === 'object' ? e.Data : e)) : [d])
      if (typeof t === 'string') driven.add(t);
  }
}
// Entry points run themselves: an event source is what starts a chain.
const ENTRY = /DynamicImpulseReceiver|ButtonEvents|OnStart|OnLoaded|Update$|SecondsTimer|SlotChildrenEvents|OnDestroying|OnGrabbable/;
for (const id of runnable) {
  const c = comps.get(id);
  if (ENTRY.test(shortName(c.type))) continue;
  if (!driven.has(id)) problems.push([c.type, `nothing runs it - no impulse anywhere points at this node (a continuation only goes one place; use a Sequence to fan one)`]);
}

for (const [cp, why] of problems) { bad++; console.log(`  FAIL ${cp}\n         ${why}`); }
console.log(bad
  ? `\n${bad} problem(s) across ${checked} types`
  : `\nall ${checked} types exist at the namespace they name, satisfy their constraints, declare their members in order, wire impulses to operations and data to values, have something that runs them, and every async node runs in an async context`);
process.exitCode = bad ? 1 : 0;
