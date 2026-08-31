/**
 * The two committed data files, bundled into the Worker.
 *
 * They are imported rather than fetched so a pull costs no network hop and the
 * deployed odds are pinned to the deployed commit. Import attributes are used
 * because Node needs them to run worker/test/*; if a future wrangler build
 * rejects them, drop the `with` clause here - it is the only place they appear.
 */
export { default as weights } from '../../data/pack-weights.json' with { type: 'json' };
export { default as poolBP01 } from '../../data/pool-bp01.json' with { type: 'json' };
export { default as decks } from '../../data/decks.json' with { type: 'json' };

// The trial-deck pools are imported for ONE field each: `landscape`. The image
// route needs to know which printings Palify serves already-turned, and that list
// is per-set, so all three pools have to be here even though only BP01 is rolled
// against. Bundling them is ~14 KB and keeps the list pinned to the deployed
// commit like everything else.
export { default as poolTD01 } from '../../data/pool-td01.json' with { type: 'json' };
export { default as poolTD02 } from '../../data/pool-td02.json' with { type: 'json' };
