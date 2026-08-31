// Build the ResoPal in-world panel: a UIX panel whose buttons fetch a deck or a
// booster pull from resopal and lay the cards out in front of you.
//
// Three builds' worth of lessons are baked in here:
//
//  1. There must be something to look at before any network call succeeds. The
//     first build was logic-only ProtoFlux and showed nothing.
//  2. Node positions must clear a real node visual. The first build spaced them
//     at about a third of one and unpacked into a heap.
//  3. A classpath that reads plausibly is not a classpath that exists. The second
//     build emitted `WriteDynamicValueVariable<string>`, which cannot exist -
//     that node is declared `where T : unmanaged` - so every button did nothing.
//  4. GET_String and RequestHostAccessUrl are both `AsyncActionNode`. An ordinary
//     impulse cannot run one: the chain has to pass through a StartAsyncTask
//     first, or they simply never execute. There is exactly one, right after the
//     buttons join, so everything downstream of it is async-capable.
//  5. A constant must not sit in the lane between two nodes that wire to each
//     other. The URL constants used to sit between the receiver and the write,
//     so the impulse wire ran straight through a node box and read as
//     unconnected (pretty-flux section 2).
//
// `verify-classpaths.mjs` gates 3 and 4; `test-panel.mjs` gates 5.
//
// The graph is split across TWO Moduprint canvases on purpose. Everything a human
// needs in order to read or debug this lives in `Flux - control`, which is about
// thirty nodes. The seventy card decoders are a generated array and live in
// `Flux - card decoders`, so unpacking the control canvas stays fathomable.
//
// Nothing about a deck is baked in. The panel knows five URLs; the card art,
// how many cards there are and what order they come in all arrive over the wire.
//
//   RKL=/path/to/Resonite-Knowledge-Library node build-panel.mjs
//
// Every classpath and field shape was read out of a real decoded package - mostly
// the owner's own WS_Connector panel - or the decompiled engine. None is guessed.

import { Int32 } from 'bson';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { memberOrder, isFluxNode, haveSource } from './members.mjs';
import { asUrl } from './urlmarker.mjs';
import { deckImport } from './deck-import.mjs';

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const encoder = path.join(RKL, 'protoflux', 'skill', 'scripts', 'protoflux.mjs');
if (!existsSync(encoder)) {
  console.error(`Cannot find the ProtoFlux encoder at:\n  ${encoder}\n\n` +
    `Clone the Resonite Knowledge Library and point RKL at it:\n` +
    `  RKL=/path/to/Resonite-Knowledge-Library node booster/build-panel.mjs\n`);
  process.exit(1);
}
const { ProtoFlux } = await import(`file://${encoder}`);

// ── configuration ────────────────────────────────────────────────────────────
const PROXY = process.env.PROXY || 'https://resopal-proxy.dalek.workers.dev';
const LOGO = process.env.LOGO || 'https://resopal.dalek.coffee/assets/logo.png';

// The response is one art URL per line. `format=fixed` pads each record to a
// fixed width, which the old constant-offset decoder needed; this one does not -
// it walks to the next newline and trims - but the padding is harmless and the
// format is already documented, tested and cacheable, so it stays.
//
// IMPORTED from the Worker rather than restated. It was written here as a
// literal 64 and the Worker moved to 80, so the status line's Substring cut the
// first record at 64 characters and showed a truncated URL. Nothing failed: the
// loop walks newlines and never reads this, so only the readout was wrong, and
// only for URLs longer than 64. There is one definition of the width now.
const { RECORD_WIDTH } = await import('../worker/src/roll.js');

const BUTTONS = [
  { tag: 'deck/td01', label: 'Trial Deck  ·  Red / Blue',     url: `${PROXY}/api/deck?deck=td01&format=fixed` },
  { tag: 'deck/td02', label: 'Trial Deck  ·  Green / Purple', url: `${PROXY}/api/deck?deck=td02&format=fixed` },
  // ONE pack in-world, where the site offers 3 and 10. A pull spawns a card per
  // record, each fetching its own texture, and a world full of people opening
  // ten packs at once is seventy simultaneous texture loads per person. The site
  // has no such problem - it is one browser, and the cards are already in an
  // atlas. Ten packs there, one here.
  { tag: 'pack/1',    label: 'Open 1 Booster  ·  BP01',       url: `${PROXY}/api/pull?set=BP01&packs=1&format=fixed` },
];

// The paste field POSTs whatever is in it. The Worker decides whether that was a
// palify.org deck link, a bare deck id or a pasted decklist - see
// worker/src/resolve.js - so the panel does not have to know, and does not have
// to parse a decklist in ProtoFlux.
const RESOLVE = `${PROXY}/api/resolve?format=fixed`;

// The grid the cards land in. There is no card ceiling in the graph any more:
// cards are duplicated from a template as records arrive, so the count is
// whatever came back. This is only how wide a row is before it wraps.
const COLS = 10;
const CARD_W = 0.063, CARD_H = 0.088, GAP = 0.008;
const PITCH_X = CARD_W + GAP, PITCH_Y = CARD_H + GAP;

const CANVAS_W = 620, CANVAS_H = 660, CANVAS_SCALE = 0.00058;

const hex = (h, a = 1) => [...h.match(/[\da-f]{2}/gi).map((c) => parseInt(c, 16) / 255), a];
const GOLD = hex('c8a35e'), INK = hex('12100c'), PANEL = hex('1c1913');
const BTN = hex('2a251b'), BTN_HI = hex('3d3626'), BTN_PRESS = hex('c8a35e');
const CYAN = hex('4fd8e8'), TEXT = hex('e8e2d4'), DIM = hex('8a8272');

// ── verbatim classpaths ──────────────────────────────────────────────────────
const PB = '[ProtoFluxBindings]FrooxEngine.ProtoFlux.Runtimes.Execution.Nodes.';
const FE = '[FrooxEngine]FrooxEngine.';
const UIX = FE + 'UIX.';
const T = {
  // No IsHostAccessAllowedUrl / RequestHostAccessUrl here on purpose.
  // WebRequestBase.RunAsync asks for permission itself, at scope HTTP, before it
  // sends - so a pre-gate is a second way to fail for a prompt the user gets
  // anyway. The cost is the prompt saying "Web Request Node" rather than naming
  // ResoPal. See booster/PRIOR-ART.md section 1.
  Get:         PB + 'FrooxEngine.Network.GET_String',
  If:          PB + 'If',
  // NOT `Nodes.StartAsyncTask` - there is no such class. The one that exists is
  // `Nodes.FrooxEngine.Async.StartAsyncTask`, and the wrong path cost three dead
  // red nodes in-world: the requests and the loop had nothing that could run
  // them. `verify-classpaths.mjs` was blind to it because it looked the class up
  // by LEAF NAME, so a file three namespaces away answered for it. It now
  // requires the file to sit exactly where the namespace says.
  StartAsync:  PB + 'FrooxEngine.Async.StartAsyncTask',
  Post:        PB + 'FrooxEngine.Network.POST_String',
  // Spawning. DuplicateSlot copies the template slot AND the ProtoFlux inside
  // it, rewiring the copy's internal references - which is why one card
  // template replaces seventy pre-baked decoders.
  Dup:         PB + 'FrooxEngine.Slots.DuplicateSlot',
  ClearKids:   PB + 'FrooxEngine.Slots.DestroySlotChildren',
  IndexOfChild: PB + 'FrooxEngine.Slots.IndexOfChild',
  // The deck-import branch. `WriteDynamicValueVariable<T>` is `where T : unmanaged`
  // - bool satisfies that where string does not, which is why the string write
  // beside it has to be the Object form.
  ChildCount:  PB + 'FrooxEngine.Slots.ChildrenCount',
  GetChild:    PB + 'FrooxEngine.Slots.GetChild',
  SetParent:   PB + 'FrooxEngine.Slots.SetParent',
  FindChild:   PB + 'FrooxEngine.Slots.FindChildByName',
  BoolIn:      PB + 'ValueInput<bool>',
  WriteBoolVar: PB + 'FrooxEngine.Variables.WriteDynamicValueVariable<bool>',
  SetPos:      PB + 'FrooxEngine.Transform.SetLocalPosition',
  DelayFrames: PB + 'FrooxEngine.Async.DelayUpdates',
  IndexOf:     PB + 'Strings.IndexOfString',
  IntInc:      PB + 'Operators.ValueInc<int>',
  IntMod:      PB + 'Operators.ValueMod<int>',
  IntDiv:      PB + 'Operators.ValueDiv<int>',
  IntToFloat:  PB + 'Casts.Cast_int_To_float',
  FloatMul:    PB + 'Operators.ValueMul<float>',
  FloatIn:     PB + 'ValueInput<float>',
  PackF3:      PB + 'Operators.Pack_Float3',
  // A local variable: the node is the value, the +Store proxy holds it. This is
  // what makes the parse loop possible - the response is written back over
  // itself, minus the record just consumed, so there is no cursor to walk off
  // the end of.
  Store:       PB + 'FrooxEngine.Variables.DataModelObjectFieldStore<string>',
  StoreProxy:  '[ProtoFlux.Nodes.FrooxEngine]ProtoFlux.Runtimes.Execution.Nodes.FrooxEngine.Variables.DataModelObjectFieldStore<string>+Store',
  StoreWrite:  PB + 'ObjectWrite<[FrooxEngine]FrooxEngine.ProtoFlux.FrooxEngineContext,string>',
  // Pointing a node at a slot or a field takes two components on one slot: the
  // node, and a GlobalReference holding the actual target.
  SlotIn:      '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.SlotSource',
  SlotRef:     FE + 'ProtoFlux.GlobalReference<[FrooxEngine]FrooxEngine.Slot>',
  StrSource:   '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectValueSource<string>',
  StrSourceRef: FE + 'ProtoFlux.GlobalReference<[FrooxEngine]FrooxEngine.IValue<string>>',
  // The response's HTTP code, for the event line. GET_String only writes the
  // exception message into Content on a TRANSPORT error; a 404 or a 500 is a
  // perfectly successful request with a body that is not cards, and without
  // this the panel shows you the first 64 characters of an error page.
  StatusCast:  PB + 'Casts.ValueToObjectCast<HttpStatusCode>',
  Format:      PB + 'Strings.FormatString',
  StrIn:       PB + 'ValueObjectInput<string>',
  IntIn:       PB + 'ValueInput<int>',
  Substr:      PB + 'Strings.Substring',
  Trim:        PB + 'Strings.TrimString',
  StrLen:      PB + 'Strings.StringLength',
  ToUri:       PB + 'Utility.Uris.StringToAbsoluteURI',
  IntGt:       PB + 'Operators.ValueGreaterThan<int>',
  StrPick:     PB + 'ObjectConditional<string>',
  StrRelay:    PB + 'ObjectRelay<string>',
  IntRelay:    PB + 'ValueRelay<int>',
  FlowRelay:   PB + 'ContinuationRelay',
  Receiver:    PB + 'Actions.DynamicImpulseReceiver',
  ReceiverProxy: '[ProtoFlux.Nodes.FrooxEngine]ProtoFlux.Runtimes.Execution.Nodes.Actions.DynamicImpulseReceiver+Proxy',
  // NOT WriteDynamicValueVariable<string>: that node is `where T : unmanaged`,
  // so the string form cannot exist. This is the object variant, and emitting
  // the wrong one is what made every button dead.
  WriteVar:    PB + 'FrooxEngine.Variables.WriteDynamicObjectVariable<string>',
  GlobalStr:   FE + 'ProtoFlux.GlobalValue<string>',
  UriDrive:      '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectFieldDrive<Uri>',
  UriDriveProxy: FE + 'ProtoFlux.CoreNodes.FieldDriveBase<Uri>+Proxy',
  StrDrive:      '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectFieldDrive<string>',
  StrDriveProxy: FE + 'ProtoFlux.CoreNodes.FieldDriveBase<string>+Proxy',
  BoolDrive:     '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ValueFieldDrive<bool>',
  BoolDriveProxy: FE + 'ProtoFlux.CoreNodes.FieldDriveBase<bool>+Proxy',
  Grabbable: FE + 'Grabbable',
  ObjectRoot: FE + 'ObjectRoot',
  VarSpace: FE + 'DynamicVariableSpace',
  StrVar: FE + 'DynamicValueVariable<string>',
  F3x3Var: FE + 'DynamicValueVariable<float3x3>',
  VarDriver: FE + 'DynamicValueVariableDriver<string>',
  BoxCollider: FE + 'BoxCollider',
  QuadMesh: FE + 'QuadMesh',
  MeshRenderer: FE + 'MeshRenderer',
  Unlit: FE + 'UnlitMaterial',
  Texture: FE + 'StaticTexture2D',
  FontChain: FE + 'FontChain',
  StaticFont: FE + 'StaticFont',
  UIUnlit: FE + 'UI_UnlitMaterial',
  UIText: FE + 'UI_TextUnlitMaterial',
  BtnTrigger: FE + 'ButtonDynamicImpulseTrigger',
  SpriteProvider: FE + 'SpriteProvider',
  TextField: UIX + 'TextField',
  TextEditor: FE + 'TextEditor',
  SizeDriver: FE + 'TextureSizeDriver',
  Snapper:     FE + 'Snapper',
  Swizzle:     FE + 'Float2ToFloat3SwizzleDriver',
  Canvas: UIX + 'Canvas',
  Rect: UIX + 'RectTransform',
  Image: UIX + 'Image',
  Text: UIX + 'Text',
  Button: UIX + 'Button',
  LayoutElement: UIX + 'LayoutElement',
  VerticalLayout: UIX + 'VerticalLayout',
};
const TYPE_VERSIONS = { [T.Grabbable]: 2, [T.BoxCollider]: 1 };

const pf = ProtoFlux();
const D = pf.D, I = (n) => new Int32(n);
const C = (rgba, profile = 'sRGB') => [...rgba.map(D), profile];
const V2 = (x, y) => [D(x), D(y)];
const V3 = (x, y, z) => [D(x), D(y), D(z)];

// ── builders ─────────────────────────────────────────────────────────────────
// Components on slots serialize `persistent-ID` as a bare id; entries in
// doc.Assets serialize `persistent` as a wrapped bool. Both are verbatim from
// real packages, and mixing them up is a silent load failure.
//
// MEMBERS ARE EMITTED IN THE ORDER THE CLASS DECLARES THEM, always. This is not
// cosmetic. Written in the order the builder happened to list them, the panel
// encoded cleanly, validated with zero dangling references, and in-world every
// node was red with wires on the wrong ports: `If` went out as
// {Condition, OnTrue, OnFalse} where the class declares {OnTrue, OnFalse,
// Condition}, and `GET_String` declares `Content` LAST - it comes from a
// subclass, after the base's impulses - so emitting it fifth shifted every
// impulse output by one. `members.mjs` reads the real order out of each class's
// own GetSyncMember switch; passing a name the class does not have is a build
// error rather than a field that silently goes nowhere.
function build(classpath, fields, kind) {
  const id = pf.nextId();
  const head = kind === 'asset'
    ? { ID: id, persistent: pf.fd(true), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) }
    : { ID: id, 'persistent-ID': pf.nextId(), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) };
  const data = head;
  const f = {};
  const put = (k, v) => { const w = pf.fd(v); data[k] = w; f[k] = w.ID; };
  const order = memberOrder(classpath, kind);
  if (order) {
    const body = order.slice(3);          // past persistent / UpdateOrder / Enabled
    for (const k of Object.keys(fields))
      if (!body.includes(k)) throw new Error(`${classpath} has no member "${k}" (has ${body.join(', ')})`);
    // A ProtoFlux node's members are all ports, so every one is declared even
    // when nothing is wired to it - an absent port is a port the graph cannot
    // resolve. A plain component keeps only what is set, because a value-typed
    // member written as null is worse than one left to its own default.
    for (const k of body)
      if (k in fields) put(k, fields[k]);
      else if (isFluxNode(classpath)) put(k, null);
  } else {
    for (const [k, v] of Object.entries(fields)) put(k, v);
  }
  return { Type: pf.typeIndex(classpath), Data: data, id, f };
}
function comp(classpath, fields = {}) {
  const b = build(classpath, fields, 'component');
  return { comp: { Type: b.Type, Data: b.Data }, id: b.id, f: b.f };
}
function asset(classpath, fields = {}) {
  const b = build(classpath, fields, 'asset');
  return { entry: { Type: b.Type, Data: b.Data }, id: b.id, f: b.f };
}
function slot(name, components = [], pos = [0, 0, 0], children = [], tag = null, id = pf.nextId(), scale = [1, 1, 1]) {
  const position = pf.fd(V3(...pos));
  const rotation = pf.fd([D(0), D(0), D(0), D(1)]);
  const sc = pf.fd(V3(...scale));
  const active = pf.fd(true);
  return {
    _slot: { id, positionFieldId: position.ID, rotationFieldId: rotation.ID, scaleFieldId: sc.ID, activeFieldId: active.ID },
    ID: id,
    Components: { ID: pf.nextId(), Data: components },
    Name: pf.fd(name), Tag: pf.fd(tag), Active: active, 'Persistent-ID': pf.nextId(),
    Position: position, Rotation: rotation, Scale: sc,
    OrderOffset: pf.longField(0), ParentReference: null, Children: children,
  };
}

// Layout units. A node visual is about 0.30 x 0.15, and the reference canvas
// runs ~0.30 cols x 0.28 rows - so neighbouring nodes very nearly abut. An
// earlier build used 0.60 columns "to leave room for the pipe" and unpacked into
// something 25 units wide with 4% of its grid occupied: a wall of empty sky with
// wires crossing it. Space is for where a wire has to pass, not a default.
const COL = 0.36, ROW = 0.26;
const NODE_HALF_W = 0.15, NODE_HALF_H = 0.075;

function node(name, classpath, fields = {}, pos = [0, 0, 0]) {
  const c = comp(classpath, fields);
  const s = slot(name, [c.comp], pos);
  return { slot: s, id: c.id, f: c.f, pos, classpath };
}
function proxyNode(name, classpath, proxyClasspath, fields = {}, pos = [0, 0, 0], extra = []) {
  const c = comp(classpath, fields);
  const p = comp(proxyClasspath, { Node: c.id, Path: [] });
  return { slot: slot(name, [c.comp, p.comp, ...extra], pos), id: c.id, f: c.f, pos, classpath };
}
const strIn = (name, s, pos) => node(name, T.StrIn, { Value: s }, pos);
const intIn = (name, n, pos) => node(name, T.IntIn, { Value: I(n) }, pos);
const strRelay = (name, src, pos) => node(name, T.StrRelay, { Input: src }, pos);
const intRelay = (name, src, pos) => node(name, T.IntRelay, { Input: src }, pos);

function drive(name, kind, sourceId, targetFieldId, pos) {
  const [cls, proxyCls] = {
    uri: [T.UriDrive, T.UriDriveProxy], str: [T.StrDrive, T.StrDriveProxy], bool: [T.BoolDrive, T.BoolDriveProxy],
  }[kind];
  const d = comp(cls, { Value: sourceId });
  const p = comp(proxyCls, { Node: d.id, Path: [], Drive: targetFieldId });
  return { slot: slot(name, [d.comp, p.comp], pos), id: d.id, pos };
}

/**
 * A Moduprint comment zone.
 *
 * Encoding per pretty-flux section 4: a `Meta: Comments` slot carrying, per zone,
 * a `DynamicValueVariable<float3x3>` whose rows are [anchor], [signed size
 * (+w,-h)], [(1,0,0)], paired in order with a `DynamicValueVariable<string>`
 * title. Zones must be disjoint - `commentZoneOverlaps` gates that, and it is
 * part of `npm test`.
 */
function zones(list) {
  const comps = [];
  for (const z of list) {
    comps.push(comp(T.F3x3Var, {
      VariableName: `Moduprint/Zone/${comps.length}`,
      Value: [V3(z.x, z.y, 0), V3(z.w, -z.h, 0), V3(1, 0, 0)],
      OverrideOnLink: false,
    }).comp);
    comps.push(comp(T.StrVar, { VariableName: `Moduprint/ZoneLabel/${comps.length}`, Value: z.title, OverrideOnLink: false }).comp);
  }
  return slot('Meta: Comments', comps, [0, 0, 0], [], 'Moduprint.Meta/ColinTheCat.Comments');
}
/** Zone rect around a set of placed nodes: pad 0.08, plus title headroom on top. */
function around(title, nodes, pad = 0.08, headroom = 0.14) {
  const xs = nodes.map((n) => n.pos[0]), ys = nodes.map((n) => n.pos[1]);
  const x = Math.min(...xs) - NODE_HALF_W - pad;
  const x1 = Math.max(...xs) + NODE_HALF_W + pad;
  const yHi = Math.max(...ys) + NODE_HALF_H + pad + headroom;
  const yLo = Math.min(...ys) - NODE_HALF_H - pad;
  return { title, x, y: yHi, w: x1 - x, h: yHi - yLo };
}

// ── the font ─────────────────────────────────────────────────────────────────
// UIX Text needs a real font asset: Text.OnAttach assigns the world default, but
// OnAttach does not run on load, so a null Font renders nothing. This is the same
// stock font the Deck Maker template already embeds, lifted from our own template.
const templateZip = await JSZip.loadAsync(await readFile(path.join(import.meta.dirname, '..', 'data', 'template.resonitepackage')));
const FONT_HASH = 'c801b8d2522fb554678f17f4597158b1af3f9be3abd6ce35d5a3112a81e2bf39';
const fontBytes = await templateZip.file(`Assets/${FONT_HASH}`).async('uint8array');
if (createHash('sha256').update(fontBytes).digest('hex') !== FONT_HASH) throw new Error('font hash mismatch');

const staticFont = asset(T.StaticFont, {
  URL: `@packdb:///${FONT_HASH}`, Padding: I(1), PixelRange: I(4), GlyphEmSize: I(32),
  MipMaps: true, MipMapFiltering: 'Box',
});
const fontChain = asset(T.FontChain, { MainFont: staticFont.id, FallbackFonts: [] });
const uiMat = asset(T.UIUnlit, {});
const textMat = asset(T.UIText, {});
const assets = [staticFont.entry, fontChain.entry, uiMat.entry, textMat.entry];

// ── UI helpers ───────────────────────────────────────────────────────────────
const rect = (opts = {}) => comp(T.Rect, {
  AnchorMin: V2(...(opts.min ?? [0, 0])), AnchorMax: V2(...(opts.max ?? [1, 1])),
  OffsetMin: V2(0, 0), OffsetMax: V2(0, 0), Pivot: V2(0.5, 0.5),
});
const image = (tint) => comp(T.Image, {
  Sprite: null, Material: uiMat.id, PreserveAspect: false, NineSliceSizing: 'TextureSize',
  FlipHorizontally: false, FlipVertically: false, InteractionTarget: true,
  FillRect: { X: D(0), Y: D(0), Width: D(1), Height: D(1) }, Tint: C(tint),
});
const text = (content, size, color, opts = {}) => comp(T.Text, {
  Font: fontChain.id, Content: content, ParseRichText: true, NullContent: null, Size: D(size),
  HorizontalAlign: opts.h ?? 'Center', VerticalAlign: opts.v ?? 'Middle', AlignmentMode: 'Geometric',
  Color: C(color), Materials: pf.list([textMat.id]), LineHeight: D(0.8), MaskPattern: null,
  HorizontalAutoSize: false, VerticalAutoSize: false, AutoSizeMin: D(8), AutoSizeMax: D(64),
  CaretPosition: I(-1), SelectionStart: I(-1),
  CaretColor: C([0, 0, 0, 0], 'Linear'), SelectionColor: C([0, 0, 0, 0], 'Linear'), InteractionTarget: false,
});
const layoutElement = (h) => comp(T.LayoutElement, {
  MinWidth: D(-1), PreferredWidth: D(-1), FlexibleWidth: D(-1),
  MinHeight: D(-1), PreferredHeight: D(h), FlexibleHeight: D(-1), Area: D(-1),
  Priority: I(1), UseZeroMetrics: false,
});
const label = (name, content, size, color, opts = {}) =>
  slot(name, [rect().comp, text(content, size, color, opts).comp]);

function bar(name, h, tint, content, size, color, extra = []) {
  return slot(name, [rect().comp, layoutElement(h).comp, image(tint).comp], [0, 0, 0],
    [label(name + ' label', content, size, color), ...extra]);
}

const logoTex = asset(T.Texture, {
  URL: asUrl(LOGO), Uncompressed: false, DirectLoad: false, ForceExactVariant: false,
  PreferredProfile: 'sRGB', MipMapBias: D(0), IsNormalMap: false,
  WrapModeU: 'Clamp', WrapModeV: 'Clamp', PowerOfTwoAlignThreshold: D(0.05),
  CrunchCompressed: true, MipMaps: true, KeepOriginalMipMaps: false, MipMapFilter: 'Box', Readable: false,
});
const logoSprite = asset(T.SpriteProvider, {
  Texture: logoTex.id, Rect: { X: D(0), Y: D(0), Width: D(1), Height: D(1) },
  Borders: [D(0), D(0), D(0), D(0)], Scale: D(1), FixedSize: D(64),
});
assets.push(logoTex.entry, logoSprite.entry);

const logoMark = () => slot('mark', [
  comp(T.Rect, { AnchorMin: V2(0.015, 0.08), AnchorMax: V2(0.14, 0.92), OffsetMin: V2(0, 0), OffsetMax: V2(0, 0), Pivot: V2(0.5, 0.5) }).comp,
  comp(T.Image, {
    Sprite: logoSprite.id, Material: uiMat.id, PreserveAspect: true, NineSliceSizing: 'TextureSize',
    FlipHorizontally: false, FlipVertically: false, InteractionTarget: false,
    FillRect: { X: D(0), Y: D(0), Width: D(1), Height: D(1) }, Tint: C([1, 1, 1, 1]),
  }).comp,
]);

/**
 * A button. The Button tints the Image on its own slot through ColorDrivers, and
 * ButtonDynamicImpulseTrigger fires a named impulse at a target hierarchy on
 * press - so button and graph never reference each other.
 *
 * `target` must be a REAL slot. It cannot be the object root: the encoder
 * reserves id 00000000-...-000000000000 for the root, which is byte-identical to
 * the null GUID, so a reference to it deserializes as null. A null Target here
 * silently falls back to broadcasting at the whole world root.
 */
function button(target, { tag, label: caption }) {
  const r = rect();
  const img = image(BTN);
  const btn = comp(T.Button, {
    BaseColor: C([1, 1, 1, 1]),
    ColorDrivers: [{
      ID: pf.nextId(),
      ColorDrive: pf.fd(img.f.Tint),
      TintColorMode: pf.fd('Explicit'),
      NormalColor: pf.fd(C(BTN)),
      HighlightColor: pf.fd(C(BTN_HI)),
      PressColor: pf.fd(C(BTN_PRESS)),
      DisabledColor: pf.fd(C([0.45, 0.45, 0.45, 1])),
    }],
    IsPressed: false, IsHovering: false, HoverVibrate: 'Short', PressVibrate: 'Medium',
    ClearFocusOnPress: true, PassThroughHorizontalMovement: true, PassThroughVerticalMovement: true,
    RequireLockInToPress: false, RequireInitialPress: true, PressPoint: V2(0, 0), SendSlotEvents: true,
    Pressed: { Target: null }, Pressing: { Target: null }, Released: { Target: null },
    HoverEnter: { Target: null }, HoverStay: { Target: null }, HoverLeave: { Target: null },
  });
  const trigger = comp(T.BtnTrigger, {
    Target: target, ExcludeDisabled: true, PressedTag: `ResoPal/${tag}`,
    PressingTag: null, ReleasedTag: null, HoverEnterTag: null, HoverStayTag: null, HoverLeaveTag: null,
  });
  return slot(`btn ${tag}`, [r.comp, layoutElement(58).comp, img.comp, btn.comp, trigger.comp], [0, 0, 0],
    [label('caption', caption, 24, TEXT)]);
}
// ── the card template ────────────────────────────────────────────────────────
// ONE card. Every card in-world is a duplicate of this slot, made as its record
// arrives, so nothing here knows or cares how many there will be.
//
// The trick that makes it work: DuplicateSlot copies the ProtoFlux *inside* the
// slot too, and rewires the copy's internal references to the copy's own
// components. So these three nodes exist once in the package and once per card
// in-world, each driving its own texture from its own variable.
//
// Texture and material are components ON THE SLOT rather than entries in
// doc.Assets, because doc.Assets is shared: a card duplicated from a template
// whose texture lives there would point at the template's one texture, and every
// card would show the same art.
const cardTexture = comp(T.Texture, {
  URL: null, Uncompressed: false, DirectLoad: false, ForceExactVariant: false,
  PreferredProfile: 'sRGB', MipMapBias: D(0), IsNormalMap: false,
  WrapModeU: 'Clamp', WrapModeV: 'Clamp', PowerOfTwoAlignThreshold: D(0.05),
  CrunchCompressed: true, MipMaps: true, KeepOriginalMipMaps: false, MipMapFilter: 'Box', Readable: false,
});
// Cutout at 0.72, the values the deck bake settled on: Palify art carries its
// rounded corners in the alpha, and is matted against white so 0.5 leaves a rim.
const cardMat = comp(T.Unlit, {
  TintColor: C([1, 1, 1, 1]), Texture: cardTexture.id, BlendMode: 'Cutout', AlphaCutoff: D(0.72),
  UseVertexColors: false, ZWrite: 'Auto',
});
// QuadMesh carries its OWN Rotation, and the engine default is identity (see
// QuadMesh.cs line 171). The card that worked in-world had it at [0,1,0,0] - a
// half turn about Y - and omitting the field left the quad facing the other way,
// so the card presented its back and the front was culled. State it here rather
// than inherit a default: this one field decides which way a card faces.
const cardMesh = comp(T.QuadMesh, {
  Size: V2(CARD_W, CARD_H), Rotation: [D(0), D(1), D(0), D(0)],
  DualSided: false, UseVertexColors: false,
});
const cardRenderer = comp(T.MeshRenderer, {
  Mesh: cardMesh.id, Materials: pf.list([cardMat.id]), MaterialPropertyBlocks: [],
  ShadowCastMode: 'On', SortingOrder: I(0),
});
// Landscape cards render landscape without anyone asking: this reads the loaded
// texture's own pixel size. UnitHeight normalises to (aspect, 1), Ratio scales
// that to the card height, MaxSize caps the width at one grid cell.
const cardSize = comp(T.SizeDriver, {
  Texture: cardTexture.id, Target: cardMesh.f.Size, DriveMode: 'UnitHeight',
  Premultiply: V2(1, 1), Ratio: V2(CARD_H, CARD_H), MaxSize: V2(CARD_W, CARD_H),
});
// The one thing written into a duplicate from outside. A separate space from the
// panel's own `ResoPal`, so a write aimed at a card cannot land on the panel.
const cardVarSpace = comp(T.VarSpace, { SpaceName: 'CARD', OnlyDirectBinding: false });
const cardUrlVar = comp(T.StrVar, { VariableName: 'CARD/url', Value: '', OverrideOnLink: false });

// The three nodes that turn that string into the card's art. `Source` on a
// CoreNodes source node is not the target itself - it points at a
// GlobalReference component on the same slot, which holds the field.
const cardSrc = comp(T.StrSource, { Source: null });
const cardSrcRef = comp(T.StrSourceRef, { Reference: cardUrlVar.f.Value });
cardSrc.comp.Data.Source.Data = cardSrcRef.id;
const cardUri = comp(T.ToUri, { Input: cardSrc.id });
const cardDrive = comp(T.UriDrive, { Value: cardUri.id });
const cardDriveProxy = comp(T.UriDriveProxy, { Node: cardDrive.id, Path: [], Drive: cardTexture.f.URL });

// ── the card back ────────────────────────────────────────────────────────────
// The same image for every Palworld card, so it ships INSIDE the package rather
// than being fetched. Fetching it would mean either a second host-access prompt
// (a different origin from the card art) or another route on the Worker, and the
// point of a back face is that it is just there.
//
// A texture asset needs its `Metadata/<hash>.bitmap` sidecar as well as the
// bytes - the engine reads width/height/format from it, not from the file. The
// field name really is misspelled `assetIdenfitier`; see docs/PIPELINE.md.
const backBytes = new Uint8Array(await readFile(path.join(import.meta.dirname, '..', 'assets', 'DefaultBack.png')));
const BACK_HASH = createHash('sha256').update(backBytes).digest('hex');
const pngSize = (b) => ({ width: (b[16]<<24)|(b[17]<<16)|(b[18]<<8)|b[19], height: (b[20]<<24)|(b[21]<<16)|(b[22]<<8)|b[23] });
const backDims = pngSize(backBytes);
const backMeta = Buffer.from(JSON.stringify({
  ...backDims, mipMapCount: 1, baseFormat: 'png', isCorrupted: false, metadataVersion: 5,
  assetIdenfitier: BACK_HASH, bitsPerPixel: 32, channelCount: 4, colorData: 'Color', alphaData: 'Alpha',
  invalidPixelCount: 0,
}));

const backTexture = comp(T.Texture, {
  URL: `@packdb:///${BACK_HASH}`, Uncompressed: false, DirectLoad: false, ForceExactVariant: false,
  PreferredProfile: 'sRGB', MipMapBias: D(0), IsNormalMap: false,
  WrapModeU: 'Clamp', WrapModeV: 'Clamp', PowerOfTwoAlignThreshold: D(0.05),
  CrunchCompressed: true, MipMaps: true, KeepOriginalMipMaps: false, MipMapFilter: 'Box', Readable: false,
});
const backMat = comp(T.Unlit, {
  TintColor: C([1, 1, 1, 1]), Texture: backTexture.id, BlendMode: 'Cutout', AlphaCutoff: D(0.72),
  UseVertexColors: false, ZWrite: 'Auto',
});
// The back faces the other way, and says so on the same field. Rotating the SLOT
// instead is what went wrong twice: the slot's turn composes with the mesh's own,
// and two half turns cancel - the back ends up facing the same way as the front
// and covers it.
const backMesh = comp(T.QuadMesh, {
  Size: V2(CARD_W, CARD_H), Rotation: [D(0), D(0), D(0), D(1)],
  DualSided: false, UseVertexColors: false,
});
const backRenderer = comp(T.MeshRenderer, {
  Mesh: backMesh.id, Materials: pf.list([backMat.id]), MaterialPropertyBlocks: [],
  ShadowCastMode: 'On', SortingOrder: I(0),
});
// The back is a child rotated a half turn about Y, a hair behind the front, so
// the two faces do not z-fight. Turning the card over shows the back, which is
// what a card does - no flip button, no toggle, no state to get out of step.
const backFace = slot('back', [backMesh.comp, backMat.comp, backTexture.comp, backRenderer.comp], [0, 0, -0.0004]);

// ── the card as a physical object ────────────────────────────────────────────
// A collider is what makes a card touchable and grabbable; without one it is a
// picture hanging in the air. Its size follows the quad rather than being fixed,
// because TextureSizeDriver rewrites that quad for landscape cards - a fixed
// collider would be the wrong shape for the 19 landscape cards in BP01.
// A fixed size with real thickness, not one driven from the quad. The quad starts
// at (0,0) and only gets its size once TextureSizeDriver has seen the texture
// load - so a driven collider is zero-sized until then, and a card you cannot
// grab until its art arrives is a card that looks broken. DeckReader's card uses
// a fixed 0.35 x 0.5 x 0.0027 for the same reason.
const cardCollider = comp(T.BoxCollider, {
  Offset: V3(0, 0, 0), Type: 'Static', Mass: D(1),
  CharacterCollider: false, IgnoreRaycasts: false, Size: V3(CARD_W, CARD_H, 0.002),
});
const cardGrab = comp(T.Grabbable, { Scalable: false, ReparentOnRelease: true, PreserveUserSpace: true });
// Keyword "Card" is what a deck's receiver surface looks for. Nothing uses it
// yet - the deck holder is the next piece - but a card that cannot be recognised
// as a card would have to be rebuilt to join one.
const cardSnapper = comp(T.Snapper, { Keywords: pf.list(['Card']) });

const cardTemplate = slot('card', [
  cardVarSpace.comp, cardUrlVar.comp, cardTexture.comp, cardMat.comp,
  cardMesh.comp, cardRenderer.comp, cardSize.comp,
  cardCollider.comp, cardGrab.comp, cardSnapper.comp,
], [0, 0, 0], [
  backFace,
  slot('CARD/url -> texture', [cardSrc.comp, cardSrcRef.comp], [0, 0, 0]),
  slot('as a Uri', [cardUri.comp], [COL, 0, 0]),
  slot('drive the texture URL', [cardDrive.comp, cardDriveProxy.comp], [COL * 2, 0, 0]),
]);
// The CARD stays active and its HOLDER is switched off. `DuplicateSlot` calls
// `slot.Duplicate()`, which copies `Active` verbatim - duplicating an inactive
// card gives an inactive card, and nothing in the spawn chain turns it back on.
// Hiding it behind an inactive parent keeps the template out of sight while the
// copy, reparented under the active Cards slot, comes up visible.
const templateSlot = slot('Card template', [], [0, -0.42, 0], [cardTemplate]);
templateSlot.Active.Data = false;
// -0.22, not -0.42. The canvas is 660 units at 0.00058, so the panel's bottom
// edge sits at about -0.19; starting the grid at -0.42 left a gap wider than a
// card row between the panel and the first card, and the grid grows DOWNWARD from
// here, so the whole block hung well below the thing that spawned it.
const cardsSlot = slot('Cards', [], [-((COLS - 1) / 2) * PITCH_X, -0.22, 0]);
// A deck is a metre-wide object; it does not belong on the grid the loose cards
// land on, so duplicates get their own parent beside it rather than sharing one.
const decksSlot = slot('Decks', [], [0, -0.22, -0.25]);

// ═══════════════════════════════════════════════════════════════════════════════
// THE GRAPH. One canvas. Everything a human needs is on it.
// ═══════════════════════════════════════════════════════════════════════════════
const controlId = pf.nextId();          // the impulse target; a real slot, not the root
const controlNodes = [], controlZones = [];

// Zone 1: the buttons. One receiver per tag, each writing its URL into the
// shared variable, all joining one trunk relay so the request node takes a
// single incoming wire (pretty-flux section 2, the owner's own fan rule).
const joinTrunk = node('any button -> fetch', T.FlowRelay, { Next: null }, [COL * 4.2, -ROW * 4.8, 0]);
const buttonNodes = [joinTrunk];
const urlWrites = [];
BUTTONS.forEach((b, i) => {
  const y = -i * ROW * 2.4;
  const tagValue = comp(T.GlobalStr, { Value: `ResoPal/${b.tag}` });
  // The URL constant sits HALF A ROW BELOW the receiver-to-write line. Placed on
  // that line - which is where it used to be - the impulse wire runs straight
  // through its box and the pair reads as unconnected. Pretty-flux section 2:
  // never let a const sit in the lane between two nodes that wire to each other.
  const url = strIn(`url: ${b.tag}`, b.url, [COL * 1.5, y - ROW * 0.75, 0]);
  // The variable NAME is duplicated per row rather than shared through a trunk.
  // One shared const above a column of five writes sends its wires straight down
  // THROUGH the writes above each target; a local copy has no wire to route.
  const pathConst = strIn(`name: ResoPal/url`, 'ResoPal/url', [COL * 1.5, y + ROW * 0.75, 0]);
  const write = node(`set ResoPal/url := ${b.tag}`, T.WriteVar, {
    Target: null, Path: pathConst.id, OnNotFound: null, OnSuccess: joinTrunk.id, OnFailed: null, Value: url.id,
  }, [COL * 2.4, y, 0]);
  const recv = proxyNode(`on press: ${b.tag}`, T.Receiver, T.ReceiverProxy,
    { Tag: tagValue.id, OnTriggered: write.id }, [0, y, 0], [tagValue.comp]);
  buttonNodes.push(url, pathConst, recv, write);
  urlWrites.push(write);
});

// Both failure paths of every URL write. DynamicVariableAction returns
// OnNotFound when the space or the variable is missing, OnFailed when the value
// will not take; both are otherwise dead ends that stop the chain before the
// request node ever runs, with nothing anywhere to say so. This write lives
// here rather than in the event column because a wire from the write column all
// the way across to that column would run straight through zone 2.
const failText = strIn('text: could not set ResoPal/url', 'could not set ResoPal/url', [COL * 2.0, -ROW * 12, 0]);
const failPath = strIn('name: ResoPal/event', 'ResoPal/event', [COL * 2.0, -ROW * 13, 0]);
const failSay = node('a write failed -> say so', T.WriteVar, {
  Target: null, Path: failPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: failText.id,
}, [COL * 4.2, -ROW * 12, 0]);
for (const w of urlWrites) {
  w.slot.Components.Data[0].Data.OnNotFound.Data = failSay.id;
  w.slot.Components.Data[0].Data.OnFailed.Data = failSay.id;
}
buttonNodes.push(failText, failPath, failSay);

// The sixth button does not pick a URL - it sends whatever is in the paste field
// to /api/resolve, and the Worker works out whether that was a palify deck link
// or a decklist. It sits below the other five with its own clear run rightwards.
const importTag = comp(T.GlobalStr, { Value: 'ResoPal/import' });
const importRecv = proxyNode('on press: import', T.Receiver, T.ReceiverProxy,
  { Tag: importTag.id, OnTriggered: null }, [COL * 2.4, -ROW * 16, 0], [importTag.comp]);
buttonNodes.push(importRecv);

controlNodes.push(...buttonNodes);
controlZones.push(around('1 · a button picks what to ask for', buttonNodes));

// Zone 2: the two requests.
//
// There is no host-access gate. WebRequestBase.RunAsync asks for permission
// itself - at scope HTTP, naming the host - before it sends, so a pre-gate is
// only a second way to fail for a prompt the user gets anyway. It also cannot be
// shared between two request nodes without a multiplexer. See PRIOR-ART.md §1.
//
// Both requests are AsyncActionNodes, so each is entered through its own
// StartAsyncTask; an ordinary impulse cannot run one and the chain would stop
// with no error at all.
const ZX = COL * 5.8;   // zone 1 ends near 4.2 columns, and a zone needs a gap
const urlNode = strIn('the URL to fetch', BUTTONS[2].url, [ZX + COL * 0.5, ROW * 2, 0]);
const urlDriver = comp(T.VarDriver, { VariableName: 'ResoPal/url', Target: urlNode.f.Value, DefaultValue: BUTTONS[2].url });
urlNode.slot.Components.Data.push(urlDriver.comp);
const urlTrunk = strRelay('URL -> request + readout', urlNode.id, [ZX + COL * 1.5, ROW * 2, 0]);
const apiUri = node('URL -> Uri', T.ToUri, { Input: urlTrunk.id }, [ZX + COL * 2.5, ROW * 2, 0]);
const get = node('GET the card list', T.Get, {
  URL: apiUri.id, Content: null, StatusCode: null, OnSent: null, OnResponse: null, OnError: null, OnDenied: null,
}, [ZX + COL * 3.5, 0, 0]);
const getAsync = node('run the request asynchronously', T.StartAsync,
  { TaskStart: get.id, OnStarted: null, OnFailed: null }, [ZX, 0, 0]);
joinTrunk.slot.Components.Data[0].Data.Next.Data = getAsync.id;
const dUrl = drive('drive the URL readout', 'str', urlTrunk.id, null, [ZX + COL * 2.5, ROW * 3.5, 0]);

// The paste field's text is read the same way a card reads its own variable: a
// source node plus a GlobalReference holding the actual field.
const pasteSrc = comp(T.StrSource, { Source: null });
const pasteRef = comp(T.StrSourceRef, { Reference: null });
pasteSrc.comp.Data.Source.Data = pasteRef.id;
const pasteNode = { slot: slot('what you pasted', [pasteSrc.comp, pasteRef.comp], [ZX + COL * 0.5, -ROW * 9.5, 0]),
  id: pasteSrc.id, pos: [ZX + COL * 0.5, -ROW * 9.5, 0] };
const resolveConst = strIn('url: /api/resolve', RESOLVE, [ZX + COL * 0.5, -ROW * 8, 0]);
const resolveUri = node('resolve URL -> Uri', T.ToUri, { Input: resolveConst.id }, [ZX + COL * 1.5, -ROW * 8, 0]);
const mediaConst = strIn('media type', 'text/plain', [ZX + COL * 0.5, -ROW * 11, 0]);
const post = node('POST what you pasted', T.Post, {
  URL: resolveUri.id, String: pasteNode.id, MediaType: mediaConst.id,
  Content: null, StatusCode: null, OnSent: null, OnResponse: null, OnError: null, OnDenied: null,
}, [ZX + COL * 3.5, -ROW * 6, 0]);
const postAsync = node('run the POST asynchronously', T.StartAsync,
  { TaskStart: post.id, OnStarted: null, OnFailed: null }, [ZX, -ROW * 6, 0]);
importRecv.slot.Components.Data[0].Data.OnTriggered.Data = postAsync.id;

// ── each request reports its own outcome ─────────────────────────────────────
// The event writes live here rather than in one far-right column, because a wire
// from a request all the way across the unpack and readout zones cuts through
// everything in between. Each outcome gets a stub beside the request, then its
// own three-column band: the write on the right, its inputs combed into the
// column beside it, one per row.
//
// The stubs share one tight COLUMN, four rows apart, right of both requests. A
// fan to targets stacked in a column dives fast enough to clear the nearer ones;
// a fan to targets on the same ROW passes straight through them. Each stub then
// runs LEVEL into its own write, so that run is a straight line half a row above
// everything the write reads, and no band's run ever crosses another band.
const EVX = ZX + COL * 5.6;
const eventNodes = [];
function outcome(name, band, extra) {
  const y = -ROW * 4 * band;
  const sx = EVX + COL * 5;
  const stub = node(name, T.FlowRelay, { Next: null }, [EVX, y, 0]);
  const path = strIn('name: ResoPal/event', 'ResoPal/event', [sx - COL, y - ROW * 1.5, 0]);
  const value = extra(sx, y);
  const say = node('-> ResoPal/event', T.WriteVar, {
    Target: null, Path: path.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: value.id,
  }, [sx, y, 0]);
  stub.slot.Components.Data[0].Data.Next.Data = say.id;
  eventNodes.push(stub, path, say);
  return { stub, say };
}
const says = (text) => (sx, y) => {
  const c = strIn(`text: ${text}`, text, [sx - COL * 2, y - ROW * 1.5, 0]);
  eventNodes.push(c);
  return c;
};
// Each request reports its OWN status code. A single shared band could only read
// one of the two StatusCode fields, and it read the GET's: a pasted import would
// have announced whatever the last fetch returned, or "HTTP 0" on a panel that
// had never fetched anything at all.
//
// StatusCode is a named OUTPUT, addressed by its FIELD id. The node's own
// component id is a different thing entirely and would read as nothing.
const answered = (label, band, codeField) => outcome(label, band, (sx, y) => {
  const tmpl = strIn('text: response received - HTTP {0}', 'response received - HTTP {0}', [sx - COL * 4, y - ROW * 1.5, 0]);
  const cast = node('the HTTP code as text', T.StatusCast, { Input: codeField }, [sx - COL * 4, y - ROW * 2.5, 0]);
  const fmt = node('fill in the code', T.Format, { Format: tmpl.id, Parameters: pf.list([cast.id]) }, [sx - COL * 3, y - ROW * 2, 0]);
  eventNodes.push(cast, tmpl, fmt);
  return fmt;
});
const getOk = answered('the fetch answered', 0, get.f.StatusCode);
const postOk = answered('the import answered', 1, post.f.StatusCode);
const errStub = outcome('a request did not answer', 2, says('network error - no answer from the host')).stub;
// The request node asks for host access itself, so its OnDenied is the only
// place a refusal appears at all. Unwired it is a dead end, and the panel looks
// exactly like a button that did nothing.
const refuseStub = outcome('a request was refused', 3, says('host access refused')).stub;
get.slot.Components.Data[0].Data.OnResponse.Data = getOk.stub.id;
post.slot.Components.Data[0].Data.OnResponse.Data = postOk.stub.id;
for (const req of [get, post]) {
  const d = req.slot.Components.Data[0].Data;
  d.OnError.Data = errStub.id;
  d.OnDenied.Data = refuseStub.id;
  // OnResponse lands on that request's own "answered" band, and the write there
  // carries on into the unpack - see the landing writes below.
}

const requestNodes = [urlNode, urlTrunk, apiUri, get, getAsync, dUrl,
  resolveConst, resolveUri, pasteNode, mediaConst, post, postAsync, ...eventNodes];
controlNodes.push(...requestNodes);
controlZones.push(around('2 · ask resopal, and say what came back', requestNodes));

// Zone 3: unpack the response into cards.
//
// The response is one art URL per line. Instead of a cursor index walking
// forwards - which is what wrapped past the end and lit 62 cards for a 7-card
// pull - the remainder is written back OVER ITSELF minus the record just taken.
// It only ever gets shorter, so the loop provably terminates.
//
// `rest` and `body` are DataModelObjectFieldStore locals: the node IS the value,
// the +Store proxy beside it holds it.
const SX = COL * 19.2;   // zone 2's event writes end near 18.2 columns
const at = (col, row) => [SX + col * COL, -row * 0.30, 0];

const restStore = proxyNode('rest of the response', T.Store, T.StoreProxy, {}, at(-1.2, 4));
const bodyStore = proxyNode('the whole response', T.Store, T.StoreProxy, {}, at(-0.6, -1));
// Seed both with an empty string rather than leaving the Sync<string> at null.
// Nothing reads them before the first response, but a local that is "" behaves
// like a zero-length string everywhere and one that is null relies on every
// string node in the chain handling null the same way.
for (const store of [restStore, bodyStore]) store.slot.Components.Data[1].Data.Value.Data = '';
const cardsRef = comp(T.SlotRef, { Reference: cardsSlot._slot.id });
const cardsIn = comp(T.SlotIn, { Source: cardsRef.id });
const cardsNode = { slot: slot('the Cards slot', [cardsIn.comp, cardsRef.comp], at(3, 6)), id: cardsIn.id, pos: at(3, 6) };
const tmplRef = comp(T.SlotRef, { Reference: cardTemplate._slot.id });
const tmplIn = comp(T.SlotIn, { Source: tmplRef.id });
const tmplNode = { slot: slot('the card template', [tmplIn.comp, tmplRef.comp], at(4.4, 3)), id: tmplIn.id, pos: at(4.4, 3) };

// Both requests land here. Each stashes the body twice - once whole for the
// readout, once as the remainder the loop eats - then clears the previous
// import and starts the loop.
const startLoop = node('start unpacking', T.FlowRelay, { Next: null }, at(3, 0));
function landing(name, contentField, row) {
  const toBody = node(`${name} -> keep the whole body`, T.StoreWrite,
    { Variable: bodyStore.id, Value: contentField, OnWritten: null }, at(1, row));
  const toRest = node(`${name} -> and a copy to eat`, T.StoreWrite,
    { Variable: restStore.id, Value: contentField, OnWritten: null }, at(2, row));
  toBody.slot.Components.Data[0].Data.OnWritten.Data = toRest.id;
  toRest.slot.Components.Data[0].Data.OnWritten.Data = startLoop.id;
  return [toBody, toRest];
}
const [getBody, getRest] = landing('GET', get.f.Content, 1);
const [postBody, postRest] = landing('POST', post.f.Content, 2);
// Answering has TWO jobs - say so on the event line, and hand the body to the
// unpack - and a continuation only goes one place. Rather than fan through a
// Sequence, the report comes first and CARRIES ON into the landing write: the
// event write's three outcomes all continue there, so a panel that cannot write
// its own event line still imports the deck. Losing this link is what orphaned
// the whole zone once - the writes below had no trigger at all and the loop
// never ran, which is why `test-panel.mjs` now fails the build on an operation
// nothing runs.
for (const [ok, land] of [[getOk, getBody], [postOk, postBody]]) {
  const d = ok.say.slot.Components.Data[0].Data;
  d.OnSuccess.Data = land.id;
  d.OnNotFound.Data = land.id;
  d.OnFailed.Data = land.id;
}
const clear = node('remove the last import', T.ClearKids,
  { Instance: cardsNode.id, PreserveAssets: false, SendDestroyingEvent: true, Next: null }, at(4, 0));
const loopAsync = node('the loop is asynchronous', T.StartAsync,
  { TaskStart: null, OnStarted: null, OnFailed: null }, at(5, 0));
startLoop.slot.Components.Data[0].Data.Next.Data = clear.id;
clear.slot.Components.Data[0].Data.Next.Data = loopAsync.id;

// The loop spine runs left to right along row 8; everything it reads hangs below
// it, and the one wire that goes backwards runs along row 13, under all of it.
const R = 8;
const loopTop = node('next record', T.FlowRelay, { Next: null }, at(-0.6, R));
loopAsync.slot.Components.Data[0].Data.TaskStart.Data = loopTop.id;
const oneFrame = intIn('one frame', 1, at(0, R + 1));
const breathe = node('let a frame pass', T.DelayFrames,
  { Updates: oneFrame.id, OnTriggered: null, Next: null }, at(1, R));

// One tap for the remainder, in the row that reads it. Four consumers spread
// across the loop pulling on the store directly is four wires back across the
// zone; a relay beside them is one.
const restTap = strRelay('the remainder, three ways', restStore.id, at(-1.2, R + 5));
const newline = strIn('a newline', '\n', at(0, R + 3));
const nlAt = node('where the record ends', T.IndexOf,
  { Str: restTap.id, Part: newline.id, StartIndex: null, SearchFromEnd: null, ComparisonMode: null }, at(1, R + 3));
const nlTrunk = intRelay('that offset, three ways', nlAt.id, at(2, R + 3));
const shortest = intIn('shortest sane record', 8, at(2.6, R + 6.5));
// One condition covers both ways the loop can be done: IndexOfString returns -1
// when there is no newline left, and a record too short to be a URL is junk.
// So `nl > 8` is "there is another record and it is plausible", and the
// remainder shrinks by at least 9 每 pass, which is why this cannot spin.
const another = node('another record?', T.IntGt, { A: nlTrunk.id, B: shortest.id }, at(3, R + 2));
const gate = node('another record ? spawn : done', T.If,
  { Condition: another.id, OnTrue: null, OnFalse: null }, at(2, R));

const zero = intIn('from the start', 0, at(3.6, R + 3.25));
const record = node('this record', T.Substr,
  { Str: restTap.id, StartIndex: zero.id, Length: nlTrunk.id }, at(4, R + 4));
const artUrl = node('trimmed to the art URL', T.Trim, { A: record.id }, at(5, R + 4));
const afterNl = node('just past the newline', T.IntInc, { N: nlTrunk.id }, at(4, R + 7));
const remainder = node('everything after it', T.Substr,
  { Str: restTap.id, StartIndex: afterNl.id, Length: null }, at(5, R + 6));

// `Duplicate` is an output sentinel. It has to be emitted as a field or there
// is no id for the nodes downstream to address, and they would silently end up
// pointing at nothing.
const dup = node('make a card', T.Dup,
  { Template: tmplNode.id, OverrideParent: cardsNode.id, Duplicate: null, Next: null }, at(3, R));
gate.slot.Components.Data[0].Data.OnTrue.Data = dup.id;
const cardPath = strIn('name: CARD/url', 'CARD/url', at(5, R + 2));
const setUrl = node('tell the card its art', T.WriteVar,
  { Target: dup.f.Duplicate, Path: cardPath.id, Value: artUrl.id, OnSuccess: null, OnNotFound: null, OnFailed: null },
  at(6, R));
dup.slot.Components.Data[0].Data.Next.Data = setUrl.id;

// Where it goes. The card asks for its OWN index rather than counting the
// Cards slot's children: by the time this runs the duplicate is already
// parented, so a count includes it and every card would land one cell late.
// `IndexOfChild` returns `slot.ChildIndex` for the slot handed to it, which is
// exactly the number wanted, and needs no second reference to Cards.
const howMany = node('which card is this', T.IndexOfChild, { Instance: dup.f.Duplicate }, at(6, R + 8));
const idx = intRelay('that index, twice', howMany.id, at(7, R + 8));
const perRow = intIn(`cards per row (${COLS})`, COLS, at(7, R + 9));
const colOf = node('which column', T.IntMod, { A: idx.id, B: perRow.id }, at(8, R + 7));
const rowOf = node('which row', T.IntDiv, { A: idx.id, B: perRow.id }, at(8, R + 9));
const colF = node('as a float', T.IntToFloat, { Input: colOf.id }, at(9, R + 7));
const rowF = node('as a float', T.IntToFloat, { Input: rowOf.id }, at(9, R + 9));
const pitchX = node(`column pitch`, T.FloatIn, { Value: D(PITCH_X) }, at(8.6, R + 6));
const pitchY = node(`row pitch (down)`, T.FloatIn, { Value: D(-PITCH_Y) }, at(8.6, R + 10));
const xOf = node('x', T.FloatMul, { A: colF.id, B: pitchX.id }, at(10, R + 7));
const yOf = node('y', T.FloatMul, { A: rowF.id, B: pitchY.id }, at(10, R + 9));
const zeroF = node('z', T.FloatIn, { Value: D(0) }, at(10, R + 10));
const place = node('where the card goes', T.PackF3, { X: xOf.id, Y: yOf.id, Z: zeroF.id }, at(11, R + 8));
const setPos = node('put it there', T.SetPos,
  { Instance: dup.f.Duplicate, Position: place.id, Next: null }, at(7, R));
setUrl.slot.Components.Data[0].Data.OnSuccess.Data = setPos.id;
// If this write fails the loop stops dead - OnSuccess is what continues it - so
// one card would sit there with no art and nothing would say why. Both failure
// paths report instead.
const cardFailText = strIn('text: a card would not take its art', 'a card would not take its art', at(6.6, 4));
const cardFailPath = strIn('name: ResoPal/event', 'ResoPal/event', at(6.6, 5));
const cardFailSay = node('-> ResoPal/event', T.WriteVar, {
  Target: null, Path: cardFailPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: cardFailText.id,
}, at(7.6, 4));
setUrl.slot.Components.Data[0].Data.OnNotFound.Data = cardFailSay.id;
setUrl.slot.Components.Data[0].Data.OnFailed.Data = cardFailSay.id;

// Only now is the record consumed. Everything above reads `rest`, so eating it
// first would make every one of those reads see the NEXT record instead.
const eat = node('eat that record', T.StoreWrite,
  { Variable: restStore.id, Value: remainder.id, OnWritten: null }, at(8, R));
setPos.slot.Components.Data[0].Data.Next.Data = eat.id;
const backA = node('and go round again', T.FlowRelay, { Next: null }, at(12.4, R));
const backB = node('back to the top', T.FlowRelay, { Next: null }, at(12.4, R + 13));
// Three corners, not one diagonal: the return runs down its own column, along a
// row below everything, and back up the left edge. A straight line from the end
// of the loop to the start cuts through every data row in between.
const backC = node('and in again', T.FlowRelay, { Next: loopTop.id }, at(-0.6, R + 13));
// The loop-back edge needs its OWN async context. `breathe` is a DelayUpdates -
// an AsyncActionNode - and the top of the loop only reaches it through
// `loopAsync`. Coming round again from `eat.OnWritten` re-enters that same async
// node from a SYNCHRONOUS continuation, which runs nothing: the first record
// spawns a card and every record after it dies silently. Found by the owner in
// world, not by any check here - verify-classpaths walks impulse edges from the
// entry points and treats the cycle as already-visited, so it never re-tests the
// edge that closes the loop.
const loopAgainAsync = node('and again, asynchronously', T.StartAsync,
  { TaskStart: null, OnStarted: null, OnFailed: null }, at(10.2, R));
eat.slot.Components.Data[0].Data.OnWritten.Data = loopAgainAsync.id;
loopAgainAsync.slot.Components.Data[0].Data.TaskStart.Data = backA.id;
backA.slot.Components.Data[0].Data.Next.Data = backB.id;
backB.slot.Components.Data[0].Data.Next.Data = backC.id;
loopTop.slot.Components.Data[0].Data.Next.Data = breathe.id;
breathe.slot.Components.Data[0].Data.Next.Data = gate.id;

const spawnNodes = [loopAgainAsync, restStore, bodyStore, cardsNode, tmplNode, startLoop, getBody, getRest, postBody, postRest,
  clear, loopAsync, loopTop, oneFrame, breathe, newline, nlAt, nlTrunk, shortest, another, gate,
  restTap, zero, record, artUrl, afterNl, remainder, dup, cardPath, setUrl,
  cardFailText, cardFailPath, cardFailSay, howMany, idx, perRow,
  colOf, rowOf, colF, rowF, pitchX, pitchY, xOf, yOf, zeroF, place, setPos, eat, backA, backB, backC];
controlNodes.push(...spawnNodes);
controlZones.push(around('3 · unpack the response into cards', spawnNodes));

// Zone 4: the readouts. Three lines on the panel, all driven straight from this
// graph, so a failure is legible without opening the flux at all.
const RX = SX + COL * 14.5;   // zone 3 ends near 13.5 of its own
const bodyTrunk = strRelay('response -> readout', bodyStore.id, [RX, 0, 0]);
const bodyLen = node('response length', T.StrLen, { A: bodyTrunk.id }, [RX + COL, ROW * 1.5, 0]);
const zeroLen = intIn('0', 0, [RX + COL, ROW * 2.5, 0]);
const gotAny = node('did anything come back?', T.IntGt, { A: bodyLen.id, B: zeroLen.id }, [RX + COL * 2, ROW * 0.5, 0]);
const recWidth = intIn(`record width (${RECORD_WIDTH})`, RECORD_WIDTH, [RX - COL * 0.4, -ROW * 3, 0]);
const zeroStart = intIn('first record starts at 0', 0, [RX, -ROW * 4, 0]);
const firstEnd = node('end of the first record', T.Substr,
  { Str: bodyTrunk.id, StartIndex: zeroStart.id, Length: recWidth.id }, [RX + COL, -ROW * 1.5, 0]);
const firstTrim = node('first record, trimmed', T.Trim, { A: firstEnd.id }, [RX + COL * 2, -ROW * 1.5, 0]);
// OnFalse is reached only when the body is EMPTY. A transport failure is not
// empty - GET_String writes the exception into Content - so the error still
// comes out of OnTrue, trimmed like a record. Without a placeholder here the
// drive writes "" over the caption the panel ships with and the line goes blank
// before anything has even been pressed.
const readyText = strIn('text: Ready', 'Ready — pick a deck, or paste a palify link', [RX + COL * 3, ROW * 1.5, 0]);
const statusMsg = node('status: first card, else the error, else Ready', T.StrPick,
  { Condition: gotAny.id, OnTrue: firstTrim.id, OnFalse: readyText.id }, [RX + COL * 3, 0, 0]);

const statusLabel = label('status text', 'Ready — pick a deck, or paste a palify link', 17, CYAN);
const statusFieldId = statusLabel.Components.Data[1].Data.Content.ID;
const urlLabel = label('url text', PROXY, 14, DIM);
const urlFieldId = urlLabel.Components.Data[1].Data.Content.ID;
dUrl.slot.Components.Data[1].Data.Drive.Data = urlFieldId;
const dStatus = drive('drive the status line', 'str', statusMsg.id, statusFieldId, [RX + COL * 4, 0, 0]);

const readoutNodes = [bodyTrunk, firstEnd, firstTrim, bodyLen, zeroLen, gotAny, readyText, statusMsg, dStatus, recWidth, zeroStart];
controlNodes.push(...readoutNodes);
controlZones.push(around('4 · what the panel shows you', readoutNodes));

// The loop ending is the only success signal there is: cards appear one frame
// at a time, so "it finished" and "it never started" look identical without it.
// It is reported here, beside the gate that produces it, for the same routing
// reason the request outcomes are reported beside the requests.
const doneStub = node('no records left', T.FlowRelay, { Next: null }, at(0.4, R + 14));
gate.slot.Components.Data[0].Data.OnFalse.Data = doneStub.id;
const doneText = strIn('text: all cards placed', 'all cards placed', at(2, R + 15.8));
const donePath = strIn('name: ResoPal/event', 'ResoPal/event', at(2, R + 16.8));
const doneSay = node('-> ResoPal/event', T.WriteVar, {
  Target: null, Path: donePath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: doneText.id,
}, at(4, R + 15));
doneStub.slot.Components.Data[0].Data.Next.Data = doneSay.id;
spawnNodes.push(doneStub, doneText, donePath, doneSay);
controlNodes.push(doneStub, doneText, donePath, doneSay);
controlZones[2] = around('3 · unpack the response into cards', spawnNodes);

// ── zone 5: a big import goes in a deck holder ───────────────────────────────
// The same nodes `graft-deck-import.mjs` splices into the packed panel, from the
// same module, so the builder cannot drift away from what actually ships. Their
// positions come from `deck-import.mjs` rather than from layout.json: they are the
// one part of this graph the owner's cleanup has never seen, and they are placed
// to clear his canvas rather than to sit inside it.
const deckKit = {
  T,
  node,
  refNode(name, targetSlotId, pos) {
    const ref = comp(T.SlotRef, { Reference: targetSlotId });
    const src = comp(T.SlotIn, { Source: ref.id });
    return { slot: slot(name, [src.comp, ref.comp], pos), id: src.id, f: src.f, pos, classpath: T.SlotIn };
  },
  strIn, intIn,
  boolIn: (name, v, pos) => node(name, T.BoolIn, { Value: v }, pos),
};
const deck = deckImport(deckKit, {
  panelCards: cardsSlot._slot.id,
  // The template itself is a separate graft - the deck is a foreign document with
  // its own ids, types and blobs, and `graft-deck.mjs` is what moves it and fills
  // this reference in. Null here is an unbound external hook, not a dangling one.
  deckTemplate: null,
  decksHolder: decksSlot._slot.id,
});
for (const k of ['OnSuccess', 'OnNotFound', 'OnFailed'])
  doneSay.slot.Components.Data[0].Data[k].Data = deck.entryId;
controlNodes.push(...deck.nodes);
const deckPlaced = new Set(deck.nodes.map((n) => n.id));
controlZones.push(around('5 · a big import goes in a deck holder', deck.nodes));

const evtInput = strIn('the last event', '-', [RX, -ROW * 5, 0]);
evtInput.slot.Components.Data.push(comp(T.VarDriver, {
  VariableName: 'ResoPal/event', Target: evtInput.f.Value, DefaultValue: 'idle - no request yet',
}).comp);
const evtLabel = label('event text', 'idle - no request yet', 14, DIM);
const evtFieldId = evtLabel.Components.Data[1].Data.Content.ID;
const dEvent = drive('drive the event readout', 'str', evtInput.id, evtFieldId, [RX + COL, -ROW * 5, 0]);
controlNodes.push(evtInput, dEvent);
controlZones[3] = around('4 · what the panel shows you', readoutNodes.concat([evtInput, dEvent]));

// ── the owner's layout ───────────────────────────────────────────────────────
// Positions come from layout.json, decoded from the owner's own cleanup of this
// panel. They are the source of truth: the placement rules in pretty-flux.md are
// what he applied by hand, and reproducing them from the prose has failed twice.
// The builder's own `at()` coordinates are now only a fallback for nodes he has
// never seen - a new node lands somewhere sane and gets moved once, into the file.
//
// Relays are deliberately NOT in layout.json. They are routing output, not layout,
// and the router places them around whatever these positions are.
const LAYOUT = JSON.parse(await readFile(path.join(import.meta.dirname, 'layout.json'), 'utf8')).positions;
let placed = 0; const unplaced = [];
const known = Object.values(LAYOUT);
const bbox = known.reduce((b, p) => ({
  x0: Math.min(b.x0, p[0]), x1: Math.max(b.x1, p[0]),
  y0: Math.min(b.y0, p[1]), y1: Math.max(b.y1, p[1]),
}), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });

for (const n of controlNodes) {
  // The deck branch brings its own coordinates and keeps them. Parking it in the
  // unplaced row under his canvas would drop a whole stage on top of his graph.
  if (deckPlaced.has(n.id)) { n.slot.Position.Data = n.pos.map((v) => D(v)); continue; }
  const key = `${String(n.slot.Name.Data)}|${n.classpath}`;
  const p = LAYOUT[key];
  if (p) { n.pos = [p[0], p[1], p[2] ?? 0]; placed++; }
  else {
    // A node the owner's cleanup has never seen. Park it in a row just under his
    // canvas rather than at the builder's own old coordinates - those are in a
    // different frame, and a node left there sits metres away and drags a wire
    // across everything. Adjacent and obvious beats far and tidy: it gets placed
    // properly the next time layout.json is refreshed, and the build names it.
    n.pos = [bbox.x0 + unplaced.length * 0.36, bbox.y0 - 0.55, 0];
    unplaced.push(key.split('|')[0]);
  }
  n.slot.Position.Data = n.pos.map((v) => D(v));
}

// ── the router ───────────────────────────────────────────────────────────────
// Wires were emitted straight from producer to consumer and left that way, which
// is why the canvas read as a spray of long diagonals: median wire 0.82 against
// the reference's 0.23, p90 2.87 against 0.59, six wires over 4.0 where the gate
// is none. The house style ships an autorouter for exactly this
// (protoflux/pretty-flux.md 0: "emit logic wired directly to true producers, then
// let an autorouter place every relay") and it was not being used.
//
// It turns each long or obstructed wire into a pipe, flanks corners with a relay
// pair, and leaves short clear hops direct.
const { routeGraph } = await import(`file://${path.join(RKL, 'protoflux', 'skill', 'scripts', 'router.mjs')}`);
const LS = await import(`file://${path.join(RKL, 'protoflux', 'skill', 'scripts', 'layout_stats.mjs')}`);

// Which relay can carry a given producer's output. A stream with no verified relay
// type is left direct rather than guessed at - a wrong relay is a broken wire.
const relayFor = (classpath) => {
  if (/ObjectRelay<string>|GET_String|POST_String|Substring|ValueObjectInput<string>|ObjectValueSource<string>|ObjectRelay/.test(classpath)) return T.StrRelay;
  if (/ValueRelay<int>|IndexOfString|ValueInput<int>|ChildrenCount|IndexOfChild|ValueAdd<int>|ValueSub<int>/.test(classpath)) return T.IntRelay;
  return null;
};

// Keyed on the node's OWN component. A proxy alongside it (FieldDriveBase+Proxy)
// points at a scene field, not at another node, so it is not a wire endpoint.
const nodeRec = new Map();          // component id -> { data, box, type }
for (const n of controlNodes) {
  const data = n.slot.Components.Data[0].Data;
  const type = n.classpath;
  const { w, h } = LS.footprint(type, LS.countPorts(data));
  nodeRec.set(data.ID, { data, type, box: { x: n.pos[0], y: n.pos[1], w, h } });
}
const obstacles = [...nodeRec.values()].map((r) => ({ x: r.box.x, y: r.box.y, w: r.box.w / 2, h: r.box.h / 2 }));

const ROTQ = { 0: null, 90: [0, 0, 0.70710678, 0.70710678], 180: [0, 0, 1, 0], 270: [0, 0, -0.70710678, 0.70710678] };
const routedRelays = [];
function makeRelay(relayType, [x, y], rotDeg) {
  const isCont = relayType === T.FlowRelay;
  const n = node(isCont ? 'ContinuationRelay' : 'Relay', relayType,
    isCont ? { Next: null } : { Input: null }, [x, y, 0]);
  if (ROTQ[rotDeg]) n.slot.Rotation.Data = ROTQ[rotDeg].map((v) => D(v));
  routedRelays.push(n);
  const data = n.slot.Components.Data[0].Data;
  return { id: n.id, setInput: (id) => { data.Input.Data = id; }, setNext: (id) => { data.Next.Data = id; } };
}

const streams = new Map();
for (const rec of nodeRec.values()) {
  for (const [k, v] of Object.entries(rec.data)) {
    if (LS.META.has(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (typeof v.Data !== 'string' || !/^[0-9a-f]{8}-/.test(v.Data)) continue;
    const impulse = LS.IMPULSE_FIELDS.has(k) && !LS.isConditionalType(rec.type);
    const other = nodeRec.get(v.Data);
    if (!other) continue;                       // a scene reference, not a wire
    if (impulse) {
      const sy = LS.portY(rec.box.y, rec.box.h, LS.countPorts(rec.data), LS.portRow(rec.data, k));
      streams.set(`${rec.data.ID}:${k}`, {
        key: `${rec.data.ID}:${k}`, outId: null, source: rec.box, sy, relayType: T.FlowRelay, impulse: true,
        consumers: [{ x: other.box.x, y: other.box.y, w: other.box.w, h: other.box.h, box: other.box,
                      targetId: v.Data, rewire: (nid) => { v.Data = nid; }, label: k }],
      });
    } else {
      // NEVER relay a reference to an action node's own COMPONENT id. That id is
      // what an impulse targets, and it carries no value - a named output like
      // GET_String.Content is addressed by its FIELD id. Keying a data stream on it
      // put an ObjectRelay in front of the node, which then swallowed the
      // StartAsyncTask -> TaskStart impulse edge: the request had nothing running
      // it, and the relay's own Input pointed at a component id that has no value.
      if (v.Data === other.data.ID) continue;
      const rt = relayFor(other.type);
      if (!rt) continue;                        // no verified relay for this type: leave it direct
      let st = streams.get(v.Data);
      if (!st) {
        const sy = v.Data === other.data.ID ? other.box.y
          : LS.portY(other.box.y, other.box.h, LS.countPorts(other.data), LS.portRowOfId(other.data, v.Data));
        st = { key: v.Data, outId: v.Data, source: other.box, sy, relayType: rt, impulse: false, consumers: [] };
        streams.set(v.Data, st);
      }
      const py = LS.portY(rec.box.y, rec.box.h, LS.countPorts(rec.data), LS.portRow(rec.data, k));
      st.consumers.push({ x: rec.box.x, y: rec.box.y, w: rec.box.w, h: rec.box.h, box: rec.box, py,
                          rewire: (nid) => { v.Data = nid; }, label: k });
    }
  }
}

const routed = routeGraph({
  obstacles, streams: [...streams.values()], makeRelay,
  // trunkFirst: a producer feeding three or more consumers gets ONE relay off its
  // port and the branches come off that, so no node carries a six-wire fan.
  // fillOver: Infinity - no fill relays on straight runs. The house rule is that
  // every relay must turn a corner, tap a branch or make a real direction change
  // (pretty-flux 0b); fills on long straights are the "sprinkled relays that change
  // nothing" the owner called out. Corners still get their flank pair.
  opts: { trunkFirst: true, fillOver: Infinity, directMax: 0.65 },
  log: () => {},
});
controlNodes.push(...routedRelays);

const controlFlux = slot('Flux - control', [], [0, 1.35, 0],
  [zones(controlZones), ...controlNodes.map((n) => n.slot)], 'Moduprint.ProtoFlux', controlId);

// ── assemble ─────────────────────────────────────────────────────────────────
const urlVar = comp(T.StrVar, { VariableName: 'ResoPal/url', Value: BUTTONS[2].url, OverrideOnLink: false });
const evtVar = comp(T.StrVar, { VariableName: 'ResoPal/event', Value: 'idle - no request yet', OverrideOnLink: false });
const varsSlot = slot('Vars', [urlVar.comp, evtVar.comp], [0, 0, 0]);

/**
 * The paste field.
 *
 * UIX text entry is three components that have to agree: a `Text` holding the
 * content, a `TextEditor` pointing at that Text, and a `TextField` pointing at
 * the editor. The Text must be an interaction target or there is nothing to
 * click. `FinishHandling: NullOnWhitespace` leaves an empty field genuinely
 * empty rather than holding a string of spaces the Worker would reject.
 *
 * The graph reads `Text.Content` directly - the same way a card reads its own
 * variable - so the field and the graph never reference each other by name.
 */
const pasteText = comp(T.Text, {
  Font: fontChain.id, Content: null, ParseRichText: false, NullContent: 'paste a palify.org deck link, or a decklist',
  Size: D(15), HorizontalAlign: 'Left', VerticalAlign: 'Middle', AlignmentMode: 'Geometric',
  Color: C(TEXT), Materials: pf.list([textMat.id]), LineHeight: D(0.8), MaskPattern: null,
  HorizontalAutoSize: false, VerticalAutoSize: false, AutoSizeMin: D(8), AutoSizeMax: D(64),
  CaretPosition: I(-1), SelectionStart: I(-1),
  CaretColor: C(GOLD), SelectionColor: C([...GOLD.slice(0, 3), 0.4]), InteractionTarget: true,
});
const pasteEditor = comp(T.TextEditor, {
  Text: pasteText.id, Undo: false, UndoDescription: null, FinishHandling: 'NullOnWhitespace',
  AutoCaretColorField: false, CaretColorField: C(GOLD), SelectionColorField: C([...GOLD.slice(0, 3), 0.4]),
});
const pasteField = comp(T.TextField, { Editor: pasteEditor.id });
pasteRef.comp.Data.Reference.Data = pasteText.f.Content;

const pasteRow = slot('Paste', [rect().comp, layoutElement(44).comp, image(PANEL).comp], [0, 0, 0], [
  slot('paste text', [
    comp(T.Rect, { AnchorMin: V2(0.03, 0), AnchorMax: V2(0.97, 1), OffsetMin: V2(0, 0), OffsetMax: V2(0, 0), Pivot: V2(0.5, 0.5) }).comp,
    pasteText.comp, pasteEditor.comp, pasteField.comp,
  ]),
]);

const bg = slot('BG', [
  rect().comp,
  image(INK).comp,
  comp(T.VerticalLayout, {
    PaddingTop: D(16), PaddingRight: D(16), PaddingBottom: D(16), PaddingLeft: D(16),
    Spacing: D(9), HorizontalAlign: 'Center', VerticalAlign: 'Top',
    ForceExpandWidth: true, ForceExpandHeight: false,
  }).comp,
], [0, 0, 0], [
  bar('Header', 70, GOLD, '<b>RESOPAL</b>', 38, INK, [logoMark()]),
  slot('Status', [rect().comp, layoutElement(46).comp, image(PANEL).comp], [0, 0, 0], [statusLabel]),
  slot('URL', [rect().comp, layoutElement(24).comp, image(INK).comp], [0, 0, 0], [urlLabel]),
  slot('Event', [rect().comp, layoutElement(24).comp, image(INK).comp], [0, 0, 0], [evtLabel]),
  ...BUTTONS.map((b) => button(controlId, b)),
  pasteRow,
  button(controlId, { tag: 'import', label: 'Import what I pasted' }),
  label('Footer', 'Cards & data by Palify · palify.org', 14, DIM),
]);

const canvasRect = rect();
const canvasCollider = comp(T.BoxCollider, {
  Offset: V3(0, 0, 0), Type: 'Static', Mass: D(1),
  CharacterCollider: false, IgnoreRaycasts: false, Size: V3(CANVAS_W, CANVAS_H, 0),
});
const canvas = comp(T.Canvas, {
  Size: V2(CANVAS_W, CANVAS_H), EditModeOnly: false,
  AcceptRemoteTouch: true, AcceptPhysicalTouch: true, AcceptExistingTouch: false,
  HighPriorityIntegration: false, IgnoreTouchesFromBehind: true, BlockAllInteractions: false,
  LaserPassThrough: false, PixelScale: D(1), UnitScale: D(1),
  _rootRect: canvasRect.id, Collider: canvasCollider.id, DefaultCulling: 'Back',
  _colliderSize: canvasCollider.f.Size, _colliderOffset: canvasCollider.f.Offset,
  StartingOffset: I(-32000), StartingMaskDepth: I(0),
});
canvas.comp.Data.UpdateOrder = pf.fi(100000);
canvasCollider.comp.Data.UpdateOrder = pf.fi(1000000);

const canvasSlot = slot('UI Canvas', [canvas.comp, canvasRect.comp, canvasCollider.comp],
  [0, 0.66, 0], [bg], null, pf.nextId(), [CANVAS_SCALE, CANVAS_SCALE, CANVAS_SCALE]);

const credits = slot('credits', [], [0, 0, 0], [
  slot('Card images & deck data by Palify - palify.org'),
  slot('ResoPal by Dalek - resopal.dalek.coffee'),
]);

const root = slot('ResoPal', [
  comp(T.Grabbable, { Scalable: true }).comp,
  comp(T.ObjectRoot, {}).comp,
  comp(T.VarSpace, { SpaceName: 'ResoPal', OnlyDirectBinding: false }).comp,
], [0, 0, 0], [varsSlot, canvasSlot, templateSlot, cardsSlot, decksSlot, credits, controlFlux], null, pf.rootId);

const res = await pf.exportPackage({
  name: 'ResoPal Panel',
  root, assets,
  embeddedAssets: [{ hash: FONT_HASH, bytes: fontBytes }, { hash: BACK_HASH, bytes: backBytes, metadata: backMeta }],
  // out= so a comparison build cannot clobber the shipped package. It has been
  // overwritten once by a build run only to check the tests, and out/ is tracked.
  outPath: process.argv.slice(2).map((a) => a.split('=')).find(([k]) => k === 'out')?.[1]
    ?? path.join(import.meta.dirname, 'out', 'ResoPal_Panel.resonitepackage'),
  version: '2026.6.24.835',
  typeVersions: TYPE_VERSIONS,
});

console.log(`\n  buttons        ${BUTTONS.length} presets + paste & import`);
BUTTONS.forEach((b) => console.log(`                   ${b.label.padEnd(32)} ${b.url}`));
console.log(`                   ${'Import what I pasted'.padEnd(32)} POST ${RESOLVE}`);
console.log(`  graph          ${controlNodes.length} nodes, ${controlZones.length} comment zones, one canvas`);
console.log(`  layout         ${placed} nodes from layout.json` + (unplaced.length ? `, ${unplaced.length} placed by the builder: ${unplaced.slice(0, 4).join(', ')}` : ''));
console.log(`  routing        ${routed.direct} direct, ${routed.routed} routed, ${routed.relays} relays, ${routed.fallback} fallback`);
console.log(`  cards          one template, duplicated per record - no ceiling in the graph`);
console.log(`  panel          ${CANVAS_W}x${CANVAS_H} units at ${CANVAS_SCALE} = ${(CANVAS_W * CANVAS_SCALE).toFixed(2)}x${(CANVAS_H * CANVAS_SCALE).toFixed(2)} m`);
if (!res.ok) process.exitCode = 1;
