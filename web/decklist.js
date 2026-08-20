// Parse a deck list exported from Palify. Handles the two shapes Palify emits and
// the handwritten ones people actually paste.
//
//   quantity,code,name     CSV, with or without the header row
//   2,TD02-001,Mossanda - Guard Captain
//   2x Mossanda - Guard Captain [TD02-001]      the .txt export
//   2x TD02-001
//   TD02-001                                     bare code, quantity 1
//
// Lines starting with # are comments. The code column is authoritative - names are
// only carried through for display, because a decklist's spelling drifts and the
// catalogue's does not.

const CODE = '[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}';
const RE = {
  bracket: new RegExp(`^(?:(\\d+)\\s*[x*]?\\s+)?(.*?)\\s*\\[(${CODE})\\]\\s*$`, 'i'),
  prefix:  new RegExp(`^(?:(\\d+)\\s*[x*]?\\s+)(${CODE})\\b\\s*(.*)$`, 'i'),
  bare:    new RegExp(`^(${CODE})\\s*$`, 'i'),
};

const isHeader = l => /^\s*quantity\s*,\s*code\b/i.test(l);

function parseLine(line) {
  const csv = line.split(',');
  if (csv.length >= 2) {
    const q = csv[0].trim(), c = csv[1].trim();
    if (/^\d+$/.test(q) && new RegExp(`^${CODE}$`, 'i').test(c))
      return { n: +q, code: c.toUpperCase(), name: (csv.slice(2).join(',') || '').trim() };
  }
  let m = RE.bracket.exec(line);
  if (m) return { n: m[1] ? +m[1] : 1, code: m[3].toUpperCase(), name: m[2].trim() };
  m = RE.prefix.exec(line);
  if (m) return { n: +m[1], code: m[2].toUpperCase(), name: (m[3] || '').trim() };
  m = RE.bare.exec(line);
  if (m) return { n: 1, code: m[1].toUpperCase(), name: '' };
  return null;
}

/**
 * Returns {deck: [{code, n, name}], total, skipped: [lines]}.
 * Deck order is first-appearance order; repeated codes accumulate, because that is
 * what a physical deck does and the atlas is laid out in deck order.
 */
export function parseDeckList(text) {
  const deck = [], byCode = new Map(), skipped = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || isHeader(line)) continue;
    const e = parseLine(line);
    if (!e || e.n < 1) { skipped.push(line); continue; }
    const seen = byCode.get(e.code);
    if (seen) { seen.n += e.n; if (!seen.name && e.name) seen.name = e.name; }
    else { const rec = { code: e.code, n: e.n, name: e.name }; byCode.set(e.code, rec); deck.push(rec); }
  }
  return { deck, total: deck.reduce((t, e) => t + e.n, 0), skipped };
}
