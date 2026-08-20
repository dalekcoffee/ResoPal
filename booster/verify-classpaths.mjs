// Check every type the package emits actually exists in Resonite, and that its
// generic argument satisfies the real constraint.
//
// This exists because of a specific failure: the panel emitted
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
const declared = new Map();   // simple name -> [{ generic, constraint, file }]
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
    const list = declared.get(name) || [];
    list.push({ asm, generic: !!generic, constraint: where ? where[1].trim() : null });
    declared.set(name, list);
  }
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
  const isValue = VALUE_TYPES.has(arg);
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

for (const [cp, why] of problems) { bad++; console.log(`  FAIL ${cp}\n         ${why}`); }
console.log(bad ? `\n${bad} of ${checked} types are wrong` : `\nall ${checked} types exist and satisfy their constraints`);
process.exitCode = bad ? 1 : 0;
