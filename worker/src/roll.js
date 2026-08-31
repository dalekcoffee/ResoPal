/**
 * The pack roll. One implementation, server-side, for both callers.
 *
 * The website used to roll in the browser with Math.random(), which anyone can
 * edit in devtools; the in-world spawner cannot roll at all (no RNG worth the
 * name and no card list). Moving the roll here is what makes a pull mean
 * something, and it is the only way in-world and on-site odds cannot drift -
 * they are not two implementations kept in step, they are one.
 *
 * Inputs are the two committed data files, unmodified:
 *   data/pack-weights.json   slot layout + hit-slot odds + event bonuses
 *   data/pool-<set>.json     which printings exist at each rarity (from Palify)
 */

/** xmur3: string -> 32-bit seed. Paired with mulberry32 below. */
function seedFrom(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** mulberry32: small, fast, well-distributed. Same seed => same pull, forever. */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random 6-hex seed, for when the caller did not pin one. */
export const newSeed = () => Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');

/**
 * Apply the event multipliers to the hit table.
 *
 * `R` is deliberately left alone: it is the floor of the hit slot, so scaling it
 * with everything else would make a "twice as generous" event change nothing.
 * Raising the rares raises them *against* R. This matches the site's reading of
 * the same file, and is why globalBonus is worth having at all.
 */
export function hitTable(set, globalBonus = 1) {
  const bonus = set.perPackBonus || {};
  const out = {};
  for (const [rarity, weight] of Object.entries(set.hitSlot))
    out[rarity] = weight * (rarity === 'R' ? 1 : (bonus[rarity] || 1) * globalBonus);
  return out;
}

/**
 * Roll `packs` packs of `set`.
 *
 * Returns { pulls, best, unavailable }. `pulls` is flat and in pack order; each
 * pack's own cards are sorted RAREST FIRST, because that is the order the deck
 * bake lays out into the atlas and therefore the order the physical stack ends
 * up in - see docs/BOOSTER.md "Stack order".
 *
 * A rarity the weights ask for but the pool cannot supply is dropped from the
 * hit table and named in `unavailable`, never silently swapped for another
 * rarity: quietly changing the odds is worse than visibly refusing to.
 */
export function rollPacks({ pool, weights, setCode, packs = 1, seed }) {
  const set = weights.sets?.[setCode];
  if (!set) throw new Error(`no weights for set ${setCode}`);
  if (pool.set !== setCode) throw new Error(`pool is for ${pool.set}, not ${setCode}`);

  const rank = weights.rank || [];
  const rarer = (a, b) => rank.indexOf(a.rarity) - rank.indexOf(b.rarity);
  const has = (r) => Array.isArray(pool.byRarity[r]) && pool.byRarity[r].length > 0;

  const unavailable = [];
  const hit = {};
  for (const [rarity, weight] of Object.entries(hitTable(set, weights.globalBonus?.value ?? 1))) {
    if (has(rarity)) hit[rarity] = weight;
    else unavailable.push(rarity);
  }
  if (!Object.keys(hit).length) throw new Error(`${setCode}: no hit-slot rarity exists in the pool`);
  for (const slot of set.slots)
    if (slot.rarity !== 'HIT' && !has(slot.rarity))
      throw new Error(`${setCode}: pool has no ${slot.rarity} printings, but a slot requires ${slot.count}`);

  const rand = mulberry32(seedFrom(String(seed))());
  const hitKeys = Object.keys(hit);
  const hitSum = hitKeys.reduce((t, k) => t + hit[k], 0);
  const rollHit = () => {
    let r = rand() * hitSum;
    for (const k of hitKeys) { r -= hit[k]; if (r <= 0) return k; }
    return hitKeys[hitKeys.length - 1];
  };

  const pulls = [];
  for (let p = 1; p <= packs; p++) {
    const pack = [];
    for (const slot of set.slots) {
      for (let i = 0; i < slot.count; i++) {
        const rarity = slot.rarity === 'HIT' ? rollHit() : slot.rarity;
        const list = pool.byRarity[rarity];
        const pick = list[Math.floor(rand() * list.length)];
        pack.push({ pack: p, slot: slot.rarity, code: pick.code, base: pick.base, rarity });
      }
    }
    pack.sort(rarer);
    pulls.push(...pack);
  }

  const best = pulls.slice().sort(rarer)[0]?.rarity ?? null;
  return { pulls, best, unavailable };
}

/** `code,rarity` per line - the only shape ProtoFlux can take apart cheaply. */
export const toFlat = (pulls) => pulls.map((c) => `${c.code},${c.rarity}`).join('\n') + '\n';

/**
 * Fixed-width art URLs, one RECORD_WIDTH-char record per card.
 *
 * This exists for ProtoFlux and nothing else. With variable-length lines, card i
 * can only be found by walking i newlines, which makes each card depend on the
 * one before it - a 70-deep chain, three extra nodes per card, and a graph no
 * one can read. At a fixed width card i starts at i*64 flat, so every card
 * decodes independently from a constant.
 *
 * Each record is the full URL, right-padded with spaces, then a newline - so it
 * stays readable in a browser while still being fixed-width. The engine's
 * TrimString removes both.
 *
 * A URL that will not fit is an error rather than a truncation: a silently
 * clipped URL would load nothing and say nothing about why.
 */
// 80, not 64. The longest code in the pools, TD01-024TSR-ERR, already made a
// 65-character url - toFixed threw on that card before any of this. 80 leaves
// room for it plus the cache-bust below.
export const RECORD_WIDTH = 80;

/**
 * In-world art is served at 512px, not the 1024 the site bakes from.
 *
 * A spawned card is its own texture - there is no atlas in-world - so a 50-card
 * deck is 50 textures resident at once. At w=1024 that is ~95 MB of VRAM; at
 * w=512 it is ~24 MB, and 512px is the same per-card resolution a whole-set
 * atlas could have managed inside Resonite's 8192 texture limit anyway.
 *
 * Resonite caches by URL, so cards shared between players and between decks cost
 * nothing extra - which is why per-card textures beat a bespoke atlas per deck
 * for a room full of people: the atlases would all be different images.
 */
export const IN_WORLD_WIDTH = 512;

export function toFixed(pulls, artBase) {
  const out = [];
  for (const c of pulls) {
    // &v= is what makes Resonite refetch. It caches an asset by URL, in the
    // install, and neither a new world nor a fresh import clears it - so without
    // this a client keeps the texture it fetched before the art was rotated. The
    // Worker ignores unknown query parameters and keys its own cache on code and
    // width, so this changes nothing upstream. Must match ART_VERSION in
    // booster/build-deck-probe.mjs.
    const url = `${artBase}${c.code}?w=${IN_WORLD_WIDTH}&v=2`;
    if (url.length > RECORD_WIDTH - 1)
      throw new Error(`art URL ${url.length} chars exceeds the ${RECORD_WIDTH - 1} the fixed format allows`);
    out.push(url.padEnd(RECORD_WIDTH - 1, ' ') + '\n');
  }
  return out.join('');
}
