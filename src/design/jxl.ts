// JPEG XL support for imported images: Penpot and Chromium (which draws the screenshots) do not read
// JXL, so it is decoded with libjxl (WebAssembly, from @jsquash/jxl) and stored as a PNG.
// No VS Code imports here, so it can be unit-tested with plain Node.
import * as fs from "node:fs";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { crc32 } from "../zip";

/** A JXL codestream (FF 0A) or a JXL container (ISO BMFF box "JXL "). */
export function isJxl(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0x0a) return true;
  const sig = [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
  return b.length >= 12 && sig.every((v, i) => b[i] === v);
}

let decoder: Promise<(data: ArrayBuffer) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>> | undefined;

/** The WebAssembly decoder: next to the bundle (dist/jxl_dec.wasm) or in node_modules (tests). */
function wasmPath(): string {
  const local = path.join(__dirname, "jxl_dec.wasm");
  if (fs.existsSync(local)) return local;
  const dev = "@jsquash/jxl/codec/dec/jxl_dec.wasm"; // a variable, so the bundler leaves it alone
  return require.resolve(dev);
}

function loadDecoder() {
  decoder ??= (async () => {
    const mod = await import("@jsquash/jxl/decode.js");
    await mod.init(await WebAssembly.compile(fs.readFileSync(wasmPath())));
    return mod.default as any;
  })();
  decoder.catch(() => { decoder = undefined; });
  return decoder;
}

/** Decodes a JXL image and encodes it as a PNG (8-bit RGBA, or RGB when it is fully opaque). */
export async function jxlToPng(bytes: Uint8Array): Promise<Uint8Array> {
  const decode = await loadDecoder();
  // A copy with its own ArrayBuffer: a Node Buffer can be a view into a larger shared pool.
  const copy = new Uint8Array(bytes);
  const img = await decode(copy.buffer as ArrayBuffer);
  return encodePng(img.data, img.width, img.height);
}

export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const bpp = opaque ? 3 : 4;
  const row = width * bpp;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (row + 1);
    raw[o] = 0; // filter: none
    if (opaque) {
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4, d = o + 1 + x * 3;
        raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
      }
    } else raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), o + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // RGB or RGBA
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]));
}
