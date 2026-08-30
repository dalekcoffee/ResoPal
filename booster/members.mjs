// The declared member order of a Resonite type, read out of its own
// `GetSyncMember(int index)` switch in the decompiled source.
//
// This exists because of a whole-package failure that every other check passed:
// the panel encoded cleanly, validated with zero dangling references, and
// in-world every node in the graph was red and half the wires landed on the
// wrong ports. `If` was emitted as {Condition, OnTrue, OnFalse}; the class
// declares {OnTrue, OnFalse, Condition}. `GET_String` declares `Content` LAST -
// it comes from a subclass, after the base's impulses - and emitting it fifth
// shifted every impulse output by one, which is why the request read as
// "connected to things, but nothing calls it".
//
// Resonite writes its own packages in this order. Rather than trust that a
// loader is tolerant of another one, the builder emits in it too, and
// `verify-classpaths.mjs` fails the build if anything drifts.
//
// The switch is the right source rather than the field declarations because it
// is the flattened list INCLUDING inherited members, in the order the engine
// itself indexes them - `Next` from a base class comes first, before anything
// the leaf class declares.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const DECOMPILED = path.join(RKL, 'decompiled');

// Serialized names for the three members every Worker starts with. Components
// write the first as `persistent-ID` (a bare id); entries in doc.Assets write it
// as `persistent` (a wrapped bool). Both are verbatim from real packages.
const HEAD = { component: ['persistent-ID', 'UpdateOrder', 'Enabled'], asset: ['persistent', 'UpdateOrder', 'Enabled'] };
const ALIAS = { persistent: null, updateOrder: null, EnabledField: null };

const fileCache = new Map();
const orderCache = new Map();

function sourceFiles(name) {
  if (fileCache.has(name)) return fileCache.get(name);
  let out = [];
  try {
    out = execFileSync('find', [DECOMPILED, '-name', `${name}.cs`], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch { /* none */ }
  fileCache.set(name, out);
  return out;
}


/**
 * The base of `name` as declared in `body`.
 *
 * A file can declare the same class at two generic arities - `ObjectWrite<T> :
 * ObjectWrite<ExecutionContext, T>` sits above `ObjectWrite<C, T> :
 * WriteBase<C, T>` - so taking the first match walks in a circle and stops one
 * link short of ActionNode. Prefer a base that is a different class.
 */
function baseOf(body, name) {
  const found = [...body.matchAll(new RegExp('class\\s+' + name + '[^:{\\n]*:\\s*([A-Za-z0-9_]+)', 'g'))].map((m) => m[1]);
  return found.find((b) => b !== name) ?? found[found.length - 1] ?? null;
}

/** `[Asm]Namespace.Outer<Arg>+Nested` -> { name, nested } */
export function parseClasspath(classpath) {
  const body = classpath.replace(/^\[[^\]]+\]/, '');
  const nested = body.includes('+') ? body.slice(body.indexOf('+') + 1) : null;
  const outer = nested ? body.slice(0, body.indexOf('+')) : body;
  const lt = outer.indexOf('<');
  const dotted = lt >= 0 ? outer.slice(0, lt) : outer;
  return { name: dotted.slice(dotted.lastIndexOf('.') + 1), nested };
}

function switchIn(src, nested) {
  // The outer class declares GetSyncMember at one tab, a nested class at two.
  // Matching the wrong one reports a receiver as having its Proxy's members.
  const indent = nested ? '\t\t' : '\t';
  if (nested) {
    const i = src.indexOf(`class ${nested}`);
    if (i < 0) return null;
    src = src.slice(i);
  }
  const re = new RegExp(`\\n${indent}public override ISyncMember GetSyncMember\\(int index\\)\\s*\\{\\s*return index switch\\s*\\{([\\s\\S]*?)\\};`);
  const m = re.exec(src);
  if (!m) return null;
  const names = [];
  for (const line of m[1].split('\n')) {
    const g = /^\s*\d+\s*=>\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (g) names.push(g[1]);
  }
  return names.length ? names : null;
}

/**
 * The serialized member names of `classpath`, in order, or null if the type has
 * no `GetSyncMember` to read (a few base types).
 *
 * `kind` picks how the first member is spelled: components write `persistent-ID`,
 * assets write `persistent`.
 */
export function memberOrder(classpath, kind = 'component') {
  const key = `${kind}|${classpath}`;
  if (orderCache.has(key)) return orderCache.get(key);
  let result = null;
  if (existsSync(DECOMPILED)) {
    const { name, nested } = parseClasspath(classpath);
    for (const f of sourceFiles(name)) {
      const names = switchIn(readFileSync(f, 'utf8'), nested);
      if (names) {
        result = names.map((n) => (n in ALIAS ? null : n)).map((n, i) => n ?? HEAD[kind][i]);
        break;
      }
    }
  }
  orderCache.set(key, result);
  return result;
}

/** Anything under a ProtoFlux namespace: every member is a port, so every one
 *  is emitted, unwired ones as null. Plain components keep only what is set. */
export const isFluxNode = (classpath) => /ProtoFlux/.test(classpath);

export const haveSource = () => existsSync(DECOMPILED);

/**
 * What KIND each member is, from how the binding class declares it:
 *
 *   SyncRef<INodeOperation> X          an impulse output - must point at a node
 *                                      that can be run
 *   SyncRef<INodeObjectOutput<T>> X    a data input - must point at something
 *   SyncRef<INodeValueOutput<T>> X     that produces a value, never at an action
 *                                      node's own component id
 *   NodeObjectOutput<T> X              this node's OWN output. It exists to be
 *   NodeValueOutput<T> X               addressed by FIELD id; its own value in
 *                                      the file is null
 *
 * That last distinction is the one this project keeps rediscovering: a node's
 * data output is its component id, but a NAMED output like `GET_String.Content`
 * is a field id, and wiring the component id instead reads the action node's own
 * value - which for an action node is nothing at all.
 */
const kindCache = new Map();
export function memberKinds(classpath) {
  if (kindCache.has(classpath)) return kindCache.get(classpath);
  const kinds = new Map();
  const first = parseClasspath(classpath);
  let name = first.name, nested = first.nested;
  const seen = new Set();
  // Walk up the base chain: `Next` and the request impulses are declared on a
  // base, not on the leaf.
  while (name && !seen.has(name)) {
    seen.add(name);
    // The BINDING is the authority. The runtime class beside it declares the
    // same ports with different C# types (ObjectInput<T> rather than
    // SyncRef<INodeObjectOutput<T>>), and only the binding is what a package
    // actually contains.
    const file = sourceFiles(name).find((f) => f.includes('/ProtoFluxBindings/'))
      || sourceFiles(name).find((f) => f.includes('/ProtoFlux'));
    if (!file) break;
    let body = readFileSync(file, 'utf8');
    if (nested) {
      const i = body.indexOf(`class ${nested}`);
      if (i >= 0) body = body.slice(i);
      nested = null;
    }
    for (const m of body.matchAll(/public (?:new )?readonly ([A-Za-z]+<[^;]*?>|[A-Za-z]+)\s+([A-Za-z_][A-Za-z0-9_]*);/g)) {
      const [, decl, member] = m;
      if (kinds.has(member)) continue;
      kinds.set(member,
        /^SyncRef(List)?<I(Sync)?NodeOperation>$/.test(decl) ? 'impulse'
          : /^SyncRef<INode(Object|Value)(Output|List|ListOutput)</.test(decl) ? 'data'
            : /^Node(Object|Value)Output</.test(decl) ? 'output' : 'sync');
    }
    name = baseOf(body, name);
  }
  kindCache.set(classpath, kinds);
  return kinds;
}

/** The binding's base chain, leaf first. */
export function baseChain(classpath) {
  const out = [];
  let { name } = parseClasspath(classpath);
  const seen = new Set();
  while (name && !seen.has(name)) {
    seen.add(name);
    out.push(name);
    const file = sourceFiles(name).find((f) => f.includes('/ProtoFluxBindings/'))
      || sourceFiles(name).find((f) => f.includes('/ProtoFlux'));
    if (!file) break;
    const body = readFileSync(file, 'utf8');
    name = baseOf(body, name);
  }
  return out;
}

/**
 * Can this node be RUN? Only an operation may sit on the far end of an impulse
 * wire, and only a non-operation may sit on the far end of a data wire - an
 * action node's component id carries no value, which is why a named output like
 * `GET_String.Content` has to be addressed by its field id instead.
 */
export const isOperation = (classpath) =>
  baseChain(classpath).some((n) => /^(Action|AsyncAction)(Node|FlowNode|BreakableFlowNode)$/.test(n));
