// The credit lines a v1.0 deck carries, and the check that it still carries them.
//
// Ukilop's and Palify's credits are a permanent requirement, not a courtesy
// (CLAUDE.md). v1.0 adds Sharkmake, whose card templates every card is built on.
//
// A deck carries them as slot NAMES, because slot names are all a deck has once it
// is loose in a world: plain text, no rich text and no clickable links, so the urls
// are written out to be read.
//
// ── why this VERIFIES instead of building ────────────────────────────────────
//
// The old credits.js built the /credits slot at bake time, because a raw Deck Maker
// export only carries Ukilop's line. The v1.0 template already ships all four, from
// the panel it was extracted out of - so building them again would either duplicate
// the slot or quietly disagree with the panel's copy. Checking is the whole job, and
// it fails the export rather than shipping a deck that credits the wrong people.
//
// Ukilop's line keeps its version number on purpose: it matters when a future Deck
// Maker changes the template.

export const DECK_CREDITS = [
  'Card data - Palify - palify.org',
  'Deck template - Deck Maker by Ukilop V1.4.4',
  'Card templates & TCG field systems - Sharkmake (AKA Flux)',
  'Tool by Dalek - dalek.coffee - ResoPal v1.0 - resopal.dalek.coffee',
];

/** Throws unless the deck root carries a /credits slot naming exactly these four. */
export function verifyCredits(doc) {
  const root = doc.Object;
  const credits = (root.Children ?? []).find(c => String(c?.Name?.Data ?? '') === 'credits');
  if (!credits) throw new Error('the deck carries no /credits slot');

  const got = (credits.Children ?? []).map(c => String(c?.Name?.Data ?? ''));
  const missing = DECK_CREDITS.filter(w => !got.includes(w));
  if (missing.length) throw new Error(
    `/credits is missing ${missing.length} line(s), first: ${JSON.stringify(missing[0])}`);
  return credits;
}
