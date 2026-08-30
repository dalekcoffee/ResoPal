/**
 * Parsers for Palify's RSC flight payloads.
 *
 * Palify has no deck or profile endpoint (docs/PALIFY-API.md). The only
 * machine-readable form of `/decks/<uuid>` and `/u/<handle>` is the React
 * flight payload the pages ship to the client, requested with `RSC: 1`.
 *
 * This lives in the Worker on purpose: the format is undocumented and will
 * change without warning, and when it does the fix should be one Worker deploy
 * rather than a new front end on a static host.
 *
 * Everything below was written against real payloads captured 2026-08:
 *   /decks/<uuid>  ~81-109 KB   /u/<handle>  ~28 KB
 *
 * The payload is a stream of `<id>:<json>` lines carrying serialised React
 * elements, so it is not JSON as a whole. What it does contain are islands of
 * ordinary JSON, and the deck page hands us a ready-made list:
 *
 *   "deckId":"<uuid>","list":[{"n":3,"name":"Eikthyrdeer Terra - ...","code":"TD02-005"}]
 *
 * We find those islands by key, brace-match them out, and JSON.parse only that
 * slice. No card data is ever invented here - a payload we cannot read returns
 * null and the caller answers 502, which is a fixable error rather than a
 * plausible wrong deck.
 */

const CODE = /^[A-Z][A-Z0-9]{1,5}-[0-9]{1,4}[A-Z]{0,4}$/;

/**
 * Palify answers a missing deck or profile with HTTP **200** and Next.js's own
 * 404 payload, so the status line cannot be trusted. Measured: a random UUID
 * returns 200 and ~19 KB carrying `NEXT_HTTP_ERROR_FALLBACK;404`.
 *
 * Without this check a deleted or private deck reads as "the format changed",
 * which sends the user hunting for a bug instead of telling them to export the
 * deck from Palify.
 *
 * The error digest is the ONLY reliable marker. Every Next.js page - a perfectly
 * good deck included - ships "404: This page could not be found." inside its
 * unrendered `notFound` slot, so matching on that string rejects every deck.
 */
export function isNotFound(text) {
  return /NEXT_HTTP_ERROR_FALLBACK;404/.test(text);
}

/**
 * Slice one balanced `[...]` or `{...}` starting at `start`, respecting string
 * literals and escapes. Returns null if it never closes.
 */
export function sliceJson(text, start) {
  const open = text[start];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** JSON.parse the value of the first `"key":<[ or {>` that parses cleanly. */
function islands(text, key) {
  const out = [];
  const re = new RegExp(`"${key}":\\s*(?=[[{])`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const raw = sliceJson(text, m.index + m[0].length);
    if (!raw) continue;
    try { out.push(JSON.parse(raw)); } catch (e) { /* not an island, keep looking */ }
  }
  return out;
}

/** First capture of `re`, JSON-unescaped. */
function str(text, re) {
  const m = re.exec(text);
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch (e) { return m[1]; }
}

const STR = (key) => new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`);

/**
 * A deck page -> {id, name, author, total, cards:[{code, name, n}]}.
 * Returns null if the payload carries no readable list.
 */
export function parseDeck(text, id) {
  const list = islands(text, 'list').find((a) =>
    Array.isArray(a) && a.length &&
    a.every((e) => e && typeof e.code === 'string' && CODE.test(e.code) &&
      typeof e.n === 'number' && e.n >= 1));
  if (!list) return null;

  // Deck order is the list's own order: the atlas is laid out in deck order and
  // a card's index is its position in the physical stack (docs/BOOSTER.md).
  const cards = list.map((e) => ({
    code: e.code.toUpperCase(),
    name: typeof e.name === 'string' ? e.name : '',
    n: Math.min(99, Math.round(e.n)),
  }));

  return {
    id,
    // "deckName" comes from the share widget, "name" from the list's own island;
    // both carry the same string, and a deck with neither still imports.
    name: str(text, STR('deckName')) || str(text, STR('name')) || 'Palify deck',
    author: str(text, STR('creator')),
    total: cards.reduce((t, c) => t + c.n, 0),
    cards,
  };
}

/**
 * A profile page -> {handle, title, decks:[{id, name, total, colors}]}.
 *
 * Public decks are rendered as links to /decks/<uuid>; each carries its name, a
 * card count, and the colour bar Palify draws from the deck's own contents. No
 * card codes, which is why the picker shows colours rather than faces - the
 * alternative is one full deck fetch per row.
 */
export function parseProfile(text, handle) {
  const decks = [];
  const seen = new Set();
  const re = /"href":"\/decks\/([0-9a-f-]{36})"/g;
  let m;
  while ((m = re.exec(text))) {
    const id = m[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    // Bound the scan at the next deck link so one row cannot read another's name.
    re.lastIndex = m.index + m[0].length;
    const next = new RegExp('"href":"/decks/').exec(text.slice(re.lastIndex));
    const chunk = text.slice(re.lastIndex, re.lastIndex + (next ? next.index : 4000));
    const total = /"children":\[(\d+)," cards?"\]/.exec(chunk);
    const colors = [];
    const cre = /\["\$","div","([A-Za-z]+)",\{"style":\{"width":"([\d.]+)%"/g;
    let c;
    while ((c = cre.exec(chunk))) colors.push({ color: c[1], pct: +c[2] });
    decks.push({
      id,
      name: str(chunk, STR('children')) || 'Untitled deck',
      total: total ? +total[1] : null,
      colors,
    });
  }
  if (!decks.length && !/Public decks/.test(text)) return null;
  // The page's own <title> is nav chrome; the display name lives in the profile
  // island, next to the handle that identifies which profile this is.
  const title = str(text, /"kind":"profile","title":"((?:[^"\\]|\\.)*)"/);
  return { handle, title: title || handle, decks };
}
