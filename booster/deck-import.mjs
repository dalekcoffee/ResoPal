/**
 * The deck-import branch: what happens after the last card of a big import lands.
 *
 * The panel spawns loose cards. Past thirty of them the import is a DECK, and a
 * deck belongs in Ukilop's holder - so this branch duplicates the grafted deck
 * template, throws away the stock cards it ships with, and moves the cards the
 * panel just made into it. Boosters and single cards never reach here: they are
 * already placed, and the gate simply does not fire.
 *
 * Emitted through a KIT rather than against one builder, because it has to exist
 * in two documents: `build-panel.mjs` calls it so the builder does not drift, and
 * `graft-deck-import.mjs` calls it to splice the same nodes into the panel the
 * owner hand-packed. That file is the artifact - see docs/HANDOFF.md - and a
 * second copy of this graph would be a second thing to keep in step.
 *
 * ── TWO THINGS THE HANDOFF GOT WRONG, both measured out of the deck ──────────
 *
 * 1. **The receiver surface cannot be triggered by reparenting.** The note said
 *    dropping a card onto `Surface/cards` or `Cards` lets "the deck's own handler
 *    stack it and set OrderOffset". It does not: `OnGrabbableReceiverSurfaceReceived`
 *    hangs off `GrabbableReceiverSurface.OnLocalReceived`, which is raised only by
 *    `Receive(grabbable, grabber)`, and the only caller of that in the whole engine
 *    is `Grabber.cs:447` - a person letting go of something they grabbed. A
 *    `SetParent` from ProtoFlux raises nothing. A card reparented onto `Cards` would
 *    sit there with no buffer, no position driver and no OrderOffset.
 *
 *    So this branch does what the handler does, in the handler's own order, read
 *    out of `/Deck/logixs/add/remove handling`: duplicate `/Deck/buffer`, move the
 *    copy's packed `proxy` into `/Deck/Assets`, park the card inside the buffer,
 *    then parent the buffer under `Cards`. The proxy carries that card's position
 *    flux, and appending to both lists in the same pass is what keeps them in step -
 *    the deck indexes `/Deck/Assets` BY POSITION, which is the bug that broke
 *    grabbing the last time something moved those proxies.
 *
 * 2. **`InnerDeck/grid X` and `grid Y` are outputs, not inputs.** The note said
 *    writing those two ints engages the search spread. Both `Value` fields are
 *    DRIVEN, from `/Deck/logixs/Deck functions`, off `ChildrenCount(Cards)` and the
 *    card aspect: grid Y = round(sqrt(n/aspect)), grid X = ceil(aspect * that). The
 *    shipped 9 and 6 are exactly what that yields for 52 cards, which is how the
 *    drive was confirmed rather than assumed. Writing a driven field is a no-op the
 *    next update, and there is nothing to write anyway - the grid follows the card
 *    count on its own the moment the cards land.
 *
 *    What actually opens the spread is a bool: `BooleanValueDriver<floatQ>.State`
 *    on `/Deck/Surface/cards`, which the search button's own flux writes and whose
 *    label reads "Search" while true and "Close" while false. It is a plain field
 *    with no variable on it, so `graft-deck.mjs` attaches one `DynamicField<bool>`
 *    exposing it as `InnerDeck/spread` - the same idiom the deck already uses for
 *    `InnerDeck/SmoothSpeed` - and this branch writes it false.
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
 * than this pokes through the one above it. The panel's card is 0.002 thick at the
 * collider, and scaled UNIFORMLY to fit the cell it would become 0.0057, three and
 * a half times the gap it has to sit in. So the scale is not uniform: X and Y take
 * the card to the cell, Z takes it to the pitch.
 */
export const DECK_CARD_THICKNESS = 0.0015911388909444213;

/**
 * @param kit  emitters from whichever document this is going into:
 *             node(name, classpath, fields, pos), refNode(name, targetSlotId, pos),
 *             strIn/intIn/boolIn/f3In(name, value, pos), and the type table T.
 * @param hook ids in that document this branch has to reach:
 *             panelCards - the panel's own Cards slot (where loose cards land)
 *             deckTemplate - the grafted deck's ROOT slot
 *             decksHolder - the slot deck duplicates are parented under
 *             cardScale - [x, y, z] scale taking a panel card to a deck card
 * @returns { nodes, entryId } - entryId is what the "all cards placed" write
 *          continues into.
 */
export function deckImport(kit, hook) {
  const { node, refNode, strIn, intIn, boolIn, f3In, T } = kit;
  const n = [];
  const push = (x) => { n.push(x); return x; };

  // ── is this a deck? ────────────────────────────────────────────────────────
  // The count comes off the panel's Cards slot AFTER the loop has finished, which
  // is the only moment it means "how many cards were imported".
  const enter = push(node('a deck, or loose cards?', T.FlowRelay, { Next: null }, at(0, -3.38)));
  const panelCardsA = push(refNode('the panel Cards slot', hook.panelCards, at(0, 0.39)));
  const countA = push(node('how many cards landed', T.ChildCount, { Instance: panelCardsA.id }, at(0, 0.13)));
  const deckMin = push(intIn(`a deck is more than ${DECK_MIN_CARDS}`, DECK_MIN_CARDS, at(1, 0.13)));
  const isDeck = push(node('deck-sized?', T.IntGt, { A: countA.id, B: deckMin.id }, at(1, 0.39)));
  const deckGate = push(node('deck ? put it in a holder : leave them loose', T.If,
    { OnTrue: null, OnFalse: null, Condition: isDeck.id }, atg(1, 0.65)));
  enter.slot.Components.Data[0].Data.Next.Data = deckGate.id;

  // ── a holder to fill ───────────────────────────────────────────────────────
  // The template is grafted INACTIVE-HELD: its holder slot is switched off and the
  // deck itself is on, exactly as the card template is, because DuplicateSlot
  // copies `Active` verbatim and nothing downstream turns a copy back on.
  const tmpl = push(refNode('the deck template', hook.deckTemplate, at(3, 0.91)));
  const decks = push(refNode('where decks go', hook.decksHolder, atg(4, 0.52)));
  const deckDup = push(node('make a deck', T.Dup,
    { Next: null, Template: tmpl.id, OverrideParent: decks.id, Duplicate: null }, atg(3, 0.91)));
  deckGate.slot.Components.Data[0].Data.OnTrue.Data = deckDup.id;

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
  // Its two constants go in the gutter, and `up` says on which side: above when
  // something has to descend past this column, below otherwise. Each lookup gets
  // its OWN pair rather than sharing one - a local copy has no wire to route, and
  // one shared constant fanning four ways is four wires across the zone.
  const kid = (name, parentId, target, pos, litPos, exactPos) => {
    const lit = push(strIn(`name: ${target}`, target, litPos));
    const exact = push(boolIn('the whole name, not part of it', false, exactPos));
    return push(node(name, T.FindChild,
      { Instance: parentId, Name: lit.id, MatchSubstring: exact.id, IgnoreCase: null, SearchDepth: null },
      pos));
  };
  const surface = kid('the deck surface', deckDup.f.Duplicate, 'Surface/cards', atg(2, 0.65), atg(2, 0.91), at(1, 0.91));
  const deckCards = kid('the deck Cards slot', surface.id, 'Cards', atg(3, 0.65), at(3, 0.52), at(3, 0.195));
  const deckBuffer = kid('the deck buffer template', deckDup.f.Duplicate, 'buffer', atg(4, -1.93), atg(3, -1.93), atg(3, -2.19));
  const deckAssets = kid('the deck Assets slot', deckDup.f.Duplicate, 'Assets', atg(4, -1.17), atg(4, -1.43), atg(4, -0.90));

  // The template ships at its full card count and the extras go in-world: that is
  // Ukilop's own trim hook, and it is why this is one node rather than a loop.
  // Each buffer carries a DestroyProxy aimed at that card's `/Assets` driver, so
  // clearing `Cards` empties `Assets` with it and the two lists stay in step.
  const clearStock = push(node('throw away the stock cards', T.ClearKids,
    { Next: null, Instance: deckCards.id, PreserveAssets: false, SendDestroyingEvent: true }, at(2, 0.52)));
  deckDup.slot.Components.Data[0].Data.Next.Data = clearStock.id;

  // ── move the cards across, one per frame ───────────────────────────────────
  // DelayUpdates is an AsyncActionNode, so the loop needs its own async context
  // both to START and to come round AGAIN. Re-entering it from a synchronous
  // continuation runs nothing at all, silently - the defect that once spawned the
  // first card of an import and dropped every one after it.
  const moveAsync = push(node('moving is asynchronous', T.StartAsync,
    { TaskStart: null, OnStarted: null, OnFailed: null }, at(2, 0.30)));
  clearStock.slot.Components.Data[0].Data.Next.Data = moveAsync.id;

  // Down the right edge and back along an empty row, rather than one diagonal
  // across the whole band. Both horizontal returns get their own row - -0.65 in,
  // -0.78 back - so neither runs through the other.
  const inA = push(node('down to the loop', T.FlowRelay, { Next: null }, atg(2, -0.30)));
  const inB = push(node('and along to it', T.FlowRelay, { Next: null }, atg(2, -0.52)));
  moveAsync.slot.Components.Data[0].Data.TaskStart.Data = inA.id;
  inA.slot.Components.Data[0].Data.Next.Data = inB.id;

  const moveTop = push(node('next card', T.FlowRelay, { Next: null }, at(1, -0.78)));
  inB.slot.Components.Data[0].Data.Next.Data = moveTop.id;
  const oneFrame = push(intIn('one frame', 1, at(1, -1.30)));
  const breathe = push(node('let a frame pass', T.DelayFrames,
    { Next: null, OnTriggered: null, Updates: oneFrame.id }, at(1, -1.04)));
  moveTop.slot.Components.Data[0].Data.Next.Data = breathe.id;

  // A SECOND read of the same slot, beside the nodes that use it, rather than one
  // wire back up to the gate's. A reference node is two components and no wire at
  // all; the wire it replaces ran three units down the spine column and through
  // four other nodes on the way.
  const panelCardsB = push(refNode('the panel Cards slot', hook.panelCards, atg(2, -2.47)));
  const countB = push(node('how many are still loose', T.ChildCount, { Instance: panelCardsB.id }, atg(3, -2.70)));
  const none = push(intIn('none left', 0, at(2, -1.17)));
  // The guard re-reads the count every pass, which is why this terminates: each
  // pass takes child 0 off the panel's Cards slot, so the count falls by one and
  // cannot be walked past. There is no index to get wrong.
  const anyLeft = push(node('any cards still loose?', T.IntGt, { A: countB.id, B: none.id }, atg(2, -1.17)));
  const moveGate = push(node('a card left ? move it : done', T.If,
    { OnTrue: null, OnFalse: null, Condition: anyLeft.id }, at(4, -0.195)));
  breathe.slot.Components.Data[0].Data.Next.Data = moveGate.id;

  // The handler's own sequence, in the handler's own order. A buffer is duplicated
  // where the template sits, its packed proxy is moved into `/Deck/Assets`, the
  // card goes inside the buffer, and only then does the buffer join `Cards`.
  const bufDup = push(node('make a buffer for it', T.Dup,
    { Next: null, Template: deckBuffer.id, OverrideParent: null, Duplicate: null }, at(3, -1.04)));
  moveGate.slot.Components.Data[0].Data.OnTrue.Data = bufDup.id;

  const firstA = push(intIn('the first one', 0, at(3, -3.00)));
  const bufProxy = push(node('the buffer’s packed flux', T.GetChild,
    { Instance: bufDup.f.Duplicate, ChildIndex: firstA.id }, at(3, -2.70)));

  // ── every SetParent here keeps the LOCAL transform, and it has to say so ──
  // `PreserveGlobalPosition` is `[DefaultValue(true)]` on the runtime class, and
  // `Do` passes `defaultValue: true` a second time for good measure. Left unwired
  // it is TRUE: the slot keeps its WORLD position and the engine recomputes a local
  // offset to match. Every card came out of the first working import at a local
  // [-0.319, 0.480, …] inside its buffer for exactly this reason - the same offset
  // on all 48, because they had all been reset to the same point on the panel
  // first - and `filler` then measured half of that, because the deck drives its
  // edge stack off the cards' bounds and dutifully followed them off the holder.
  // One unwired port, and the deck reads as three pieces lying apart.
  //
  // Ukilop's own handler leaves it unwired and gets away with it because it calls
  // `SetLocalPositionRotation` AFTER the reparent. This branch resets BEFORE, so
  // that `GetChild` still names the same card, and therefore has to say `false`.
  // A local copy per SetParent rather than one constant fanning three ways: these
  // three sit at opposite corners of the band, and one shared `false` sends wires
  // straight through the nodes between them - the same reason each name lookup
  // above carries its own.
  const keepLocal = (pos) => push(boolIn('keep the local transform', false, pos)).id;
  const proxyHome = push(node('its flux goes to Assets', T.SetParent,
    { Next: null, Instance: bufProxy.id, NewParent: deckAssets.id,
      PreserveGlobalPosition: keepLocal(atg(3, -1.56)) }, at(3, -1.56)));
  bufDup.slot.Components.Data[0].Data.Next.Data = proxyHome.id;

  const firstB = push(intIn('the first one', 0, atg(2, -3.00)));
  const nextCard = push(node('the card on top', T.GetChild,
    { Instance: panelCardsB.id, ChildIndex: firstB.id }, at(1, -2.70)));
  // ── the card is reset and resized BEFORE it is moved, and the order is the
  // whole of it ─────────────────────────────────────────────────────────────
  // `GetChild` is a FUNCTION node: it re-evaluates on every read, it does not
  // latch. Three action nodes reading `the card on top` are three separate calls
  // to `GetChild(panel Cards, 0)`, and the moment `SetParent` moves that card out
  // of `Cards` the same expression names a DIFFERENT card.
  //
  // With the move first, that is exactly what happened in-world: pass 1 moved card
  // A and then reset and scaled card B, still sitting on the panel; pass 2 moved
  // the already-scaled B and prepared C. So card A - the first one - never got
  // scaled and came out a third of the size of every other card, and on the last
  // pass `GetChild` returned null, which breaks an ActionBreakableFlowNode and
  // took `bufIn` with it, so the last card never joined the deck. One bug, both
  // symptoms.
  //
  // Reset and scale while the card is still under `Cards` and every read names the
  // same card. Both survive the move: `SetParent` with PreserveGlobalPosition
  // unwired keeps the LOCAL transform, so a card zeroed here arrives at its
  // buffer's origin, and local scale is not touched by reparenting at all.
  //
  // The reset is easy to read as a no-op and is not one: BOTH inputs are
  // deliberately left unwired, because an unconnected ValueInput evaluates to its
  // type's default - float3.Zero and floatQ.Identity. The node IS the reset, and
  // without it a card arrives still carrying the grid position the spawn loop gave
  // it on the panel.
  const cardHome = push(node('sit it at the buffer', T.SetLocalPosRot,
    { Next: null, Instance: nextCard.id, Position: null, Rotation: null }, at(0, -2.40)));
  proxyHome.slot.Components.Data[0].Data.Next.Data = cardHome.id;

  // And make it the size of the slot it is going into, rather than the size a
  // loose card wants in front of the panel. See DECK_CARD_HEIGHT.
  const cardScale = push(f3In('the deck\'s card size', hook.cardScale, atg(1, -3.00)));
  const cardBig = push(node('and the size of a deck card', T.SetLocalScale,
    { Next: null, Instance: nextCard.id, Scale: cardScale.id }, atg(1, -2.70)));
  cardHome.slot.Components.Data[0].Data.Next.Data = cardBig.id;

  const cardIn = push(node('the card goes in the buffer', T.SetParent,
    { Next: null, Instance: nextCard.id, NewParent: bufDup.f.Duplicate, PreserveGlobalPosition: keepLocal(atg(1, -2.08)) }, atg(1, -2.40)));
  cardBig.slot.Components.Data[0].Data.Next.Data = cardIn.id;

  // ── give the buffer an OrderOffset, or shuffle has nothing to shuffle ─────
  // Shuffle is a SWAP: `RandomInt(0, ChildrenCount)` picks a buffer under `Cards`
  // and `SetSlotOrderOffset` exchanges its OrderOffset with another's. It never
  // touches the cards at all. So a deck whose buffers all carry the SAME
  // OrderOffset shuffles perfectly and changes nothing - which is exactly what a
  // duplicate of the template buffer gives you, because `DuplicateSlot` copies
  // OrderOffset verbatim and the template's is 0. Ukilop's own handler assigns one
  // to every card it receives; this had skipped it on the reasoning that insertion
  // order already reads correctly, which was true and beside the point.
  //
  // The value is the count of what is already in the deck, read BEFORE this buffer
  // joins, so the offsets come out 0, 1, 2 … in insertion order. That keeps list
  // index equal to stack position, which is the invariant the atlas order and the
  // site's reveal order both rest on (CLAUDE.md, "A pull is ordered rarest-first").
  const inDeck = push(node('how many are in the deck already', T.ChildCount,
    { Instance: deckCards.id }, at(2, -2.83)));
  const inDeckLong = push(node('as a long', T.CastIntLong, { Input: inDeck.id }, atg(2, -3.30)));
  const setOrder = push(node('its place in the stack', T.SetOrder,
    { Next: null, Instance: bufDup.f.Duplicate, OrderOffset: inDeckLong.id }, at(1, -3.12)));
  cardIn.slot.Components.Data[0].Data.Next.Data = setOrder.id;

  const bufIn = push(node('and the buffer joins the deck', T.SetParent,
    { Next: null, Instance: bufDup.f.Duplicate, NewParent: deckCards.id, PreserveGlobalPosition: keepLocal(atg(2, -2.70)) }, at(1, -2.47)));
  setOrder.slot.Components.Data[0].Data.Next.Data = bufIn.id;

  const againAsync = push(node('and on to the next card, asynchronously', T.StartAsync,
    { TaskStart: null, OnStarted: null, OnFailed: null }, atg(2, -2.19)));
  bufIn.slot.Components.Data[0].Data.Next.Data = againAsync.id;
  // Three corners, not one diagonal: out along the band, up the right edge, and
  // back along an empty row into the top of the loop. A straight line from the end
  // of a pass to the start of it cuts through every data row in between - and up
  // the spine column it would cut through the loop's own nodes.
  const backA = push(node('go round again', T.FlowRelay, { Next: null }, at(1, -1.80)));
  const backB = push(node('back to the top', T.FlowRelay, { Next: null }, at(1, -1.56)));
  const backC = push(node('and in again', T.FlowRelay, { Next: moveTop.id }, atg(1, -1.17)));
  againAsync.slot.Components.Data[0].Data.TaskStart.Data = backA.id;
  backA.slot.Components.Data[0].Data.Next.Data = backB.id;
  backB.slot.Components.Data[0].Data.Next.Data = backC.id;

  // ── open it ───────────────────────────────────────────────────────────────
  // Written LAST, when the deck holds every card, because the spread lays out from
  // `ChildrenCount` and opening it half-filled would spread it twice. It sits
  // under the lookup it reads rather than down beside the loop that triggers it:
  // the impulse can travel, a data wire from the far corner cannot without
  // crossing the whole band.
  const spreadPath = push(strIn('name: InnerDeck/spread', 'InnerDeck/spread', atg(4, -3.00)));
  const spreadOn = push(boolIn('open, not stacked', false, atg(4, -3.30)));
  const spread = push(node('spread the deck out', T.WriteBoolVar, {
    Target: surface.id, Path: spreadPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: spreadOn.id,
  }, at(4, -3.12)));
  moveGate.slot.Components.Data[0].Data.OnFalse.Data = spread.id;

  // Say so on the event line, on every outcome. A panel that cannot write its own
  // readout has still built the deck, and the line is the only way to tell a deck
  // that finished from one that never started.
  const deckText = push(strIn('text: deck in the holder', 'deck in the holder', at(4, -3.60)));
  const deckPath = push(strIn('name: ResoPal/event', 'ResoPal/event', atg(4, -3.60)));
  const deckSay = push(node('-> ResoPal/event', T.WriteVar, {
    Target: null, Path: deckPath.id, OnNotFound: null, OnSuccess: null, OnFailed: null, Value: deckText.id,
  }, at(4, -3.38)));
  for (const k of ['OnSuccess', 'OnNotFound', 'OnFailed'])
    spread.slot.Components.Data[0].Data[k].Data = deckSay.id;

  return { nodes: n, entryId: enter.id };
}
