#!/usr/bin/env node
/**
 * Generate the pre-rotated copies of every landscape printing.
 *
 * Some printings - every one a Structure - are served by Palify already-landscape
 * against a portrait card cell. The browser bake turns them on the way into the
 * atlas, but the in-world path uses the image as it comes, and NOTHING in Resonite
 * can turn it there: TextureScale/TextureOffset reach the shader as _Tex_ST,
 * applied as `uv * scale + offset`, which scales and translates each axis but
 * cannot swap them. So the rotation has to be in the pixels.
 *
 * This writes `assets/rot/w<width>/<CODE>.webp`, which the Worker's /img/ route
 * substitutes for anything whose header measures wider than tall.
 *
 * WHICH cards get turned is decided by MEASURING each one, not by reading the
 * `landscape` array in data/pool-*.json. That array is a snapshot and can be
 * stale or wrong; the image cannot. The pools are used only to know which codes
 * exist, which is what CLAUDE.md's "never invent card data" asks for.
 *
 *   node tools/rotate-landscape.mjs [--check] [--codes BP02-014,BP02-015]
 *
 *   --check   report what would change and write nothing (exit 1 if stale)
 *
 * Normally run by .github/workflows/rotate-landscape.yml, because the images have
 * to be fetched from Palify and committed - neither of which happens on a machine
 * without a checkout and network access.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'assets', 'rot');
const UPSTREAM = 'https://palify.org';
const WIDTHS = [256, 512, 1024];      // must match the Worker's WIDTHS
const SOURCE_WIDTH = 1024;            // largest Palify serves; every size is derived from it
const QUALITY = 95;                   // matching composeAtlas's 0.95
const ROT = 90;                       // clockwise. sharp's rotate() is clockwise, as is
                                      // canvas rotate() in web/imgfix.js and PIL's ROTATE_270
                                      // in tools/compose.py. If cards come out upside down in
                                      // world, this single constant is the thing to flip.
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const extra = (args[args.indexOf('--codes') + 1] || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const CODE = /^[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}$/;

/** Every code the committed pools know about, plus anything passed with --codes. */
async function allCodes() {
  const codes = new Set(extra.filter((c) => CODE.test(c)));
  for (const f of await readdir(path.join(ROOT, 'data'))) {
    if (!/^pool-.*\.json$/.test(f)) continue;
    const pool = JSON.parse(await readFile(path.join(ROOT, 'data', f), 'utf8'));
    for (const tier of Object.values(pool.byRarity ?? {})) for (const c of tier) codes.add(c.code);
    for (const c of pool.landscape ?? []) codes.add(c);          // belt and braces
  }
  return [...codes].sort();
}

async function fetchCard(code) {
  const url = `${UPSTREAM}/cards/w${SOURCE_WIDTH}/${code}.webp`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;                          // a code the catalogue lost
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw new Error(`${code}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}

const results = { turned: [], portrait: 0, missing: [], failed: [] };
const written = new Map();

async function handle(code) {
  let bytes;
  try { bytes = await fetchCard(code); }
  catch (e) { results.failed.push(e.message); return; }
  if (!bytes) { results.missing.push(code); return; }

  const meta = await sharp(bytes).metadata();
  // The same rule the Worker applies, and for the same reason: the image decides.
  if (!(meta.width > meta.height)) { results.portrait++; return; }

  const turned = sharp(bytes).rotate(ROT);
  for (const w of WIDTHS) {
    const buf = await turned.clone().resize({ width: w }).webp({ quality: QUALITY }).toBuffer();
    const out = await sharp(buf).metadata();
    if (!(out.height > out.width))
      throw new Error(`${code} at w${w} came out ${out.width}x${out.height} - rotation did not make it portrait`);
    written.set(path.join(OUT, `w${w}`, `${code}.webp`), buf);
  }
  results.turned.push(`${code} ${meta.width}x${meta.height}`);
}

const codes = await allCodes();
console.log(`checking ${codes.length} printings from data/pool-*.json${extra.length ? ` (+${extra.length} passed in)` : ''}`);

for (let i = 0; i < codes.length; i += CONCURRENCY) {
  await Promise.all(codes.slice(i, i + CONCURRENCY).map(handle));
  process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, codes.length)}/${codes.length}`);
}
process.stdout.write('\n');

// What is already committed, so --check can tell stale from merely different bytes.
const existing = new Set();
for (const w of WIDTHS) {
  const dir = path.join(OUT, `w${w}`);
  if (existsSync(dir)) for (const f of await readdir(dir)) existing.add(path.join(dir, f));
}
const added = [...written.keys()].filter((f) => !existing.has(f));
const orphaned = [...existing].filter((f) => !written.has(f));

console.log(`\n  turned    ${results.turned.length}`);
console.log(`  portrait  ${results.portrait} (left alone)`);
if (results.missing.length) console.log(`  missing   ${results.missing.length}: ${results.missing.join(', ')}`);
if (results.failed.length) { console.log(`  FAILED    ${results.failed.length}:`); for (const f of results.failed) console.log(`     ${f}`); }
console.log(`\n  ${written.size} files, ${added.length} new, ${orphaned.length} orphaned`);
for (const t of results.turned) console.log(`     ${t}`);

if (results.failed.length) { console.error('\nrefusing to write: some cards could not be fetched'); process.exit(1); }

if (CHECK) {
  const stale = added.length > 0 || orphaned.length > 0;
  console.log(stale ? '\n--check: assets/rot is STALE' : '\n--check: assets/rot is up to date');
  process.exit(stale ? 1 : 0);
}

for (const [file, buf] of written) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buf);
}
console.log(`\nwrote ${written.size} files under assets/rot/`);
