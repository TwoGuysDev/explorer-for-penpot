// Flex layout, as the Penpot editor computes it: the backend and the .penpot file only store the result,
// so after an edit the MCP server places the children of flex boards itself.
// Covers direction (and reverse), gap, padding, justify, align, wrap, item sizing (fix/auto/fill),
// margins, min/max sizes, absolute and hidden items. Grid boards are left as they are.
// No VS Code imports here, so it can be unit-tested with plain Node.
import { Shape } from "../api";
import { Rect, boxOf, isRotated, num, setBox, translateTree } from "./geometry";

export interface LayoutHooks {
  /** Called for every shape whose geometry changed. */
  touched(id: string): void;
  /** New size of a text that must be measured again (undefined keeps its size). */
  textSize(s: Shape): { width: number; height: number } | undefined;
  warn(msg: string): void;
}

const isFlex = (s: Shape | undefined) => !!s && s.type === "frame" && s.layout === "flex";
export const hasLayout = (s: Shape | undefined) => !!s && s.type === "frame" && (s.layout === "flex" || s.layout === "grid");

/** Children that take part in the flow, in flow order (Penpot keeps the layer list bottom-up). */
export function flowItems(objects: Record<string, Shape>, c: Shape): Shape[] {
  return [...(c.shapes || [])]
    .reverse()
    .map((id) => objects[id])
    .filter((s): s is Shape => !!s && !s.hidden && !s.layoutItemAbsolute);
}

interface Pad { top: number; right: number; bottom: number; left: number }
const padding = (c: Shape): Pad => {
  const p = c.layoutPadding || {};
  return { top: num(p.p1), right: num(p.p2), bottom: num(p.p3), left: num(p.p4) };
};
const margin = (s: Shape): Pad => {
  const m = s.layoutItemMargin || {};
  return { top: num(m.m1), right: num(m.m2), bottom: num(m.m3), left: num(m.m4) };
};
const isRow = (c: Shape) => !String(c.layoutFlexDir || "row").startsWith("column");
const isReverse = (c: Shape) => String(c.layoutFlexDir || "").endsWith("reverse");
/** Gap between items on the main axis, and between lines (wrap). */
const gaps = (c: Shape) => {
  const g = c.layoutGap || {};
  return isRow(c) ? { main: num(g.columnGap), cross: num(g.rowGap) } : { main: num(g.rowGap), cross: num(g.columnGap) };
};
const clamp = (v: number, min: unknown, max: unknown) => {
  if (typeof max === "number" && max > 0) v = Math.min(v, max);
  if (typeof min === "number") v = Math.max(v, min);
  return Math.max(0, v);
};
const sizing = (s: Shape, horizontal: boolean): string => String((horizontal ? s.layoutItemHSizing : s.layoutItemVSizing) || "fix");

export class FlexEngine {
  constructor(private readonly objects: Record<string, Shape>, private readonly hooks: LayoutHooks) {}

  /** Lays out a board and every flex board inside it. */
  run(rootId: string) {
    // Twice: a size set by "fill" can change the content size of an auto board above it.
    for (let pass = 0; pass < 2; pass++) {
      this.fit(rootId);
      this.arrange(rootId);
    }
  }

  private resize(s: Shape, width: number, height: number) {
    const b = boxOf(s);
    if (Math.abs(b.width - width) < 0.001 && Math.abs(b.height - height) < 0.001) return;
    if (isRotated(s)) {
      this.hooks.warn(`"${s.name}" is rotated: its size was not changed by the layout.`);
      return;
    }
    setBox(s, { x: b.x, y: b.y, width, height });
    this.hooks.touched(s.id);
  }

  private moveTo(s: Shape, x: number, y: number) {
    const b = boxOf(s);
    translateTree(this.objects, s.id, x - b.x, y - b.y, (id) => this.hooks.touched(id));
  }

  /** Bottom-up: sizes of texts and of boards that hug their content ("auto"). */
  private fit(id: string) {
    const s = this.objects[id];
    if (!s) return;
    for (const c of s.shapes || []) if (this.objects[c]?.type === "frame" || this.objects[c]?.type === "text") this.fit(c);
    if (s.type === "text") {
      const size = this.hooks.textSize(s);
      if (size) this.resize(s, size.width, size.height);
      return;
    }
    if (!isFlex(s)) return;
    const hAuto = sizing(s, true) === "auto", vAuto = sizing(s, false) === "auto";
    if (!hAuto && !vAuto) return;
    const content = this.contentSize(s);
    const b = boxOf(s);
    this.resize(
      s,
      hAuto ? clamp(content.width, s.layoutItemMinW, s.layoutItemMaxW) : b.width,
      vAuto ? clamp(content.height, s.layoutItemMinH, s.layoutItemMaxH) : b.height,
    );
  }

  /** Size the items need, padding included. */
  private contentSize(c: Shape) {
    const row = isRow(c);
    const pad = padding(c);
    const g = gaps(c);
    const items = flowItems(this.objects, c);
    const lines = this.lines(c, items, Infinity);
    let main = 0, cross = 0;
    for (const line of lines) {
      main = Math.max(main, line.main);
      cross += line.cross;
    }
    cross += Math.max(0, lines.length - 1) * g.cross;
    const w = row ? main : cross, h = row ? cross : main;
    return { width: w + pad.left + pad.right, height: h + pad.top + pad.bottom };
  }

  /** Outer size of an item on both axes (margins included). */
  private outer(c: Shape, s: Shape) {
    const b = boxOf(s);
    const m = margin(s);
    const row = isRow(c);
    const w = b.width + m.left + m.right, h = b.height + m.top + m.bottom;
    return { main: row ? w : h, cross: row ? h : w };
  }

  private lines(c: Shape, items: Shape[], available: number) {
    const wrap = c.layoutWrapType === "wrap";
    const g = gaps(c);
    const lines: { items: Shape[]; main: number; cross: number }[] = [];
    let cur: { items: Shape[]; main: number; cross: number } | undefined;
    for (const s of items) {
      const o = this.outer(c, s);
      if (!cur || (wrap && cur.items.length && cur.main + g.main + o.main > available + 0.01)) {
        cur = { items: [], main: 0, cross: 0 };
        lines.push(cur);
      }
      cur.main += (cur.items.length ? g.main : 0) + o.main;
      cur.cross = Math.max(cur.cross, o.cross);
      cur.items.push(s);
    }
    return lines;
  }

  /** Top-down: positions and "fill" sizes of the items, then the boards inside. */
  private arrange(id: string) {
    const c = this.objects[id];
    if (!c) return;
    if (c.type === "frame" && c.layout === "grid") this.hooks.warn(`"${c.name}" uses a grid layout: its children were not moved.`);
    if (isFlex(c)) this.arrangeFlex(c);
    for (const ch of c.shapes || []) if (this.objects[ch]?.type === "frame" || this.objects[ch]?.type === "group") this.arrange(ch);
  }

  private arrangeFlex(c: Shape) {
    const row = isRow(c);
    const box = boxOf(c);
    const pad = padding(c);
    const g = gaps(c);
    const inner: Rect = {
      x: box.x + pad.left,
      y: box.y + pad.top,
      width: Math.max(0, box.width - pad.left - pad.right),
      height: Math.max(0, box.height - pad.top - pad.bottom),
    };
    const innerMain = row ? inner.width : inner.height;
    const innerCross = row ? inner.height : inner.width;
    const items = flowItems(this.objects, c);
    if (!items.length) return;

    // "fill" on the cross axis stretches to the line; on the main axis it shares the free space.
    const lines = this.lines(c, items, innerMain);
    const single = lines.length === 1;
    let crossPos = 0;
    for (const line of lines) {
      const lineCross = single ? innerCross : line.cross;
      const fills = line.items.filter((s) => sizing(s, row) === "fill");
      if (fills.length) {
        let fixed = 0;
        for (const s of line.items) if (!fills.includes(s)) fixed += this.outer(c, s).main;
        for (const s of fills) {
          const m = margin(s);
          fixed += row ? m.left + m.right : m.top + m.bottom;
        }
        fixed += g.main * (line.items.length - 1);
        const each = Math.max(0, (innerMain - fixed) / fills.length);
        for (const s of fills) {
          const b = boxOf(s);
          const v = row ? clamp(each, s.layoutItemMinW, s.layoutItemMaxW) : clamp(each, s.layoutItemMinH, s.layoutItemMaxH);
          this.resize(s, row ? v : b.width, row ? b.height : v);
        }
      }
      for (const s of line.items) {
        if (sizing(s, !row) !== "fill") continue;
        const m = margin(s);
        const b = boxOf(s);
        const v = lineCross - (row ? m.top + m.bottom : m.left + m.right);
        const size = row ? clamp(v, s.layoutItemMinH, s.layoutItemMaxH) : clamp(v, s.layoutItemMinW, s.layoutItemMaxW);
        this.resize(s, row ? b.width : size, row ? size : b.height);
      }

      // Main axis: justify-content.
      const used = line.items.reduce((sum, s) => sum + this.outer(c, s).main, 0) + g.main * (line.items.length - 1);
      const free = innerMain - used;
      const n = line.items.length;
      let start = 0, between = g.main;
      switch (c.layoutJustifyContent) {
        case "center": start = free / 2; break;
        case "end": start = free; break;
        case "space-between": if (n > 1) between = g.main + Math.max(0, free) / (n - 1); break;
        case "space-around": if (free > 0) { start = free / n / 2; between = g.main + free / n; } break;
        case "space-evenly": if (free > 0) { start = free / (n + 1); between = g.main + free / (n + 1); } break;
      }
      let pos = start;
      for (const s of line.items) {
        const o = this.outer(c, s);
        const m = margin(s);
        const b = boxOf(s);
        // Cross axis: align-items (per item: layoutItemAlignSelf).
        const align = s.layoutItemAlignSelf || c.layoutAlignItems || "start";
        const itemCross = o.cross;
        let off = 0;
        if (align === "center") off = (lineCross - itemCross) / 2;
        else if (align === "end") off = lineCross - itemCross;
        let mainStart = pos + (row ? m.left : m.top);
        if (isReverse(c)) mainStart = innerMain - (pos + o.main) + (row ? m.left : m.top);
        const crossStart = crossPos + off + (row ? m.top : m.left);
        const x = row ? inner.x + mainStart : inner.x + crossStart;
        const y = row ? inner.y + crossStart : inner.y + mainStart;
        if (Math.abs(b.x - x) > 0.001 || Math.abs(b.y - y) > 0.001) this.moveTo(s, x, y);
        pos += o.main + between;
      }
      crossPos += lineCross + g.cross;
    }
  }
}
