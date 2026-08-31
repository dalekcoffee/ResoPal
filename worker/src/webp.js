/**
 * Read a WebP's pixel dimensions out of its header.
 *
 * This is byte inspection, not decoding - the first ~30 bytes of the container -
 * so it keeps the Worker to moving bytes (docs/WORKER.md).
 *
 * It exists so orientation is a property of the IMAGE rather than of a committed
 * list. `landscape` in data/pool-*.json is a snapshot: a card from a set nobody
 * has snapshotted yet is absent from it, so a list-driven rule silently fails to
 * turn exactly the cards a user import is most likely to bring. The image is
 * always right, and always present, because we are already fetching it.
 *
 * Container: "RIFF" <u32 size> "WEBP" <fourcc> <u32 chunk size> <payload...>
 *
 *   VP8   lossy     3-byte frame tag, 3-byte start code 9d 01 2a, then
 *                   u16 width and u16 height, each 14 significant bits
 *   VP8L  lossless  0x2f signature, then 14 bits (width-1), 14 bits (height-1)
 *   VP8X  extended  4 bytes flags, then u24 (canvas width-1), u24 (canvas height-1)
 *
 * Returns null for anything it does not recognise, and every caller treats null
 * as "leave the image alone" - an unreadable header must never be a reason to
 * transform a picture.
 */
export function webpSize(bytes) {
  if (!bytes || bytes.length < 30) return null;
  const tag = (o, s) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]) === s;
  if (!tag(0, 'RIFF') || !tag(8, 'WEBP')) return null;

  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const u24 = (o) => bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);

  if (tag(12, 'VP8 ')) {
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) return null;
    return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff, form: 'VP8' };
  }

  if (tag(12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null;
    // 32 bits little-endian: 14 for width-1, then 14 for height-1.
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, form: 'VP8L' };
  }

  if (tag(12, 'VP8X')) {
    return { width: u24(24) + 1, height: u24(27) + 1, form: 'VP8X' };
  }

  return null;
}

/** True only when the header is readable AND the image is wider than it is tall. */
export const isLandscape = (bytes) => {
  const d = webpSize(bytes);
  return !!d && d.width > d.height;
};
