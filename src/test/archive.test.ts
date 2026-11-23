import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { ROOT_ID } from "../api";
import { ArchiveError, PenpotArchive } from "../archive";
import { renderSvg } from "../render";
import { ZipReader } from "../zip";

/** Builds a ZIP in memory (stored or deflated entries); the CRC is not checked by the reader. */
function makeZip(entries: Record<string, string | Uint8Array>, deflate = true): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += lh.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const F = "f1", P1 = "p1", P2 = "p2";
const j = (o: unknown) => JSON.stringify(o);

function sampleExport(deflate = true) {
  return makeZip({
    "manifest.json": j({ type: "penpot/export-files", version: 1, files: [{ id: F, name: "Design" }] }),
    [`files/${F}.json`]: j({ id: F, name: "Design system" }),
    [`files/${F}/pages/${P2}.json`]: j({ id: P2, name: "Second", index: 1 }),
    [`files/${F}/pages/${P1}.json`]: j({ id: P1, name: "First", index: 0 }),
    [`files/${F}/pages/${P1}/${ROOT_ID}.json`]: j({ id: ROOT_ID, name: "Root Frame", type: "frame", shapes: ["b"] }),
    [`files/${F}/pages/${P1}/b.json`]: j({
      id: "b", name: "Board", type: "frame", x: 0, y: 0, width: 100, height: 60, parentId: ROOT_ID, shapes: ["i"],
      fills: [{ fillColor: "#112233", fillOpacity: 1 }],
    }),
    [`files/${F}/pages/${P1}/i.json`]: j({
      id: "i", name: "Logo", type: "rect", x: 10, y: 10, width: 20, height: 20, parentId: "b",
      fills: [{ fillOpacity: 1, fillImage: { id: "m1", width: 20, height: 20, mtype: "image/png" } }],
    }),
    [`files/${F}/media/m1.json`]: j({ id: "m1", mediaId: "s1", mtype: "image/png" }),
    "objects/s1.json": j({ id: "s1", contentType: "image/png" }),
    "objects/s1.png": PNG,
    [`files/${F}/thumbnails/frame/${P1}/b.json`]: j({ fileId: F, pageId: P1, frameId: "b", tag: "frame", mediaId: "s2" }),
    "objects/s2.json": j({ id: "s2", contentType: "image/png" }),
    "objects/s2.png": PNG,
  }, deflate);
}

test("reads stored and deflated ZIP entries", () => {
  for (const deflate of [true, false]) {
    const zip = new ZipReader(makeZip({ "a.txt": "hello", "dir/b.json": j({ ok: 1 }) }, deflate));
    assert.equal(zip.readText("a.txt"), "hello");
    assert.deepEqual(zip.readJson("dir/b.json"), { ok: 1 });
    assert.throws(() => zip.read("missing"));
  }
});

test("lists files and pages in Penpot's page order", () => {
  const a = PenpotArchive.open(sampleExport());
  assert.deepEqual(a.files, [{ id: F, name: "Design system", pages: [{ id: P1, name: "First" }, { id: P2, name: "Second" }] }]);
  assert.deepEqual(Object.keys(a.pageObjects(F, P1)).sort(), [ROOT_ID, "b", "i"].sort());
  assert.deepEqual(a.pageObjects(F, P2), {});
});

test("resolves images and board thumbnails from the export", () => {
  const a = PenpotArchive.open(sampleExport(false));
  const uri = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
  assert.equal(a.imageDataUri(F, "m1"), uri);
  assert.equal(a.imageDataUri(F, "nope"), undefined);
  assert.equal(a.thumbnailDataUri(F, "b"), uri);
  assert.equal(a.thumbnailDataUri(F, "other"), undefined);
});

test("draws a board from the export with its images", async () => {
  const a = PenpotArchive.open(sampleExport());
  const res = await renderSvg(a.pageObjects(F, P1), "b", { loadImage: async (id, mime) => a.imageDataUri(F, id, mime) });
  assert.match(res.svg, /#112233/);
  assert.match(res.svg, /href="data:image\/png;base64,/);
  assert.deepEqual(res.warnings, []);
});

test("rejects files that are not Penpot 2.x exports", () => {
  const kind = (buf: Uint8Array) => {
    try { PenpotArchive.open(buf); return "ok"; } catch (e) { return e instanceof ArchiveError ? e.kind : "other"; }
  };
  assert.equal(kind(new TextEncoder().encode("PENPOT\u0001binary")), "legacy");
  assert.equal(kind(new TextEncoder().encode("just text")), "format");
  assert.equal(kind(makeZip({ "readme.txt": "hi" })), "format");
});

test("lists a page's boards without loading every shape", () => {
  const a = PenpotArchive.open(sampleExport());
  assert.deepEqual(a.pageBoards(F, P1), [{ id: "b", name: "Board", width: 100, height: 60, component: false }]);
  assert.deepEqual(a.pageBoards(F, P2), []);
});
