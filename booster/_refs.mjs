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
const owner = new Map();
(function w(n, sl) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach((x)=>w(x, sl));
  if (n.Name && n.Components !== undefined) sl = n;
  if (n.Type !== undefined && n.Data?.ID) owner.set(n.Data.ID, `${nm(sl)}«${shortT(doc.Types[Number(n.Type)])}»`);
  for (const v of Object.values(n)) w(v, sl);
})(doc, null);
const holder = (doc.Object.Children||[]).find((s)=>nm(s)==='Card template');
const card = (holder.Children||[])[0];
const dump = (sl) => {
  for (const c of (sl.Components?.Data||[])) {
    const t = shortT(doc.Types[Number(c.Type)]);
    if (t === 'MeshRenderer') {
      const mesh = c.Data.Mesh?.Data, mats = (c.Data.Materials?.Data||[]).map((m)=>m?.Data);
      console.log(`${nm(sl).padEnd(6)} MeshRenderer  Mesh -> ${owner.get(mesh) ?? '?'}   Materials -> ${mats.map((m)=>owner.get(m) ?? '?').join(', ')}`);
    }
    if (t === 'UnlitMaterial') console.log(`${nm(sl).padEnd(6)} UnlitMaterial Texture -> ${owner.get(c.Data.Texture?.Data) ?? '?'}`);
  }
  for (const ch of (sl.Children||[])) dump(ch);
};
dump(card);
