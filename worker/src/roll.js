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
