// Geometry of Penpot shapes: coordinates are absolute in the page; a shape keeps its box in x/y/width/height,
// selrect and points (the four corners), plus a transform that only holds rotation and flips.
// No VS Code imports here, so it can be unit-tested with plain Node.
import { ROOT_ID, Shape } from "../api";

export interface Rect { x: number; y: number; width: number; height: number }

export const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const num = (v: unknown, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);

export function isRotated(s: Shape) {
  const t = s.transform;
  return (!!s.rotation && num(s.rotation) % 360 !== 0) || (!!t && (t.a !== 1 || t.b !== 0 || t.c !== 0 || t.d !== 1));
}

export function boxOf(s: Shape): Rect {
  const sr = s.selrect;
  if (sr && isFinite(sr.x) && isFinite(sr.width)) return { x: sr.x, y: sr.y, width: sr.width, height: sr.height };
  return { x: num(s.x), y: num(s.y), width: num(s.width), height: num(s.height) };
}

export function selrect(r: Rect) {
  return { x: r.x, y: r.y, width: r.width, height: r.height, x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height };
}

export function corners(r: Rect) {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

/** Puts an unrotated shape in this box (it does not touch its children). */
export function setBox(s: Shape, r: Rect) {
  s.x = r.x;
  s.y = r.y;
  s.width = r.width;
  s.height = r.height;
  s.selrect = selrect(r);
  s.points = corners(r);
  if (!s.transform) s.transform = { ...IDENTITY };
  if (!s.transformInverse) s.transformInverse = { ...IDENTITY };
}

/** Moves the numbers of an absolute SVG path ("M10,20L30,40…"). */
export function translatePath(d: string, dx: number, dy: number): string {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
  let out = "";
  let cmd = "";
  let i = 0; // index of the number inside the current command's parameters
  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  for (const t of tokens) {
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t;
      i = 0;
      out += t;
      continue;
    }
    let n = parseFloat(t);
    const C = cmd.toUpperCase();
    const relative = cmd !== C && cmd !== "";
    if (!relative) {
      if (C === "H") n += dx;
      else if (C === "V") n += dy;
      else if (C === "A") {
        const k = i % 7;
        if (k === 5) n += dx;
        else if (k === 6) n += dy;
      } else if ("MLCSQT".includes(C)) n += i % 2 === 0 ? dx : dy;
    }
    // A relative "m" at the very start is absolute.
    if (relative && C === "M" && out.length === 1) n += i % 2 === 0 ? dx : dy;
    out += (out && !/[a-zA-Z]$/.test(out) ? "," : "") + fmt(n);
    i++;
  }
  return out;
}

/** Moves path content in either format: a string or a list of {command, params}. */
export function translateContent(content: unknown, dx: number, dy: number): unknown {
  if (typeof content === "string") return translatePath(content, dx, dy);
  if (!Array.isArray(content)) return content;
  return content.map((seg: any) => {
    const p = seg?.params;
    if (!p) return seg;
    const q: any = { ...p };
    for (const k of Object.keys(q)) {
      if (typeof q[k] !== "number") continue;
      if (/^(x|c1x|c2x)$/.test(k)) q[k] += dx;
      else if (/^(y|c1y|c2y)$/.test(k)) q[k] += dy;
    }
    return { ...seg, params: q };
  });
}

/** Ids of a shape and everything under it (parents before children). */
export function subtree(objects: Record<string, Shape>, id: string): string[] {
  const out: string[] = [];
  const walk = (i: string) => {
    const s = objects[i];
    if (!s) return;
    out.push(i);
    for (const c of s.shapes || []) if (c !== i && c !== ROOT_ID) walk(c);
  };
  walk(id);
  return out;
}

/** Moves a shape and all its children by (dx, dy). */
export function translateTree(objects: Record<string, Shape>, id: string, dx: number, dy: number, touched?: (id: string) => void) {
  if (!dx && !dy) return;
  for (const i of subtree(objects, id)) {
    const s = objects[i];
    const b = boxOf(s);
    if (isRotated(s)) {
      s.x = num(s.x) + dx;
      s.y = num(s.y) + dy;
      s.selrect = selrect({ ...b, x: b.x + dx, y: b.y + dy });
      s.points = (s.points || corners(b)).map((p: any) => ({ x: p.x + dx, y: p.y + dy }));
    } else {
      setBox(s, { ...b, x: b.x + dx, y: b.y + dy });
    }
    if ((s.type === "path" || s.type === "bool") && s.content != null) s.content = translateContent(s.content, dx, dy);
    if (Array.isArray(s.positionData)) s.positionData = s.positionData.map((p: any) => ({ ...p, x: num(p.x) + dx, y: num(p.y) + dy }));
    touched?.(i);
  }
}

/** Box around the corners of these shapes. */
export function unionBox(shapes: Shape[]): Rect | undefined {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of shapes) {
    const pts: { x: number; y: number }[] = Array.isArray(s.points) && s.points.length ? s.points : corners(boxOf(s));
    for (const p of pts) {
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
    }
  }
  return isFinite(x1) ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : undefined;
}
