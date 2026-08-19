// Trim a baked deck to N cards. Safe because the deck's flux drives its loops
// from `Children Count`, not a baked-in count.
export function trimToCards(doc, N, log = console.log) {
  const kidsOf = s => s.Children ?? [];
  const nm = s => String(s?.Name?.Data ?? '');
  const typeName = a => {
    const t = a.Type;
    const i = (t && typeof t === 'object') ? (t.value ?? t.valueOf?.()) : t;
    return String(doc.Types?.[i] ?? '');
  };

  const rootKids = kidsOf(doc.Object);
  const assetsSlot = rootKids.find(c => nm(c) === 'Assets');
  const surface = rootKids.find(c => nm(c).startsWith('Surface'));
  const cards = kidsOf(surface)[0];

  const before = kidsOf(cards).length;
  if (N > before) throw new Error(`template holds ${before} cards; cannot grow to ${N} — bake a larger template`);
  if (kidsOf(assetsSlot).length !== before)
    throw new Error(`/Assets proxies (${kidsOf(assetsSlot).length}) do not match card slots (${before})`);

  // both are 1:1 per card: card slots, and their per-card driver flux under /Assets
  cards.Children = kidsOf(cards).slice(0, N);
  assetsSlot.Children = kidsOf(assetsSlot).slice(0, N);
  log(`  card slots ${before} -> ${N}   /Assets driver proxies ${before} -> ${N}`);

  // GridFrames must follow the card count (front atlas only, not the 1x1 back)
  let frames = 0;
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (o && typeof o === 'object') {
      if (o.GridSize && o.GridFrames) {
        const g = o.GridSize.Data.map(v => (v && typeof v === 'object' && 'value' in v) ? v.value : Number(v));
        if (g[0] > 1) { o.GridFrames.Data = N; frames++; }
      }
      for (const k in o) w(o[k]);
    }
  })(doc.Object);
  log(`  GridFrames -> ${N} (${frames} atlas)`);

  // Count every id occurrence across the WHOLE doc - object graph AND Assets,
  // because assets reference each other (FontChain->StaticFont, material->SpriteProvider).
  // An asset that only appears once is just its own declaration => unreferenced.
  const count = new Map();
  (function w(o) {
    if (Array.isArray(o)) return o.forEach(w);
    if (o && typeof o === 'object') {
      for (const k in o) {
        const v = o[k];
        if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) count.set(v, (count.get(v) || 0) + 1);
        else w(v);
      }
    }
  })(doc);

  // ONLY meshes are ever removed here. Never fonts, sprites or materials.
  const dropped = [], keep = [];
  for (const a of doc.Assets) {
    const isMesh = /StaticMesh/.test(typeName(a));
    const id = a?.Data?.ID;
    if (isMesh && id && (count.get(id) || 0) <= 1) {
      const u = a?.Data?.URL?.Data;
      if (u) dropped.push(String(u).replace(/^@?packdb:\/\/\//, ''));
    } else keep.push(a);
  }
  doc.Assets = keep;
  log(`  orphaned StaticMesh assets dropped: ${dropped.length} (expected ${before - N})`);
  if (dropped.length !== before - N)
    throw new Error(`mesh drop mismatch: dropped ${dropped.length}, expected ${before - N}`);
  return dropped;
}
