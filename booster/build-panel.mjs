// Build the ResoPal in-world panel: a UIX panel with buttons that fetch a deck
// or a booster pull from resopal and lay the cards out in front of you.
//
// This replaces an earlier build that emitted logic-only ProtoFlux with no UI. It
// was unusable for two reasons worth writing down: there was nothing to look at
// unless the network call already worked, and the node positions were spaced
// tighter than a ProtoFlux node visual, so unpacking produced an overlapping heap.
// Both are fixed here - the panel is visible and interactive before any request
// happens, and the graph is grouped into labelled (f) clusters on a real grid.
//
// Nothing about a deck is baked in. The panel knows five URLs; the card codes,
// their count and their order all arrive over the wire.
//
//   RKL=/path/to/Resonite-Knowledge-Library node build-panel.mjs
//
// Every classpath and field shape below was read out of a real decoded package -
// mostly the owner's own WS_Connector panel - or the decompiled engine. Guessed
// classpaths fail silently in-world, so nothing here is guessed.

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
const ART = `${PROXY}/img/`;
// The site serves the mark; the panel loads it over http rather than embedding a
// copy, so re-branding is a file swap on resopal and not a rebuild of this.
const LOGO = process.env.LOGO || 'https://resopal.dalek.coffee/assets/logo.png';

// The buttons. Each is a label and a URL, nothing more - adding a set or a deck
// is a line here, and the panel never learns what is inside one.
const BUTTONS = [
  { tag: 'deck/td01',  label: 'Trial Deck  ·  Red / Blue',     url: `${PROXY}/api/deck?deck=td01&format=flat` },
  { tag: 'deck/td02',  label: 'Trial Deck  ·  Green / Purple', url: `${PROXY}/api/deck?deck=td02&format=flat` },
  { tag: 'pack/1',     label: 'Open 1 Booster  ·  BP01',       url: `${PROXY}/api/pull?set=BP01&packs=1&format=flat` },
  { tag: 'pack/3',     label: 'Open 3 Boosters  ·  BP01',      url: `${PROXY}/api/pull?set=BP01&packs=3&format=flat` },
  { tag: 'pack/10',    label: 'Open 10 Boosters  ·  BP01',     url: `${PROXY}/api/pull?set=BP01&packs=10&format=flat` },
];

// 70 = the largest thing any button can ask for (10 boosters), and the same 10x7
// the deck template's atlas grid uses. A card is visible exactly when its line
// parsed, so a 7-card pull leaves the other 63 switched off - no count needed
// anywhere in the graph.
const COLS = 10, ROWS = 7, MAX_CARDS = COLS * ROWS;
const CARD_W = 0.063, CARD_H = 0.088, GAP = 0.008;

// Canvas units. The slot scale turns them into metres.
const CANVAS_W = 620, CANVAS_H = 600, CANVAS_SCALE = 0.00058;

// From the ResoPal mark: gold on near-black, with the logo's cyan for the accent.
const hex = (h, a = 1) => [...h.match(/[\da-f]{2}/gi).map((c) => parseInt(c, 16) / 255), a];
const GOLD = hex('c8a35e'), INK = hex('12100c'), PANEL = hex('1c1913');
const BTN = hex('2a251b'), BTN_HI = hex('3d3626'), BTN_PRESS = hex('c8a35e');
const CYAN = hex('4fd8e8'), TEXT = hex('e8e2d4'), DIM = hex('8a8272');

// ── verbatim classpaths ──────────────────────────────────────────────────────
const PB = '[ProtoFluxBindings]FrooxEngine.ProtoFlux.Runtimes.Execution.Nodes.';
const FE = '[FrooxEngine]FrooxEngine.';
const UIX = FE + 'UIX.';
const T = {
  // flux
  IsAllowed:   PB + 'FrooxEngine.Network.IsHostAccessAllowedUrl',
  RequestHost: PB + 'FrooxEngine.Network.RequestHostAccessUrl',
  Get:         PB + 'FrooxEngine.Network.GET_String',
  If:          PB + 'If',
  StrIn:       PB + 'ValueObjectInput<string>',
  IntIn:       PB + 'ValueInput<int>',
  IndexOf:     PB + 'Strings.IndexOfString',
  Substr:      PB + 'Strings.Substring',
  Concat:      PB + 'Strings.ConcatenateMultiString',
  ToUri:       PB + 'Utility.Uris.StringToAbsoluteURI',
  IntAdd:      PB + 'Operators.ValueAdd<int>',
  IntSub:      PB + 'Operators.ValueSub<int>',
  IntGt:       PB + 'Operators.ValueGreaterThan<int>',
  StrPick:     PB + 'ObjectConditional<string>',
  IntPick:     PB + 'ValueConditional<int>',
  Receiver:    PB + 'Actions.DynamicImpulseReceiver',
  ReceiverProxy: '[ProtoFlux.Nodes.FrooxEngine]ProtoFlux.Runtimes.Execution.Nodes.Actions.DynamicImpulseReceiver+Proxy',
  WriteVar:    PB + 'FrooxEngine.Variables.WriteDynamicValueVariable<string>',
  GlobalStr:   FE + 'ProtoFlux.GlobalValue<string>',
  UriDrive:      '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectFieldDrive<Uri>',
  UriDriveProxy: FE + 'ProtoFlux.CoreNodes.FieldDriveBase<Uri>+Proxy',
  StrDrive:      '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectFieldDrive<string>',
  StrDriveProxy: FE + 'ProtoFlux.CoreNodes.FieldDriveBase<string>+Proxy',
  BoolDrive:     '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ValueFieldDrive<bool>',
  BoolDriveProxy: FE + 'ProtoFlux.CoreNodes.FieldDriveBase<bool>+Proxy',
  // scene
  Grabbable: FE + 'Grabbable',
  ObjectRoot: FE + 'ObjectRoot',
  VarSpace: FE + 'DynamicVariableSpace',
  StrVar: FE + 'DynamicValueVariable<string>',
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
  // uix
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
// doc.Assets serialize `persistent` as a wrapped bool. Both shapes are verbatim
// from real packages - mixing them up is a silent load failure.
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
// Like pf.makeSlot, but hands back the Active field id so flux can drive it.
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

// ProtoFlux node = one slot, one logic component. Positions are laid out on a
// grid sized for actual node visuals (~0.4 x 0.28) rather than the far tighter
// spacing that made the first build unreadable once unpacked.
const NODE_DX = 0.45, NODE_DY = 0.30;
function node(name, classpath, fields = {}, pos = [0, 0, 0]) {
  const c = comp(classpath, fields);
  return { slot: slot(name, [c.comp], pos), id: c.id, f: c.f };
}
// A proxy node: the logic component plus its +Proxy companion on one slot, the
// shape OnDestroying uses in this repo's own deck template.
function proxyNode(name, classpath, proxyClasspath, fields = {}, pos = [0, 0, 0], extra = []) {
  const c = comp(classpath, fields);
  const p = comp(proxyClasspath, { Node: c.id, Path: [] });
  return { slot: slot(name, [c.comp, p.comp, ...extra], pos), id: c.id, f: c.f };
}
const strIn = (name, s, pos) => node(name, T.StrIn, { Value: s }, pos);
const intIn = (name, n, pos) => node(name, T.IntIn, { Value: I(n) }, pos);

// The drive pair, for the three field types this panel writes.
function drive(name, kind, sourceId, targetFieldId, pos) {
  const [cls, proxyCls] = { uri: [T.UriDrive, T.UriDriveProxy], str: [T.StrDrive, T.StrDriveProxy], bool: [T.BoolDrive, T.BoolDriveProxy] }[kind];
  const d = comp(cls, { Value: sourceId });
  const p = comp(proxyCls, { Node: d.id, Path: [], Drive: targetFieldId });
  return { slot: slot(name, [d.comp, p.comp], pos), id: d.id };
}

// ── the font ─────────────────────────────────────────────────────────────────
// UIX Text needs a real font asset: Text.OnAttach assigns the world default, but
// OnAttach does not run on load, so a null Font renders nothing. This is the same
// stock font the Deck Maker template already embeds, lifted from our own template
// rather than someone else's package - it is already in every deck ResoPal ships.
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
/** A label sitting inside its parent's rect - no layout controller needed. */
const label = (name, content, size, color, opts = {}) =>
  slot(name, [rect().comp, text(content, size, color, opts).comp]);

/** A row in the panel: background + fixed height + a centred caption. */
function bar(name, h, tint, content, size, color, extra = []) {
  return slot(name, [rect().comp, layoutElement(h).comp, image(tint).comp], [0, 0, 0],
    [label(name + ' label', content, size, color), ...extra]);
}

// UIX Image draws a Sprite, not a texture, so the mark goes through a
// SpriteProvider. If the file is not on the site yet the texture simply never
// arrives and the header keeps its bar and title - no broken state.
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
  comp(T.Rect, {
    AnchorMin: V2(0.015, 0.08), AnchorMax: V2(0.14, 0.92),
    OffsetMin: V2(0, 0), OffsetMax: V2(0, 0), Pivot: V2(0.5, 0.5),
  }).comp,
  comp(T.Image, {
    Sprite: logoSprite.id, Material: uiMat.id, PreserveAspect: true, NineSliceSizing: 'TextureSize',
    FlipHorizontally: false, FlipVertically: false, InteractionTarget: false,
    FillRect: { X: D(0), Y: D(0), Width: D(1), Height: D(1) }, Tint: C([1, 1, 1, 1]),
  }).comp,
]);

/**
 * A button. The Button component tints the Image on this same slot through its
 * ColorDrivers list, and ButtonDynamicImpulseTrigger fires a named impulse at the
 * root on press - so the button and the graph never reference each other. That is
 * what lets the flux live in its own subtree without a cross-object reference to
 * get wrong.
 */
function button(rootId, { tag, label: caption }) {
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
    Target: rootId, ExcludeDisabled: true, PressedTag: `ResoPal/${tag}`,
    PressingTag: null, ReleasedTag: null, HoverEnterTag: null, HoverStayTag: null, HoverLeaveTag: null,
  });
  return slot(`btn ${tag}`, [r.comp, layoutElement(62).comp, img.comp, btn.comp, trigger.comp], [0, 0, 0],
    [label('caption', caption, 26, TEXT)]);
}

// ── the cards ────────────────────────────────────────────────────────────────
// One texture and one material per card. This is the whole reason the in-world
// object is not the deck object: the deck's cards share a single atlas with the
// UVs baked into the mesh, so card 3 cannot be pointed anywhere else.
const cardSlots = [], textures = [], activeFields = [];
for (let i = 0; i < MAX_CARDS; i++) {
  const tex = asset(T.Texture, {
    URL: null, Uncompressed: false, DirectLoad: false, ForceExactVariant: false,
    PreferredProfile: 'sRGB', MipMapBias: D(0), IsNormalMap: false,
    WrapModeU: 'Clamp', WrapModeV: 'Clamp', PowerOfTwoAlignThreshold: D(0.05),
    CrunchCompressed: true, MipMaps: true, KeepOriginalMipMaps: false, MipMapFilter: 'Box', Readable: false,
  });
  // Cutout at 0.72, the values the deck bake settled on: Palify art carries its
  // rounded corners in the alpha, and the art is matted against white so a 0.5
  // threshold leaves a pale rim (docs/PIPELINE.md).
  const mat = asset(T.Unlit, {
    TintColor: C([1, 1, 1, 1]), Texture: tex.id, BlendMode: 'Cutout', AlphaCutoff: D(0.72),
    UseVertexColors: false, ZWrite: 'Auto',
  });
  const mesh = comp(T.QuadMesh, { Size: V2(CARD_W, CARD_H), DualSided: true, UseVertexColors: false });
  const rend = comp(T.MeshRenderer, {
    Mesh: mesh.id, Materials: pf.list([mat.id]), MaterialPropertyBlocks: [],
    ShadowCastMode: 'On', SortingOrder: I(0),
  });
  const col = i % COLS, row = Math.floor(i / COLS);
  const s = slot(`card ${String(i + 1).padStart(2, '0')}`, [mesh.comp, rend.comp],
    [(col - (COLS - 1) / 2) * (CARD_W + GAP), ((ROWS - 1) / 2 - row) * (CARD_H + GAP), 0]);
  assets.push(tex.entry, mat.entry);
  textures.push(tex); cardSlots.push(s); activeFields.push(s._slot.activeFieldId);
}

// ── flux ─────────────────────────────────────────────────────────────────────
const fluxGroups = [];
let gx = 0;
const group = (name, nodes, at) => { fluxGroups.push(slot(name, [], at ?? [gx++ * 3.2, 0, 0], nodes.map((n) => n.slot))); };

// The URL the panel is about to fetch lives in a dynamic variable, so five
// buttons share one request path instead of five GETs with five response bodies
// to multiplex back together.
const urlVar = comp(T.StrVar, { VariableName: 'ResoPal/url', Value: BUTTONS[2].url, OverrideOnLink: false });
const varsSlot = slot('Vars', [urlVar.comp], [0, 0, 0]);

// ValueObjectInput is a node whose Value is a plain field, so a
// DynamicValueVariableDriver can write the chosen URL straight into it.
const urlNode = strIn('the URL to fetch', BUTTONS[2].url, [0, 0, 0]);
const urlDriver = comp(T.VarDriver, {
  VariableName: 'ResoPal/url', Target: urlNode.f.Value, DefaultValue: BUTTONS[2].url,
});
urlNode.slot.Components.Data.push(urlDriver.comp);

const apiUri = node('URL -> Uri', T.ToUri, { Input: urlNode.id }, [NODE_DX, 0, 0]);
const hostStr = strIn('host', PROXY, [0, -NODE_DY, 0]);
const hostUri = node('host -> Uri', T.ToUri, { Input: hostStr.id }, [NODE_DX, -NODE_DY, 0]);

const get = node('GET the list', T.Get, {
  URL: apiUri.id, Content: null, StatusCode: null, OnSent: null, OnResponse: null, OnError: null, OnDenied: null,
}, [NODE_DX * 3, 0, 0]);
const BODY = get.f.Content;

const allowed = node('host access granted?', T.IsAllowed, { Host: hostUri.id, Scope: null }, [NODE_DX * 2, -NODE_DY, 0]);
const reason = strIn('permission reason', 'Fetch Palworld TCG cards from ResoPal', [0, -NODE_DY * 2, 0]);
const ask = node('ask for host access', T.RequestHost, {
  Host: hostUri.id, Reason: reason.id, Scope: null, OnGranted: get.id, OnDenied: null, OnIgnored: null,
}, [NODE_DX * 2, -NODE_DY * 2, 0]);
const gate = node('allowed ? GET : ask', T.If, { Condition: allowed.id, OnTrue: get.id, OnFalse: ask.id }, [NODE_DX * 2, 0, 0]);

group('(f) fetch', [urlNode, apiUri, hostStr, hostUri, allowed, reason, ask, gate, get]);

// One receiver per button. The tag string lives in a GlobalValue<string> on the
// receiver's own slot, which is how the engine's own graphs wire it.
const varPath = strIn('variable: ResoPal/url', 'ResoPal/url', [0, NODE_DY, 0]);
const buttonNodes = [varPath];
BUTTONS.forEach((b, i) => {
  const tagValue = comp(T.GlobalStr, { Value: `ResoPal/${b.tag}` });
  const url = strIn(`url: ${b.tag}`, b.url, [0, -i * NODE_DY, 0]);
  const write = node(`set URL := ${b.tag}`, T.WriteVar, {
    Target: null, Path: varPath.id, OnNotFound: null, OnSuccess: gate.id, OnFailed: null, Value: url.id,
  }, [NODE_DX * 2, -i * NODE_DY, 0]);
  const recv = proxyNode(`on press: ${b.tag}`, T.Receiver, T.ReceiverProxy,
    { Tag: tagValue.id, OnTriggered: write.id }, [NODE_DX, -i * NODE_DY, 0], [tagValue.comp]);
  buttonNodes.push(url, write, recv);
});
group('(f) buttons', buttonNodes);

// ── parse: one chain per card ────────────────────────────────────────────────
// The response is one `CODE,RARITY` line per physical card. Line starts are found
// by walking newlines with IndexOfString's StartIndex, because ProtoFlux has no
// split. A card's slot is Active exactly when its own line parsed, which is what
// makes the count dynamic without the graph ever counting anything.
const artBase = strIn('art URL prefix', ART, [0, 0, 0]);
const ONE = intIn('1', 1, [0, -NODE_DY, 0]);
const ZERO = intIn('line 0 starts at 0', 0, [0, -NODE_DY * 2, 0]);
const MINUS1 = intIn('-1 (no more lines)', -1, [NODE_DX, -NODE_DY * 2, 0]);
const NL = strIn('needle: newline', '\n', [0, -NODE_DY * 3, 0]);
const COMMA = strIn('needle: comma', ',', [0, -NODE_DY * 4, 0]);
group('(f) constants', [artBase, ONE, ZERO, MINUS1, NL, COMMA], [-3.2, 0, 0]);

let start = ZERO;
let firstNewline = null;
for (let i = 0; i < MAX_CARDS; i++) {
  const y = (k) => [NODE_DX * k, 0, 0];
  const comma = node(`find comma`, T.IndexOf, { Str: BODY, Part: COMMA.id, StartIndex: start.id, SearchFromEnd: null, ComparisonMode: null }, y(0));
  const len = node(`code length`, T.IntSub, { A: comma.id, B: start.id }, y(1));
  const code = node(`the card code`, T.Substr, { Str: BODY, StartIndex: start.id, Length: len.id }, y(2));
  const url = node(`art URL`, T.Concat, { Inputs: pf.list([artBase.id, code.id]) }, y(3));
  const uri = node(`-> Uri`, T.ToUri, { Input: url.id }, y(4));
  const ok = node(`did this line parse?`, T.IntGt, { A: comma.id, B: start.id }, [0, -NODE_DY, 0]);
  const dUrl = drive(`drive texture URL`, 'uri', uri.id, textures[i].f.URL, y(5));
  const dOn = drive(`drive card visible`, 'bool', ok.id, activeFields[i], [NODE_DX * 5, -NODE_DY, 0]);

  const chain = [comma, len, code, url, uri, ok, dUrl, dOn];
  if (i < MAX_CARDS - 1) {
    const nl = node(`find newline`, T.IndexOf, { Str: BODY, Part: NL.id, StartIndex: start.id, SearchFromEnd: null, ComparisonMode: null }, [0, -NODE_DY * 2, 0]);
    const more = node(`is there another line?`, T.IntGt, { A: nl.id, B: MINUS1.id }, [NODE_DX, -NODE_DY * 2, 0]);
    const step = node(`next line starts here`, T.IntAdd, { A: nl.id, B: ONE.id }, [NODE_DX * 2, -NODE_DY * 2, 0]);
    // Past the last line the cursor must STOP, not wrap. IndexOfString returns -1
    // for a start index below zero or at/after the end, so parking the cursor on
    // -1 makes every later card find no comma, report false, and stay hidden.
    // Letting it fall to nl+1 = 0 instead would restart at line 0 and light up
    // every remaining card with the first card's art - which is exactly what the
    // first build of this did.
    const next = node(`or stop here`, T.IntPick, { Condition: more.id, OnTrue: step.id, OnFalse: nl.id }, [NODE_DX * 3, -NODE_DY * 2, 0]);
    chain.push(nl, more, step, next);
    if (i === 0) firstNewline = nl;
    start = next;
  }
  // Groups are spread on a wide grid so an unpacked graph reads as separate
  // clusters instead of one heap.
  group(`(f) card ${String(i + 1).padStart(2, '0')}`, chain, [(i % 10) * 3.2, -2.0 - Math.floor(i / 10) * 1.6, 0]);
}

// ── status line ──────────────────────────────────────────────────────────────
// GET_String writes the exception message into Content when a request fails, so
// showing the first line of the body doubles as the error display - which is the
// difference between "nothing happened" and knowing why.
const statusLabel = label('status text', 'Ready — pick a deck or a booster', 20, CYAN, { h: 'Center', v: 'Middle' });
const statusText = statusLabel.Components.Data[1];
const statusFieldId = statusText.Data.Content.ID;

const firstLine = node('first line of the response', T.Substr, { Str: BODY, StartIndex: ZERO.id, Length: firstNewline.id }, [0, 0, 0]);
const gotAny = node('any line at all?', T.IntGt, { A: firstNewline.id, B: ZERO.id }, [0, -NODE_DY, 0]);
const statusPick = node('first line, else whole body', T.StrPick, { Condition: gotAny.id, OnTrue: firstLine.id, OnFalse: BODY }, [NODE_DX, -NODE_DY, 0]);
const statusMsg = node('status text', T.Concat, { Inputs: pf.list([statusPick.id]) }, [NODE_DX * 2, 0, 0]);
const dStatus = drive('drive the status line', 'str', statusMsg.id, statusFieldId, [NODE_DX * 3, 0, 0]);
group('(f) status', [firstLine, gotAny, statusPick, statusMsg, dStatus], [-3.2, -2.0, 0]);

// ── assemble ─────────────────────────────────────────────────────────────────
const rootId = pf.rootId;

const bg = slot('BG', [
  rect().comp,
  image(INK).comp,
  comp(T.VerticalLayout, {
    PaddingTop: D(18), PaddingRight: D(18), PaddingBottom: D(18), PaddingLeft: D(18),
    Spacing: D(12), HorizontalAlign: 'Center', VerticalAlign: 'Top',
    ForceExpandWidth: true, ForceExpandHeight: false,
  }).comp,
], [0, 0, 0], [
  bar('Header', 76, GOLD, '<b>RESOPAL</b>', 40, INK, [logoMark()]),
  slot('Status', [rect().comp, layoutElement(56).comp, image(PANEL).comp], [0, 0, 0], [statusLabel]),
  ...BUTTONS.map((b) => button(rootId, b)),
  label('Footer', 'Cards & data by Palify · palify.org', 16, DIM),
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
  [0, 0.62, 0], [bg], null, pf.nextId(), [CANVAS_SCALE, CANVAS_SCALE, CANVAS_SCALE]);

const cards = slot('Cards', [], [0, 0, 0], cardSlots);
const flux = slot('Flux', [], [0, 1.2, 0], fluxGroups, 'Moduprint.ProtoFlux');

// Palify's credit is a permanent requirement, not a courtesy.
const credits = slot('credits', [], [0, 0, 0], [
  slot('Card images & deck data by Palify - palify.org'),
  slot('ResoPal by Dalek - resopal.dalek.coffee'),
]);

const root = slot('ResoPal', [
  comp(T.Grabbable, { Scalable: true }).comp,
  comp(T.ObjectRoot, {}).comp,
  comp(T.VarSpace, { SpaceName: 'ResoPal', OnlyDirectBinding: false }).comp,
], [0, 0, 0], [varsSlot, canvasSlot, cards, credits, flux], null, rootId);

const res = await pf.exportPackage({
  name: 'ResoPal Panel',
  root, assets,
  embeddedAssets: [{ hash: FONT_HASH, bytes: fontBytes }],
  outPath: path.join(import.meta.dirname, 'out', 'ResoPal_Panel.resonitepackage'),
  version: '2026.6.24.835',
  typeVersions: TYPE_VERSIONS,
});

console.log(`\n  buttons    ${BUTTONS.length}`);
BUTTONS.forEach((b) => console.log(`               ${b.label.padEnd(34)} ${b.url}`));
console.log(`  cards      up to ${MAX_CARDS} (${COLS}x${ROWS}), shown only when their line parsed`);
console.log(`  flux       ${fluxGroups.length} labelled groups`);
console.log(`  panel      ${CANVAS_W}x${CANVAS_H} units at ${CANVAS_SCALE} = ${(CANVAS_W * CANVAS_SCALE).toFixed(2)}x${(CANVAS_H * CANVAS_SCALE).toFixed(2)} m`);
if (!res.ok) process.exitCode = 1;
