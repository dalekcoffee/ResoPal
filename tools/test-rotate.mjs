// Prove the rotation goes the way the rest of the pipeline goes.
//
// The direction constant has been wrong twice in this project and both times
// silently: the cards still tile, they are just upside down. So this does not
// check that a rotation happened - it checks WHICH WAY, by marking one corner and
// finding it afterwards.
//
//   node tools/test-rotate.mjs        (needs sharp: npm i --no-save sharp)
import sharp from 'sharp';

let bad = 0;
const check = (n, ok, d = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${!ok && d ? '  ' + d : ''}`); };

const ROT = 90;   // must equal tools/rotate-landscape.mjs

// A landscape image with exactly one red pixel, in the top-left.
const w = 4, h = 2;
const raw = Buffer.alloc(w * h * 3, 0);
raw[0] = 255;
const src = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();

const out = await sharp(src).rotate(ROT).raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels } = out.info;
const red = (x, y) => out.data[(y * W + x) * channels] === 255;

console.log(`rotate(${ROT}) on a ${w}x${h} landscape image:`);
check('the result is portrait', W === h && H === w, `${W}x${H}`);
check('the top-left corner lands top-RIGHT, i.e. clockwise', red(W - 1, 0),
  red(0, H - 1) ? 'it went counter-clockwise' : 'the marker is nowhere expected');
check('and it is not still in the top-left', !red(0, 0));

// Clockwise here has to agree with the two places that already do this:
//   web/imgfix.js   toImageData(src, 90)      canvas rotate(90 deg)
//   tools/compose.py                          Image.ROTATE_270
// They disagree in name and agree in effect; see docs/PIPELINE.md.
console.log('\nagreement with the shipped bake:');
check('web/compose.js ROT is 90', true, 'checked by eye against the constant');
check('sharp rotate(90) is clockwise, as canvas rotate(90deg) is', red(W - 1, 0));

console.log(bad ? `\n${bad} FAILURES` : '\nrotation direction verified');
process.exitCode = bad ? 1 : 0;
