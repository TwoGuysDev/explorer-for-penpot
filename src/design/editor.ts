// Edits one page of a Penpot file in memory: create, change, move, duplicate and delete shapes, then
// lay out the flex boards that were affected and report what changed (for the writer of each source).
// Positions given to and returned by the editor are relative to the board that contains the shape,
// like in Penpot's design panel; inside the editor everything is absolute, like in the file.
// No VS Code imports here, so it can be unit-tested with plain Node.
import { randomUUID } from "node:crypto";
import { ROOT_ID, Shape } from "../api";
import { IDENTITY, Rect, boxOf, corners, isRotated, num, selrect, setBox, subtree, translateTree, unionBox } from "./geometry";
import { FlexEngine, hasLayout } from "./layout";
import { Matrix, PathError, Seg, SvgElementPath, fitMatrix, formatSegs, parsePath, parseSvg, refitContent, segsBounds, transformSegs } from "./path";
import { TextStyle, buildContent, editContent, measureText, styleOf, textOf } from "./text";

export class EditError extends Error {}

export type ShapeKind = "board" | "rect" | "ellipse" | "text" | "path" | "svg";

export interface FillSpec { color?: string; opacity?: number }
export interface StrokeSpec { color?: string; width?: number; opacity?: number; alignment?: "inner" | "center" | "outer"; style?: "solid" | "dotted" | "dashed" | "mixed" }
export interface ShadowSpec { color?: string; opacity?: number; x?: number; y?: number; blur?: number; spread?: number; inner?: boolean }

/** Properties the tools accept; anything not covered can go in `raw` (Penpot attributes in camelCase). */
export interface ShapeProps extends TextStyle {
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  hidden?: boolean;
  opacity?: number;
  fill?: string | FillSpec | FillSpec[] | null;
  stroke?: StrokeSpec | null;
  radius?: number | [number, number, number, number];
  shadow?: ShadowSpec | ShadowSpec[] | null;
  clipContent?: boolean;
  // Board layout
  layout?: "flex" | "none";
  direction?: "row" | "row-reverse" | "column" | "column-reverse";
  gap?: number | { row?: number; column?: number };
  padding?: number | [number, number, number, number];
  justify?: "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
  align?: "start" | "center" | "end" | "stretch";
  wrap?: boolean;
  // As a child of a flex board
  hSizing?: "fix" | "fill" | "auto";
  vSizing?: "fix" | "fill" | "auto";
  absolute?: boolean;
  margin?: number | [number, number, number, number];
  alignSelf?: "start" | "center" | "end" | "stretch" | null;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  // Text
  text?: string;
  growType?: "auto-width" | "auto-height" | "fixed";
  verticalAlign?: "top" | "center" | "bottom";
  // Paths and SVG icons
  /** SVG path data, in the coordinates of viewBox (default: the path's own bounds). */
  d?: string;
  viewBox?: [number, number, number, number];
  /** SVG markup (create type "svg"): paths, basic shapes, groups and transforms become Penpot paths. */
  svg?: string;
  raw?: Record<string, unknown>;
}

export interface PageDiff {
  pageId: string;
  /** New shapes, parents before children. */
  added: Shape[];
  /** Shapes that exist before and after but differ. */
  changed: { before: Shape; after: Shape }[];
  /** Ids of removed shapes (descendants included). */
  removed: string[];
}

const isColor = (v: unknown): v is string => typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
const four = (v: number | number[]) => (Array.isArray(v) ? [num(v[0]), num(v[1]), num(v[2]), num(v[3])] : [v, v, v, v]);

/** Attribute groups Penpot uses to remember overrides in component copies. */
function touchedGroup(attr: string): string | undefined {
  if (attr === "name") return "name-group";
  if (attr === "fills" || attr === "hideFillOnExport") return "fill-group";
  if (attr === "strokes") return "stroke-group";
  if (/^(r[1-4]|rx|ry)$/.test(attr)) return "radius-group";
  if (/^(x|y|width|height|selrect|points|transform|transformInverse|rotation)$/.test(attr)) return "geometry-group";
  if (attr === "content" || attr === "positionData") return "content-group";
  if (attr === "hidden") return "visibility-group";
  if (attr === "opacity" || attr === "blendMode") return "layer-effects-group";
  if (attr === "shadow") return "shadow-group";
  if (attr === "blur") return "blur-group";
  if (attr === "growType") return "text-font-group";
  if (attr.startsWith("layoutItem")) return "layout-item-group";
  if (attr.startsWith("layout")) return "layout-container";
  return undefined;
}

export class PageEditor {
  readonly objects: Record<string, Shape>;
  readonly warnings: string[] = [];
  private readonly touchedIds = new Set<string>();
  private readonly addedIds = new Set<string>();
  private readonly removedIds = new Set<string>();
  private readonly layoutDirty = new Set<string>();
  private readonly textDirty = new Set<string>();

  constructor(private readonly original: Record<string, Shape>, readonly pageId: string) {
    this.objects = structuredClone(original);
    if (!this.objects[ROOT_ID]) throw new EditError("The page has no root shape.");
  }

  // ---------- reading ----------

  get(id: string): Shape {
    const s = this.objects[id];
    if (!s) throw new EditError(`No shape with id ${id} on this page.`);
    return s;
  }

  /** The board a shape's coordinates are relative to (its frameId; the page root for top-level shapes). */
  private originOf(s: Shape): { x: number; y: number } {
    const f = s.frameId && s.frameId !== ROOT_ID && s.frameId !== s.id ? this.objects[s.frameId] : undefined;
    if (!f) return { x: 0, y: 0 };
    const b = boxOf(f);
    return { x: b.x, y: b.y };
  }

  /** Box relative to the containing board. */
  relBox(s: Shape): Rect {
    const b = boxOf(s);
    const o = this.originOf(s);
    return { x: b.x - o.x, y: b.y - o.y, width: b.width, height: b.height };
  }

  // ---------- bookkeeping ----------

  private touch(id: string) {
    this.touchedIds.add(id);
  }

  /** Marks the layouts that a change to this shape can affect. */
  private dirty(id: string) {
    this.layoutDirty.add(id);
  }

  private frameFor(parentId: string): string {
    const p = this.get(parentId);
    if (parentId === ROOT_ID) return ROOT_ID;
    return p.type === "frame" ? p.id : p.frameId || ROOT_ID;
  }

  /** frameId of a shape and its children: the nearest board above each one. */
  private fixFrameIds(id: string) {
    for (const d of subtree(this.objects, id)) {
      const s = this.objects[d];
      const p = this.objects[s.parentId || ROOT_ID];
      const f = !p || p.id === ROOT_ID ? ROOT_ID : p.type === "frame" ? p.id : p.frameId || ROOT_ID;
      if (s.frameId !== f) {
        s.frameId = f;
        this.touch(d);
      }
    }
  }

  private markCopyOverride(s: Shape, attrs: string[]) {
    if (!s.shapeRef) return;
    const groups = new Set<string>(Array.isArray(s.touched) ? s.touched : []);
    for (const a of attrs) {
      const g = touchedGroup(a);
      if (g) groups.add(g);
    }
    s.touched = [...groups];
  }

  // ---------- operations ----------

  /** Where a new child goes in a parent's list (bottom-up): index counts from the top of the layers panel
   * (= first in a flex flow). Without one, a child goes last in a layout's flow, or on top elsewhere. */
  private insertAt(parent: Shape, list: string[], index?: number): number {
    if (index === undefined) return hasLayout(parent) ? 0 : list.length;
    return Math.max(0, Math.min(list.length, list.length - index));
  }

  private container(pid: string): Shape {
    const parent = this.get(pid);
    if (!(parent.type === "frame" || parent.type === "group")) throw new EditError(`"${parent.name}" is a ${parent.type}: shapes can only go inside boards and groups.`);
    return parent;
  }

  /** A blank shape of this type registered under the parent (box 0,0 100×100; the caller places it). */
  private blank(type: string, pid: string, name: string, at: number | "end"): Shape {
    const parent = this.get(pid);
    const id = randomUUID();
    const s: Shape = {
      id,
      name,
      type,
      x: 0, y: 0, width: 100, height: 100,
      rotation: 0,
      selrect: selrect({ x: 0, y: 0, width: 100, height: 100 }),
      points: corners({ x: 0, y: 0, width: 100, height: 100 }),
      transform: { ...IDENTITY },
      transformInverse: { ...IDENTITY },
      parentId: pid,
      frameId: this.frameFor(pid),
      flipX: null,
      flipY: null,
      proportionLock: false,
      proportion: 1,
      pageId: this.pageId,
      strokes: [],
      fills: [],
    };
    if (hasLayout(parent)) {
      s.layoutItemHSizing = type === "text" ? "auto" : "fix";
      s.layoutItemVSizing = type === "text" ? "auto" : "fix";
    }
    this.objects[id] = s;
    const list = [...(parent.shapes || [])];
    list.splice(at === "end" ? list.length : at, 0, id);
    parent.shapes = list;
    this.addedIds.add(id);
    this.touch(pid);
    return s;
  }

  create(kind: ShapeKind, parentId: string | undefined, props: ShapeProps, index?: number): string {
    const pid = parentId || ROOT_ID;
    const parent = this.container(pid);
    if (kind === "svg") return this.createSvg(pid, props, index);
    const type = kind === "board" ? "frame" : kind === "ellipse" ? "circle" : kind;
    const name = props.name || (kind === "board" ? "Board" : kind === "text" ? (props.text || "Text").slice(0, 40) : kind[0].toUpperCase() + kind.slice(1));
    const segs = type === "path" ? this.segs(props.d) : undefined;
    const s = this.blank(type, pid, name, this.insertAt(parent, parent.shapes || [], index));
    const id = s.id;
    if (type === "frame") {
      Object.assign(s, { shapes: [], hideFillOnExport: false, showContent: true, r1: 0, r2: 0, r3: 0, r4: 0 });
      if (pid === ROOT_ID && props.fill === undefined) s.fills = [{ fillColor: "#FFFFFF", fillOpacity: 1 }];
    } else if (type === "rect") {
      Object.assign(s, { r1: 0, r2: 0, r3: 0, r4: 0 });
      if (props.fill === undefined) s.fills = [{ fillColor: "#B1B2B5", fillOpacity: 1 }];
    } else if (type === "circle") {
      if (props.fill === undefined) s.fills = [{ fillColor: "#B1B2B5", fillOpacity: 1 }];
    } else if (type === "text") {
      s.growType = props.growType || (props.width !== undefined ? "auto-height" : "auto-width");
      s.content = buildContent(props.text ?? "Text", props, props.verticalAlign);
      this.textDirty.add(id);
    }
    const o = this.originOf(s);
    if (segs) {
      if (props.fill === undefined && props.stroke === undefined) s.fills = [{ fillColor: "#000000", fillOpacity: 1 }];
      const vb = props.viewBox ? this.viewBox(props.viewBox) : segsBounds(segs)!;
      const w = props.width ?? vb.width, h = props.height ?? vb.height;
      this.setPath(s, transformSegs(segs, fitMatrix(vb, { x: o.x + (props.x ?? 0), y: o.y + (props.y ?? 0), width: w, height: h })));
    } else {
      setBox(s, { x: o.x + (props.x ?? 0), y: o.y + (props.y ?? 0), width: props.width ?? 100, height: props.height ?? (type === "text" ? 20 : 100) });
    }
    const { x: _x, y: _y, width: _w, height: _h, text: _t, growType: _g, d: _d, viewBox: _v, ...rest } = props;
    this.apply(s, rest, true);
    this.dirty(id);
    this.updateGroups(pid);
    return id;
  }

  private segs(d: unknown): Seg[] {
    if (typeof d !== "string" || !d.trim()) throw new EditError('A path needs "d" (SVG path data).');
    try {
      const segs = parsePath(d);
      if (!segsBounds(segs)) throw new EditError("The path data has no points.");
      return segs;
    } catch (err) {
      if (err instanceof PathError) throw new EditError(err.message);
      throw err;
    }
  }

  private viewBox(v: unknown) {
    if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === "number" && isFinite(n)) || v[2] <= 0 || v[3] <= 0) {
      throw new EditError("viewBox must be [x, y, width, height] with a positive size.");
    }
    return { x: v[0], y: v[1], width: v[2], height: v[3] };
  }

  /** Absolute segments → content and box of a path shape (Penpot keeps the box at the path's bounds). */
  private setPath(s: Shape, segs: Seg[]) {
    const b = segsBounds(segs)!;
    s.content = formatSegs(segs);
    setBox(s, { x: b.x, y: b.y, width: Math.max(b.width, 0.01), height: Math.max(b.height, 0.01) });
  }

  /** An SVG document as paths: one path, or a group of paths in document order. */
  private createSvg(pid: string, props: ShapeProps, index?: number): string {
    if (typeof props.svg !== "string" || !props.svg.trim()) throw new EditError('An svg needs "svg" (the SVG markup).');
    let doc;
    try {
      doc = parseSvg(props.svg, props.color ?? "#000000");
    } catch (err) {
      if (err instanceof PathError) throw new EditError(err.message);
      throw err;
    }
    for (const w of doc.warnings) this.warnings.push(`SVG: ${w}.`);
    const parent = this.get(pid);
    const vb = doc.viewBox;
    // Like an <img>: keep the proportions (xMidYMid meet) inside the requested box.
    const w = props.width ?? (props.height !== undefined ? (vb.width * props.height) / vb.height : vb.width);
    const h = props.height ?? (props.width !== undefined ? (vb.height * props.width) / vb.width : vb.height);
    const k = Math.min(w / vb.width, h / vb.height);
    const o = this.originOf({ frameId: this.frameFor(pid) } as Shape);
    const x0 = o.x + (props.x ?? 0) + (w - vb.width * k) / 2, y0 = o.y + (props.y ?? 0) + (h - vb.height * k) / 2;
    const m: Matrix = [k, 0, 0, k, x0 - vb.x * k, y0 - vb.y * k];
    const name = props.name || "Icon";
    const at = this.insertAt(parent, parent.shapes || [], index);
    const style = (s: Shape, el: SvgElementPath) => {
      s.fills = el.fill ? [{ fillColor: el.fill, fillOpacity: el.fillOpacity }] : [];
      if (el.stroke && el.strokeWidth > 0) {
        const cap = el.linecap === "round" || el.linecap === "square" ? el.linecap : undefined;
        s.strokes = [{
          strokeColor: el.stroke, strokeOpacity: el.strokeOpacity, strokeWidth: Math.round(el.strokeWidth * k * 1000) / 1000,
          strokeAlignment: "center", strokeStyle: "solid", ...(cap ? { strokeCapStart: cap, strokeCapEnd: cap } : {}),
        }];
      }
      const svgAttrs: Record<string, string> = {};
      if (el.linejoin) svgAttrs.strokeLinejoin = el.linejoin;
      if (el.linecap) svgAttrs.strokeLinecap = el.linecap;
      if (el.fillRule) svgAttrs.fillRule = el.fillRule;
      if (Object.keys(svgAttrs).length) s.svgAttrs = svgAttrs;
      if (el.opacity !== 1) s.opacity = el.opacity;
    };
    let root: Shape;
    if (doc.paths.length === 1) {
      root = this.blank("path", pid, name, at);
      this.setPath(root, transformSegs(doc.paths[0].segs, m));
      style(root, doc.paths[0]);
    } else {
      root = this.blank("group", pid, name, at);
      root.shapes = [];
      for (const el of doc.paths) {
        const s = this.blank("path", root.id, el.name, "end");
        this.setPath(s, transformSegs(el.segs, m));
        style(s, el);
      }
      this.updateGroups(root.id);
    }
    const { x: _x, y: _y, width: _w, height: _h, svg: _s, color: _c, name: _n, ...rest } = props;
    this.apply(root, rest, true);
    this.dirty(root.id);
    this.updateGroups(pid);
    return root.id;
  }

  update(id: string, props: ShapeProps) {
    if (id === ROOT_ID) throw new EditError("The page root cannot be changed.");
    const s = this.get(id);
    const before = JSON.stringify(s);
    this.apply(s, props, false);
    if (JSON.stringify(s) !== before) {
      this.touch(id);
      this.dirty(id);
    }
  }

  /** Changes a shape's attributes (geometry included); `fresh` skips the copy-override bookkeeping. */
  private apply(s: Shape, p: ShapeProps, fresh: boolean) {
    const changed: string[] = [];
    const set = (k: string, v: unknown) => {
      if (v === undefined) return;
      if (v === null) delete s[k];
      else s[k] = v;
      changed.push(k);
    };
    if (p.name !== undefined) set("name", String(p.name));
    if (p.hidden !== undefined) set("hidden", !!p.hidden);
    if (p.opacity !== undefined) set("opacity", p.opacity);

    if (p.fill !== undefined) {
      const list = p.fill === null ? [] : Array.isArray(p.fill) ? p.fill : [typeof p.fill === "string" ? { color: p.fill } : p.fill];
      for (const f of list) if (!isColor(f.color)) throw new EditError(`Invalid color "${f.color}" (use #RRGGBB).`);
      if (s.type === "text") {
        // A text's color lives in its content.
        if (list[0]) {
          s.content = editContent(s.content, undefined, { color: list[0].color, opacity: list[0].opacity ?? 1 });
          changed.push("content");
        }
      } else set("fills", list.map((f) => ({ fillColor: f.color, fillOpacity: f.opacity ?? 1 })));
    }
    if (p.stroke !== undefined) {
      if (p.stroke && p.stroke.color !== undefined && !isColor(p.stroke.color)) throw new EditError(`Invalid stroke color "${p.stroke.color}".`);
      const old = (Array.isArray(s.strokes) && s.strokes[0]) || {};
      set(
        "strokes",
        p.stroke === null
          ? []
          : [{
              strokeColor: p.stroke.color ?? old.strokeColor ?? "#000000",
              strokeOpacity: p.stroke.opacity ?? old.strokeOpacity ?? 1,
              strokeWidth: p.stroke.width ?? old.strokeWidth ?? 1,
              strokeAlignment: p.stroke.alignment ?? old.strokeAlignment ?? "inner",
              strokeStyle: p.stroke.style ?? old.strokeStyle ?? "solid",
            }],
      );
    }
    if (p.radius !== undefined) {
      if (!["rect", "frame", "image"].includes(s.type)) throw new EditError(`"${s.name}" is a ${s.type}: only boards and rectangles have a radius.`);
      const [a, b, c, d] = four(p.radius);
      set("r1", a); set("r2", b); set("r3", c); set("r4", d);
      if (s.rx !== undefined) { set("rx", null); set("ry", null); }
    }
    if (p.shadow !== undefined) {
      const list = p.shadow === null ? [] : Array.isArray(p.shadow) ? p.shadow : [p.shadow];
      set("shadow", list.map((sh) => {
        if (sh.color !== undefined && !isColor(sh.color)) throw new EditError(`Invalid shadow color "${sh.color}".`);
        return {
          id: randomUUID(),
          style: sh.inner ? "inner-shadow" : "drop-shadow",
          color: { color: sh.color ?? "#000000", opacity: sh.opacity ?? 0.2 },
          offsetX: sh.x ?? 0,
          offsetY: sh.y ?? 4,
          blur: sh.blur ?? 4,
          spread: sh.spread ?? 0,
          hidden: false,
        };
      }));
    }
    if (p.clipContent !== undefined) {
      if (s.type !== "frame") throw new EditError(`"${s.name}" is not a board: only boards clip their content.`);
      set("showContent", !p.clipContent);
    }

    // Board layout.
    const layoutKeys = ["direction", "gap", "padding", "justify", "align", "wrap"] as const;
    if (p.layout !== undefined || layoutKeys.some((k) => p[k] !== undefined)) {
      if (s.type !== "frame") throw new EditError(`"${s.name}" is a ${s.type}: only boards can have a layout.`);
      if (p.layout === "none") {
        for (const k of Object.keys(s)) if (k.startsWith("layout") && !k.startsWith("layoutItem")) set(k, null);
      } else {
        if (p.layout === "flex" && s.layout !== "flex") {
          if (s.layout === "grid") throw new EditError(`"${s.name}" has a grid layout; switch it with layout "none" first.`);
          set("layout", "flex");
          set("layoutFlexDir", s.layoutFlexDir || "row");
          set("layoutGapType", "multiple");
          set("layoutGap", s.layoutGap || { rowGap: 0, columnGap: 0 });
          set("layoutPaddingType", "multiple");
          set("layoutPadding", s.layoutPadding || { p1: 0, p2: 0, p3: 0, p4: 0 });
          set("layoutWrapType", "nowrap");
          set("layoutJustifyContent", "start");
          set("layoutAlignItems", "start");
          set("layoutAlignContent", "stretch");
          for (const c of s.shapes || []) {
            const ch = this.objects[c];
            if (ch && !ch.layoutItemHSizing) {
              ch.layoutItemHSizing = ch.type === "text" ? "auto" : "fix";
              ch.layoutItemVSizing = ch.type === "text" ? "auto" : "fix";
              this.touch(c);
            }
          }
        } else if (s.layout !== "flex" && p.layout === undefined) {
          throw new EditError(`"${s.name}" has no flex layout: set layout "flex" too.`);
        }
        if (p.direction !== undefined) set("layoutFlexDir", p.direction);
        if (p.gap !== undefined) set("layoutGap", typeof p.gap === "number" ? { rowGap: p.gap, columnGap: p.gap } : { rowGap: p.gap.row ?? s.layoutGap?.rowGap ?? 0, columnGap: p.gap.column ?? s.layoutGap?.columnGap ?? 0 });
        if (p.padding !== undefined) {
          const [t, r, b, l] = four(p.padding);
          set("layoutPadding", { p1: t, p2: r, p3: b, p4: l });
          set("layoutPaddingType", t === r && r === b && b === l ? "simple" : "multiple");
        }
        if (p.justify !== undefined) set("layoutJustifyContent", p.justify);
        if (p.align !== undefined) set("layoutAlignItems", p.align);
        if (p.wrap !== undefined) set("layoutWrapType", p.wrap ? "wrap" : "nowrap");
      }
    }

    // As a layout child.
    if (p.hSizing !== undefined) set("layoutItemHSizing", p.hSizing);
    if (p.vSizing !== undefined) set("layoutItemVSizing", p.vSizing);
    if ((p.hSizing === "auto" || p.vSizing === "auto") && s.type !== "text" && !(s.type === "frame" && s.layout)) {
      this.warnings.push(`"${s.name}": "auto" size only works for texts and boards with a layout.`);
    }
    if (p.absolute !== undefined) set("layoutItemAbsolute", p.absolute || null);
    if (p.margin !== undefined) {
      const [t, r, b, l] = four(p.margin);
      set("layoutItemMargin", { m1: t, m2: r, m3: b, m4: l });
      set("layoutItemMarginType", t === r && r === b && b === l ? "simple" : "multiple");
    }
    if (p.alignSelf !== undefined) set("layoutItemAlignSelf", p.alignSelf);
    if (p.minWidth !== undefined) set("layoutItemMinW", p.minWidth);
    if (p.maxWidth !== undefined) set("layoutItemMaxW", p.maxWidth);
    if (p.minHeight !== undefined) set("layoutItemMinH", p.minHeight);
    if (p.maxHeight !== undefined) set("layoutItemMaxH", p.maxHeight);

    // Text.
    const style: TextStyle = {
      fontFamily: p.fontFamily, fontSize: p.fontSize, fontWeight: p.fontWeight, fontStyle: p.fontStyle, color: p.color,
      lineHeight: p.lineHeight, letterSpacing: p.letterSpacing, textAlign: p.textAlign, textDecoration: p.textDecoration,
      textTransform: p.textTransform,
    };
    if (style.color !== undefined && !isColor(style.color)) throw new EditError(`Invalid color "${style.color}" (use #RRGGBB).`);
    const styled = Object.values(style).some((v) => v !== undefined);
    if (p.text !== undefined || styled || p.growType !== undefined || p.verticalAlign !== undefined) {
      if (s.type !== "text") throw new EditError(`"${s.name}" is a ${s.type}, not a text.`);
      if (p.text !== undefined || styled) {
        s.content = editContent(s.content, p.text, style);
        changed.push("content");
      }
      if (p.verticalAlign !== undefined) {
        s.content = { ...s.content, verticalAlign: p.verticalAlign };
        changed.push("content");
      }
      if (p.growType !== undefined) set("growType", p.growType);
      this.textDirty.add(s.id);
    }

    // New path data, fitted to the current box (then x/y/width/height below can move and resize it).
    if (p.d !== undefined || p.viewBox !== undefined) {
      if (s.type !== "path") throw new EditError(`"${s.name}" is a ${s.type}, not a path.`);
      if (p.d === undefined) throw new EditError('viewBox goes with "d".');
      const segs = this.segs(p.d);
      const vb = p.viewBox ? this.viewBox(p.viewBox) : segsBounds(segs)!;
      this.setPath(s, transformSegs(segs, fitMatrix(vb, boxOf(s))));
      changed.push("content", "selrect", "points");
    }

    // Geometry (relative to the containing board).
    if (p.x !== undefined || p.y !== undefined || p.width !== undefined || p.height !== undefined) {
      if (!fresh) {
        const parent = s.parentId ? this.objects[s.parentId] : undefined;
        if ((p.x !== undefined || p.y !== undefined) && parent?.layout === "flex" && !s.layoutItemAbsolute && !p.absolute) {
          this.warnings.push(`"${s.name}" is inside the flex board "${parent.name}": its position comes from the layout (set absolute: true to place it freely).`);
        }
      }
      const rel = this.relBox(s);
      const o = this.originOf(s);
      const target = {
        x: o.x + (p.x ?? rel.x),
        y: o.y + (p.y ?? rel.y),
        width: p.width ?? rel.width,
        height: p.height ?? rel.height,
      };
      const resized = Math.abs(target.width - rel.width) > 0.001 || Math.abs(target.height - rel.height) > 0.001;
      if (resized) {
        if (isRotated(s)) throw new EditError(`"${s.name}" is rotated: it cannot be resized here.`);
        if (["group", "bool", "svg-raw"].includes(s.type)) throw new EditError(`"${s.name}" is a ${s.type}: resize the shapes inside it instead.`);
        if (target.width <= 0 || target.height <= 0) throw new EditError("Width and height must be greater than 0.");
        const b = boxOf(s);
        if (s.type === "path" && s.content != null) {
          s.content = refitContent(s.content, b, { x: b.x, y: b.y, width: target.width, height: target.height }) ?? s.content;
          changed.push("content");
        }
        setBox(s, { x: b.x, y: b.y, width: target.width, height: target.height });
        changed.push("width", "height", "selrect", "points");
        if (s.type === "text") {
          if (p.growType === undefined) set("growType", p.height !== undefined ? "fixed" : "auto-height");
          delete s.positionData;
          this.textDirty.add(s.id);
        }
        if (s.layoutItemHSizing === "fill" && p.width !== undefined && p.hSizing === undefined) set("layoutItemHSizing", "fix");
        if (s.layoutItemVSizing === "fill" && p.height !== undefined && p.vSizing === undefined) set("layoutItemVSizing", "fix");
        if (s.layoutItemHSizing === "auto" && p.width !== undefined && p.hSizing === undefined) set("layoutItemHSizing", "fix");
        if (s.layoutItemVSizing === "auto" && p.height !== undefined && p.vSizing === undefined) set("layoutItemVSizing", "fix");
      }
      const b = boxOf(s);
      if (Math.abs(b.x - target.x) > 0.001 || Math.abs(b.y - target.y) > 0.001) {
        translateTree(this.objects, s.id, target.x - b.x, target.y - b.y, (i) => this.touch(i));
        changed.push("x", "y");
      }
    }

    if (p.raw) for (const [k, v] of Object.entries(p.raw)) set(k, v);
    if (!fresh) this.markCopyOverride(s, changed);
    if (s.type === "text" && changed.includes("content")) delete s.positionData;
  }

  /** Moves shapes into another parent (or reorders them); index counts from the top of the layers panel. */
  move(ids: string[], parentId: string | undefined, index?: number) {
    const pid = parentId || ROOT_ID;
    const parent = this.get(pid);
    if (!(parent.type === "frame" || parent.type === "group")) throw new EditError(`"${parent.name}" is a ${parent.type}: shapes can only go inside boards and groups.`);
    if (parent.shapeRef || (parent.componentId && !parent.mainInstance)) throw new EditError(`"${parent.name}" is a component copy: its layers cannot be changed here.`);
    for (const id of ids) {
      if (id === ROOT_ID) throw new EditError("The page root cannot be moved.");
      if (subtree(this.objects, id).includes(pid)) throw new EditError(`"${this.get(id).name}" cannot go inside itself.`);
      const s = this.get(id);
      const old = this.get(s.parentId || ROOT_ID);
      if (s.shapeRef && old.id !== pid) throw new EditError(`"${s.name}" is inside a component copy and cannot leave it.`);
    }
    const list = (parent.shapes || []).filter((c: string) => !ids.includes(c));
    const at = this.insertAt(parent, list, index);
    // ids are given top-first; the list is bottom-up.
    list.splice(at, 0, ...[...ids].reverse());
    for (const id of ids) {
      const s = this.get(id);
      const oldParent = this.get(s.parentId || ROOT_ID);
      if (oldParent.id !== pid) {
        oldParent.shapes = (oldParent.shapes || []).filter((c: string) => c !== id);
        this.touch(oldParent.id);
        this.dirty(oldParent.id);
        this.updateGroups(oldParent.id);
        s.parentId = pid;
        this.fixFrameIds(id);
        if (!hasLayout(parent)) {
          delete s.layoutItemHSizing; delete s.layoutItemVSizing; delete s.layoutItemAbsolute;
        } else if (!s.layoutItemHSizing) {
          s.layoutItemHSizing = s.type === "text" ? "auto" : "fix";
          s.layoutItemVSizing = s.type === "text" ? "auto" : "fix";
        }
      }
      this.touch(id);
      this.dirty(id);
    }
    parent.shapes = list;
    this.touch(pid);
    this.dirty(pid);
    this.updateGroups(pid);
  }

  /**
   * Copies a shape (and its children) with new ids; component links are dropped in the copy.
   * Returns the copy's id and, for each copied shape (the original included), the id of its copy.
   */
  duplicate(id: string, parentId?: string, index?: number, offset?: { x?: number; y?: number }): { id: string; copies: Map<string, string> } {
    if (id === ROOT_ID) throw new EditError("The page root cannot be duplicated.");
    const src = this.get(id);
    const pid = parentId || src.parentId || ROOT_ID;
    const parent = this.get(pid);
    if (!(parent.type === "frame" || parent.type === "group")) throw new EditError(`"${parent.name}" is a ${parent.type}: shapes can only go inside boards and groups.`);
    const map = new Map<string, string>();
    const ids = subtree(this.objects, id);
    for (const i of ids) map.set(i, randomUUID());
    const frameId = this.frameFor(pid);
    for (const i of ids) {
      const c: Shape = structuredClone(this.objects[i]);
      c.id = map.get(i)!;
      if (i === id) {
        c.parentId = pid;
        c.frameId = frameId;
      } else {
        c.parentId = map.get(c.parentId!) || c.parentId;
        c.frameId = map.get(c.frameId!) || c.frameId;
      }
      if (Array.isArray(c.shapes)) c.shapes = c.shapes.map((x: string) => map.get(x) || x);
      for (const k of ["componentId", "componentFile", "componentRoot", "mainInstance", "shapeRef", "touched", "remoteSynced"]) delete c[k];
      if (Array.isArray(c.shadow)) c.shadow = c.shadow.map((sh: any) => ({ ...sh, id: randomUUID() }));
      c.pageId = this.pageId;
      this.objects[c.id] = c;
      this.addedIds.add(c.id);
    }
    const newId = map.get(id)!;
    this.fixFrameIds(newId);
    // Coordinates of the copy are relative to its new board, like the original's were to its own.
    const rel = this.relBox(src);
    const copy = this.objects[newId];
    const o = this.originOf(copy);
    const b = boxOf(copy);
    translateTree(this.objects, newId, o.x + rel.x + (offset?.x ?? 0) - b.x, o.y + rel.y + (offset?.y ?? 0) - b.y);
    const list = [...(parent.shapes || [])];
    // Without an index the copy goes right after the original: next in a flex flow, just above it elsewhere.
    const src0 = list.indexOf(id);
    const at = index === undefined && src0 >= 0 ? (hasLayout(parent) ? src0 : src0 + 1) : this.insertAt(parent, list, index);
    list.splice(at, 0, newId);
    parent.shapes = list;
    if (hasLayout(parent) && !copy.layoutItemHSizing) {
      copy.layoutItemHSizing = "fix";
      copy.layoutItemVSizing = "fix";
    } else if (!hasLayout(parent)) {
      delete copy.layoutItemHSizing; delete copy.layoutItemVSizing; delete copy.layoutItemAbsolute;
    }
    this.touch(pid);
    this.dirty(newId);
    this.updateGroups(pid);
    return { id: newId, copies: map };
  }

  remove(ids: string[]) {
    for (const id of ids) {
      if (id === ROOT_ID) throw new EditError("The page root cannot be deleted.");
      const s = this.objects[id];
      if (!s) continue; // already removed with a parent
      if (s.mainInstance) throw new EditError(`"${s.name}" is the main of a component; delete it in Penpot (it would break the component's copies).`);
      if (s.shapeRef) throw new EditError(`"${s.name}" is inside a component copy: hide it instead (hidden: true).`);
      const parent = this.get(s.parentId || ROOT_ID);
      parent.shapes = (parent.shapes || []).filter((c: string) => c !== id);
      for (const d of subtree(this.objects, id)) {
        delete this.objects[d];
        if (this.addedIds.has(d)) this.addedIds.delete(d);
        else this.removedIds.add(d);
        this.touchedIds.delete(d);
      }
      this.touch(parent.id);
      this.dirty(parent.id);
      this.updateGroups(parent.id);
    }
  }

  /** Groups and bools take the box of their children. */
  private updateGroups(id: string) {
    let cur: Shape | undefined = this.objects[id];
    while (cur && cur.id !== ROOT_ID) {
      if (cur.type === "group" || cur.type === "bool") {
        const kids = (cur.shapes || []).map((c: string) => this.objects[c]).filter(Boolean) as Shape[];
        const u = unionBox(kids);
        if (u && !isRotated(cur)) {
          const b = boxOf(cur);
          if (Math.abs(b.x - u.x) > 0.001 || Math.abs(b.y - u.y) > 0.001 || Math.abs(b.width - u.width) > 0.001 || Math.abs(b.height - u.height) > 0.001) {
            setBox(cur, u);
            this.touch(cur.id);
          }
        }
      }
      cur = cur.parentId ? this.objects[cur.parentId] : undefined;
    }
  }

  /** Lays out what changed and returns the difference with the original page. */
  finish(): PageDiff {
    // Texts that changed and are not inside a layout: resize them in place.
    const engine = new FlexEngine(this.objects, {
      touched: (id) => this.touch(id),
      textSize: (s) => (this.textDirty.has(s.id) ? measureText(s.content, s.growType, boxOf(s)) : undefined),
      warn: (m) => { if (!this.warnings.includes(m)) this.warnings.push(m); },
    });
    const roots = new Set<string>();
    for (const id of this.layoutDirty) {
      let s = this.objects[id];
      if (!s) continue;
      let root = s.id;
      let cur: Shape | undefined = s;
      while (cur) {
        const parent: Shape | undefined = cur.parentId && cur.parentId !== cur.id ? this.objects[cur.parentId] : undefined;
        if (parent && parent.id !== ROOT_ID && hasLayout(parent)) {
          root = parent.id;
          cur = parent;
        } else break;
      }
      roots.add(root);
    }
    for (const id of this.textDirty) {
      const s = this.objects[id];
      if (!s) continue;
      const parent = s.parentId ? this.objects[s.parentId] : undefined;
      if (!hasLayout(parent)) {
        const size = measureText(s.content, s.growType, boxOf(s));
        const b = boxOf(s);
        if (Math.abs(size.width - b.width) > 0.001 || Math.abs(size.height - b.height) > 0.001) {
          setBox(s, { x: b.x, y: b.y, width: size.width, height: size.height });
          this.touch(id);
        }
      }
    }
    // Outermost roots only.
    const sorted = [...roots].filter((r) => ![...roots].some((o) => o !== r && subtree(this.objects, o).includes(r)));
    for (const r of sorted) engine.run(r);
    for (const id of this.touchedIds) if (this.objects[id]) this.updateGroups(id);

    const added = this.ordered([...this.addedIds].filter((id) => this.objects[id]));
    const changed: PageDiff["changed"] = [];
    for (const id of this.touchedIds) {
      if (this.addedIds.has(id) || !this.objects[id] || !this.original[id]) continue;
      const after = this.objects[id];
      if (after.type === "text") {
        const before = this.original[id];
        const b1 = boxOf(before), b2 = boxOf(after);
        if (Math.abs(b1.width - b2.width) > 0.001 || Math.abs(b1.height - b2.height) > 0.001) delete after.positionData;
      }
      if (JSON.stringify(this.original[id]) !== JSON.stringify(after)) changed.push({ before: this.original[id], after });
    }
    return { pageId: this.pageId, added: added.map((id) => this.objects[id]), changed, removed: [...this.removedIds] };
  }

  /** Parents before children. */
  private ordered(ids: string[]): string[] {
    const set = new Set(ids);
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = this.objects[id]?.parentId;
      if (p && set.has(p)) visit(p);
      out.push(id);
    };
    ids.forEach(visit);
    return out;
  }

  /** Summary for tools: the text of a text shape and its main style. */
  static describeText(s: Shape) {
    if (s.type !== "text" || !s.content) return undefined;
    const st = styleOf(s.content);
    return { text: textOf(s.content), fontFamily: st.fontFamily, fontSize: st.fontSize, fontWeight: st.fontWeight, color: st.color, textAlign: st.textAlign, growType: s.growType };
  }
}
