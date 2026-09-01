/**
 * The deck-import branch: what happens after the last card of a big import lands.
 *
 * The panel spawns loose cards. Past thirty of them the import is a DECK, and a
 * deck belongs in Ukilop's holder - so this branch duplicates the grafted deck
 * template, trims it to the number of cards imported, and writes each card's art
 * URL onto the deck's own card. Boosters and single cards never reach here: they
 * are already placed, and the gate simply does not fire.
 *
 * Emitted through a KIT rather than against one builder, because it has to exist
 * in two documents: `build-panel.mjs` calls it so the builder does not drift, and
 * `graft-deck-import.mjs` calls it to splice the same nodes into the panel the
 * owner hand-packed. That file is the artifact - see docs/HANDOFF.md - and a
 * second copy of this graph would be a second thing to keep in step.
 *
 * ── WHY THE DECK'S OWN CARDS, AND NOT OURS ──────────────────────────────────
 *
 * This branch used to throw all 52 stock cards away and move the panel's own
 * quads into the deck instead. Everything that broke over three rounds came out
 * of that one decision: our card had no `Card` tag, so the receiver surface
 * refused it; no `Receivable`, so no surface was ever told; a zero
 * `SnapCheckRadius`, so it snapped to nothing; a `CARD` space where the deck
 * writes `Card`; a non-uniform scale the deck's own reparent sheared; and square
 * corners, because a quad has square corners. Every one of those is a property a
 * Ukilop card already has.
 *
 * What made moving cards look necessary was that a Deck Maker card's art is not a
 * texture you can swap. All 52 share three materials; the art is baked into each
 * card's own MeshX UVs against one atlas. But `UnlitMaterial.TextureScale` and
 * `.TextureOffset` reach the shader as `_Tex_ST` and Unity samples at
 * `uv * scale + offset`, so a card's cell scales back up to the whole of a
 * per-card texture: `TextureScale = (10, 7)`, `TextureOffset = (-col, -(6-row))`
 * on the 10x7 grid. `build-deck-probe.mjs` gives every card its own front
 * material at its own cell's ST and a texture driven from `Card/url`, measured
 * against the MeshX UV bounds by `meshx.mjs` and checked by
 * `test-deck-probe.mjs`. `npm run template:deck` is what builds the template the
 * panel carries.
 *
 * So there is nothing left for this branch to do but count, trim and write.
 * Nothing is moved, nothing is reparented and nothing is rescaled - and the deck
 * keeps every snapper, tag, collider, pose and contract Ukilop gave it.
 *
 * ── TWO THINGS THE HANDOFF GOT WRONG, both measured out of the deck ──────────
 *
 * 1. **The receiver surface cannot be triggered by reparenting.** The note said
 *    dropping a card onto `Surface/cards` or `Cards` lets "the deck's own handler
 *    stack it and set OrderOffset". It does not: `OnGrabbableReceiverSurfaceReceived`
 *    hangs off `GrabbableReceiverSurface.OnLocalReceived`, which is raised only by
 *    `Receive(grabbable, grabber)`, and the only caller of that in the whole engine
 *    is `Grabber.cs:447` - a person letting go of something they grabbed. A
 *    `SetParent` from ProtoFlux raises nothing. That is what made the old branch
 *    have to reproduce the handler's whole sequence by hand; this one never moves
 *    a card, so the question does not arise.
 *
 * 2. **`InnerDeck/grid X` and `grid Y` are outputs, not inputs.** The note said
 *    writing those two ints engages the search spread. Both `Value` fields are
 *    DRIVEN, from `/Deck/logixs/Deck functions`, off `ChildrenCount(Cards)` and the
 *    card aspect: grid Y = round(sqrt(n/aspect)), grid X = ceil(aspect * that). The
 *    shipped 9 and 6 are exactly what that yields for 52 cards, which is how the
 *    drive was confirmed rather than assumed. Writing a driven field is a no-op the
 *    next update, and there is nothing to write anyway - the grid follows the card
 *    count on its own the moment the trim finishes.
 *
 *    What actually opens the spread is a bool: `BooleanValueDriver<floatQ>.State`
 *    on `/Deck/Surface/cards`, which the search button's own flux writes and whose
 *    label reads "Search" while true and "Close" while false. It is a plain field
 *    with no variable on it, so `graft-deck.mjs` attaches one `DynamicField<bool>`
 *    exposing it as `InnerDeck/spread` - the same idiom the deck already uses for
 *    `InnerDeck/SmoothSpeed` - and this branch writes it false.
 *
 * ── KNOWN LIMITS ────────────────────────────────────────────────────────────
 *
 * A deck longer than the template cannot be held: the template is 52 cards and
 * that is the number of baked meshes in the source export. `keep` is the smaller
 * of the two counts, so the extras stay loose rather than being written past the
 * end. Both trial decks are 48 and 50.
 *
 * A LANDSCAPE printing renders portrait in a deck. On a loose card
 * `TextureSizeDriver` rewrites the quad to match the texture; a baked mesh cannot
 * be rewritten, and an axis-aligned ST remap cannot rotate. Neither trial deck
 * has a landscape card - they are a booster thing - so this is recorded, not
 * solved.
 *
 * Everything here lands at x >= 14.3, right of the owner's canvas (his ends at
 * 13.57), on row Ys taken from his own file, wired into his existing chain.
 */

// Columns and rows. The column pitch is DOUBLE his 0.36, and that is the whole
// difference between a branch that reads and one that does not. Packed at his
// pitch these 43 nodes fit in 1.44 units and put 46 wires through other node
// boxes - 16 of them through CONSTANTS, which is the defect that makes a node read
// as unconnected in-world. Handing that to the autorouter made it worse (98
// crossings, 32 relays with nowhere to sit): a router needs lanes between boxes,
// and at 0.36 with every column full there are none. At 0.72 there are.
//
// The rows are HIS rows, lifted out of the packed panel rather than invented,
// which is what keeps a grafted node on a line with the ones beside it.
export const COL_X = [14.30, 15.02, 15.74, 16.46, 17.18];
// A GUTTER column sits half a pitch left of each: nothing else is ever placed
// there, so it is where a constant goes. A constant parked in its consumer's own
// column ends up in the lane between two nodes that wire to each other, which is
// the pretty-flux section 2 defect - the pair reads as unconnected and the wire
// reads as decoration. Twelve of those, all hard failures, came out of the first
// placement here; putting every constant in a gutter is what removed them.
const gut = (col) => COL_X[col] - 0.36;
const at = (col, row) => [COL_X[col], row, 0];
const atg = (col, row) => [gut(col), row, 0];

/** More than this many cards and the import is a deck rather than a pull. */
export const DECK_MIN_CARDS = 30;

/**
 * The height of a card slot in Ukilop's deck, in metres: `Deck/cardSize`.Y, read
 * out of `/Deck` in the template, where it is [0.175, 0.25, 0.0016].
 *
 * The panel's own card is 0.088 tall, because that is the size a grid of loose
 * cards wants in front of a 0.36 m panel. Dropped into the deck unchanged it is a
 * third of the cell it sits in - the spread comes out as small cards with wide
 * gaps, which is exactly what the first in-world import looked like. The card is
 * scaled to the cell on its way in; the deck's own furniture (its collider, its
 * baked edge mesh, its spacing) is all built around 0.175 x 0.25 and is left
 * alone, which is why the CARD moves and not the cell.
 */
export const DECK_CARD_HEIGHT = 0.25;

/**
 * And its thickness: `Deck/cardSize`.Z, 0.0015911.
 *
 * The deck stacks its buffers exactly this far apart - the reference deck's
 * buffers measure z = 0.0406, 0.0390, 0.0374, a 0.0016 pitch - so a card thicker
 * than this pokes through the one above it.
 */
export const DECK_CARD_THICKNESS = 0.0015911388909444213;

/**
 * How much of that pitch a card's collider is allowed to fill.
 *
 * Ukilop's own card collider is 0.0027349 deep at its 0.5 slot scale - 0.0013674
 * in the deck, 86% of the pitch - so two stacked cards' colliders never touch.
 */
const DECK_CARD_CLEARANCE = 0.86;

/**
 * The scale that takes a card of `cardHeight` into a deck cell. **Uniform**, and
 * that is the whole point of it.
 *
 * It used to be `[2.84, 2.84, 0.7956]` - X and Y taking the card to the cell, Z
 * taking its 0.002 collider down to the buffer pitch. Correct arithmetic, and a
 * transform that cannot survive being reparented. Our own `SetParent` keeps the
 * local values and so it looked right, but the moment the DECK began accepting
 * cards - which only happened once the slot carried its `Card` tag - its own
 * handler started reparenting them preserving the GLOBAL transform, which is
 * `parentGlobal⁻¹ × childGlobal`. Under a relative rotation a non-uniform scale
 * gives a matrix with SHEAR in it, and `Slot` has only position/rotation/scale to
 * decompose that into: the shear is dropped and the scale comes back wrong. The
 * deck is posed a half turn about the axis between -Y and -Z, so the rotation is
 * always there, and every card the deck received came out mangled.
 *
 * A uniform scale has no such failure mode. Thickness is dealt with where it
 * belongs instead: the card is AUTHORED thin, at `deckCardDepth`, so that a single
 * uniform factor lands it inside the pitch.
 */
export const deckCardScale = (cardHeight) => {
  const s = DECK_CARD_HEIGHT / cardHeight;
  return [s, s, s];
};

/**
 * The collider depth to author a card at, so `deckCardScale` lands it just inside
 * the buffer pitch. About 0.00048 for the panel's 0.088 card.
 */
export const deckCardDepth = (cardHeight) =>
  (DECK_CARD_THICKNESS * DECK_CARD_CLEARANCE) / (DECK_CARD_HEIGHT / cardHeight);

/**
 * The pose a spawned deck takes, in the PANEL's frame — placed in-world by the
 * owner and read back off the Scene Inspector.
 *
 * Rotation is `Euler(-90, -90, -90)`, which `floatQ.EulerRad` turns into
 * `(0, -0.70710678, -0.70710678, 0)`: a half turn about the axis between -Y and
 * -Z. It takes the deck's local +Z — the axis its buffers stack along — to panel
 * UP, and its local +Y to panel FORWARD, so the deck lies as a stack with its card
 * faces toward whoever is reading the panel. Identity left it standing on its side,
 * because a deck is authored Y-up and the panel is a wall.
 *
 * ── IT GOES ON THE TEMPLATE, NOT ON `Decks` ─────────────────────────────────
 * This was first put on the `Decks` slot the duplicates are parented under, and it
 * did nothing at all, because:
 *
 *   public Slot Duplicate(Slot duplicateRoot = null, bool keepGlobalTransform = true, …)
 *
 * and the ProtoFlux node calls `slot.Duplicate(duplicateRoot)` — taking that
 * default. A duplicate keeps the TEMPLATE's world transform and is merely
 * re-parented, so the parent's own pose never enters into it. Posing the parent is
 * the one thing that cannot work.
 *
 * So `graft-deck.mjs` writes these onto the grafted deck's ROOT, and `Decks` stays
 * at identity. The template is a child of the panel, so the pose is still
 * panel-relative and a deck still comes up square to whoever is reading it.
 *
 * That is the second time a `…GlobalTransform`/`…GlobalPosition` parameter has
 * defaulted to TRUE and quietly ignored what this code set - see `SetParent` in the
 * move loop. Assume any transform-preserving flag is on unless it says otherwise.
 */
export const DECK_POSITION = [0.2, 0, -1.31];
export const DECK_ROTATION = [0, -0.7071067811865476, -0.7071067811865476, 0];

/** * @param kit  emitters from whichever document this is going into:
 *             node(name, classpath, fields, pos), refNode(name, targetSlotId, pos),
 *             strIn/intIn/boolIn(name, value, pos), and the type table T.
 * @param hook ids in that document this branch has to reach:
 *             panelCards - the panel's own Cards slot (where loose cards land)
 *             deckTemplate - the grafted deck's ROOT slot
 *             decksHolder - the slot deck duplicates are parented under
 * @returns { nodes, entryId } - entryId is what the "all cards placed" write
 *          continues into.
 */
export function deckImport(kit, hook) {
  const { node, refNode, strIn, intIn, boolIn, T } = kit;
  const n = [];
  const push = (x) => { n.push(x); return x; };
  const wire = (from, port, to) => { from.slot.Components.Data[0].Data[port].Data = to; };

  // ── is this a deck? ────────────────────────────────────────────────────────
  // The count comes off the panel's Cards slot AFTER the spawn loop has finished,
  // which is the only moment it means "how many cards were imported".
  const enter = push(node('a deck, or loose cards?', T.FlowRelay, { Next: null }, at(0, 0.39)));
  const panelCardsA = push(refNode('the panel Cards slot', hook.panelCards, at(0, 1.04)));
  const countA = push(node('how many cards landed', T.ChildCount, { Instance: panelCardsA.id }, at(0, 0.65)));
  const deckMin = push(intIn(`a deck is more than ${DECK_MIN_CARDS}`, DECK_MIN_CARDS, atg(1, 0.78)));
  const isDeck = push(node('deck-sized?', T.IntGt, { A: countA.id, B: deckMin.id }, atg(1, 0.26)));
  const deckGate = push(node('deck ? fill a holder : leave them loose', T.If,
    { OnTrue: null, OnFalse: null, Condition: isDeck.id }, at(1, 0.52)));
  wire(enter, 'Next', deckGate.id);

  // ── a holder to fill ───────────────────────────────────────────────────────
  // The template is grafted INACTIVE-HELD: its holder slot is switched off and the
  // deck itself is on, exactly as the card template is, because DuplicateSlot
  // copies `Active` verbatim and nothing downstream turns a copy back on.
  const tmpl = push(refNode('the deck template', hook.deckTemplate, at(2, 1.04)));
  const decks = push(refNode('where decks go', hook.decksHolder, atg(3, 0.91)));
  const deckDup = push(node('make a deck', T.Dup,
    { Next: null, Template: tmpl.id, OverrideParent: decks.id, Duplicate: null }, at(2, 0.52)));
  wire(deckGate, 'OnTrue', deckDup.id);

  // Two hops rather than one deep search. `Cards` sits at `Surface/cards/Cards`,
  // and a depth search for it would also have to not match `Surface/cards` - so
  // each lookup is EXACT NAME, DIRECT CHILDREN, and cannot land on a namesake.
  //
  // `SearchDepth` and `IgnoreCase` are left unwired on purpose: an unconnected
  // ValueArgument<int> reads 0, and `Slot.FindChild` treats depth 0 as "direct
  // children only", which is exactly the search wanted. `MatchSubstring` cannot be
  // left alone the same way - it carries [DefaultValue(true)], so left null
  // "Cards" would match "Surface/cards" and every lookup below it would be aimed
  // one slot too high.
  //
  // Each lookup gets its OWN pair of constants rather than sharing one: a local
  // copy has no wire to route, and one shared constant fanning two ways is two
  // wires across the zone.
  const kid = (name, parentId, target, litPos, exactPos, pos) => {
    const lit = push(strIn(`name: ${target}`, target, litPos));
    const exact = push(boolIn('the whole name, not part of it', false, exactPos));
    return push(node(name, T.FindChild,
      { Instance: parentId, Name: lit.id, MatchSubstring: exact.id, IgnoreCase: null, SearchDepth: null },
      pos));
  };
  const surface = kid('the deck surface', deckDup.f.Duplicate, 'Surface/cards',
    at(3, 0.78), atg(4, 0.78), at(3, 0.52));
  const deckCards = kid('the deck Cards slot', surface.id, 'Cards',
    at(4, 0.91), atg(4, 0.26), at(4, 0.65));

  // ── how many cards to keep ─────────────────────────────────────────────────
  // The template ships full - 52 cards, each with its own front material, its own
  // texture and its own `Card/url` drive chain - and an import KEEPS them. It used
  // to throw all 52 away and move the panel's own quads in instead, and that was
  // the wrong shape: a Deck Maker card's art is not a texture you can swap, it is
  // baked into the mesh UVs against a shared atlas, so the only way to make a
  // Ukilop card show our art is to give it its own material at that cell's ST.
  // `build-deck-probe.mjs` does exactly that, per card, and is drag-tested.
  //
  // What is left is arithmetic. `keep` is the smaller of the two counts, because a
  // deck longer than the template cannot be held: the extra cards stay loose rather
  // than being written past the end of the list.
  const panelCardsB = push(refNode('the panel Cards slot', hook.panelCards, at(0, 0.00)));
  const countB = push(node('how many cards to place', T.ChildCount, { Instance: panelCardsB.id }, at(0, -0.26)));
  const deckCount = push(node('how many the deck holds', T.ChildCount, { Instance: deckCards.id }, at(4, 0.13)));
  const keep = push(node('the smaller of the two', T.IntMin, { A: countB.id, B: deckCount.id }, at(2, -0.26)));
  const extra = push(node('and how many are spare', T.IntSub, { A: deckCount.id, B: keep.id }, at(3, -0.26)));

  // ── throw away the cards the deck does not need ────────────────────────────
  // Ukilop's own trim hook: each buffer carries a `DestroyProxy` aimed at that
  // card's driver under `/Deck/Assets`, so destroying a buffer empties its slot in
  // `Assets` too and the two lists stay in step. `SendDestroyingEvent` is what
  // fires it; without it the drivers pile up.
  //
  // The index is CONSTANT at `keep` and the loop runs `extra` times, because
  // `GetChild` is a function node - it re-evaluates every pass - so destroying
  // child `keep` repeatedly walks the tail off one at a time. Destroying by
  // `iteration` would index past the end as the list shrank under it.
  const trimLoop = push(node('drop the spare cards', T.For,
    { Count: extra.id, Reverse: null, LoopStart: null, LoopIteration: null, LoopEnd: null }, at(3, -0.78)));
  wire(deckDup, 'Next', trimLoop.id);
  const spare = push(node('the first spare card', T.GetChild,
    { Instance: deckCards.id, ChildIndex: keep.id }, at(3, -1.30)));
  const dropAssets = push(boolIn('let its assets go with it', false, at(4, -1.30)));
  const tellDeck = push(boolIn('tell the deck it is going', true, at(4, -0.52)));
  const dropOne = push(node('destroy it, and its driver with it', T.DestroySlot,
    { Next: null, Instance: spare.id, PreserveAssets: dropAssets.id, SendDestroyingEvent: tellDeck.id },
    atg(4, -1.04)));
  wire(trimLoop, 'LoopIteration', dropOne.id);

  // ── give each remaining card its art ───────────────────────────────────────
  // One `Card/url` write per card, in place. No cards are moved, nothing is
  // reparented and nothing is rescaled - which is the point of doing it this way:
  // every scale, pose, snapper, tag and contract on a deck card is Ukilop's own and
  // already correct, and the three rounds of bugs before this were all about
  // reproducing them on a card of ours.
  //
  // Card i of the deck takes panel card i's url, so deck order is import order and
  // list index stays stack position - the invariant the atlas order and the site's
  // reveal order both rest on (CLAUDE.md, "A pull is ordered rarest-first"). The
  // stock buffers already carry OrderOffset 0..51, so trimming the tail leaves
  // 0..keep-1 and shuffle works untouched.
  const fillLoop = push(node('give each card its art', T.For,
    { Count: keep.id, Reverse: null, LoopStart: null, LoopIteration: null, LoopEnd: null }, atg(3, -1.56)));
  wire(trimLoop, 'LoopEnd', fillLoop.id);

  const srcCard = push(node('the panel card at that index', T.GetChild,
    { Instance: panelCardsB.id, ChildIndex: fillLoop.f.Iteration }, at(0, -2.08)));
  // `CARD` is the PANEL's space and `Card` is the DECK's - two different spaces
  // with two different names, and this is the one place they meet.
  const srcPath = push(strIn('name: CARD/url', 'CARD/url', atg(1, -2.34)));
  const readUrl = push(node('what art was it given?', T.ReadVar,
    { Source: srcCard.id, Path: srcPath.id }, atg(2, -2.08)));

  // `buffer -> Card`, the deck's own two-level shape. `GetChild(buffer, 0)` rather
  // than a name lookup because a buffer holds exactly one child and the deck's own
  // flux walks it the same way; the url variable itself lives deeper still, on
  // `Card/Visual (Baked)/art`, and resolves up to the `Card` space on this slot.
  const dstBuf = push(node('the deck card at that index', T.GetChild,
    { Instance: deckCards.id, ChildIndex: fillLoop.f.Iteration }, at(3, -1.82)));
  const firstKid = push(intIn('its only child', 0, at(3, -2.08)));
  const dstCard = push(node('and the Card inside it', T.GetChild,
    { Instance: dstBuf.id, ChildIndex: firstKid.id }, at(4, -2.34)));
  const dstPath = push(strIn('name: Card/url', 'Card/url', atg(2, -2.34)));
  const writeUrl = push(node('tell that card its art', T.WriteVar,
    { Target: dstCard.id, Path: dstPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null,
      Value: readUrl.f.Value }, at(2, -2.08)));
  wire(fillLoop, 'LoopIteration', writeUrl.id);

  // ── clear the panel ────────────────────────────────────────────────────────
  // The loose cards were only ever the carrier: they hold the urls this branch
  // reads and nothing else. Leaving them would show the deck twice, once as a grid
  // in front of the panel and once in the holder.
  const clearAssets = push(boolIn('let their assets go too', false, at(1, -1.04)));
  const tellPanel = push(boolIn('tell them they are going', true, atg(1, -1.56)));
  const clearPanel = push(node('take the loose cards away', T.ClearKids,
    { Next: null, Instance: panelCardsB.id, PreserveAssets: clearAssets.id, SendDestroyingEvent: tellPanel.id },
    at(0, -1.04)));
  wire(fillLoop, 'LoopEnd', clearPanel.id);

  // ── open it ───────────────────────────────────────────────────────────────
  // Written LAST, when every card has its art, because the spread lays out from
  // `ChildrenCount` and opening it half-filled would spread it twice. `grid X` and
  // `grid Y` look like the spread's inputs and are not: both are driven outputs of
  // `ChildrenCount`, so writing them does nothing. The toggle is a bool.
  const spreadPath = push(strIn('name: InnerDeck/spread', 'InnerDeck/spread', atg(3, -3.12)));
  const spreadOn = push(boolIn('open, not stacked', false, atg(4, -3.38)));
  const spread = push(node('spread the deck out', T.WriteBoolVar, {
    Target: surface.id, Path: spreadPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: spreadOn.id,
  }, at(4, -2.74)));
  wire(clearPanel, 'Next', spread.id);

  // Say so on the event line, on every outcome. A panel that cannot write its own
  // readout has still built the deck, and the line is the only way to tell a deck
  // that finished from one that never started.
  const deckText = push(strIn('text: deck in the holder', 'deck in the holder', atg(3, -3.38)));
  const deckPath = push(strIn('name: ResoPal/event', 'ResoPal/event', at(4, -3.38)));
  const deckSay = push(node('-> ResoPal/event', T.WriteVar, {
    Target: null, Path: deckPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: deckText.id,
  }, at(4, -3.12)));
  for (const k of ['OnSuccess', 'OnNotFound', 'OnFailed']) wire(spread, k, deckSay.id);

  return { nodes: n, entryId: enter.id };
}
