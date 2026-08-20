// Build the in-world booster spawner: ResoPal_Booster_BP01.resonitepackage
//
// What it is: a grabbable object holding seven card quads. On spawn it asks for
// host access, GETs /api/pull?format=flat, takes the seven `code,rarity` lines
// apart with the Strings family, and drives each card's StaticTexture2D.URL at
// the image proxy. No bake, no download, no atlas - the cards appear as fast as
// the images load.
//
// Why NOT the deck package: the deck's cards share ONE atlas texture with the
// per-card UVs baked into the mesh, so card 3 cannot point somewhere else - and
// nothing in-world can compose an 8192 atlas anyway (docs/WORKER.md). Seven
// independent textures is the only shape that works at runtime. The deck path
// still exists and is better for keeping a pull: rip on the site and export.
// Both roll through the same endpoint, so a seed reproduces one from the other.
//
// Requires the Resonite Knowledge Library for its ProtoFlux encoder. That library
// is not vendored here - point at a checkout:
//   RKL=../Resonite-Knowledge-Library node booster/build-spawner.mjs
//
// HONESTY: this validates as a structurally-correct package with zero dangling
// references and a round-trip-identical re-decode. Only a VR drag-test confirms
// Resonite accepts and runs it. See booster/README.md for what to check first.

import { Int32 } from 'bson';
import path from 'node:path';
import { existsSync } from 'node:fs';

const RKL = process.env.RKL || path.resolve(import.meta.dirname, '..', '..', 'Resonite-Knowledge-Library');
const encoder = path.join(RKL, 'protoflux', 'skill', 'scripts', 'protoflux.mjs');
if (!existsSync(encoder)) {
  console.error(`Cannot find the ProtoFlux encoder at:\n  ${encoder}\n\n` +
    `Clone the Resonite Knowledge Library and point RKL at it:\n` +
    `  RKL=/path/to/Resonite-Knowledge-Library node booster/build-spawner.mjs\n`);
  process.exit(1);
}
const { ProtoFlux } = await import(`file://${encoder}`);

// ── configuration ────────────────────────────────────────────────────────────
const PROXY = process.env.PROXY || 'https://resopal-proxy.dalek.workers.dev';
const SET = process.env.SET || 'BP01';
const PACK_SIZE = 7;
const PULL_URL = `${PROXY}/api/pull?set=${SET}&packs=1&format=flat`;
const ART_URL = `${PROXY}/img/`;              // + CODE  -> the card's 1024px art
const FALLBACK_URL = `${PROXY}/img/${SET}-001?w=256`;   // shown when a line fails to parse

// Real card proportions: 63 x 88 mm.
const CARD_W = 0.063, CARD_H = 0.088;
// Stack spacing. Cards sit in the XY plane and stack along +Z, matching the deck
// template's own convention (its card slots run +Z to -Z in list order), so index
// 0 - the rarest card - is at the top of the stack in both paths.
const CARD_GAP = 0.0012;

// ── verbatim classpaths ──────────────────────────────────────────────────────
// Every one of these was read off a real decoded package or the decompiled
// source, never inferred - wrong classpaths fail silently in-world.
//   ObjectFieldDrive<Uri> / FieldDriveBase<Uri>+Proxy  <- StreamRedeems capture
//   OnStart / OnStart+Proxy shape                      <- OnDestroying in the deck template
//   GET_String, host-access, QuadMesh, UnlitMaterial   <- decompiled 2026.6.24.835
const PB = '[ProtoFluxBindings]FrooxEngine.ProtoFlux.Runtimes.Execution.Nodes.';
const FE = '[FrooxEngine]FrooxEngine.';
const T = {
  OnStart:      PB + 'FrooxEngine.Slots.OnStart',
  OnStartProxy: '[ProtoFlux.Nodes.FrooxEngine]ProtoFlux.Runtimes.Execution.Nodes.FrooxEngine.Slots.OnStart+Proxy',
  IsAllowed:    PB + 'FrooxEngine.Network.IsHostAccessAllowedUrl',
  RequestHost:  PB + 'FrooxEngine.Network.RequestHostAccessUrl',
  Get:          PB + 'FrooxEngine.Network.GET_String',
  If:           PB + 'If',
  StrIn:        PB + 'ValueObjectInput<string>',
  IntIn:        PB + 'ValueInput<int>',
  IndexOf:      PB + 'Strings.IndexOfString',
  Substr:       PB + 'Strings.Substring',
  Concat:       PB + 'Strings.ConcatenateMultiString',
  ToUri:        PB + 'Utility.Uris.StringToAbsoluteURI',
  IntAdd:       PB + 'Operators.ValueAdd<int>',
  IntSub:       PB + 'Operators.ValueSub<int>',
  IntGt:        PB + 'Operators.ValueGreaterThan<int>',
  StrPick:      PB + 'ObjectConditional<string>',
  UriDrive:     '[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ObjectFieldDrive<Uri>',
  UriDriveProxy: FE + 'ProtoFlux.CoreNodes.FieldDriveBase<Uri>+Proxy',
  QuadMesh:     FE + 'QuadMesh',
  MeshRenderer: FE + 'MeshRenderer',
  Unlit:        FE + 'UnlitMaterial',
  Texture:      FE + 'StaticTexture2D',
  Grabbable:    FE + 'Grabbable',
  BoxCollider:  FE + 'BoxCollider',
};
// From the leaf `override int Version` in the decompile. An absent entry declares
// version 0, and the engine then migrates the fields on import - silently.
const TYPE_VERSIONS = { [T.Grabbable]: 2, [T.BoxCollider]: 1 };

const pf = ProtoFlux();
const D = pf.D, I = (n) => new Int32(n);

// Node helper that also hands back each field's wrapper ID. Output-sentinel fields
// (GET_String.Content, and every StaticTexture2D.URL) are addressed by FIELD id,
// not component id - that distinction is THE addressing rule and getting it wrong
// is the classic silent failure.
let _slot = 0;
const P = () => [(_slot % 9) * 0.17 - 0.7, -Math.floor(_slot++ / 9) * 0.15, 0];
function N(name, classpath, fields = {}) {
  const id = pf.nextId();
  const data = { ID: id, 'persistent-ID': pf.nextId(), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) };
  const f = {};
  for (const [k, v] of Object.entries(fields)) { const w = pf.fd(v); data[k] = w; f[k] = w.ID; }
  return { slot: pf.makeSlot(name, [{ Type: pf.typeIndex(classpath), Data: data }], P()), id, f };
}
// Asset-array entries use `persistent` as a wrapped bool, where node components
// use a bare `persistent-ID`. Both shapes are verbatim from real packages.
function asset(classpath, fields = {}) {
  const id = pf.nextId();
  const data = { ID: id, persistent: pf.fd(true), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) };
  const f = {};
  for (const [k, v] of Object.entries(fields)) { const w = pf.fd(v); data[k] = w; f[k] = w.ID; }
  return { entry: { Type: pf.typeIndex(classpath), Data: data }, id, f };
}
const str = (name, s) => N(name, T.StrIn, { Value: s });
const int = (name, n) => N(name, T.IntIn, { Value: I(n) });

// ── the seven cards: quad + renderer + material + texture ────────────────────
// One texture and one material each. That is the whole reason this object is not
// the deck: seven textures can be pointed at seven URLs; one atlas cannot.
const assets = [], cardSlots = [], textures = [];
for (let i = 0; i < PACK_SIZE; i++) {
  const tex = asset(T.Texture, {
    URL: null,                       // driven from the parsed code at runtime
    Uncompressed: false, DirectLoad: false, ForceExactVariant: false,
    PreferredProfile: 'sRGB', MipMapBias: D(0), IsNormalMap: false,
    WrapModeU: 'Clamp', WrapModeV: 'Clamp',
    PowerOfTwoAlignThreshold: D(0.05), CrunchCompressed: true,
    MipMaps: true, KeepOriginalMipMaps: false, MipMapFilter: 'Box', Readable: false,
  });
  // Cutout, not Opaque: Palify art carries its rounded corners in the alpha, and
  // Opaque discards alpha entirely so the cards render as hard rectangles. 0.72
  // rather than 0.5 for the same reason the deck bake uses it - the art is matted
  // against white and a 0.5 threshold keeps a pale rim (docs/PIPELINE.md).
  const mat = asset(T.Unlit, {
    TintColor: [D(1), D(1), D(1), D(1), 'sRGB'],
    Texture: tex.id, BlendMode: 'Cutout', AlphaCutoff: D(0.72),
    UseVertexColors: false, ZWrite: 'Auto',
  });
  const mesh = pf.component(T.QuadMesh, {
    Size: [D(CARD_W), D(CARD_H)], DualSided: true, UseVertexColors: false,
  });
  const rend = pf.component(T.MeshRenderer, {
    Mesh: mesh.id, Materials: pf.list([mat.id]), MaterialPropertyBlocks: [],
    ShadowCastMode: 'On', SortingOrder: I(0),
  });
  assets.push(tex.entry, mat.entry);
  textures.push(tex);
  // Index 0 is the rarest card and sits at the top of the stack (largest Z).
  cardSlots.push(pf.makeSlot(`Card ${i + 1}${i === 0 ? ' (rarest - top)' : i === PACK_SIZE - 1 ? ' (commonest - bottom)' : ''}`,
    [mesh.comp, rend.comp], [0, 0, (PACK_SIZE - 1 - i) * CARD_GAP]));
}

// ── flux: gate host access, GET, parse, drive ────────────────────────────────
const apiStr = str('URL: /api/pull?format=flat', PULL_URL);
const apiUri = N('-> Uri', T.ToUri, { Input: apiStr.id });
const hostStr = str('host', PROXY);
const hostUri = N('host -> Uri', T.ToUri, { Input: hostStr.id });

// Content is an OUTPUT sentinel: downstream nodes address the FIELD id, not the
// component id. Wiring the component id here would read the node's own value
// output, which for an action node is not the response body.
const get = N('② GET the pull', T.Get, { URL: apiUri.id, Content: null, StatusCode: null, OnSent: null, OnResponse: null, OnError: null, OnDenied: null });
const BODY = get.f.Content;

const allowed = N('host access already granted?', T.IsAllowed, { Host: hostUri.id, Scope: null });
const reason = str('reason shown in the permission prompt', `Fetch a ${SET} booster pack from ResoPal`);
const ask = N('③ ask the user for host access', T.RequestHost, { Host: hostUri.id, Reason: reason.id, Scope: null, OnGranted: get.id, OnDenied: null, OnIgnored: null });
const gate = N('① allowed ? GET : ask', T.If, { Condition: allowed.id, OnTrue: get.id, OnFalse: ask.id });

// OnStart is a proxy node: the event component plus its +Proxy companion on the
// same slot, exactly like OnDestroying in the deck template.
const onStart = (() => {
  const node = pf.component(T.OnStart, { Trigger: gate.id, OnlyHost: null });
  const proxy = pf.component(T.OnStartProxy, { Node: node.id, Path: [] });
  return { slot: pf.makeSlot('▶ On Start', [node.comp, proxy.comp], P()), id: node.id };
})();

// Parse. The response is PACK_SIZE lines of `CODE,RARITY`. Line starts are found
// by walking newlines with IndexOfString's StartIndex - the only way to reach line
// i without a split node, which ProtoFlux does not have.
const NL = str('needle: newline', '\n');
const COMMA = str('needle: comma', ',');
const ONE = int('1', 1);
const artBase = str('art URL prefix', ART_URL);
const fallback = str('fallback art (unparsed line)', FALLBACK_URL);

const parseNodes = [];
let start = null;                      // ValueInput 0 for line 0, else prevNewline + 1
for (let i = 0; i < PACK_SIZE; i++) {
  if (i === 0) { start = int('line 0 starts at 0', 0); parseNodes.push(start); }

  const comma = N(`line ${i}: find comma`, T.IndexOf, { Str: BODY, Part: COMMA.id, StartIndex: start.id, SearchFromEnd: null, ComparisonMode: null });
  const len = N(`line ${i}: code length`, T.IntSub, { A: comma.id, B: start.id });
  const code = N(`line ${i}: the card code`, T.Substr, { Str: BODY, StartIndex: start.id, Length: len.id });
  const url = N(`line ${i}: art URL`, T.Concat, { Inputs: pf.list([artBase.id, code.id]) });
  // A line that has not arrived yet gives comma = -1, so the subtraction goes
  // negative and the substring is meaningless. Rather than let that reach the
  // texture - where a bad URL fails silently and the card just stays blank
  // forever - the card falls back to a visible placeholder.
  const ok = N(`line ${i}: parsed?`, T.IntGt, { A: comma.id, B: start.id });
  const pick = N(`line ${i}: URL or fallback`, T.StrPick, { Condition: ok.id, OnTrue: url.id, OnFalse: fallback.id });
  const uri = N(`line ${i}: -> Uri`, T.ToUri, { Input: pick.id });

  // The drive is continuous and pulls its input every frame, so the cards update
  // the moment Content lands. No impulse chain needed past the GET - this is the
  // confirmed live-texture-swap pattern.
  const drive = pf.component(T.UriDrive, { Value: uri.id });
  const proxy = pf.component(T.UriDriveProxy, { Node: drive.id, Path: [], Drive: textures[i].f.URL });
  const driveSlot = pf.makeSlot(`card ${i + 1}: drive StaticTexture2D.URL`, [drive.comp, proxy.comp], P());

  parseNodes.push(comma, len, code, url, ok, pick, uri, { slot: driveSlot });

  if (i < PACK_SIZE - 1) {
    const nl = N(`line ${i}: find newline`, T.IndexOf, { Str: BODY, Part: NL.id, StartIndex: start.id, SearchFromEnd: null, ComparisonMode: null });
    const next = N(`line ${i + 1} starts here`, T.IntAdd, { A: nl.id, B: ONE.id });
    parseNodes.push(nl, next);
    start = next;
  }
}

// ── assemble ─────────────────────────────────────────────────────────────────
const fluxNodes = [onStart, gate, allowed, ask, reason, apiStr, apiUri, hostStr, hostUri, get,
  NL, COMMA, ONE, artBase, fallback, ...parseNodes].map((n) => n.slot);
const flux = pf.makeSlot(`ResoPal pull (packed - unpack with Moduprint to edit)`, [], [0, 0.25, 0],
  fluxNodes, 'Moduprint.ProtoFlux');

const cards = pf.makeSlot('Cards', [], [0, 0, 0], cardSlots);

// Ukilop's and Palify's credits ship inside every generated object. This one is
// not a Deck Maker export, so Ukilop's line is dropped rather than misattributed -
// no Deck Maker geometry is used here. Palify's is not optional.
const credits = pf.makeSlot('credits', [], [0, 0, 0], [
  pf.makeSlot('Card images & deck data by Palify - palify.org'),
  pf.makeSlot('ResoPal booster spawner by Dalek - resopal.dalek.coffee'),
  pf.makeSlot(`Pack contents rolled by ${PROXY}/api/pull`),
]);

const grab = pf.component(T.Grabbable, { Scalable: true });
const collider = pf.component(T.BoxCollider, {
  Size: [D(CARD_W), D(CARD_H), D(PACK_SIZE * CARD_GAP)], Type: 'Static', Mass: D(1),
});
const root = pf.makeSlot(`ResoPal Booster Pack - ${SET}`, [grab.comp, collider.comp],
  [0, 0, 0], [cards, credits, flux], null, pf.rootId);

const res = await pf.exportPackage({
  name: `ResoPal Booster ${SET}`,
  root, assets,
  outPath: path.join(import.meta.dirname, 'out', `ResoPal_Booster_${SET}.resonitepackage`),
  version: '2026.6.24.835',
  typeVersions: TYPE_VERSIONS,
});

console.log(`\n  set        ${SET}`);
console.log(`  pull       ${PULL_URL}`);
console.log(`  art        ${ART_URL}<CODE>`);
console.log(`  cards      ${PACK_SIZE}, index 0 = rarest = top of the stack`);
console.log(`  flux nodes ${fluxNodes.length}`);
if (!res.ok) process.exitCode = 1;
