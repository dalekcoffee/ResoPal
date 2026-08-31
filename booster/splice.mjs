// Moving a subtree from one .resonitepackage document into another.
//
// Every id in a document is local to it, and so is every entry in its `Types`
// table, so a slot cannot simply be appended to another document's tree. These are
// the pieces that make it safe, factored out because two builders need them and a
// second copy would drift.
//
// The rules each encode a bug that has already been paid for; see docs/PIPELINE.md.

/**
 * A key whose value DECLARES an id rather than referencing one.
 *
 * There is more than one spelling, and missing any of them duplicates an id: `ID`
 * on components and fields, `persistent-ID` on a component's persistence flag,
 * `Persistent-ID` and `ParentReference` on slots, and a `<name>-ID` form for a
 * type's private fields - `UnlitMaterial` alone carries `_shader-ID`, `_unlit-ID`,
 * `_unlitBillboard-ID` and `__legacyZWrite-ID`. Remapping only `ID` and
 * `persistent-ID` left every material clone sharing the original's `_unlit-ID`.
 */
export const isDeclarationKey = (k) => k === 'ID' || k === 'ParentReference' || /-ID$/i.test(k);

/**
 * Deep clone that leaves BSON's typed wrappers alone. They are immutable and only
 * ever replaced wholesale, so sharing the instances is safe; running them through
 * a structural clone is what loses their type, and a Double that becomes a plain
 * number re-serializes as the wrong BSON type.
 */
export const dclone = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dclone);
  const c = v.constructor?.name;
  if (c === 'Int32' || c === 'Double' || c === 'Long' || c === 'Binary' || c === 'Date') return v;
  const o = {};
  for (const [k, val] of Object.entries(v)) o[k] = dclone(val);
  return o;
};

/**
 * An id allocator that starts clear of everything a document already uses.
 *
 * The high-water mark counts REFERENCES as well as declarations: a reference names
 * a real id, and an id that is only ever referenced still occupies the space.
 */
export function allocator(doc, gap = 0x1000) {
  let high = 0;
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        const m = /^([0-9a-f]{8})-0000-0000-0000-000000000000$/.exec(v);
        if (m) high = Math.max(high, parseInt(m[1], 16));
      } else w(v);
    }
  })(doc);
  let next = high + gap;
  const fn = () => `${(++next).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
  fn.start = high + gap + 1;
  return fn;
}

/**
 * Clone a node - a component entry, a slot, or a GROUP of them - giving every id
 * declared inside a fresh one and rewriting references that point at those. A
 * reference OUT of the clone is left pointing where it pointed, so the caller
 * decides what to re-point.
 *
 * Clone things that reference each other in ONE call. Cloning them separately
 * gives each its own id map, so cross-references keep the SOURCE document's ids -
 * and where the two documents' id ranges overlap, those land on real but unrelated
 * components. Nothing dangles and the graph is wired to the wrong things.
 *
 * Equally, never pass the same node twice in one call: one map keyed by old id
 * maps each to one new id, so both copies come out identical.
 */
export function cloneNode(node, newId) {
  const copy = dclone(node);
  const map = new Map();
  (function declare(o) {
    if (Array.isArray(o)) return o.forEach(declare);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && isDeclarationKey(k) && !map.has(v)) map.set(v, newId());
      else declare(v);
    }
  })(copy);
  (function rewrite(o) {
    if (Array.isArray(o)) return o.forEach(rewrite);
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string' && map.has(v)) o[k] = map.get(v);
      else rewrite(v);
    }
  })(copy);
  return copy;
}

/**
 * Map a type index from one document's `Types` table into another's, appending
 * where absent and carrying the source's `TypeVersions` entry with it.
 *
 * Matching is by EXACT string, never substring. `UnlitMaterial` is a substring of
 * `UI_UnlitMaterial`, and a deck's `GlobalReference<Slot>` is a different type from
 * `GlobalReference<IValue<string>>` - CLAUDE.md's "a classpath is a path, not a
 * name", one level down.
 */
export function typeMapper(into, from) {
  const appended = [];
  const map = (sourceIndex) => {
    const name = String(from.Types[sourceIndex]);
    let i = into.Types.indexOf(name);
    if (i < 0) {
      i = into.Types.length;
      into.Types.push(name);
      appended.push(name);
      const v = from.TypeVersions?.[name];
      if (v !== undefined) (into.TypeVersions ??= {})[name] = v;
    }
    return i;
  };
  map.appended = appended;
  return map;
}
