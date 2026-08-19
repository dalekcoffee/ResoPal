import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { frdtToBsonBytes, bsonBytesToFrdt, deserializeBson, serializeBson } from './decode.mjs';
import { addCredits } from './credits.mjs';
import { trimToCards } from './trim.mjs';
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const sha256 = b => createHash('sha256').update(b).digest('hex');

const OLD_ATLAS='971a5f8b1153061fc65a30f2a00dfc1ea5f305d3f1629a84bda31afece70766c';
const OLD_BACK ='1456016c0996fa34c066751023d63ca055136dfc73e8de53e2e18051ec2f5632';
const TEX_FRONT='000000c5-0000-0000-0000-000000000000';
const TEX_BACK ='00000057-0000-0000-0000-000000000000';
const CUTOFF = 0.72;
const EDGE_TINT = process.env.EDGE_TINT ? process.env.EDGE_TINT.split(',').map(Number) : null;

const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(0,i),a.slice(i+1)];}));
const zip=await JSZip.loadAsync(await readFile(args.src));
const record=JSON.parse(await zip.file('R-Main.record').async('string'));
const oldFrdt=String(record.assetUri).replace(/^@?packdb:\/\/\//,'');
const doc=await deserializeBson(await frdtToBsonBytes(new Uint8Array(await zip.file(`Assets/${oldFrdt}`).async('uint8array'))));

// ---------- texture swaps ----------
const swaps=[];
async function stage(oldHash,file,w,h){
  const bytes=await readFile(file), newHash=sha256(bytes);
  const s=JSON.parse(await zip.file(`Metadata/${oldHash}.bitmap`).async('string'));
  s.assetIdenfitier=newHash; s.baseFormat='webp'; s.width=w; s.height=h;
  swaps.push({oldHash,newHash,bytes,sidecar:Buffer.from(JSON.stringify(s))});
  console.log(`  tex ${oldHash.slice(0,8)} -> ${newHash.slice(0,8)}  ${w}x${h}  ${(bytes.length/1048576).toFixed(2)}MB`);
}
await stage(OLD_ATLAS,args.front,+args.fw,+args.fh);
await stage(OLD_BACK,args.back,+args.bw,+args.bh);

// ---------- font strip: keep MainFont, drop fallbacks ----------
const keepFonts=new Set(), dropFonts=new Set();
(function scan(o){ if(Array.isArray(o))return o.forEach(scan);
  if(o&&typeof o==='object'){
    if(o.MainFont&&o.FallbackFonts){
      keepFonts.add(o.MainFont.Data);
      for(const f of (o.FallbackFonts.Data||[])) dropFonts.add(f.Data);
      o.FallbackFonts.Data=[];                    // clear the chain
    }
    for(const k in o) scan(o[k]);
  }})(doc);
for(const k of keepFonts) dropFonts.delete(k);
console.log(`  fonts: keeping ${keepFonts.size} main, dropping ${dropFonts.size} fallback`);

// find the asset blobs those dropped StaticFonts point at, then remove the assets
const fontBlobs=new Set();
const A=doc.Assets||[];
const kept=[];
for(const a of A){
  const id=a.Data&&a.Data.ID;
  if(id&&dropFonts.has(id)){
    const u=a.Data.URL&&a.Data.URL.Data;
    if(u) fontBlobs.add(String(u).replace(/^@?packdb:\/\/\//,''));
    continue;                                     // drop the asset entry
  }
  kept.push(a);
}
doc.Assets=kept;
console.log(`  font blobs removed: ${fontBlobs.size}`);

// ---------- URL swap + material fixes ----------
let urlHits=0,blend=0,cut=0,edgeHits=0;
const targets=new Set([TEX_FRONT,TEX_BACK]);
(function walk(o){ if(Array.isArray(o))return o.forEach(walk);
  if(!o||typeof o!=='object')return;
  for(const k of Object.keys(o)) if(k==='Data'&&typeof o[k]==='string')
    for(const s of swaps) if(o[k].includes(s.oldHash)){o[k]=o[k].replace(s.oldHash,s.newHash);urlHits++;}
  if(o.BlendMode&&o.Texture&&typeof o.Texture.Data==='string'&&targets.has(o.Texture.Data)){
    if(o.BlendMode.Data==='Opaque')o.BlendMode.Data='Cutout';
    if(o.BlendMode.Data==='Cutout')blend++;
    if(o.AlphaCutoff&&o.AlphaCutoff.Data!=null){ o.AlphaCutoff.Data=CUTOFF; cut++; }   // BSON Double -> plain JS number
  }
  if(EDGE_TINT&&o.TintColor&&o.TextureScale&&Array.isArray(o.TextureScale.Data)){
    const ts=o.TextureScale.Data.map(v=>typeof v==='object'&&v!==null&&'value'in v?v.value:Number(v));
    if(ts[1]>10&&Array.isArray(o.TintColor.Data)){     // the 100x-tiled edge stripe material
      for(let i=0;i<3;i++) o.TintColor.Data[i]=EDGE_TINT[i];
      edgeHits++;
    }
  }
  for(const k of Object.keys(o)) walk(o[k]);
})(doc);
console.log(`  URL refs=${urlHits}  Cutout materials=${blend}  AlphaCutoff->${CUTOFF} on ${cut}  edgeTint=${edgeHits}`);
if(urlHits!==swaps.length) throw new Error(`expected ${swaps.length} URL refs, got ${urlHits}`);
if(cut<1) throw new Error('AlphaCutoff never applied');
if(blend<2) throw new Error(`expected both card materials to end as Cutout, got ${blend}`);

const trimmed = args.cards ? trimToCards(doc, +args.cards) : [];
addCredits(doc);

const newFrdt=Buffer.from(await bsonBytesToFrdt(await serializeBson(doc)));
const newFrdtHash=sha256(newFrdt);

// ---------- rebuild ----------
const drop=new Set([`Assets/${oldFrdt}`,'R-Main.record',
  ...swaps.flatMap(s=>[`Assets/${s.oldHash}`,`Metadata/${s.oldHash}.bitmap`]),
  ...[...fontBlobs].map(h=>`Assets/${h}`), ...trimmed.map(h=>`Assets/${h}`)]);
const out=new JSZip();
for(const [n,f] of Object.entries(zip.files)){ if(f.dir||drop.has(n))continue; out.file(n,await f.async('nodebuffer')); }
for(const s of swaps){ out.file(`Assets/${s.newHash}`,s.bytes); out.file(`Metadata/${s.newHash}.bitmap`,s.sidecar); }
out.file(`Assets/${newFrdtHash}`,newFrdt);

const gone=new Set([oldFrdt,...swaps.map(s=>s.oldHash),...fontBlobs,...trimmed]);
record.assetUri=`packdb:///${newFrdtHash}`;
record.name=args.name||record.name;
record.assetManifest=[...record.assetManifest.filter(e=>!gone.has(e.hash)),
  ...swaps.map(s=>({hash:s.newHash,bytes:s.bytes.length})),{hash:newFrdtHash,bytes:newFrdt.length}];
out.file('R-Main.record',JSON.stringify(record));
await writeFile(args.out,await out.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
console.log(`  wrote ${args.out}`);
