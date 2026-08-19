// Browser FrDT codec. Node's decode.mjs forces brotli-wasm's CommonJS build
// because the web build fetches its WASM over the network; in a browser that is
// exactly what we want, so the plain ESM import is correct here.
import brotliPromise from 'brotli-wasm';
import { serialize, deserialize } from 'bson';

const MAGIC = [0x46, 0x72, 0x44, 0x54];          // "FrDT"
const BROTLI = 3;                                 // byte 8: compression marker

export const isFrdt = b => MAGIC.every((m, i) => b[i] === m);

/** FrDT blob -> typed BSON doc (Int32/Long/Double preserved, not promoted). */
export async function frdtToDoc(bytes) {
  if (!isFrdt(bytes)) throw new Error('Not an FrDT blob (magic "FrDT" mismatch)');
  if (bytes[8] !== BROTLI) throw new Error(`Compression byte is ${bytes[8]}, expected ${BROTLI} (Brotli)`);
  const brotli = await brotliPromise;
  return deserialize(brotli.decompress(bytes.slice(9)), {
    promoteValues: false,   // keep Int32 / Double as typed instances
    promoteLongs: false,    // keep Long (Int64) as a Long instance
    promoteBuffers: false,
  });
}

/** typed doc -> FrDT blob (9-byte header + Brotli payload). */
export async function docToFrdt(doc, quality = 4) {
  const brotli = await brotliPromise;
  const payload = brotli.compress(serialize(doc), { quality });
  const out = new Uint8Array(9 + payload.length);
  out.set([...MAGIC, 0, 0, 0, 0, BROTLI], 0);
  out.set(payload, 9);
  return out;
}
