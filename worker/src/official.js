/**
 * Where the official card game site keeps a card's art, from Palify's code.
 *
 * English printings carry an `E` prefix on both the folder and the file:
 *   TD02-002     -> ETD02/ETD02-002.png
 *   BP01-025SSP  -> EBP01/EBP01-025SSP.png
 *
 * A code this gets wrong is not an error anyone sees: the official site 404s and
 * /official/ serves Palify's copy instead (index.js, `official()`). So a wrong
 * mapping costs the official art for that printing, never the card.
 */
export const OFFICIAL = 'https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist';

export function officialUrl(code) {
  const set = code.split('-')[0];
  return `${OFFICIAL}/E${set}/E${code}.png`;
}
