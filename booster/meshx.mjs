// MeshX reader - enough of it to read a card mesh's UVs.
//
// Written because the whole per-card-art plan rests on where a card's front-face
// UVs actually sit, and docs/PIPELINE.md's atlas contract is prose. Prose is what
// the rotation bug was checked against, twice, and it was wrong both times. This
// reads the geometry.
//
// Format from Elements.Assets/MeshX.cs `Encode`:
//
//   "MeshX"              length-prefixed string
//   int32                version (7)
//   uint32               flags: 1 normals, 2 tangents, 4 colors, 8 bone bindings
//   7-bit                VertexCount, SubmeshCount, BoneCount, BlendShapeCount, UV_ChannelCount
//   byte * channels      UV dimension per channel (2, 3 or 4)
//   string               Profile
//   byte                 encoding: 0 Plain, 1 LZ4, 2 LZMA
//   <payload>            positions, normals, tangents, colors, bones, UVs, then submeshes
//
// The LZ4 form is lz4net's `LZ4Stream`, which frames raw LZ4 blocks as
// `varint flags, varint originalLength, [varint compressedLength], bytes` with
// flags bit 0 = compressed. Verified on this template: header + one chunk of
// 21758 compressed / 40530 raw accounts for the file exactly, and the vertex
// streams then consume 34304 of those 40530 bytes with the submeshes filling the
// rest to the byte.

/** Raw LZ4 block decompression. Not the framed format - LZ4Stream does the framing. */
export function lz4BlockDecode(src, outLen) {
  const dst = Buffer.alloc(outLen);
  let ip = 0, op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let litLen = token >> 4;
    if (litLen === 15) { let b; do { b = src[ip++]; litLen += b; } while (b === 255); }
    src.copy(dst, op, ip, ip + litLen); ip += litLen; op += litLen;
    if (ip >= src.length) break;
    const offset = src[ip] | (src[ip + 1] << 8); ip += 2;
    let mLen = token & 0xf;
    if (mLen === 15) { let b; do { b = src[ip++]; mLen += b; } while (b === 255); }
    mLen += 4;
    let mp = op - offset;
    for (let i = 0; i < mLen; i++) dst[op++] = dst[mp++];   // may overlap; byte at a time on purpose
  }
  if (op !== outLen) throw new Error(`lz4: produced ${op} bytes, header promised ${outLen}`);
  return dst;
}

export function readMeshX(buf) {
  let p = 0;
  const vint = () => { let v = 0, sh = 0, b; do { b = buf[p++]; v += (b & 0x7f) * 2 ** sh; sh += 7; } while (b & 0x80); return v; };
  const str = () => { const len = vint(); const s = buf.toString('utf8', p, p + len); p += len; return s; };

  const magic = str();
  if (magic !== 'MeshX') throw new Error(`not a MeshX blob (magic ${JSON.stringify(magic)})`);
  const version = buf.readInt32LE(p); p += 4;
  if (version > 7) throw new Error(`MeshX version ${version} is newer than this reader knows`);
  const flags = buf.readUInt32LE(p); p += 4;
  const hasNormals = !!(flags & 1), hasTangents = !!(flags & 2), hasColors = !!(flags & 4), hasBones = !!(flags & 8);
  const vertexCount = vint(), submeshCount = vint(), boneCount = vint(), blendCount = vint(), uvChannels = vint();
  const uvDims = []; for (let i = 0; i < uvChannels; i++) uvDims.push(buf[p++]);
  const profile = str();
  const encoding = buf[p++];

  let body;
  if (encoding === 0) body = buf.subarray(p);
  else if (encoding === 1) {
    const parts = [];
    while (p < buf.length) {
      const chunkFlags = vint(), orig = vint();
      if (chunkFlags & 1) { const comp = vint(); parts.push(lz4BlockDecode(buf.subarray(p, p + comp), orig)); p += comp; }
      else { parts.push(Buffer.from(buf.subarray(p, p + orig))); p += orig; }
    }
    body = Buffer.concat(parts);
  } else throw new Error(`MeshX encoding ${encoding} (LZMA) is not implemented`);

  // Vertex streams, in Encode()'s order. Each is present only if its flag is set.
  let o = 0;
  const take = (bytes) => { const s = body.subarray(o, o + bytes); o += bytes; return s; };
  const n = vertexCount;
  const positions = take(n * 12);
  const normals = hasNormals ? take(n * 12) : null;
  const tangents = hasTangents ? take(n * 16) : null;
  const colors = hasColors ? take(n * 16) : null;
  const boneBindings = hasBones ? take(n * 20) : null;
  const uvs = [];
  for (let i = 0; i < uvChannels; i++) uvs.push(take(n * 4 * uvDims[i]));

  // Submeshes: topology name, 7-bit primitive count, then int32 indices.
  const submeshes = [];
  let q = o;
  const svint = () => { let v = 0, sh = 0, b; do { b = body[q++]; v += (b & 0x7f) * 2 ** sh; sh += 7; } while (b & 0x80); return v; };
  const sstr = () => { const len = svint(); const s = body.toString('utf8', q, q + len); q += len; return s; };
  for (let i = 0; i < submeshCount; i++) {
    const topology = sstr();
    if (topology === '') { submeshes.push(null); continue; }
    const count = svint();
    const per = { Triangles: 3, Points: 1, Lines: 2 }[topology] ?? 3;
    const indices = new Int32Array(count * per);
    for (let k = 0; k < indices.length; k++) { indices[k] = body.readInt32LE(q); q += 4; }
    submeshes.push({ topology, count, indices });
  }
  if (q !== body.length) throw new Error(`MeshX: ${body.length - q} trailing bytes after the submeshes`);

  return { version, vertexCount, submeshCount, uvChannels, uvDims, profile, encoding,
           positions, normals, tangents, colors, boneBindings, uvs, submeshes };
}

/** UV bounding box of one submesh, on one UV channel. */
export function submeshUVBounds(mesh, submeshIndex, channel = 0) {
  const sub = mesh.submeshes[submeshIndex];
  if (!sub) throw new Error(`submesh ${submeshIndex} is empty`);
  const uv = mesh.uvs[channel];
  const dim = mesh.uvDims[channel];
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const vi of sub.indices) {
    const u = uv.readFloatLE(vi * 4 * dim), v = uv.readFloatLE(vi * 4 * dim + 4);
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  return { minU, maxU, minV, maxV };
}
