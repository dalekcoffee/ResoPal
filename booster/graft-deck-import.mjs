#!/usr/bin/env node
/**
 * Graft the deck-import branch into the panel the owner hand-packed.
 *
 * This is the SHIPPING path, and it is a graft rather than a rebuild for the
 * reason docs/HANDOFF.md gives and this run re-measured: the packed panel is 100
 * logic nodes and 16 relays, a fresh `build-panel.mjs` is 101 and 111. The
 * autorouter sprays a relay at almost every wire, so rebuilding would hand back
 * a canvas six times as tangled as the one he cleaned - 212 nodes, 576 pairs of
 * overlapping node visuals, and 226 wires crossing a wired node against a budget
 * of 30. The HANDOFF's "the builder reproduces the shipped panel" note predates
 * the router and is no longer true; it is corrected there.
 *
 * So the builder stays upstream and this moves its output in. Three things go
 * into the file, each of which can be checked on its own:
 *
 *  1. **The missing loop-back `StartAsyncTask`.** The packed panel has two async
 *     wrappers where the builder has three, and the one it is missing is the one
 *     that closes the spawn loop. `DelayUpdates` is an `AsyncActionNode`, so
 *     re-entering it from `eat that record`'s synchronous continuation runs
 *     nothing at all: in-world the first record spawns a card and every record
 *     after it dies with no error anywhere. `verify-classpaths.mjs` fails the
 *     shipped file on exactly this, and has done since the builder was fixed.
 *
 *  2. **The deck-import branch** (`deck-import.mjs`), wired into the existing
 *     "all cards placed" write, at x >= 14.3 on his own row Ys.
 *
 *  3. **A `Decks` slot** for deck duplicates to land under, beside `Cards`.
 *
 * The deck TEMPLATE is a separate step and a separate file: run `graft-deck.mjs`
 * on the output of this, or this on the output of that - they touch different
 * things and either order works. `npm run graft:import` does both, in order.
 *
 *   node booster/graft-deck-import.mjs [panel=out/ResoPal_Panel.resonitepackage]
 *                                      [out=out/ResoPal_Panel_DeckImport.resonitepackage]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { allocator } from './splice.mjs';
import { memberOrder, isFluxNode } from './members.mjs';
import { deckImport, COL_X } from './deck-import.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { Int32, Long } = require('bson');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const ROOT = path.resolve(import.meta.dirname, '..');
const RKL = process.env.RKL || path.resolve(ROOT, '..', 'Resonite-Knowledge-Library');
const codec = path.join(RKL, 'protoflux', 'skill', 'scripts', 'decode.mjs');
if (!existsSync(codec)) throw new Error(`No ${codec}. Set RKL=<knowledge library checkout>.`);
const { frdtToBsonBytes, bsonBytesToFrdt, deserializeBson, serializeBson } = await import(`file://${codec}`);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)];
}));
const PANEL = args.panel || path.join(import.meta.dirname, 'out', 'ResoPal_Panel.resonitepackage');
const OUT = args.out || path.join(import.meta.dirname, 'out', 'ResoPal_Panel_DeckImport.resonitepackage');

const zip = await JSZip.loadAsync(await readFile(PANEL));
const record = JSON.parse(await zip.file('R-Main.record').async('string'));
const oldHash = String(record.assetUri).replace(/^@?packdb:\/\/\//, '');
const doc = await deserializeBson(await frdtToBsonBytes(new Uint8Array(await zip.file(`Assets/${oldHash}`).async('uint8array'))));

const nm = (s) => String(s?.Name?.Data ?? '');
const idx = (v) => (v && typeof v === 'object') ? (v.value ?? v.valueOf?.() ?? v) : v;
const short = (t) => String(t).replace(/^.*Nodes\./, '').replace(/^.*CoreNodes\./, '');

// ── an emitter kit over a document that already exists ───────────────────────
// The same shapes `build-panel.mjs` writes, but allocating out of THIS document's
// id space and appending to THIS document's `Types` table. Everything else about
// a node - member order above all - comes from `members.mjs`, so a grafted node
// is byte-shaped like a built one.
const nextId = allocator(doc);
const typeIndex = (name) => {
  let i = doc.Types.indexOf(name);
  if (i < 0) { i = doc.Types.length; doc.Types.push(name); }
  return new Int32(i);
};
const D = (n) => (typeof n === 'number' ? new (require('bson').Double)(n) : n);
const fd = (data) => ({ ID: nextId(), Data: data });
const fi = (n) => ({ ID: nextId(), Data: new Int32(n) });

function comp(classpath, fields = {}) {
  const id = nextId();
  const data = { ID: id, 'persistent-ID': nextId(), UpdateOrder: fi(0), Enabled: fd(true) };
  const f = {};
  const put = (k, v) => { const w = fd(v); data[k] = w; f[k] = w.ID; };
  const order = memberOrder(classpath, 'component');
  if (order) {
    const body = order.slice(3);
    for (const k of Object.keys(fields))
      if (!body.includes(k)) throw new Error(`${classpath} has no member "${k}" (has ${body.join(', ')})`);
    // Every member of a flux node is emitted, unwired ones as null: they are all
    // ports, and a port that is not in the file is a port the graph cannot resolve.
    for (const k of body)
      if (k in fields) put(k, fields[k]);
      else if (isFluxNode(classpath)) put(k, null);
  } else {
    for (const [k, v] of Object.entries(fields)) put(k, v);
  }
  return { comp: { Type: typeIndex(classpath), Data: data }, id, f };
}
function slot(name, components = [], pos = [0, 0, 0], children = [], tag = null) {
  return {
    ID: nextId(),
    Components: { ID: nextId(), Data: components },
    Name: fd(name), Tag: fd(tag), Active: fd(true), 'Persistent-ID': nextId(),
    Position: fd(pos.map(D)), Rotation: fd([0, 0, 0, 1].map(D)), Scale: fd([1, 1, 1].map(D)),
    OrderOffset: { ID: nextId(), Data: Long.fromNumber(0) }, ParentReference: null, Children: children,
  };
}

const PB = '[ProtoFluxBindings]FrooxEngine.ProtoFlux.Runtimes.Execution.Nodes.';
const FE = '[FrooxEngine]FrooxEngine.';
const T = {
  If: PB + 'If',
  Dup: PB + 'FrooxEngine.Slots.DuplicateSlot',
  ClearKids: PB + 'FrooxEngine.Slots.DestroySlotChildren',
  ChildCount: PB + 'FrooxEngine.Slots.ChildrenCount',
  GetChild: PB + 'FrooxEngine.Slots.GetChild',
  SetParent: PB + 'FrooxEngine.Slots.SetParent',
  FindChild: PB + 'FrooxEngine.Slots.FindChildByName',
  StartAsync: PB + 'FrooxEngine.Async.StartAsyncTask',
  DelayFrames: PB + 'FrooxEngine.Async.DelayUpdates',
  IntGt: PB + 'Operators.ValueGreaterThan<int>',
  StrIn: PB + 'ValueObjectInput<string>',
  IntIn: PB + 'ValueInput<int>',
  BoolIn: PB + 'ValueInput<bool>',
  FlowRelay: PB + 'ContinuationRelay',
  // Relays for every stream the branch carries. `ObjectRelay<T>` is unconstrained;
  // `ValueRelay<T>` is `where T : unmanaged`, which int and bool satisfy and a
  // reference type would not - the same constraint that made
  // WriteDynamicValueVariable<string> impossible.
  SlotRelay: PB + 'ObjectRelay<[FrooxEngine]FrooxEngine.Slot>',
  StrRelay: PB + 'ObjectRelay<string>',
  IntRelay: PB + 'ValueRelay<int>',
  BoolRelay: PB + 'ValueRelay<bool>',
  WriteVar: PB + 'FrooxEngine.Variables.WriteDynamicObjectVariable<string>',
  // `bool` is unmanaged, so unlike the string form this generic really exists.
  WriteBoolVar: PB + 'FrooxEngine.Variables.WriteDynamicValueVariable<bool>',
  SlotIn: '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.SlotSource',
  SlotRef: FE + 'ProtoFlux.GlobalReference<[FrooxEngine]FrooxEngine.Slot>',
};

const emitted = [];
const kit = {
  T,
  node(name, classpath, fields = {}, pos = [0, 0, 0]) {
    const c = comp(classpath, fields);
    const n = { slot: slot(name, [c.comp], pos), id: c.id, f: c.f, pos, classpath };
    emitted.push(n); return n;
  },
  // Pointing a node at a slot takes two components on one slot: the source node,
  // and a GlobalReference holding the actual target.
  refNode(name, targetSlotId, pos) {
    const ref = comp(T.SlotRef, { Reference: targetSlotId });
    const src = comp(T.SlotIn, { Source: ref.id });
    const n = { slot: slot(name, [src.comp, ref.comp], pos), id: src.id, f: src.f, pos, classpath: T.SlotIn };
    emitted.push(n); return n;
  },
  strIn: (name, v, pos) => kit.node(name, T.StrIn, { Value: v }, pos),
  intIn: (name, v, pos) => kit.node(name, T.IntIn, { Value: new Int32(v) }, pos),
  boolIn: (name, v, pos) => kit.node(name, T.BoolIn, { Value: v }, pos),
};

// ── find what the branch has to reach in the packed panel ────────────────────
const canvas = (doc.Object.Children || []).find((s) => String(s.Tag?.Data ?? '') === 'Moduprint.ProtoFlux');
if (!canvas) throw new Error('no Moduprint.ProtoFlux canvas in the panel');

const cardsSlot = (doc.Object.Children || []).find((s) => nm(s) === 'Cards');
if (!cardsSlot) throw new Error('no Cards slot on the panel root');

// A deck is a metre-wide object; it does not belong in the grid the loose cards
// land on, so it gets its own slot beside it rather than sharing that parent.
const decksSlot = slot('Decks', [], [0, -0.22, -0.25]);
doc.Object.Children.push(decksSlot);

const nodeOf = (s) => ({ slot: s, type: String(doc.Types[idx(s.Components?.Data?.[0]?.Type ?? 0)]), data: s.Components?.Data?.[0]?.Data });
const nodes = (canvas.Children || []).filter((s) => nm(s) !== 'Meta: Comments').map(nodeOf);
const byName = (n) => nodes.find((x) => nm(x.slot) === n);

// The branch hangs off the write that says "all cards placed" - the only place in
// the graph that knows the import has finished. All THREE outcomes continue into
// it, the way the response landings do: a panel that cannot write its own event
// line has still imported the deck, and dropping the deck because a readout
// failed would be the same defect that once orphaned the whole spawn zone.
const donePlaced = nodes.find((x) => /WriteDynamicObjectVariable/.test(x.type) &&
  String(byName2(x, 'Value'))?.includes('all cards placed'));
function byName2(x, field) {
  const id = x.data?.[field]?.Data;
  const src = nodes.find((y) => y.data?.ID === id);
  return src?.data?.Value?.Data;
}
if (!donePlaced) throw new Error('cannot find the "all cards placed" write to hang the branch off');

// ── 1. the loop-back StartAsyncTask the packed file is missing ───────────────
// `eat that record` continues round the loop and lands, through relays, on the
// `DelayUpdates` at the top of it. That node is async and cannot be re-entered
// from a synchronous continuation, so the wrapper goes in between, exactly where
// `build-panel.mjs` puts it.
const eat = byName('eat that record');
if (!eat) throw new Error('cannot find "eat that record"');
let asyncAdded = 0;
{
  const reachesDelay = (startId, depth = 12) => {
    let cur = nodes.find((x) => x.data?.ID === startId);
    for (let i = 0; cur && i < depth; i++) {
      if (/DelayUpdates/.test(cur.type)) return true;
      if (/StartAsyncTask/.test(cur.type)) return false;
      const nxt = ['Next', 'TaskStart'].map((f) => cur.data?.[f]?.Data).find((v) => typeof v === 'string');
      cur = nodes.find((x) => x.data?.ID === nxt);
    }
    return false;
  };
  const onWritten = eat.data.OnWritten?.Data;
  if (onWritten && reachesDelay(onWritten)) {
    // Parked directly under `eat` on his own grid, so the inserted node reads as
    // part of the run it belongs to rather than as something dropped in.
    const p = eat.slot.Position.Data.map(Number);
    const wrap = kit.node('and again, asynchronously', T.StartAsync,
      { TaskStart: onWritten, OnStarted: null, OnFailed: null }, [p[0], p[1] - 0.3, 0]);
    eat.data.OnWritten.Data = wrap.id;
    asyncAdded = 1;
  }
}

// ── 2. the branch ────────────────────────────────────────────────────────────
// `deckTemplate` is left null here and filled in by `graft-deck.mjs`, which is
// what knows the id the deck lands on. A null GlobalReference is an unbound
// external hook, not a dangling one - the builder reports them the same way.
const { nodes: branch, entryId } = deckImport(kit, {
  panelCards: cardsSlot.ID,
  deckTemplate: null,
  decksHolder: decksSlot.ID,
});
for (const k of ['OnSuccess', 'OnNotFound', 'OnFailed'])
  if (donePlaced.data[k]) donePlaced.data[k].Data = entryId;

// ── why there is no autorouter pass here ─────────────────────────────────────
// The house style says to emit logic wired straight to its producers and let the
// autorouter place every relay (protoflux/pretty-flux.md 0), and that was tried.
// It made this branch worse, twice: 32 relays and 98 wires through node boxes at
// his 0.36 column pitch, 33 and 85 at double it, against 46 for the same graph
// left unrouted. A router needs empty lanes between the boxes to thread, and a
// branch bolted onto the right-hand edge of a full canvas has almost none.
//
// So the positions in `deck-import.mjs` are the routing. They were hill-climbed
// against this file's own crossing test rather than eyeballed - constants into
// gutter columns, leaf producers duplicated beside their consumers instead of
// wired across the zone - and they measure 0 wires through a constant and 2
// through a wired node, where the hand placement they replaced had 12 and 18 and
// the routed one 30-odd. The owner's own graph carries 16.

canvas.Children.push(...emitted.map((n) => n.slot));

// ── 3. a comment zone around it ──────────────────────────────────────────────
// Moduprint zone encoding, per protoflux/pretty-flux.md section 4: one
// float3x3 whose rows are [anchor], [signed size (+w,-h)], [(1,0,0)], paired in
// order with a string title. It is computed from where the nodes ACTUALLY sit,
// which is the whole reason the branch has fixed coordinates.
{
  const meta = (canvas.Children || []).find((s) => nm(s) === 'Meta: Comments');
  if (!meta) throw new Error('no Meta: Comments slot on the canvas');
  const HALF_W = 0.15, HALF_H = 0.075, PAD = 0.08, HEAD = 0.14;
  // The branch only. The loop-back wrapper inserted above is grafted too, but it
  // belongs to zone 3 and sits at x ~9.5; measuring the rectangle over everything
  // emitted stretched zone 5 back across the middle of his canvas.
  const xs = branch.map((n) => n.pos[0]), ys = branch.map((n) => n.pos[1]);
  const x = Math.min(...xs) - HALF_W - PAD, x1 = Math.max(...xs) + HALF_W + PAD;
  const yHi = Math.max(...ys) + HALF_H + PAD + HEAD, yLo = Math.min(...ys) - HALF_H - PAD;
  const n = meta.Components.Data.length;
  meta.Components.Data.push(comp(FE + 'DynamicValueVariable<float3x3>', {
    VariableName: `Moduprint/Zone/${n}`,
    Value: [[x, yHi, 0], [x1 - x, -(yHi - yLo), 0], [1, 0, 0]].map((r) => r.map(D)),
    OverrideOnLink: false,
  }).comp);
  meta.Components.Data.push(comp(FE + 'DynamicValueVariable<string>', {
    VariableName: `Moduprint/ZoneLabel/${n + 1}`, Value: '5 · a big import goes in a deck holder', OverrideOnLink: false,
  }).comp);
  console.log(`  zone 5   x ${x.toFixed(2)} .. ${x1.toFixed(2)}   y ${yHi.toFixed(2)} .. ${yLo.toFixed(2)}`);
}

// ── write ────────────────────────────────────────────────────────────────────
const newFrdt = Buffer.from(await bsonBytesToFrdt(await serializeBson(doc)));
const newHash = sha256(newFrdt);
const out = new JSZip();
for (const [n, f] of Object.entries(zip.files)) {
  if (f.dir || n === 'R-Main.record' || n === `Assets/${oldHash}`) continue;
  out.file(n, await f.async('nodebuffer'));
}
out.file(`Assets/${newHash}`, newFrdt);
record.assetUri = `packdb:///${newHash}`;
record.assetManifest = [
  ...record.assetManifest.filter((e) => e.hash !== oldHash),
  { hash: newHash, bytes: newFrdt.length },
];
out.file('R-Main.record', JSON.stringify(record));
await mkdir(path.dirname(OUT), { recursive: true });
const bytes = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(OUT, bytes);

const total = (canvas.Children || []).filter((s) => nm(s) !== 'Meta: Comments').length;
console.log(`\n✓ ${OUT}`);
console.log(`  ${emitted.length} nodes grafted (${asyncAdded ? '1 of them the missing loop-back StartAsyncTask' : 'loop-back wrapper already present'})`);
console.log(`  canvas ${total - emitted.length} -> ${total} nodes, branch logic at x >= ${COL_X[0]}`);
console.log(`  hooks: panel Cards ${cardsSlot.ID.slice(0, 8)}, Decks ${decksSlot.ID.slice(0, 8)}, deck template unbound until graft-deck\n`);
