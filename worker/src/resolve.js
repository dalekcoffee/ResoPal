/**
 * Turn "whatever the user pasted" into a list of card codes and quantities.
 *
 * Two inputs are supported, because Palify offers two and people will paste
 * either one:
 *
 *   a deck link      https://palify.org/decks/<uuid>
 *   a decklist       # Green/Purple Trial (50 cards)
 *                    2x Mossanda – Guard Captain [TD02-001]
 *
 * Everything here is pure - no fetching, no catalogue lookup - so the whole
 * grammar is testable without a network. `index.js` does the I/O and then
 * validates every code against Palify's own catalogue, because a code this
 * file accepted is still only a well-formed string until Palify confirms it
 * exists. Inventing card data is the one thing this project must never do.
 */

/** The shape of a printing code. Same rule the image proxy whitelists on. */
const CODE = /^[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}$/;
const CODE_ANYWHERE = /\b[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}\b/g;
const DECK_URL = /palify\.org\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** More than this and something has gone wrong, or someone is being funny. */
export const MAX_CARDS = 200;

/**
 * What did they paste?
 *
 * A deck link and a bare deck id both mean "go and fetch it"; anything else is
 * treated as a list, including a single line with one card code on it.
 */
export function sniff(text) {
  const t = String(text || '').trim();
  const m = DECK_URL.exec(t);
  if (m) return { kind: 'palify', id: m[1].toLowerCase() };
  if (BARE_UUID.test(t)) return { kind: 'palify', id: t.toLowerCase() };
  return { kind: 'list' };
}

/**
 * Pull the deck out of a Palify RSC flight payload.
 *
 * Palify's deck pages are Next.js routes with no public API, so the only
 * machine-readable form is the flight payload (`RSC: 1`). It carries a
 * purpose-built array right next to the deck id:
 *
 *   "deckId":"<uuid>","list":[{"n":2,"name":"Mossanda – Guard Captain","code":"TD02-001"}, …]
 *
 * That array is what Palify's own copy-as-text export is built from, which is
 * why the two input formats agree card for card.
 *
 * This is an undocumented internal format and it WILL change without warning.
 * When it does the failure is loud - zero entries, reported as such - rather
 * than a deck that quietly comes back short.
 */
export function parseFlight(payload) {
  const s = String(payload || '');
  const name = /"deckName":"((?:[^"\\]|\\.)*)"/.exec(s);
  const entries = [];

  const at = s.indexOf('"list":[');
  if (at >= 0) {
    const open = at + '"list":'.length;
    const end = matchBracket(s, open);
    if (end > 0) {
      try {
        for (const e of JSON.parse(s.slice(open, end + 1))) {
          if (e && typeof e.code === 'string' && CODE.test(e.code))
            entries.push({ code: e.code, n: clampQty(e.n), name: typeof e.name === 'string' ? e.name : null });
        }
      } catch { /* fall through to the empty result; the caller reports it */ }
    }
  }
  return { name: name ? unescapeJson(name[1]) : null, entries, unrecognised: [] };
}

/** Walk from an opening bracket to its match, respecting strings and escapes. */
function matchBracket(s, open) {
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

const unescapeJson = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
const clampQty = (n) => (Number.isInteger(n) && n >= 1 && n <= 99 ? n : 1);

/**
 * Parse a pasted decklist.
 *
 * The grammar is "one card per line, and a line counts only if it carries a
 * card code". Palify's export is the shape this was written against:
 *
 *   # Green/Purple Trial (50 cards)
 *   2x Mossanda – Guard Captain [TD02-001]
 *
 * but these all work too, because people paste from everywhere:
 *
 *   2 Mossanda [TD02-001]      TD02-001 x2       TD02-001,2
 *   2x TD02-001                TD02-001          - 2x TD02-001
 *
 * **A line without a code is skipped and reported, never guessed at.** Matching
 * names to cards would mean inventing card data on a typo, and two phantom
 * cards have already reached production here that way. If a list has no codes
 * the caller gets zero cards and a list of what it could not read, which is a
 * failure someone can act on.
 */
export function parseDeckList(text) {
  const entries = [], unrecognised = [];
  let name = null;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // Reset lastIndex: the regex is global and shared across lines.
    CODE_ANYWHERE.lastIndex = 0;
    // Prefer a bracketed code - that is where Palify puts it, and it cannot be
    // confused with a set name or a date that happens to look code-shaped.
    const bracketed = /\[([A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4})\]/.exec(line);
    const found = bracketed ? [bracketed[1]] : (line.toUpperCase().match(CODE_ANYWHERE) || []);
    const code = found.find((c) => CODE.test(c));

    if (!code) {
      // A leading comment with no code is a title, not an error. Take the first
      // one; Palify's export puts the deck name there.
      const comment = /^(?:#+|\/\/)\s*(.+?)\s*$/.exec(line);
      if (comment) {
        if (name === null) name = comment[1].replace(/\s*\(\s*\d+\s+cards?\s*\)\s*$/i, '').trim() || null;
      } else if (!/^[-=*_\s]+$/.test(line)) {
        unrecognised.push(line.slice(0, 120));
      }
      continue;
    }

    // A pasted card URL - https://palify.org/card/bp01-091-wooden-wall - already
    // yields the right code, because the slug carries it. What it does NOT carry
    // is a usable name: stripping the code out of the url leaves the url. Names
    // are resolved against data/pool-*.json anyway (CLAUDE.md: never carry a name
    // over from whatever the source claimed), so null is the honest value.
    const fromUrl = /^https?:\/\/\S*\/card\/\S+$/i.test(line.trim());
    entries.push({ code, n: quantityOf(line, code), name: fromUrl ? null : labelOf(line, code) });
  }
  return { name, entries, unrecognised };
}

/**
 * How many of it. Leading `2x` / `2` wins; then a trailing `x2` or `,2`.
 * Anything unparseable is one card, which is the safe direction: a deck that is
 * short by three is obvious, a deck silently inflated to 99 is not.
 */
function quantityOf(line, code) {
  const lead = /^\s*(?:[-*+•]\s*)?(\d{1,2})\s*[xX*]?\s+/.exec(line);
  if (lead) return clampQty(Number(lead[1]));
  const after = new RegExp(`${escapeRe(code)}\\s*[\\],]?\\s*[xX*×]?\\s*(\\d{1,2})\\b`).exec(line);
  if (after) return clampQty(Number(after[1]));
  return 1;
}

/** Whatever the human wrote between the quantity and the code, if anything. */
function labelOf(line, code) {
  const t = line
    .replace(/^\s*(?:[-*+•]\s*)?\d{1,2}\s*[xX*]?\s+/, '')
    .replace(new RegExp(`\\[?${escapeRe(code)}\\]?`, 'i'), '')
    .replace(/[,;]\s*\d{1,2}\s*$/, '')
    .trim();
  return t || null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Expand `{code, n}` entries into one record per physical card, in list order.
 *
 * A four-of is four cards because the panel spawns one card per record and a
 * real deck has four of it. The cap is a cap, not a wrap: hitting it truncates
 * and says so rather than quietly serving a different deck.
 */
export function expand(entries, limit = MAX_CARDS) {
  const cards = [];
  let truncated = false;
  for (const e of entries) {
    for (let i = 0; i < e.n; i++) {
      if (cards.length >= limit) { truncated = true; break; }
      cards.push({ code: e.code, base: e.code, rarity: null, name: e.name });
    }
    if (truncated) break;
  }
  return { cards, truncated };
}
