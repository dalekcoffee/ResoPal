// Top-level browser pipeline: deck in, .resonitepackage out.
//
// Two exports, and they no longer share a step.
//
//   fillDeck        the deck. Writes each card's art URL into the v1.0 template and
//                   re-zips it. No canvas, no atlas, no art downloaded - see fill.js.
//   bakeSheetOnly   the raw 8192 sheet + back, for baking by hand with Ukilop's Deck
//                   Maker. This one still draws, so compose.js, the CORS rules and
//                   the "bake must stay in the browser" argument all still apply TO
//                   IT, and only to it.
//
// What went: `bakeDeck`, which composited a 10x7 atlas and patched it into a baked
// Deck Maker export. A v1.0 card takes its face from a URL it fetches itself, so
// there is nothing to composite and nothing per-deck to embed - which is also why a
// deck in someone's inventory is now the holder and nothing else.
//
// patch.js, trim.js, credits.js and imgfix.js were that path's machinery. They are
// no longer reachable from here, but they are not deleted: tools/patch.mjs is their
// command-line twin and docs/PIPELINE.md's fixes live in their comments. Delete them
// once a v1.0 deck has been confirmed in-world, not before.

import { composeAtlas, prepareBack, COLS, ROWS } from './compose.js';

export { fillDeck, artUrlFor, backUrlFor, IN_WORLD_WIDTH, ART_VERSION, DEFAULT_PROXY } from './fill.js';
export { COLS, ROWS };

/** The 10x7 sheet's capacity. NOT the deck's - see MAX_DECK in index.html. */
export const MAX_SHEET = COLS * ROWS;

/** Path B: the raw sheet + back, for baking by hand with Ukilop's Deck Maker. */
export async function bakeSheetOnly({ deck, loadArt, landscape, back, size = 8192, onPhase = () => {} }) {
  const atlas = await composeAtlas(deck, loadArt, landscape, { size, onProgress: (d, t) => onPhase('art', d, t) });
  const backOut = await prepareBack(back);
  return {
    front: atlas.blob, back: backOut.blob,
    cards: atlas.cards, cols: COLS, rows: ROWS, size,
    backWidth: backOut.width, backHeight: backOut.height,
  };
}
