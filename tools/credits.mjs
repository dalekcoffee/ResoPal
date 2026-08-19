// Build a /credits slot under the deck root, move Ukilop's credit into it,
// and add Palify + ResoPal credit slots. Name-only slots, no components.
export function addCredits(doc, log = console.log) {
  const root = doc.Object;
  const kidsOf = s => { if (!s.Children) s.Children = []; return s.Children; };

  // collect every ID string in use so new ones cannot collide
  const used = new Set();
  (function scan(o) {
    if (Array.isArray(o)) return o.forEach(scan);
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if ((k === 'ID' || k === 'Persistent-ID' || k === 'ParentReference') && typeof v === 'string') used.add(v);
        else scan(v);
      }
    }
  })(doc);
  let counter = 0;
  const newId = () => {
    let id;
    do { id = `0000${(0xf000 + counter++).toString(16).padStart(4, '0')}-0000-0000-0000-000000000000`; }
    while (used.has(id));
    used.add(id); return id;
  };

  // deep clone preserving BSON type instances (Double/Long) by reference
  const clone = o => Array.isArray(o) ? o.map(clone)
    : (o && typeof o === 'object' && o.constructor === Object)
      ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clone(v)]))
      : o;
  // rewrite every ID inside a cloned slot so nothing duplicates
  const reid = o => {
    if (Array.isArray(o)) return o.forEach(reid);
    if (o && typeof o === 'object' && o.constructor === Object) {
      for (const k of Object.keys(o)) {
        if ((k === 'ID' || k === 'Persistent-ID' || k === 'ParentReference') && typeof o[k] === 'string') o[k] = newId();
        else reid(o[k]);
      }
    }
  };

  const rootKids = kidsOf(root);
  const i = rootKids.findIndex(c => typeof c?.Name?.Data === 'string' && c.Name.Data.includes('Ukilop'));
  if (i < 0) throw new Error('Ukilop credit slot not found at deck root');
  const ukilop = rootKids[i];
  log(`  found existing credit: ${JSON.stringify(ukilop.Name.Data)}`);

  // the Ukilop slot is the structural template for every credit slot
  const makeSlot = (name) => { const s = clone(ukilop); reid(s); s.Name.Data = name; s.Children = []; s.Components.Data = []; return s; };

  const credits = makeSlot('credits');
  rootKids.splice(i, 1);               // detach Ukilop from the root
  credits.Children = [
    ukilop,                            // moved, untouched: name preserved verbatim
    makeSlot('Card images & deck data by Palify - palify.org'),
    makeSlot('ResoPal import tool by Dalek - resopal.dalek.coffee'),
  ];
  rootKids.push(credits);

  log(`  /credits created with ${credits.Children.length} slots:`);
  for (const c of credits.Children) log(`      ${JSON.stringify(c.Name.Data)}`);
  return credits;
}
