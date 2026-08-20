// Browser port of tools/compose.py and tools/prepare_back.py.
//
// Layout must match the template's baked UVs: cells are filled row-major,
// left-to-right, top-to-bottom, and each card fills its cell completely (the
// template's own atlas has zero padding - verified by measurement).

import { solidify, toImageData, toCanvas } from './imgfix.js';

export const COLS = 10, ROWS = 7;   // must match the baked template's AtlasInfo GridSize
export const ROT = 90;    // clockwise, matching compose.py's ROTATE_270; verified against the atlas inside the approved v7 package
const CELL_ASPECT = 0.700;          // the template's cell; card art is 0.7156

const encode = (cv, quality) => cv.convertToBlob({ type: 'image/webp', quality });

/**
 * deck: [{code, n}] in deck order. loadArt(code) -> ImageBitmap.
 * landscape: Set of codes Palify marks landscape. Returns {blob, cards}.
 */
export async function composeAtlas(deck, loadArt, landscape, opts = {}) {
  const { size = 8192, quality = 0.95, onProgress } = opts;

  const physical = deck.flatMap(e => Array.from({ length: e.n }, () => e.code));
  if (physical.length > COLS * ROWS)
    throw new Error(`${physical.length} cards exceeds the ${COLS}x${ROWS} grid - bake a larger template`);

  const atlas = new OffscreenCanvas(size, size);
  const cx = atlas.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';

  // one decode+solidify per distinct code, reused across its copies
  const prepared = new Map();

  for (let i = 0; i < physical.length; i++) {
    const code = physical[i];
    if (!prepared.has(code)) {
      const bmp = await loadArt(code);
      // solidify BEFORE resizing: see imgfix.js
      prepared.set(code, toCanvas(solidify(toImageData(bmp, landscape.has(code) ? ROT : 0))));
      bmp.close?.();
    }
    const r = Math.floor(i / COLS), c = i % COLS;
    const x0 = Math.round(c * size / COLS), y0 = Math.round(r * size / ROWS);
    const x1 = Math.round((c + 1) * size / COLS), y1 = Math.round((r + 1) * size / ROWS);
    cx.drawImage(prepared.get(code), x0, y0, x1 - x0, y1 - y0);
    onProgress?.(i + 1, physical.length);
  }

  return { blob: await encode(atlas, quality), cards: physical.length, size };
}

/**
 * Resize a card back to the template's cell aspect (0.700). The card art is
 * 0.7156 but the cell is 0.700, so fronts are squashed 2.2%; the back is matched
 * to the same aspect so it doesn't sit at different proportions.
 */
export async function prepareBack(src, width = 1024, quality = 0.95) {
  const height = Math.round(width / CELL_ASPECT);
  const solid = toCanvas(solidify(toImageData(src)));
  const cv = new OffscreenCanvas(width, height);
  const cx = cv.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(solid, 0, 0, width, height);
  return { blob: await encode(cv, quality), width, height };
}
