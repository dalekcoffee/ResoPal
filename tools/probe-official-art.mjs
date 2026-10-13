// Compare the official card game site's art against Palify's, card by card.
//
// Read-only research for the Worker's opt-in /official/ route (docs/OFFICIAL-ART.md).
// It answers three things nobody should guess at:
//   1. Does every code in data/pool-*.json have an official PNG at the filename
//      worker/src/official.js derives? A miss is not a broken card - the route
//      falls back to Palify - but it is a printing that will never get official art.
//   2. How do the two compare: pixel size, bytes, format, orientation?
//   3. Is the cardlist PNG the biggest copy the site has? Every distinct image URL
//      shape on the cardlist page (src, data-src, srcset) is listed, with sizes.
//
// Needs both hosts reachable. Behind an HTTPS proxy, Node's fetch ignores
// HTTPS_PROXY unless told: NODE_USE_ENV_PROXY=1 node tools/probe-official-art.mjs
//
//   node tools/probe-official-art.mjs                    all pool codes
//   node tools/probe-official-art.mjs codes=TD02-002,BP01-025SSP
//   node tools/probe-official-art.mjs limit=10 out=report.md
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { officialUrl } from '../worker/src/official.js';
import { pngSize } from '../worker/src/png.js';
import { webpSize } from '../worker/src/webp.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const UA = 'ResoPal/1.0 (+https://resopal.dalek.coffee)';
const SITE = 'https://en.palworld-official-cardgame.com';
const LIST = `${SITE}/cardlist/searchresults?keyword=&keyword_type%5B%5D=all&search_type=and&product_category=&title=&card_kind=&color=&lucky=&power_1f=&power_1l=&attack_1f=&attack_1l=&aptitude=&parallel=`;
const data = path.join(import.meta.dirname, '..', 'data');

let codes;
if (args.codes) codes = args.codes.split(',').map((c) => c.trim().toUpperCase());
else {
  const seen = new Set();
  for (const f of (await readdir(data)).filter((f) => /^pool-.*\.json$/.test(f)))
    JSON.stringify(JSON.parse(await readFile(path.join(data, f), 'utf8')), (k, v) => {
      if (k === 'code' && typeof v === 'string') seen.add(v);
      return v;
    });
  codes = [...seen].sort();
}
if (args.limit) codes = codes.slice(0, Number(args.limit));

const kb = (n) => (n == null ? '-' : `${(n / 1024).toFixed(0)} KB`);
const dims = (d) => (d ? `${d.width}x${d.height}` : '-');
const size = (b) => pngSize(b) || webpSize(b) || null;

async function probe(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    const b = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    return { url, status: r.status, type: r.headers.get('content-type'), bytes: b?.length ?? null,
      dims: b ? size(b) : null, acao: r.headers.get('access-control-allow-origin'),
      cache: r.headers.get('cache-control'), modified: r.headers.get('last-modified') };
  } catch (e) { return { url, status: 'ERR', error: String(e.cause?.code || e.message) }; }
}

/** Small pool, so a few hundred requests do not land on either site at once. */
async function each(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const lines = [`# Official vs Palify card art`, ``, `Probed ${new Date().toISOString()}, ${codes.length} codes.`, ``];

// ── 3. what the cardlist page itself links ───────────────────────────────────
const page = await probe(LIST);
lines.push(`## Cardlist page`, ``, `${LIST}`, ``, `status ${page.status}`, ``);
if (page.status === 200) {
  const html = await (await fetch(LIST, { headers: { 'user-agent': UA } })).text();
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|data-src|data-original|href)=["']([^"']+\.(?:png|jpe?g|webp))["']/gi)) urls.add(m[1]);
  for (const m of html.matchAll(/srcset=["']([^"']+)["']/gi)) for (const part of m[1].split(',')) urls.add(part.trim().split(/\s+/)[0]);
  const abs = [...urls].map((u) => new URL(u, SITE).href);
  // Collapse to shapes: the card code is the only thing that should vary.
  const shapes = new Map();
  for (const u of abs) {
    const shape = u.replace(/E?[A-Z]{2,4}\d{2}-\d{3}[A-Z]*/g, '<CODE>').replace(/\/E?[A-Z]{2,4}\d{2}\//g, '/<SET>/');
    if (!shapes.has(shape)) shapes.set(shape, []);
    shapes.get(shape).push(u);
  }
  lines.push(`${abs.length} image URLs, ${shapes.size} distinct shapes:`, ``);
  for (const [shape, list] of shapes) {
    const p = await probe(list[0]);
    lines.push(`- \`${shape}\` x${list.length} — e.g. ${list[0]} → ${p.status} ${p.type ?? ''} ${dims(p.dims)} ${kb(p.bytes)}`);
  }
  const cardLinks = [...new Set([...html.matchAll(/href=["']([^"']*card[^"']*(?:detail|no|id)[^"']*)["']/gi)].map((m) => m[1]))];
  lines.push(``, `Detail-page-looking links: ${cardLinks.length}${cardLinks.length ? ' — e.g. ' + new URL(cardLinks[0], SITE).href : ''}`);
  lines.push(`Pagination-looking links: ${[...html.matchAll(/href=["'][^"']*(?:page|paged)=?\d+[^"']*["']/gi)].length}`, ``);
}

// ── 1 + 2. per card ──────────────────────────────────────────────────────────
const rows = await each(codes, 4, async (code) => {
  const [off, pal] = await Promise.all([probe(officialUrl(code)), probe(`https://palify.org/cards/w1024/${code}.webp`)]);
  return { code, off, pal };
});

const hit = rows.filter((r) => r.off.status === 200 && r.off.dims);
const miss = rows.filter((r) => r.off.status !== 200 || !r.off.dims);
lines.push(`## Per card`, ``,
  `Official PNG found for **${hit.length}/${rows.length}** codes. Missing: ${miss.map((r) => `${r.code} (${r.off.status})`).join(', ') || 'none'}`, ``,
  `| code | official | official bytes | palify w1024 | palify bytes | orientation |`,
  `|---|---|---|---|---|---|`);
for (const { code, off, pal } of rows) {
  const land = (d) => (d ? (d.width > d.height ? 'L' : 'P') : '?');
  lines.push(`| ${code} | ${off.status === 200 ? dims(off.dims) : off.status} | ${kb(off.bytes)} | ${pal.status === 200 ? dims(pal.dims) : pal.status} | ${kb(pal.bytes)} | ${land(off.dims)}/${land(pal.dims)} |`);
}
const first = rows.find((r) => r.off.status === 200);
if (first) lines.push(``, `Official headers (${first.code}): content-type \`${first.off.type}\`, ` +
  `access-control-allow-origin \`${first.off.acao}\`, cache-control \`${first.off.cache}\`, last-modified \`${first.off.modified}\``);

// Is w1024 Palify's ceiling? Try the obvious bigger paths on one card.
if (first) {
  lines.push(``, `## Palify above w1024 (${first.code})`, ``);
  for (const u of [`https://palify.org/cards/w2048/${first.code}.webp`, `https://palify.org/cards/${first.code}.webp`,
    `https://palify.org/cards/w1536/${first.code}.webp`]) {
    const p = await probe(u);
    lines.push(`- ${u} → ${p.status} ${dims(p.dims)} ${kb(p.bytes)}`);
  }
}

const report = lines.join('\n') + '\n';
if (args.out) { await writeFile(args.out, report); console.log(`wrote ${args.out}`); }
else console.log(report);
