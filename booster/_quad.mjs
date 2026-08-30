import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
const RKL = process.env.RKL;
const { frdtToBsonBytes, deserializeBson } = await import(`file://${path.join(RKL,'protoflux','skill','scripts','decode.mjs')}`);
const z = await JSZip.loadAsync(await readFile(process.argv[2]));
const r = JSON.parse(await z.file('R-Main.record').async('string'));
const doc = await deserializeBson(await frdtToBsonBytes(await z.file('Assets/'+r.assetUri.replace('packdb:///','')).async('uint8array')));
const nm = (s) => String(s?.Name?.Data ?? '');
const num = (v) => (v && typeof v === 'object' && v._bsontype ? Number(v) : v);
const shortT = (t) => String(t).replace(/^\[[^\]]+\]/,'').replace(/^.*Execution\.Nodes\./,'').replace(/^FrooxEngine\./,'');
const holder = (doc.Object.Children||[]).find((s)=>nm(s)==='Card template');
const card = (holder.Children||[])[0];
const show = (sl, d=0) => {
  for (const c of (sl.Components?.Data||[])) {
    const t = shortT(doc.Types[Number(c.Type)]);
    if (!/QuadMesh|MeshRenderer|UnlitMaterial/.test(t)) continue;
    const f = Object.entries(c.Data).filter(([k])=>/DualSided|Size|Mesh|Materials|Sidedness|Culling|BlendMode|AlphaCutoff|TintColor|Texture/.test(k));
    console.log('  '.repeat(d)+`${nm(sl)} «${t}»  ` + f.map(([k,v])=>{
      const d2 = v && typeof v==='object' ? v.Data : v;
      return `${k}=${Array.isArray(d2)? JSON.stringify(d2.map(num)) : typeof d2==='string' && d2.length===36 ? '<ref>' : JSON.stringify(num(d2))}`;
    }).join('  '));
  }
  for (const ch of (sl.Children||[])) show(ch, d+1);
};
show(card);
console.log('rotation of children:', (card.Children||[]).map((c)=>`${nm(c)}=${JSON.stringify((c.Rotation?.Data||[]).map(num))} z=${(c.Position?.Data||[]).map(num)[2]}`).join('  '));
