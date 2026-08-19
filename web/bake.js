// Top-level browser pipeline: deck in, .resonitepackage out.
//
// Mirrors what tools/ does on the command line, in the same order and with the
// same assertions. Everything here runs on the user's machine - see
// docs/WORKER.md for why the bake cannot live in a Worker.

import { composeAtlas, prepareBack, COLS, ROWS } from './compose.js';
import { patchPackage } from './patch.js';

export { COLS, ROWS };
export const MAX_CARDS = COLS * ROWS;

const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

/**
 * template  ArrayBuffer of a baked Deck Maker .resonitepackage
 * deck      [{code, n}] in deck order
 * loadArt   (code) -> ImageBitmap
 * landscape Set of codes Palify marks landscape
 * back      ImageBitmap of the card back
 * onPhase   (phase, done, total) -> void   phase: 'art'|'compose'|'back'|'pack'
 */
export async function bakeDeck({ template, deck, loadArt, landscape, back, name, size = 8192, edgeTint, onPhase = () => {}, log = () => {} }) {
  const total = deck.reduce((t, e) => t + e.n, 0);
  if (total > MAX_CARDS) throw new Error(`${total} cards exceeds the ${COLS}x${ROWS} template grid`);

  onPhase('art', 0, total);
  const atlas = await composeAtlas(deck, loadArt, landscape, {
    size, onProgress: (d, t) => onPhase('art', d, t),
  });
  log(`  atlas ${size}x${size}  cards=${atlas.cards}  ${(atlas.blob.size / 1048576).toFixed(2)}MB`);

  onPhase('back', 0, 1);
  const backOut = await prepareBack(back);
  onPhase('back', 1, 1);

  onPhase('pack', 0, 1);
  const pkg = await patchPackage(template, {
    front: { bytes: await bytesOf(atlas.blob), width: size, height: size },
    back: { bytes: await bytesOf(backOut.blob), width: backOut.width, height: backOut.height },
    cards: atlas.cards,
    name, edgeTint, log,
  });
  onPhase('pack', 1, 1);
  return { blob: pkg, cards: atlas.cards };
}

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
