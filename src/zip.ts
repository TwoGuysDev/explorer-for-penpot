// Minimal read-only ZIP reader (stored and deflated entries, ZIP64) for .penpot exports.
// No VS Code imports here, so it can be unit-tested with plain Node.
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
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
      if (!name.endsWith("/")) this.entries.set(name, { name, method, compressedSize, size, localOffset });
      o += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string) {
    return this.entries.has(name);
  }

  read(name: string): Uint8Array {
    const e = this.entries.get(name);
    if (!e) throw new ZipError(`Missing entry: ${name}`);
    if (e.size > MAX_ENTRY_SIZE) throw new ZipError(`Entry too large: ${name}`);
    this.check(e.localOffset, 30);
    if (this.u32(e.localOffset) !== 0x04034b50) throw new ZipError(`Broken ZIP entry: ${name}`);
    const start = e.localOffset + 30 + this.u16(e.localOffset + 26) + this.u16(e.localOffset + 28);
    this.check(start, e.compressedSize);
    const data = this.buf.subarray(start, start + e.compressedSize);
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
