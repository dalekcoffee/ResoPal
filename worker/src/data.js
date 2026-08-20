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
