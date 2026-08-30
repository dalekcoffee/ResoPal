import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
const RKL = process.env.RKL;
const { frdtToBsonBytes, deserializeBson } = await import(`file://${path.join(RKL,'protoflux','skill','scripts','decode.mjs')}`);
const z = await JSZip.loadAsync(await readFile(process.argv[2]));
const r = JSON.parse(await z.file('R-Main.record').async('string'));
const doc = await deserializeBson(await frdtToBsonBytes(await z.file('Assets/'+r.assetUri.replace('packdb:///','')).async('uint8array')));
const nm = (s) => String(s?.Name?.Data ?? '');
const shortT = (t) => String(t).replace(/^\[[^\]]+\]/,'').replace(/^.*Execution\.Nodes\./,'').replace(/^FrooxEngine\./,'');
const comps = new Map(), fieldOwner = new Map();
(function w(n, sl) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach((x)=>w(x, sl));
  if (n.Name && n.Components !== undefined) sl = n;
  if (n.Type !== undefined && n.Data?.ID) { comps.set(n.Data.ID, { t: shortT(doc.Types[Number(n.Type)]), d: n.Data, sl });
    for (const [k,v] of Object.entries(n.Data)) if (v && typeof v==='object' && v.ID) fieldOwner.set(v.ID, { o: n.Data.ID, m: k }); }
  for (const v of Object.values(n)) w(v, sl);
})(doc, null);
const lbl = (id) => { if (typeof id !== 'string') return String(id);
  if (comps.has(id)) { const c = comps.get(id); return `${nm(c.sl)}«${c.t}»`; }
  const f = fieldOwner.get(id); if (!f) return `DANGLING ${id}`;
  const c = comps.get(f.o); return `${nm(c.sl)}«${c.t}».${f.m}`; };
const holder = (doc.Object.Children||[]).find((s)=>nm(s)==='Card template');
const card = (holder.Children||[])[0];
const dump = (sl, d=0) => {
  for (const c of (sl.Components?.Data||[])) {
    const t = shortT(doc.Types[Number(c.Type)]);
    if (!/Source|Uri|Drive|Texture|Variable|Reference|Proxy/.test(t)) continue;
    console.log('  '.repeat(d) + `${nm(sl)} «${t}»`);
    for (const [k,v] of Object.entries(c.Data)) {
      if (k==='ID'||k==='persistent-ID'||k==='UpdateOrder'||k==='Enabled') continue;
      const dd = v && typeof v==='object' ? v.Data : v;
      if (typeof dd === 'string' && /^[0-9a-f]{8}-/.test(dd)) console.log('  '.repeat(d+1) + `${k.padEnd(14)} -> ${lbl(dd)}`);
      else if (dd === null) console.log('  '.repeat(d+1) + `${k.padEnd(14)} = null`);
      else if (typeof dd !== 'object') console.log('  '.repeat(d+1) + `${k.padEnd(14)} = ${JSON.stringify(dd)}`);
      else if (Array.isArray(dd)) console.log('  '.repeat(d+1) + `${k.padEnd(14)} = [${dd.length}]`);
    }
  }
  for (const ch of (sl.Children||[])) dump(ch, d+1);
};
dump(card);
