// Minimal ZIP reader (stored and deflated entries, ZIP64) and writer for .penpot exports.
// No VS Code imports here, so it can be unit-tested with plain Node.
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Largest entry we agree to inflate (guards against ZIP bombs). */
const MAX_ENTRY_SIZE = 512 * 1024 * 1024;

export class ZipError extends Error {}

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>();
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.readCentralDirectory();
  }

  private u16(o: number) { return this.view.getUint16(o, true); }
  private u32(o: number) { return this.view.getUint32(o, true); }
  private u64(o: number) { return Number(this.view.getBigUint64(o, true)); }

  private check(o: number, len: number) {
    if (o < 0 || o + len > this.buf.length) throw new ZipError("Truncated ZIP file");
  }

  private readCentralDirectory() {
    // End of central directory: 22 bytes plus a comment of up to 64 KiB, at the end of the file.
    const min = Math.max(0, this.buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let o = this.buf.length - 22; o >= min; o--) {
      if (this.u32(o) === 0x06054b50) { eocd = o; break; }
    }
    if (eocd < 0) throw new ZipError("Not a ZIP file");
    let count = this.u16(eocd + 10);
    let cdOffset = this.u32(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || this.u32(loc) !== 0x07064b50) throw new ZipError("Broken ZIP64 file");
      const z = this.u64(loc + 8);
      this.check(z, 56);
      if (this.u32(z) !== 0x06064b50) throw new ZipError("Broken ZIP64 file");
      count = this.u64(z + 32);
      cdOffset = this.u64(z + 48);
    }
    let o = cdOffset;
    for (let i = 0; i < count; i++) {
      this.check(o, 46);
      if (this.u32(o) !== 0x02014b50) throw new ZipError("Broken ZIP central directory");
      const method = this.u16(o + 10);
      const crc = this.u32(o + 16);
      let compressedSize = this.u32(o + 20);
      let size = this.u32(o + 24);
      const nameLen = this.u16(o + 28), extraLen = this.u16(o + 30), commentLen = this.u16(o + 32);
      let localOffset = this.u32(o + 42);
      this.check(o + 46, nameLen + extraLen);
      const name = new TextDecoder().decode(this.buf.subarray(o + 46, o + 46 + nameLen));
      // ZIP64 extra field: only the values that overflowed are present, in this order.
      for (let e = o + 46 + nameLen; e + 4 <= o + 46 + nameLen + extraLen; ) {
        const id = this.u16(e), len = this.u16(e + 2);
        if (id === 0x0001) {
          let p = e + 4;
          if (size === 0xffffffff) { size = this.u64(p); p += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = this.u64(p); p += 8; }
          if (localOffset === 0xffffffff) { localOffset = this.u64(p); }
        }
        e += 4 + len;
      }
      if (!name.endsWith("/")) this.entries.set(name, { name, method, crc, compressedSize, size, localOffset });
      o += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string) {
    return this.entries.has(name);
  }

  /** The stored (possibly compressed) bytes of an entry, to copy it into another ZIP unchanged. */
  raw(name: string): { entry: ZipEntry; data: Uint8Array } {
    const e = this.entries.get(name);
    if (!e) throw new ZipError(`Missing entry: ${name}`);
    this.check(e.localOffset, 30);
    if (this.u32(e.localOffset) !== 0x04034b50) throw new ZipError(`Broken ZIP entry: ${name}`);
    const start = e.localOffset + 30 + this.u16(e.localOffset + 26) + this.u16(e.localOffset + 28);
    this.check(start, e.compressedSize);
    return { entry: e, data: this.buf.subarray(start, start + e.compressedSize) };
  }

  read(name: string): Uint8Array {
    const { entry: e, data } = this.raw(name);
    if (e.size > MAX_ENTRY_SIZE) throw new ZipError(`Entry too large: ${name}`);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) });
    throw new ZipError(`Unsupported compression (method ${e.method}) in ${name}`);
  }

  readText(name: string) {
    return new TextDecoder().decode(this.read(name));
  }

  readJson<T = any>(name: string): T {
    return JSON.parse(this.readText(name)) as T;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An entry for writeZip: new content, or the raw bytes of an entry copied from a ZipReader. */
export type ZipSource =
  | { name: string; content: Uint8Array }
  | { name: string; copy: { entry: ZipEntry; data: Uint8Array } };

/** Writes a ZIP, deflating new content. Copied entries keep their compressed bytes and CRC. */
export function writeZip(sources: ZipSource[]): Uint8Array {
  if (sources.length >= 0xffff) throw new ZipError("Too many entries for this ZIP writer");
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const src of sources) {
    let method: number, crc: number, size: number, data: Uint8Array;
    if ("content" in src) {
      crc = crc32(src.content);
      size = src.content.length;
      const deflated = deflateRawSync(src.content);
      [method, data] = deflated.length < size ? [8, deflated] : [0, src.content];
    } else {
      ({ method, crc, size } = src.copy.entry);
      data = src.copy.data;
    }
    const name = new TextEncoder().encode(src.name);
    if (offset + 30 + name.length + data.length > 0xffffffff || size > 0xffffffff) throw new ZipError("File too large for this ZIP writer");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, data);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sources.length, 8); eocd.writeUInt16LE(sources.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, eocd]));
}
