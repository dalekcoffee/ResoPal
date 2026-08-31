// Unit-test the WebP header reader against hand-built containers.
//
// Built rather than captured because the Worker must not guess: a mis-read header
// would silently turn portrait cards sideways, which is worse than the bug it is
// meant to fix. Each vector is assembled from the spec's own field layout, so a
// wrong offset fails here rather than in-world.
import { webpSize, isLandscape } from '../src/webp.js';

let bad = 0;
const check = (n, ok, d = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${!ok && d ? '  ' + d : ''}`); };

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const container = (fourcc, payload) => {
  const b = new Uint8Array(20 + payload.length);
  b.set(ascii('RIFF'), 0);
  new DataView(b.buffer).setUint32(4, 12 + payload.length, true);
  b.set(ascii('WEBP'), 8);
  b.set(ascii(fourcc), 12);
  new DataView(b.buffer).setUint32(16, payload.length, true);
  b.set(payload, 20);
  return b;
};

// VP8 lossy: 3-byte frame tag, 9d 01 2a start code, u16 width, u16 height.
const vp8 = (w, h) => {
  const p = new Uint8Array(20);
  p.set([0, 0, 0, 0x9d, 0x01, 0x2a], 0);
  new DataView(p.buffer).setUint16(6, w, true);
  new DataView(p.buffer).setUint16(8, h, true);
  return container('VP8 ', p);
};

// VP8L lossless: 0x2f, then 14 bits (w-1) and 14 bits (h-1), little-endian.
const vp8l = (w, h) => {
  const p = new Uint8Array(20);
  p[0] = 0x2f;
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  new DataView(p.buffer).setUint32(1, bits >>> 0, true);
  return container('VP8L', p);
};

// VP8X extended: 4 bytes flags, u24 (canvas w-1), u24 (canvas h-1).
const vp8x = (w, h) => {
  const p = new Uint8Array(20);
  const put24 = (o, v) => { p[o] = v & 0xff; p[o + 1] = (v >> 8) & 0xff; p[o + 2] = (v >> 16) & 0xff; };
  put24(4, w - 1); put24(7, h - 1);
  return container('VP8X', p);
};

console.log('dimensions come back exactly:');
for (const [name, make] of [['VP8', vp8], ['VP8L', vp8l], ['VP8X', vp8x]]) {
  // 1024x732 is what Palify serves for a landscape Structure; 732x1024 is it turned.
  const land = webpSize(make(1024, 732));
  const port = webpSize(make(732, 1024));
  check(`${name}: 1024x732 reads back`, land?.width === 1024 && land?.height === 732, JSON.stringify(land));
  check(`${name}: 732x1024 reads back`, port?.width === 732 && port?.height === 1024, JSON.stringify(port));
  check(`${name}: landscape is detected`, isLandscape(make(1024, 732)));
  check(`${name}: portrait is not`, !isLandscape(make(732, 1024)));
  check(`${name}: a square is not landscape`, !isLandscape(make(800, 800)));
}

console.log('\nan unreadable header never triggers a transform:');
check('not a RIFF', webpSize(new Uint8Array(40)) === null);
check('RIFF but not WEBP', webpSize((() => { const b = new Uint8Array(40); b.set(ascii('RIFF'), 0); b.set(ascii('AVI '), 8); return b; })()) === null);
check('truncated', webpSize(vp8(1024, 732).slice(0, 12)) === null);
check('empty', webpSize(new Uint8Array(0)) === null);
check('null', webpSize(null) === null);
check('unknown chunk type', webpSize(container('ANIM', new Uint8Array(20))) === null);
check('VP8 with a broken start code', webpSize((() => { const b = vp8(1024, 732); b[23] = 0; return b; })()) === null);
check('VP8L with a broken signature', webpSize((() => { const b = vp8l(1024, 732); b[20] = 0; return b; })()) === null);
check('and none of those is landscape', [new Uint8Array(0), new Uint8Array(40)].every((b) => !isLandscape(b)));

// The dimensions each form can carry, at the edges.
console.log('\nedge sizes:');
check('VP8 14-bit maximum', webpSize(vp8(16383, 16383))?.width === 16383);
check('VP8L 14-bit maximum', webpSize(vp8l(16384, 16384))?.width === 16384);
check('VP8X 24-bit width', webpSize(vp8x(16777216, 1))?.width === 16777216);
check('1x1 is not landscape', !isLandscape(vp8(1, 1)));

console.log(bad ? `\n${bad} FAILURES` : '\nwebp header reader verified');
process.exitCode = bad ? 1 : 0;
