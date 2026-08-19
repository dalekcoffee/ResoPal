from PIL import Image
import numpy as np

def solidify(im, iters=12, trust=200):
    """Replace RGB in transparent/antialiased pixels with nearest trusted-opaque RGB.
    Kills the light matte colour that Cutout would otherwise keep as a white rim."""
    a = np.array(im).astype(np.float32)
    rgb, al = a[..., :3], a[..., 3]
    known = al >= trust
    out = rgb.copy()
    out[~known] = 0.0
    k = known.astype(np.float32)
    for _ in range(iters):
        if k.all(): break
        s = np.zeros_like(out); c = np.zeros_like(k)
        for dy, dx in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
            s += np.roll(np.roll(out*k[...,None], dy, 0), dx, 1)
            c += np.roll(np.roll(k, dy, 0), dx, 1)
        fill = (c > 0) & (k == 0)
        out[fill] = (s[fill] / c[fill][..., None])
        k[fill] = 1.0
    res = np.dstack([out, al]).clip(0,255).astype(np.uint8)
    return Image.fromarray(res, 'RGBA')

def prep(im, size):
    """solidify then resize; alpha resized alongside so edges stay smooth."""
    return solidify(im.convert('RGBA')).resize(size, Image.LANCZOS)
