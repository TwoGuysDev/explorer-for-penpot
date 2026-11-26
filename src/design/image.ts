// Images imported into a design: reads the size and type of PNG, JPEG, GIF and WebP files and
// describes them the way a .penpot export stores them (a file media object pointing to a storage
// object, which keeps the bytes and a blake2b-256 hash).
// No VS Code imports here, so it can be unit-tested with plain Node.
import { randomUUID } from "node:crypto";

export class ImageError extends Error {}

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface ImageInfo { mtype: string; ext: string; width: number; height: number }

/** An image ready to be written to a file: media id (used by fills), storage id and the bytes. */
export interface ImageAsset extends ImageInfo {
  id: string;
  storageId: string;
  name: string;
  bytes: Uint8Array;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** Type and pixel size of an image, from its header. */
export function imageInfo(b: Uint8Array): ImageInfo {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") {
    return { mtype: "image/png", ext: "png", width: be32(b, 16), height: be32(b, 20) };
  }
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
    return { mtype: "image/gif", ext: "gif", width: le16(b, 6), height: le16(b, 8) };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const kind = ascii(b, 12, 4);
    let w = 0, h = 0;
    if (kind === "VP8X") { w = le24(b, 24) + 1; h = le24(b, 27) + 1; }
    else if (kind === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === "VP8 ") { w = le16(b, 26) & 0x3fff; h = le16(b, 28) & 0x3fff; }
    if (w && h) return { mtype: "image/webp", ext: "webp", width: w, height: h };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      // SOF markers (baseline, progressive, ...) carry the size; C4, C8 and CC are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mtype: "image/jpeg", ext: "jpg", width: be16(b, i + 7), height: be16(b, i + 5) };
      }
      i += 2 + be16(b, i + 2);
    }
  }
  if (/^\s*(<\?xml|<svg|<!--)/i.test(new TextDecoder().decode(b.subarray(0, 200)))) {
    throw new ImageError('SVG files are not images here: create them with type "svg" (props.svg) so they become editable paths.');
  }
  throw new ImageError("Unsupported image: use PNG, JPEG, GIF, WebP or JPEG XL.");
}

/** Bytes of a data: URI (base64 or URL-encoded). */
export function dataUriBytes(uri: string): Uint8Array {
  const m = /^data:([^,]*?),(.*)$/s.exec(uri);
  if (!m) throw new ImageError("Invalid data URI.");
  return /;base64$/i.test(m[1]) ? new Uint8Array(Buffer.from(m[2], "base64")) : new TextEncoder().encode(decodeURIComponent(m[2]));
}

/** Largest image stored after a conversion (a JXL photo grows as a PNG); Penpot's default upload limit is about 30 MB. */
export const MAX_CONVERTED_BYTES = 30 * 1024 * 1024;

export function makeAsset(bytes: Uint8Array, name: string, max = MAX_IMAGE_BYTES): ImageAsset {
  if (bytes.length > max) throw new ImageError(`The image is too large (${Math.round(bytes.length / 1048576)} MB; at most ${Math.round(max / 1048576)} MB).`);
  const info = imageInfo(bytes);
  if (!(info.width > 0 && info.height > 0)) throw new ImageError("Could not read the size of the image.");
  return { ...info, id: randomUUID(), storageId: randomUUID(), name, bytes };
}

/** Entries of a .penpot export for an image: files/<f>/media/<id>.json, objects/<s>.json and objects/<s>.<ext>. */
export function assetEntries(fileId: string, a: ImageAsset): [string, Uint8Array][] {
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));
  return [
    [`files/${fileId}/media/${a.id}.json`, json({
      id: a.id, name: a.name, width: a.width, height: a.height, mtype: a.mtype, mediaId: a.storageId, isLocal: false,
      createdAt: new Date().toISOString(),
    })],
    [`objects/${a.storageId}.json`, json({
      id: a.storageId, size: a.bytes.length, contentType: a.mtype, bucket: "file-media-object", hash: `blake2b:${blake2b256Hex(a.bytes)}`,
    })],
    [`objects/${a.storageId}.${a.ext}`, a.bytes],
  ];
}

// ---------- BLAKE2b with a 32-byte digest (RFC 7693; Node only ships the 64-byte variant) ----------
// 64-bit words are kept as pairs of 32-bit halves (low, high), which is much faster than BigInt.

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
].map((r) => r.map((x) => x * 2));

export function blake2b256Hex(data: Uint8Array): string {
  const h = new Uint32Array(IV);
  h[0] ^= 0x01010000 ^ 32; // digest length 32, no key
  const v = new Uint32Array(32);
  const m = new Uint32Array(32);
  const block = new Uint8Array(128);
  const view = new DataView(block.buffer);
  const add = (a: number, b0: number, b1: number) => {
    const lo = v[a] + b0;
    v[a + 1] = v[a + 1] + b1 + (lo >= 0x100000000 ? 1 : 0);
    v[a] = lo;
  };
  const G = (a: number, b: number, c: number, d: number, x: number, y: number) => {
    let x0: number, x1: number;
    add(a, v[b], v[b + 1]); add(a, m[x], m[x + 1]);
    x0 = v[d] ^ v[a]; x1 = v[d + 1] ^ v[a + 1]; v[d] = x1; v[d + 1] = x0; // rotr 32
    add(c, v[d], v[d + 1]);
    x0 = v[b] ^ v[c]; x1 = v[b + 1] ^ v[c + 1]; v[b] = (x0 >>> 24) ^ (x1 << 8); v[b + 1] = (x1 >>> 24) ^ (x0 << 8); // rotr 24
    add(a, v[b], v[b + 1]); add(a, m[y], m[y + 1]);
    x0 = v[d] ^ v[a]; x1 = v[d + 1] ^ v[a + 1]; v[d] = (x0 >>> 16) ^ (x1 << 16); v[d + 1] = (x1 >>> 16) ^ (x0 << 16); // rotr 16
    add(c, v[d], v[d + 1]);
    x0 = v[b] ^ v[c]; x1 = v[b + 1] ^ v[c + 1]; v[b] = (x1 >>> 31) ^ (x0 << 1); v[b + 1] = (x0 >>> 31) ^ (x1 << 1); // rotr 63
  };
  const compress = (t: number, last: boolean) => {
    for (let i = 0; i < 32; i++) m[i] = view.getUint32(i * 4, true);
    for (let i = 0; i < 16; i++) { v[i] = h[i]; v[i + 16] = IV[i]; }
    v[24] ^= t >>> 0;
    v[25] ^= Math.floor(t / 0x100000000);
    if (last) { v[28] = ~v[28]; v[29] = ~v[29]; }
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      G(0, 8, 16, 24, s[0], s[1]); G(2, 10, 18, 26, s[2], s[3]);
      G(4, 12, 20, 28, s[4], s[5]); G(6, 14, 22, 30, s[6], s[7]);
      G(0, 10, 20, 30, s[8], s[9]); G(2, 12, 22, 24, s[10], s[11]);
      G(4, 14, 16, 26, s[12], s[13]); G(6, 8, 18, 28, s[14], s[15]);
    }
    for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16];
  };
  let off = 0;
  // Every block but the last one is compressed as it fills up.
  while (data.length - off > 128) {
    block.set(data.subarray(off, off + 128));
    off += 128;
    compress(off, false);
  }
  block.fill(0);
  block.set(data.subarray(off));
  compress(data.length, true);
  return Buffer.from(h.buffer, 0, 32).toString("hex");
}
