import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_ID, Shape } from "../api";
import { PenpotArchive } from "../archive";
import { PageEditor } from "../design/editor";
import { boxOf, corners, selrect, translatePath } from "../design/geometry";
import { LocalSource } from "../design/sources";
import { textOf, textRows } from "../design/text";
import { formatSegs, parsePath, parseSvg, segsBounds } from "../design/path";
import { McpServer } from "../mcp/server";
import { ToolHost, Tools } from "../mcp/tools";
import { ZipReader, crc32, writeZip } from "../zip";

const j = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const F = "f1", P = "p1";

function shape(id: string, type: string, parentId: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}): Shape {
  const r = { x, y, width, height };
  return {
    id, name: id, type, x, y, width, height, rotation: 0, selrect: selrect(r), points: corners(r),
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    parentId, frameId: parentId, fills: [], strokes: [], ...extra,
  } as Shape;
}

/** The "Footer" of a real export: row, padding-top 6, gap 8, align center; Skip · Spacer(fill) · Back · Next. */
function footerPage(): Record<string, Shape> {
  const o: Record<string, Shape> = {};
  o[ROOT_ID] = shape(ROOT_ID, "frame", ROOT_ID, 0, 0, 0.01, 0.01, { shapes: ["footer"] });
  o.footer = shape("footer", "frame", ROOT_ID, 3096, -36, 268, 38, {
    layout: "flex", layoutFlexDir: "row", layoutGap: { rowGap: 8, columnGap: 8 }, layoutPadding: { p1: 6, p2: 0, p3: 0, p4: 0 },
    layoutJustifyContent: "start", layoutAlignItems: "center", layoutWrapType: "nowrap",
    shapes: ["next", "back", "spacer", "skip"], // bottom-up: the flow is skip, spacer, back, next
  });
  const item = (id: string, w: number, h: number, hs: string, vs: string) =>
    (o[id] = shape(id, "rect", "footer", 0, 0, w, h, { layoutItemHSizing: hs, layoutItemVSizing: vs }));
  item("next", 97, 32, "fix", "fix");
  item("back", 58, 32, "fix", "fix");
  item("spacer", 10, 1, "fill", "fix");
  item("skip", 56, 15, "fix", "fix");
  return o;
}

test("zip: writeZip output reads back, copies keep their bytes", () => {
  const zip = writeZip([{ name: "a.json", content: j({ a: 1 }) }, { name: "b.txt", content: new TextEncoder().encode("x".repeat(1000)) }]);
  const r = new ZipReader(zip);
  assert.deepEqual(r.readJson("a.json"), { a: 1 });
  assert.equal(r.readText("b.txt").length, 1000);
  assert.equal(r.entries.get("b.txt")!.crc, crc32(new TextEncoder().encode("x".repeat(1000))));
  const again = new ZipReader(writeZip([{ name: "b.txt", copy: r.raw("b.txt") }]));
  assert.equal(again.readText("b.txt"), "x".repeat(1000));
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("geometry: absolute paths move, arcs keep their radii", () => {
  assert.equal(translatePath("M10,20L30,40", 5, -5), "M15,15L35,35");
  assert.equal(translatePath("M0 0 H10 V10 Z", 1, 2), "M1,2H11V12Z");
  assert.equal(translatePath("M0,0A5,5 0 0 1 10,10", 1, 1), "M1,1A5,5,0,0,1,11,11");
});

test("layout: reproduces Penpot's placement of a real flex row", () => {
  const ed = new PageEditor(footerPage(), P);
  ed.update("skip", { width: 56 }); // no change; forces a layout pass
  ed.update("back", { name: "Back" });
  ed.finish();
  const b = (id: string) => boxOf(ed.objects[id]);
  assert.deepEqual([b("skip").x, b("skip").y], [3096, -21.5]);
  assert.deepEqual([b("spacer").x, b("spacer").width], [3160, 33]);
  assert.deepEqual([b("back").x, b("back").y], [3201, -30]);
  assert.deepEqual([b("next").x, b("next").y], [3267, -30]);
});

test("editor: creates a flex card, hugs content, moves children with their board", () => {
  const o = footerPage();
  const ed = new PageEditor(o, P);
  const card = ed.create("board", undefined, { name: "Card", x: 0, y: 0, width: 200, height: 10, layout: "flex", direction: "column", gap: 10, padding: 20, vSizing: "auto" });
  const t1 = ed.create("text", card, { text: "Title", fontSize: 20, fontWeight: 700, color: "#111111" });
  const box = ed.create("rect", card, { width: 50, height: 40, hSizing: "fill" }, 5);
  const diff = ed.finish();
  assert.equal(diff.added.length, 3);
  const c = boxOf(ed.objects[card]), t = boxOf(ed.objects[t1]), r = boxOf(ed.objects[box]);
  assert.deepEqual([t.x, t.y], [20, 20]);
  assert.deepEqual([r.x, r.y, r.width], [20, 20 + t.height + 10, 160]);
  assert.equal(c.height, 20 + t.height + 10 + 40 + 20);
  assert.equal(textOf(ed.objects[t1].content), "Title");
  assert.deepEqual(ed.objects[card].shapes, [box, t1]);

  // Moving the board moves its children; positions are relative to the board.
  const ed2 = new PageEditor(ed.objects, P);
  ed2.update(card, { x: 100, y: 50 });
  const d2 = ed2.finish();
  assert.deepEqual([boxOf(ed2.objects[t1]).x, boxOf(ed2.objects[t1]).y], [120, 70]);
  assert.deepEqual(ed2.relBox(ed2.objects[t1]), { ...ed2.relBox(ed2.objects[t1]), x: 20, y: 20 });
  assert.equal(d2.changed.length, 3);
});

test("editor: delete, move between boards and duplicate", () => {
  const ed = new PageEditor(footerPage(), P);
  const other = ed.create("board", undefined, { x: 0, y: 0, width: 300, height: 300 });
  ed.move(["back"], other);
  assert.equal(ed.objects.back.parentId, other);
  assert.equal(ed.objects.back.frameId, other);
  assert.equal(ed.objects.back.layoutItemHSizing, undefined);
  const { id: copy, copies } = ed.duplicate("footer", undefined, 0, { y: 100 });
  assert.equal(copies.get("footer"), copy);
  assert.equal(ed.objects[copies.get("next")!].parentId, copy);
  ed.remove(["skip"]);
  const diff = ed.finish();
  assert.ok(!ed.objects.skip);
  assert.deepEqual(diff.removed, ["skip"]);
  const kids = ed.objects[copy].shapes as string[];
  assert.equal(kids.length, 3); // next, spacer, skip (the copy was made before skip was removed)
  for (const k of kids) assert.equal(ed.objects[k].parentId, copy);
  assert.equal(boxOf(ed.objects[copy]).y, -36 + 100);
  // Without Back, the footer row closes the gap: Next goes after the spacer.
  assert.equal(boxOf(ed.objects.next).x + 97, 3096 + 268);
});

test("editor: refuses to delete component mains and invalid colors", () => {
  const o = footerPage();
  o.footer.mainInstance = true;
  const ed = new PageEditor(o, P);
  assert.throws(() => ed.remove(["footer"]), /main of a component/);
  assert.throws(() => ed.update("next", { fill: "red" }), /Invalid color/);
});

function sampleArchive() {
  const o = footerPage();
  const entries = [
    { name: "manifest.json", content: j({ type: "penpot/export-files", version: 1, files: [{ id: F, name: "Design" }] }) },
    { name: `files/${F}.json`, content: j({ id: F, name: "Design" }) },
    { name: `files/${F}/pages/${P}.json`, content: j({ id: P, name: "Page 1", index: 0 }) },
    ...Object.values(o).map((s) => ({ name: `files/${F}/pages/${P}/${s.id}.json`, content: j(s) })),
    { name: `files/${F}/thumbnails/frame/${P}/footer.json`, content: j({ frameId: "footer", mediaId: "s9", tag: "frame" }) },
    { name: "objects/s9.json", content: j({ id: "s9", contentType: "image/png" }) },
    { name: "objects/s9.png", content: new Uint8Array([1, 2, 3]) },
  ];
  return writeZip(entries);
}

test("local source: writes changed shapes and drops stale thumbnails", async () => {
  let bytes = sampleArchive();
  const src = new LocalSource("local:x.penpot", async () => bytes, async (d) => { bytes = d; });
  const ed = new PageEditor(await src.pageObjects(F, P), P);
  ed.update("skip", { fill: "#ff0000" });
  await src.write(F, ed.finish());
  const a = PenpotArchive.open(bytes);
  assert.equal(a.pageObjects(F, P).skip.fills[0].fillColor, "#ff0000");
  assert.equal(a.thumbnailDataUri(F, "footer"), undefined);
  assert.ok(!new ZipReader(bytes).has("objects/s9.png"));
});

test("mcp: initialize, list tools, edit a .penpot and read it back over HTTP", async () => {
  let bytes = sampleArchive();
  const host: ToolHost = {
    listLocal: async () => [{ id: "local:x.penpot", path: "x.penpot" }],
    listCloud: async () => undefined,
    source: async (d) => {
      if (d !== "local:x.penpot") throw new Error("unknown");
      return new LocalSource(d, async () => bytes, async (b) => { bytes = b; });
    },
    rasterize: async () => undefined,
    edited: () => undefined,
  };
  const server = new McpServer(new Tools(host), { name: "test", version: "0" });
  const port = await server.start(0);
  const rpc = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: res.status === 202 ? undefined : await res.json() };
  };
  try {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.ok(list.body.result.tools.some((t: any) => t.name === "edit"));
    const call = (name: string, args: unknown, id = 3) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const edit = await call("edit", {
      design: "local:x.penpot",
      operations: [
        { op: "create", type: "text", parent: "footer", index: 0, ref: "hello", props: { text: "Hello", fontSize: 12 } },
        { op: "update", id: "$hello", props: { color: "#123456" } },
      ],
    });
    assert.equal(edit.body.result.isError, undefined, JSON.stringify(edit.body));
    assert.match(edit.body.result.content[0].text, /1 created/);
    const layers = await call("get_layers", { design: "local:x.penpot" }, 4);
    assert.match(layers.body.result.content[0].text, /text="Hello" \(sourcesanspro 12\/400 #123456/);
    const bad = await call("edit", { design: "local:x.penpot", operations: [{ op: "update", id: "nope", props: {} }] }, 5);
    assert.equal(bad.body.result.isError, true);
    assert.match(bad.body.result.content[0].text, /Nothing was saved/);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 6, method: "ping" }, { Origin: "https://evil.example" })).status, 403);
  } finally {
    await server.stop();
  }
});

test("editor: without index, new shapes go last in a flex flow and on top elsewhere", () => {
  const ed = new PageEditor(footerPage(), P);
  const a = ed.create("rect", "footer", { width: 10, height: 10 });
  // The list is bottom-up: last in the flow = first in the list.
  assert.equal((ed.objects.footer.shapes as string[])[0], a);
  const top = ed.create("rect", undefined, { width: 10, height: 10 });
  assert.equal((ed.objects[ROOT_ID].shapes as string[]).at(-1), top);
  const { id: dup } = ed.duplicate("back");
  const list = ed.objects.footer.shapes as string[];
  assert.equal(list.indexOf(dup), list.indexOf("back") - 1); // right after Back in the flow
  ed.finish();
});

test("path: commands become absolute M/L/C/Z, bounds include curve extremes", () => {
  assert.equal(formatSegs(parsePath("m1 1 h2 v2 h-2 z")), "M1,1L3,1L3,3L1,3Z");
  const arc = parsePath("M0 10 A10 10 0 0 1 20 10");
  const b = segsBounds(arc)!;
  assert.ok(Math.abs(b.y - 0) < 0.05 && Math.abs(b.height - 10) < 0.05, JSON.stringify(b));
  assert.deepEqual(parsePath("M0 0a5 5 0 105 5").at(-1)!.p.slice(4), [5, 5]); // compact arc flags
  assert.throws(() => parsePath("X1"), /Invalid path command/);
});

test("editor: path and svg icons are scaled into their box", () => {
  const ed = new PageEditor(footerPage(), P);
  const board = ed.create("board", undefined, { x: 100, y: 100, width: 200, height: 200 });
  const line = ed.create("path", board, { d: "M4 12h16", viewBox: [0, 0, 24, 24], width: 48, height: 48, stroke: { color: "#111111", width: 2 } });
  const l = ed.objects[line];
  assert.equal(l.content, "M108,124L140,124");
  assert.deepEqual(ed.relBox(l), { x: 8, y: 24, width: 32, height: 0.01 });
  const svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
  const icon = ed.create("svg", board, { svg, width: 48, color: "#ff0000", x: 50, y: 0 });
  const g = ed.objects[icon];
  assert.equal(g.type, "group");
  const parts = g.shapes as string[];
  assert.equal(parts.length, 2);
  const circle = ed.objects[parts[0]];
  assert.equal(circle.strokes[0].strokeColor, "#ff0000");
  assert.equal(circle.strokes[0].strokeWidth, 4);
  assert.equal(circle.strokes[0].strokeCapStart, "round");
  assert.deepEqual(circle.fills, []);
  const box = ed.relBox(g);
  assert.ok(Math.abs(box.x - 54) < 0.01 && Math.abs(box.width - 40) < 0.01, JSON.stringify(box));
  ed.update(line, { width: 16 });
  assert.equal(ed.objects[line].content, "M108,124L124,124");
  ed.finish();
  assert.throws(() => parseSvg("<div/>"), /No <svg>/);
});

test("text rows: wrap to the width, one row per paragraph when growing in width", () => {
  const ed = new PageEditor(footerPage(), P);
  const t = ed.create("text", undefined, { text: "Tem certeza que deseja banir este usuário da sala?\nOk", width: 120, fontSize: 14 });
  const rows = textRows(ed.objects[t].content, "auto-height", 120);
  assert.ok(rows.length > 2, rows.map((r) => r.text).join("|"));
  assert.equal(rows.at(-1)!.text, "Ok");
  assert.equal(textRows(ed.objects[t].content, "auto-width", 120).length, 2);
});
