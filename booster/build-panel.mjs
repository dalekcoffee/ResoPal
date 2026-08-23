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

// format=fixed: one 64-char record per card, holding the whole art URL padded and
// newline-terminated. The width is a contract with worker/src/roll.js. It is what
// lets card i start at a constant i*64 instead of being found by walking i
// newlines - which is three extra nodes per card and a seventy-deep dependency
// chain nobody can read.
const RECORD_WIDTH = 64;

const BUTTONS = [
  { tag: 'deck/td01', label: 'Trial Deck  ·  Red / Blue',     url: `${PROXY}/api/deck?deck=td01&format=fixed` },
  { tag: 'deck/td02', label: 'Trial Deck  ·  Green / Purple', url: `${PROXY}/api/deck?deck=td02&format=fixed` },
  { tag: 'pack/1',    label: 'Open 1 Booster  ·  BP01',       url: `${PROXY}/api/pull?set=BP01&packs=1&format=fixed` },
  { tag: 'pack/3',    label: 'Open 3 Boosters  ·  BP01',      url: `${PROXY}/api/pull?set=BP01&packs=3&format=fixed` },
  { tag: 'pack/10',   label: 'Open 10 Boosters  ·  BP01',     url: `${PROXY}/api/pull?set=BP01&packs=10&format=fixed` },
];

// 70 = the largest any button asks for, and the same 10x7 the deck template's
// atlas grid uses. A card is visible exactly when its record is present, so a
// 7-card pull leaves the other 63 switched off and nothing counts anything.
// Lowering this shrinks the decoder canvas proportionally.
const COLS = 10, ROWS = 7, MAX_CARDS = COLS * ROWS;
const CARD_W = 0.063, CARD_H = 0.088, GAP = 0.008;

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
  IsAllowed:   PB + 'FrooxEngine.Network.IsHostAccessAllowedUrl',
  RequestHost: PB + 'FrooxEngine.Network.RequestHostAccessUrl',
  Get:         PB + 'FrooxEngine.Network.GET_String',
  If:          PB + 'If',
  StartAsync:  PB + 'StartAsyncTask',
  ScopeIn:     PB + 'ValueInput<[FrooxEngine]FrooxEngine.HostAccessScope>',
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
  SizeDriver: FE + 'TextureSizeDriver',
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
function comp(classpath, fields = {}) {
  const id = pf.nextId();
  const data = { ID: id, 'persistent-ID': pf.nextId(), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) };
  const f = {};
  for (const [k, v] of Object.entries(fields)) { const w = pf.fd(v); data[k] = w; f[k] = w.ID; }
  return { comp: { Type: pf.typeIndex(classpath), Data: data }, id, f };
}
function asset(classpath, fields = {}) {
  const id = pf.nextId();
  const data = { ID: id, persistent: pf.fd(true), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) };
  const f = {};
  for (const [k, v] of Object.entries(fields)) { const w = pf.fd(v); data[k] = w; f[k] = w.ID; }
  return { entry: { Type: pf.typeIndex(classpath), Data: data }, id, f };
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

// Layout units. The reference canvas runs ~0.28 rows x 0.30 cols with constants
// hugging their consumer at dx 0.225 (pretty-flux section 2 and 5), so a column
// of 0.60 and a row of 0.30 clears a node box with room for the pipe.
const COL = 0.60, ROW = 0.30;
const NODE_HALF_W = 0.15, NODE_HALF_H = 0.075;

function node(name, classpath, fields = {}, pos = [0, 0, 0]) {
  const c = comp(classpath, fields);
  const s = slot(name, [c.comp], pos);
  return { slot: s, id: c.id, f: c.f, pos };
}
function proxyNode(name, classpath, proxyClasspath, fields = {}, pos = [0, 0, 0], extra = []) {
  const c = comp(classpath, fields);
  const p = comp(proxyClasspath, { Node: c.id, Path: [] });
  return { slot: slot(name, [c.comp, p.comp, ...extra], pos), id: c.id, f: c.f, pos };
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
  URL: LOGO, Uncompressed: false, DirectLoad: false, ForceExactVariant: false,
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

// ── the cards ────────────────────────────────────────────────────────────────
const cardSlots = [], textures = [], activeFields = [];
for (let i = 0; i < MAX_CARDS; i++) {
  const tex = asset(T.Texture, {
    URL: null, Uncompressed: false, DirectLoad: false, ForceExactVariant: false,
    PreferredProfile: 'sRGB', MipMapBias: D(0), IsNormalMap: false,
    WrapModeU: 'Clamp', WrapModeV: 'Clamp', PowerOfTwoAlignThreshold: D(0.05),
    CrunchCompressed: true, MipMaps: true, KeepOriginalMipMaps: false, MipMapFilter: 'Box', Readable: false,
  });
  // Cutout at 0.72, the values the deck bake settled on: Palify art carries its
  // rounded corners in the alpha, and is matted against white so 0.5 leaves a rim.
  const mat = asset(T.Unlit, {
    TintColor: C([1, 1, 1, 1]), Texture: tex.id, BlendMode: 'Cutout', AlphaCutoff: D(0.72),
    UseVertexColors: false, ZWrite: 'Auto',
  });
  const mesh = comp(T.QuadMesh, { Size: V2(CARD_W, CARD_H), DualSided: true, UseVertexColors: false });
  const rend = comp(T.MeshRenderer, {
    Mesh: mesh.id, Materials: pf.list([mat.id]), MaterialPropertyBlocks: [],
    ShadowCastMode: 'On', SortingOrder: I(0),
  });
  // 19 of BP01's 101 cards are printed landscape. Nothing here needs to know
  // which: TextureSizeDriver reads the loaded texture's own pixel size and
  // drives the quad from it. UnitHeight normalises to (aspect, 1), Ratio scales
  // that to CARD_H, and MaxSize caps the width so a landscape card shrinks to
  // fit its cell instead of overlapping its neighbour. No ProtoFlux, and no
  // node that exposes a texture's aspect - which is why this gap stayed open.
  const sizeDriver = comp(T.SizeDriver, {
    Texture: tex.id, Target: mesh.f.Size, DriveMode: 'UnitHeight',
    Premultiply: V2(1, 1), Ratio: V2(CARD_H, CARD_H), MaxSize: V2(CARD_W, CARD_H),
  });
  const col = i % COLS, row = Math.floor(i / COLS);
  const s = slot(`card ${String(i + 1).padStart(2, '0')}`, [mesh.comp, rend.comp, sizeDriver.comp],
    [(col - (COLS - 1) / 2) * (CARD_W + GAP), ((ROWS - 1) / 2 - row) * (CARD_H + GAP), 0]);
  assets.push(tex.entry, mat.entry);
  textures.push(tex); cardSlots.push(s); activeFields.push(s._slot.activeFieldId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS 1 - control. Everything a human reads. About thirty nodes.
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
const failText = strIn('text: could not set ResoPal/url', 'could not set ResoPal/url', [COL * 3.0, -ROW * 12, 0]);
const failPath = strIn('name: ResoPal/event', 'ResoPal/event', [COL * 3.0, -ROW * 13, 0]);
const failSay = node('a write failed -> say so', T.WriteVar, {
  Target: null, Path: failPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: failText.id,
}, [COL * 4.2, -ROW * 12, 0]);
for (const w of urlWrites) {
  w.slot.Components.Data[0].Data.OnNotFound.Data = failSay.id;
  w.slot.Components.Data[0].Data.OnFailed.Data = failSay.id;
}
buttonNodes.push(failText, failPath, failSay);

controlNodes.push(...buttonNodes);
controlZones.push(around('1 · a button picks the URL', buttonNodes));

// Zone 2: the request. The chosen URL is driven into a plain input by a
// DynamicValueVariableDriver, so the graph reads it without a Read node.
const ZX = COL * 5.2;
const urlNode = strIn('the URL to fetch', BUTTONS[2].url, [ZX + COL * 1.5, ROW * 2, 0]);
const urlDriver = comp(T.VarDriver, { VariableName: 'ResoPal/url', Target: urlNode.f.Value, DefaultValue: BUTTONS[2].url });
urlNode.slot.Components.Data.push(urlDriver.comp);
const urlTrunk = strRelay('URL -> request + readout', urlNode.id, [ZX + COL * 2.5, ROW * 2, 0]);
const apiUri = node('URL -> Uri', T.ToUri, { Input: urlTrunk.id }, [ZX + COL * 3.5, ROW * 2, 0]);

const hostStr = strIn('host', PROXY, [ZX, -ROW * 4, 0]);
const hostUri = node('host -> Uri', T.ToUri, { Input: hostStr.id }, [ZX + COL * 1, -ROW * 4, 0]);
const hostTrunk = strRelay('host -> gate + prompt', hostUri.id, [ZX + COL * 2, -ROW * 4, 0]);
// Scope is spelled out on BOTH nodes. Left unwired it defaults to `Everything`,
// which asks "is EVERY kind of access allowed for this host?" - a stricter
// question than the prompt actually grants, so the check can stay false forever
// and re-prompt on every press. We only ever speak HTTP, so say so.
const httpScope = node('scope: HTTP', T.ScopeIn, { Value: 'HTTP' }, [ZX + COL * 1, -ROW * 6, 0]);
const allowed = node('host access granted?', T.IsAllowed, { Host: hostTrunk.id, Scope: httpScope.id }, [ZX + COL * 3, -ROW * 4, 0]);
const reason = strIn('permission reason', 'Fetch Palworld TCG cards from ResoPal', [ZX + COL * 2, -ROW * 8, 0]);
const ask = node('ask for host access', T.RequestHost, {
  Host: hostTrunk.id, Reason: reason.id, Scope: httpScope.id, OnGranted: null, OnDenied: null, OnIgnored: null,
}, [ZX + COL * 3, -ROW * 6, 0]);
const get = node('GET the card list', T.Get, {
  URL: apiUri.id, Content: null, StatusCode: null, OnSent: null, OnResponse: null, OnError: null, OnDenied: null,
}, [ZX + COL * 4, 0, 0]);
const gate = node('allowed ? GET : ask', T.If, { Condition: allowed.id, OnTrue: get.id, OnFalse: ask.id }, [ZX + COL * 1.5, 0, 0]);
// GET_String and RequestHostAccessUrl are both AsyncActionNode. An ordinary
// impulse cannot run one - it needs an async context, and without this the
// chain reaches the gate and then silently stops. One StartAsyncTask here puts
// everything downstream of it, gate included, in that context.
const asyncTask = node('run the rest asynchronously', T.StartAsync,
  { TaskStart: gate.id, OnStarted: null, OnFailed: null }, [ZX, 0, 0]);
ask.slot.Components.Data[0].Data.OnGranted.Data = get.id;
joinTrunk.slot.Components.Data[0].Data.Next.Data = asyncTask.id;

// A refusal is reported here rather than in the event column, for the same
// reason the URL-write failure is reported in zone 1: a wire from the prompt all
// the way across to that column would cut diagonally through everything between.
const refuseText = strIn('text: host access refused', 'host access refused', [ZX + COL * 2, -ROW * 10, 0]);
const refusePath = strIn('name: ResoPal/event', 'ResoPal/event', [ZX + COL * 2, -ROW * 11, 0]);
const refuseSay = node('refused -> say so', T.WriteVar, {
  Target: null, Path: refusePath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: refuseText.id,
}, [ZX + COL * 3.6, -ROW * 10, 0]);
ask.slot.Components.Data[0].Data.OnDenied.Data = refuseSay.id;
ask.slot.Components.Data[0].Data.OnIgnored.Data = refuseSay.id;
get.slot.Components.Data[0].Data.OnDenied.Data = refuseSay.id;

const requestNodes = [urlNode, urlTrunk, apiUri, hostStr, hostUri, hostTrunk, httpScope, allowed, reason, ask, gate, get, asyncTask, refuseText, refusePath, refuseSay];
controlNodes.push(...requestNodes);
controlZones.push(around('2 · gate host access, then GET', requestNodes));

// Zone 3: the readouts. Two lines on the panel, both driven straight from this
// graph, so a failure is legible without opening the flux at all: the URL line
// proves the button and the variable worked, and the status line carries either
// the first record or - because GET_String writes the exception message into
// Content - the network error itself.
const RX = ZX + COL * 9;
const BODY = get.f.Content;
const bodyTrunk = strRelay('response -> readout + decoders', BODY, [RX, 0, 0]);
const firstEnd = node('end of the first record', T.Substr, { Str: bodyTrunk.id, StartIndex: null, Length: null }, [RX + COL * 0.6, -ROW, 0]);
const firstTrim = node('first record, trimmed', T.Trim, { A: firstEnd.id }, [RX + COL * 1.2, -ROW, 0]);
const bodyLen = node('response length', T.StrLen, { A: bodyTrunk.id }, [RX + COL * 0.6, ROW, 0]);
const lenTrunk = intRelay('length -> decoders + status', bodyLen.id, [RX + COL * 1.2, ROW, 0]);
const zeroLen = intIn('0', 0, [RX + COL * 0.6, -ROW * 2.6, 0]);
const gotAny = node('did anything come back?', T.IntGt, { A: lenTrunk.id, B: zeroLen.id }, [RX + COL * 1.8, -ROW * 2.5, 0]);
const statusMsg = node('status: first card, else the error', T.StrPick,
  { Condition: gotAny.id, OnTrue: firstTrim.id, OnFalse: bodyTrunk.id }, [RX + COL * 2.4, 0, 0]);

const statusLabel = label('status text', 'Ready — pick a deck or a booster', 19, CYAN);
const statusFieldId = statusLabel.Components.Data[1].Data.Content.ID;
const urlLabel = label('url text', PROXY, 14, DIM);
const urlFieldId = urlLabel.Components.Data[1].Data.Content.ID;

const dStatus = drive('drive the status line', 'str', statusMsg.id, statusFieldId, [RX + COL * 3.0, 0, 0]);
const dUrl = drive('drive the URL readout', 'str', urlTrunk.id, urlFieldId, [ZX + COL * 3.5, ROW * 3.2, 0]);

// ── which branch actually fired ──────────────────────────────────────────────
// The status line reads GET_String.Content, so it can only describe a request
// that produced a body. These four writes hang off the graph's own terminal
// impulses, so the panel names the branch that ran even when there is no body:
//
//   GET OnResponse            "response received - HTTP {code}"
//   GET OnError               "network error - no answer from the host"
//   GET/prompt OnDenied       "host access refused"
//   the URL write's failures  "could not set ResoPal/url"
//
// The HTTP code is the one that matters most. GET_String writes an exception
// message into Content only on a TRANSPORT failure - a 404 or a 502 is a
// perfectly successful request whose body is not cards, so without the code the
// status line quietly shows the first 64 characters of an error page and the
// panel looks like it half worked.
const EX = ZX + COL * 5;
const eventNodes = [];

// Each outcome gets a relay stub right beside the request node before it travels
// anywhere. That is the house style for a branch, and it is also what keeps this
// column routable: a wire drawn straight from the request to a write four
// columns away sweeps diagonally through everything in between, which is the
// defect that made the URL constants look unconnected in the first build.
const okStub = node('the request answered', T.FlowRelay, { Next: null }, [EX - COL * 0.5, ROW, 0]);
const errStub = node('the request did not answer', T.FlowRelay, { Next: null }, [EX - COL * 0.5, -ROW * 5, 0]);
get.slot.Components.Data[0].Data.OnResponse.Data = okStub.id;
get.slot.Components.Data[0].Data.OnError.Data = errStub.id;

// Row 1: the response, with its HTTP code. StatusCode is a named OUTPUT of the
// request node, so it is addressed by its FIELD id - wiring the node's component
// id would read the action node's own value output, which is not the code.
const okPath = strIn('name: ResoPal/event', 'ResoPal/event', [EX, -ROW * 2, 0]);
const okTmpl = strIn('text: response received - HTTP {0}', 'response received - HTTP {0}', [EX + COL, -ROW * 3, 0]);
const okCast = node('the HTTP code as text', T.StatusCast, { Input: get.f.StatusCode }, [EX, -ROW * 4, 0]);
const okFmt = node('fill in the code', T.Format, { Format: okTmpl.id, Parameters: pf.list([okCast.id]) }, [EX + COL, -ROW * 4, 0]);
const okSay = node('-> ResoPal/event', T.WriteVar, {
  Target: null, Path: okPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: okFmt.id,
}, [EX + COL * 2, -ROW * 2, 0]);
okStub.slot.Components.Data[0].Data.Next.Data = okSay.id;

// Row 2: no answer at all. GET_String writes the exception into Content, so the
// status line carries the detail; this line just names the branch.
const errText = strIn('text: network error - no answer from the host', 'network error - no answer from the host', [EX, -ROW * 6, 0]);
const errPath = strIn('name: ResoPal/event', 'ResoPal/event', [EX, -ROW * 7, 0]);
const errSay = node('-> ResoPal/event', T.WriteVar, {
  Target: null, Path: errPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: errText.id,
}, [EX + COL * 2, -ROW * 6, 0]);
errStub.slot.Components.Data[0].Data.Next.Data = errSay.id;

eventNodes.push(okStub, errStub, okPath, okTmpl, okCast, okFmt, okSay, errText, errPath, errSay);

const evtInput = strIn('the last event', '-', [EX, -ROW * 10, 0]);
evtInput.slot.Components.Data.push(comp(T.VarDriver, {
  VariableName: 'ResoPal/event', Target: evtInput.f.Value, DefaultValue: 'idle - no request yet',
}).comp);
const evtLabel = label('event text', 'idle - no request yet', 14, DIM);
const evtFieldId = evtLabel.Components.Data[1].Data.Content.ID;
const dEvent = drive('drive the event readout', 'str', evtInput.id, evtFieldId, [EX + COL * 2, -ROW * 10, 0]);
eventNodes.push(evtInput, dEvent);

// The URL echo sits beside the relay it reads, which puts it in zone 2's
// footprint - so it counts toward zone 2's rect, not zone 3's.
requestNodes.push(dUrl);
controlNodes.push(dUrl);
controlZones[1] = around('2 · gate host access, then GET', requestNodes);

const readoutNodes = [bodyTrunk, firstEnd, firstTrim, bodyLen, lenTrunk, zeroLen, gotAny, statusMsg, dStatus];
controlNodes.push(...readoutNodes, ...eventNodes);
controlZones.push(around('3 · what the panel shows you', readoutNodes));
controlZones.push(around('4 · which branch fired', eventNodes));

// The first record is a fixed-width slice like every other one; reuse the same
// constants the decoders use rather than a second pair.
const recWidth = intIn(`record width (${RECORD_WIDTH})`, RECORD_WIDTH, [RX - COL, -ROW * 0.6, 0]);
const zeroStart = intIn('first record starts at 0', 0, [RX - COL, -ROW * 1.6, 0]);
firstEnd.slot.Components.Data[0].Data.StartIndex.Data = zeroStart.id;
firstEnd.slot.Components.Data[0].Data.Length.Data = recWidth.id;
controlNodes.push(recWidth, zeroStart);
controlZones[2] = around('3 · what the panel shows you', readoutNodes.concat([recWidth, zeroStart]));

const controlFlux = slot('Flux - control', [], [0, 1.35, 0],
  [zones(controlZones), ...controlNodes.map((n) => n.slot)], 'Moduprint.ProtoFlux', controlId);

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS 2 - card decoders. Generated, seventy times the same five nodes.
// ═══════════════════════════════════════════════════════════════════════════════
// Because records are fixed width, card i is a constant slice at i*64 - no
// cursor, no chaining, every card independent of every other. Each row of ten
// taps the response, the width and the length through its own relay bank, so no
// producer carries seventy wires.
const decoderNodes = [], decoderZones = [];
const CARD_DX = COL * 4.2, CARD_DY = ROW * 3.4;

const busBody = strRelay('response', bodyTrunk.id, [-COL * 3.4, 0, 0]);
const busWidth = intIn(`record width (${RECORD_WIDTH})`, RECORD_WIDTH, [-COL * 3.4, -ROW, 0]);
const busLen = intRelay('response length', lenTrunk.id, [-COL * 3.4, -ROW * 2, 0]);
const bus = [busBody, busWidth, busLen];
decoderNodes.push(...bus);
decoderZones.push(around('bus · one tap per row', bus));

for (let row = 0; row < ROWS; row++) {
  const rowY = -CARD_DY * row - ROW * 4;
  const rowBody = strRelay(`row ${row + 1}: response`, busBody.id, [-COL * 1.9, rowY, 0]);
  const rowWidth = intRelay(`row ${row + 1}: record width`, busWidth.id, [-COL * 1.9, rowY - ROW, 0]);
  const rowLen = intRelay(`row ${row + 1}: response length`, busLen.id, [-COL * 1.9, rowY - ROW * 2, 0]);
  const rowNodes = [rowBody, rowWidth, rowLen];

  for (let col = 0; col < COLS; col++) {
    const i = row * COLS + col;
    const x = col * CARD_DX;
    const n = String(i + 1).padStart(2, '0');
    // Card i's record starts at a constant offset. Everything else is a slice,
    // a trim and a compare - nothing depends on any other card.
    const start = intIn(`card ${n}: starts at ${i * RECORD_WIDTH}`, i * RECORD_WIDTH, [x, rowY, 0]);
    const raw = node(`card ${n}: its record`, T.Substr, { Str: rowBody.id, StartIndex: start.id, Length: rowWidth.id }, [x + COL, rowY, 0]);
    const url = node(`card ${n}: trim the padding`, T.Trim, { A: raw.id }, [x + COL * 2, rowY, 0]);
    const uri = node(`card ${n}: -> Uri`, T.ToUri, { Input: url.id }, [x + COL * 3, rowY, 0]);
    // Present iff the response actually reaches this card's offset.
    const present = node(`card ${n}: is it there?`, T.IntGt, { A: rowLen.id, B: start.id }, [x + COL, rowY - ROW, 0]);
    const dUrlCard = drive(`card ${n}: drive art URL`, 'uri', uri.id, textures[i].f.URL, [x + COL * 3, rowY - ROW, 0]);
    const dOnCard = drive(`card ${n}: drive visible`, 'bool', present.id, activeFields[i], [x + COL * 2, rowY - ROW, 0]);
    rowNodes.push(start, raw, url, uri, present, dUrlCard, dOnCard);
  }
  decoderNodes.push(...rowNodes);
  decoderZones.push(around(
    row === 0 ? `cards 01–10 · every card is this same five-node slice` : `cards ${String(row * COLS + 1).padStart(2, '0')}–${String(row * COLS + COLS).padStart(2, '0')}`,
    rowNodes));
}

const decoderFlux = slot('Flux - card decoders', [], [0, -1.6, 0],
  [zones(decoderZones), ...decoderNodes.map((n) => n.slot)], 'Moduprint.ProtoFlux');

// ── assemble ─────────────────────────────────────────────────────────────────
const urlVar = comp(T.StrVar, { VariableName: 'ResoPal/url', Value: BUTTONS[2].url, OverrideOnLink: false });
const evtVar = comp(T.StrVar, { VariableName: 'ResoPal/event', Value: 'idle — no request yet', OverrideOnLink: false });
const varsSlot = slot('Vars', [urlVar.comp, evtVar.comp], [0, 0, 0]);

const bg = slot('BG', [
  rect().comp,
  image(INK).comp,
  comp(T.VerticalLayout, {
    PaddingTop: D(18), PaddingRight: D(18), PaddingBottom: D(18), PaddingLeft: D(18),
    Spacing: D(11), HorizontalAlign: 'Center', VerticalAlign: 'Top',
    ForceExpandWidth: true, ForceExpandHeight: false,
  }).comp,
], [0, 0, 0], [
  bar('Header', 76, GOLD, '<b>RESOPAL</b>', 40, INK, [logoMark()]),
  slot('Status', [rect().comp, layoutElement(50).comp, image(PANEL).comp], [0, 0, 0], [statusLabel]),
  slot('URL', [rect().comp, layoutElement(26).comp, image(INK).comp], [0, 0, 0], [urlLabel]),
  slot('Event', [rect().comp, layoutElement(26).comp, image(INK).comp], [0, 0, 0], [evtLabel]),
  ...BUTTONS.map((b) => button(controlId, b)),
  label('Footer', 'Cards & data by Palify · palify.org', 15, DIM),
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

const cards = slot('Cards', [], [0, 0, 0], cardSlots);
const credits = slot('credits', [], [0, 0, 0], [
  slot('Card images & deck data by Palify - palify.org'),
  slot('ResoPal by Dalek - resopal.dalek.coffee'),
]);

const root = slot('ResoPal', [
  comp(T.Grabbable, { Scalable: true }).comp,
  comp(T.ObjectRoot, {}).comp,
  comp(T.VarSpace, { SpaceName: 'ResoPal', OnlyDirectBinding: false }).comp,
], [0, 0, 0], [varsSlot, canvasSlot, cards, credits, controlFlux, decoderFlux], null, pf.rootId);

const res = await pf.exportPackage({
  name: 'ResoPal Panel',
  root, assets,
  embeddedAssets: [{ hash: FONT_HASH, bytes: fontBytes }],
  outPath: path.join(import.meta.dirname, 'out', 'ResoPal_Panel.resonitepackage'),
  version: '2026.6.24.835',
  typeVersions: TYPE_VERSIONS,
});

console.log(`\n  buttons        ${BUTTONS.length}`);
BUTTONS.forEach((b) => console.log(`                   ${b.label.padEnd(32)} ${b.url}`));
console.log(`  control canvas ${controlNodes.length} nodes, ${controlZones.length} comment zones`);
console.log(`  decoder canvas ${decoderNodes.length} nodes, ${decoderZones.length} comment zones`);
console.log(`  cards          up to ${MAX_CARDS} (${COLS}x${ROWS}), each a constant slice at i*${RECORD_WIDTH}`);
console.log(`  panel          ${CANVAS_W}x${CANVAS_H} units at ${CANVAS_SCALE} = ${(CANVAS_W * CANVAS_SCALE).toFixed(2)}x${(CANVAS_H * CANVAS_SCALE).toFixed(2)} m`);
if (!res.ok) process.exitCode = 1;
