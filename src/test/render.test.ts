import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_ID, Shape } from "../api";
import { renderSvg } from "../render";

const noImages = { loadImage: async () => undefined };

function board(extra: Partial<Shape> = {}): Record<string, Shape> {
  const objects: Record<string, Shape> = {
    [ROOT_ID]: { id: ROOT_ID, name: "Root Frame", type: "frame", shapes: ["b"] },
    b: {
      id: "b", name: "Board", type: "frame", x: 100, y: 50, width: 200, height: 120,
      fills: [{ fillColor: "#1E1F23", fillOpacity: 1 }], shapes: ["r", "t"], ...extra,
    },
    r: {
      id: "r", name: "Card", type: "rect", parentId: "b", x: 110, y: 60, width: 80, height: 40,
      r1: 8, r2: 8, r3: 8, r4: 8, fills: [{ fillColor: "#00E08A", fillOpacity: 0.5 }],
      strokes: [{ strokeColor: "#FFFFFF", strokeOpacity: 1, strokeWidth: 2, strokeAlignment: "inner" }],
    },
    t: {
      id: "t", name: "Title", type: "text", parentId: "b", x: 110, y: 120, width: 60, height: 16,
      positionData: [{ x: 110, y: 136, width: 60, height: 16, text: "Hi <you>", fontSize: "13px", fontWeight: "700", fontFamily: "Inter", fills: [{ fillColor: "#F2F3F5", fillOpacity: 1 }] }],
    },
  };
  return objects;
}

test("renders a board with its own viewBox and size", async () => {
  const res = await renderSvg(board(), "b", noImages);
  assert.equal(res.width, 200);
  assert.equal(res.height, 120);
  assert.match(res.svg, /viewBox="100 50 200 120"/);
});

test("draws fills, rounded corners and inner strokes", async () => {
  const { svg } = await renderSvg(board(), "b", noImages);
  assert.match(svg, /fill="#1E1F23"/);
  assert.match(svg, /fill="#00E08A" fill-opacity="0.5"/);
  assert.match(svg, /rx="8"/);
  // inner stroke of width 2 is drawn 1px inside the box
  const stroke = svg.match(/<rect[^>]*stroke="#FFFFFF"[^>]*>/)?.[0] || "";
  assert.match(stroke, /x="111" y="61" width="78" height="38" rx="7"/);
});

test("escapes text and keeps its font", async () => {
  const { svg } = await renderSvg(board(), "b", noImages);
  assert.match(svg, /Hi &lt;you&gt;/);
  assert.match(svg, /font-weight="700"/);
  assert.doesNotMatch(svg, /<you>/);
});

test("clips board content unless showContent is on", async () => {
  assert.match((await renderSvg(board(), "b", noImages)).svg, /clip-path="url\(#c\d+\)"/);
  const open = await renderSvg(board({ showContent: true, fills: [] }), "b", noImages);
  assert.doesNotMatch(open.svg, /clip-path/);
});

test("skips hidden shapes", async () => {
  const objects = board();
  objects.r.hidden = true;
  assert.doesNotMatch((await renderSvg(objects, "b", noImages)).svg, /#00E08A/);
});

test("paints absolute children of a layout above the flow children", async () => {
  const objects = board({ layout: "flex" });
  objects.r.layoutItemAbsolute = true; // first in the list, but absolute: must be painted last
  const svg = (await renderSvg(objects, "b", noImages)).svg;
  assert.ok(svg.indexOf("#00E08A") > svg.indexOf("Hi &lt;you&gt;"));
  // Without a layout the list order wins.
  const plain = board();
  plain.r.layoutItemAbsolute = true;
  const svg2 = (await renderSvg(plain, "b", noImages)).svg;
  assert.ok(svg2.indexOf("#00E08A") < svg2.indexOf("Hi &lt;you&gt;"));
});

test("sorts layout children by z-index, keeping list order on ties", async () => {
  const objects = board({ layout: "grid" });
  objects.r.layoutItemZIndex = 2;
  objects.t.layoutItemZIndex = 1;
  const svg = (await renderSvg(objects, "b", noImages)).svg;
  assert.ok(svg.indexOf("#00E08A") > svg.indexOf("Hi &lt;you&gt;"));
});

test("draws the top fill last (Penpot keeps fills[0] on top)", async () => {
  const objects = board({ fills: [{ fillColor: "#AAAAAA", fillOpacity: 1 }, { fillColor: "#BBBBBB", fillOpacity: 1 }] });
  const { svg } = await renderSvg(objects, "b", noImages);
  assert.ok(svg.indexOf("#BBBBBB") < svg.indexOf("#AAAAAA"));
});

test("reports images that could not load", async () => {
  const objects = board({ fills: [{ fillOpacity: 1, fillImage: { id: "m1", mtype: "image/png" } }] });
  const res = await renderSvg(objects, "b", noImages);
  assert.deepEqual(res.warnings, [{ kind: "image" }]);
  const ok = await renderSvg(objects, "b", { loadImage: async () => "data:image/png;base64,AAAA" });
  assert.match(ok.svg, /<image href="data:image\/png;base64,AAAA"/);
  assert.deepEqual(ok.warnings, []);
});

test("supports path content as commands and as a string", async () => {
  const mk = (content: unknown): Record<string, Shape> => ({
    p: { id: "p", name: "P", type: "path", content, strokes: [{ strokeColor: "#000000", strokeWidth: 1 }] },
  });
  const cmds = [{ command: "move-to", params: { x: 0, y: 0 } }, { command: "line-to", params: { x: 10, y: 0 } }, { command: "close-path", params: {} }];
  assert.match((await renderSvg(mk(cmds), "p", noImages)).svg, /d="M0,0L10,0Z"/);
  assert.match((await renderSvg(mk("M1,1L2,2"), "p", noImages)).svg, /d="M1,1L2,2"/);
});

test("drops scripts and event handlers from imported SVG", async () => {
  const objects: Record<string, Shape> = {
    s: {
      id: "s", name: "Raw", type: "svg-raw", x: 0, y: 0, width: 10, height: 10,
      content: { tag: "g", attrs: { onclick: "alert(1)" }, content: [{ tag: "script", attrs: {}, content: "alert(1)" }, { tag: "use", attrs: { href: "https://evil.example/x.svg#a" } }] },
    },
  };
  const { svg } = await renderSvg(objects, "s", noImages);
  assert.doesNotMatch(svg, /script|onclick|evil\.example/);
});

test("renders the whole page around its boards", async () => {
  const res = await renderSvg(board(), ROOT_ID, noImages);
  assert.equal(res.width, 200 + 80); // board plus 40px padding on each side
  assert.match(res.svg, /viewBox="60 10 280 200"/);
});
