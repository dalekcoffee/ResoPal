// Browser port of tools/imgfix.py.
//
// Replace RGB in transparent/antialiased pixels with the nearest trusted-opaque
// RGB. Palworld card art is matted against white, so its antialiased edge pixels
// are light grey. Downscaling those straight leaves a white rim that survives the
// material's alpha cutout - the fix is to push real card colour outward BEFORE
// resizing, so the resize never averages white into the edge.
//
// Faithful to the numpy version: 8-neighbour dilation with wraparound, the k mask
// frozen for the whole pass, alpha carried through untouched. It walks only the
// still-unknown pixels each pass rather than the whole image, which is the same
// result for far less work.

const OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function solidify(img, iters = 12, trust = 200) {
  const { width: W, height: H, data } = img;
  const N = W * H;

  const rgb = new Float32Array(N * 3);
  const known = new Uint8Array(N);
  const alpha = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    const a = data[i * 4 + 3];
    alpha[i] = a;
    if (a >= trust) {                       // trusted opaque: keep its colour
      known[i] = 1;
      rgb[i * 3] = data[i * 4];
      rgb[i * 3 + 1] = data[i * 4 + 1];
      rgb[i * 3 + 2] = data[i * 4 + 2];
    }                                       // everything else starts at 0,0,0
  }

  let todo = [];
  for (let i = 0; i < N; i++) if (!known[i]) todo.push(i);

  for (let pass = 0; pass < iters && todo.length; pass++) {
    const filled = [];
    for (const di of todo) {
      const y = (di / W) | 0, x = di - y * W;
      let r = 0, g = 0, b = 0, n = 0;
      for (let o = 0; o < 8; o++) {
        const sy = (y - OFFSETS[o][0] + H) % H;     // wraparound, as np.roll does
        const sx = (x - OFFSETS[o][1] + W) % W;
        const si = sy * W + sx;
        if (known[si]) { r += rgb[si * 3]; g += rgb[si * 3 + 1]; b += rgb[si * 3 + 2]; n++; }
      }
      if (n) filled.push(di, r / n, g / n, b / n);
    }
    // apply only after the whole pass, so the mask stays frozen while gathering
    for (let i = 0; i < filled.length; i += 4) {
      const di = filled[i];
      rgb[di * 3] = filled[i + 1];
      rgb[di * 3 + 1] = filled[i + 2];
      rgb[di * 3 + 2] = filled[i + 3];
      known[di] = 1;
    }
    if (!filled.length) break;                      // nothing reachable; stop early
    todo = todo.filter(i => !known[i]);
  }

  const out = new ImageData(W, H);
  for (let i = 0; i < N; i++) {
    out.data[i * 4] = rgb[i * 3];
    out.data[i * 4 + 1] = rgb[i * 3 + 1];
    out.data[i * 4 + 2] = rgb[i * 3 + 2];
    out.data[i * 4 + 3] = alpha[i];                 // alpha is never touched
  }
  return out;
}

/** Draw a source image to a canvas and read it back as ImageData. */
export function toImageData(src, rotate = 0) {
  const swap = rotate === 90 || rotate === 270;
  const w = swap ? src.height : src.width;
  const h = swap ? src.width : src.height;
  const cv = new OffscreenCanvas(w, h);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  if (rotate) {
    cx.translate(w / 2, h / 2);
    cx.rotate(rotate * Math.PI / 180);
    cx.drawImage(src, -src.width / 2, -src.height / 2);
  } else {
    cx.drawImage(src, 0, 0);
  }
  return cx.getImageData(0, 0, w, h);
}

/** ImageData -> a canvas that can be drawn from (for the resize step). */
export function toCanvas(img) {
  const cv = new OffscreenCanvas(img.width, img.height);
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv;
}
