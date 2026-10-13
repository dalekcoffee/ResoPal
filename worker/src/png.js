/**
 * Read a PNG's pixel dimensions out of its header - the PNG twin of webp.js.
 *
 * Byte inspection, not decoding: the signature and the IHDR chunk are the first
 * 24 bytes, and the spec requires IHDR to come first. It keeps the Worker to
 * moving bytes (docs/WORKER.md).
 *
 * It exists for the /official/ route, which serves the official site's PNGs and
 * has to know a landscape printing when it sees one - see `official()` in
 * index.js for why that card is handed back to the Palify path instead.
 *
 *   89 50 4E 47 0D 0A 1A 0A   signature
 *   <u32 length> "IHDR"        first chunk
 *   <u32be width> <u32be height> ...
 *
 * Returns null for anything it does not recognise, and every caller treats null
 * as "not a usable PNG" - an unreadable header is never a reason to serve bytes
 * as an image.
 */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  const width = u32(16), height = u32(20);
  if (!width || !height) return null;
  return { width, height };
}
