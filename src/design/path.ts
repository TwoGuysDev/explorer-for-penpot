// SVG path data and simple SVG documents turned into what Penpot stores for path shapes: absolute
// coordinates with only M, L, C and Z (other commands and arcs become lines and cubic curves).
// No VS Code imports here, so it can be unit-tested with plain Node.
import { Rect } from "./geometry";

export interface Seg { c: "M" | "L" | "C" | "Z"; p: number[] }
/** Affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY_M: Matrix = [1, 0, 0, 1, 0, 0];

export class PathError extends Error {}

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Reads SVG path data into absolute M/L/C/Z segments. */
export function parsePath(d: string): Seg[] {
  let i = 0;
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const number = (): number => {
    skip();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
    if (!m) throw new PathError(`Invalid path data near "${d.slice(i, i + 12)}".`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const flag = (): number => {
    skip();
    const ch = d[i++];
    if (ch !== "0" && ch !== "1") throw new PathError("Invalid arc flag in path data.");
    return ch === "1" ? 1 : 0;
  };
  const more = () => { skip(); return i < d.length && /[-+.\d]/.test(d[i]); };

  const out: Seg[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastC: [number, number] | undefined; // second control point of the previous cubic
  let lastQ: [number, number] | undefined; // control point of the previous quadratic
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    out.push({ c: "C", p: [x1, y1, x2, y2, ex, ey] });
    lastC = [x2, y2];
    x = ex; y = ey;
  };
  const quad = (qx: number, qy: number, ex: number, ey: number) => {
    cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
    lastQ = [qx, qy];
  };

  skip();
  while (i < d.length) {
    const cmd = d[i];
    if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(cmd)) throw new PathError(`Invalid path command "${cmd}".`);
    i++;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    let first = true;
    do {
      const ox = rel ? x : 0, oy = rel ? y : 0;
      const prevC = lastC, prevQ = lastQ;
      lastC = undefined;
      lastQ = undefined;
      switch (C) {
        case "M": {
          const nx = number() + ox, ny = number() + oy;
          if (first) { out.push({ c: "M", p: [nx, ny] }); sx = nx; sy = ny; }
          else out.push({ c: "L", p: [nx, ny] });
          x = nx; y = ny;
          break;
        }
        case "L": { x = number() + ox; y = number() + oy; out.push({ c: "L", p: [x, y] }); break; }
        case "H": { x = number() + ox; out.push({ c: "L", p: [x, y] }); break; }
        case "V": { y = number() + oy; out.push({ c: "L", p: [x, y] }); break; }
        case "C": {
          const a = [number() + ox, number() + oy, number() + ox, number() + oy, number() + ox, number() + oy];
          cubic(a[0], a[1], a[2], a[3], a[4], a[5]);
          break;
        }
        case "S": {
          const [x1, y1] = prevC ? [2 * x - prevC[0], 2 * y - prevC[1]] : [x, y];
          const a = [number() + ox, number() + oy, number() + ox, number() + oy];
          cubic(x1, y1, a[0], a[1], a[2], a[3]);
          break;
        }
        case "Q": { const a = [number() + ox, number() + oy, number() + ox, number() + oy]; quad(a[0], a[1], a[2], a[3]); break; }
        case "T": {
          const [qx, qy] = prevQ ? [2 * x - prevQ[0], 2 * y - prevQ[1]] : [x, y];
          quad(qx, qy, number() + ox, number() + oy);
          break;
        }
        case "A": {
          const rx = number(), ry = number(), rot = number(), large = flag(), sweep = flag();
          const ex = number() + ox, ey = number() + oy;
          for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey)) cubic(c[0], c[1], c[2], c[3], c[4], c[5]);
          x = ex; y = ey;
          break;
        }
        case "Z": {
          out.push({ c: "Z", p: [] });
          x = sx; y = sy;
          break;
        }
      }
      first = false;
    } while (C !== "Z" && more());
    skip();
  }
  if (out.length && out[0].c !== "M") throw new PathError("Path data must start with M.");
  return out;
}

/** Endpoint-parameterized arc → cubic curves (SVG spec, appendix F.6). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, angle: number, large: number, sweep: number, x2: number, y2: number): number[][] {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (angle * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cxp = (k * rx * yp) / ry, cyp = (-k * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const pt = (t: number) => {
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    return [cx + cos * ex - sin * ey, cy + sin * ex + cos * ey];
  };
  const deriv = (t: number) => {
    const ex = -rx * Math.sin(t), ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  const out: number[][] = [];
  for (let j = 0; j < n; j++) {
    const a = t1 + j * step, b = a + step;
    const p0 = pt(a), p3 = pt(b), d0 = deriv(a), d3 = deriv(b);
    out.push([p0[0] + alpha * d0[0], p0[1] + alpha * d0[1], p3[0] - alpha * d3[0], p3[1] - alpha * d3[1], p3[0], p3[1]]);
  }
  out[out.length - 1][4] = x2;
  out[out.length - 1][5] = y2;
  return out;
}

export function transformSegs(segs: Seg[], m: Matrix): Seg[] {
  return segs.map((s) => {
    const p: number[] = [];
    for (let k = 0; k < s.p.length; k += 2) p.push(m[0] * s.p[k] + m[2] * s.p[k + 1] + m[4], m[1] * s.p[k] + m[3] * s.p[k + 1] + m[5]);
    return { c: s.c, p };
  });
}

/** Exact bounds of the segments (curve extremes included). */
export function segsBounds(segs: Seg[]): Rect | undefined {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (x: number, y: number) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
  let cx = 0, cy = 0;
  for (const s of segs) {
    if (s.c === "M" || s.c === "L") { add(s.p[0], s.p[1]); cx = s.p[0]; cy = s.p[1]; }
    else if (s.c === "C") {
      const [ax, ay, bx, by, ex, ey] = s.p;
      add(ex, ey);
      for (const t of [...extremes(cx, ax, bx, ex), ...extremes(cy, ay, by, ey)]) {
        const u = 1 - t;
        add(u * u * u * cx + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * ex, u * u * u * cy + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * ey);
      }
      cx = ex; cy = ey;
    }
  }
  return isFinite(x1) ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : undefined;
}

/** Parameters in (0, 1) where a cubic's coordinate has a local extreme. */
function extremes(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) ts.push(-c / b); }
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) { const r = Math.sqrt(disc); ts.push((-b + r) / (2 * a), (-b - r) / (2 * a)); }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

const f = (n: number) => String(Math.round(n * 1000) / 1000);

export function formatSegs(segs: Seg[]): string {
  return segs.map((s) => s.c + (s.c === "C" ? `${f(s.p[0])},${f(s.p[1])} ${f(s.p[2])},${f(s.p[3])} ${f(s.p[4])},${f(s.p[5])}` : s.p.length ? `${f(s.p[0])},${f(s.p[1])}` : "")).join("");
}

/** Matrix that maps the rectangle `from` onto `to`. */
export function fitMatrix(from: Rect, to: Rect): Matrix {
  const sx = from.width ? to.width / from.width : 1, sy = from.height ? to.height / from.height : 1;
  return [sx, 0, 0, sy, to.x - from.x * sx, to.y - from.y * sy];
}

// ---------- SVG documents ----------

export interface SvgElementPath {
  segs: Seg[];
  fill?: string; // #rrggbb, or undefined for none
  fillOpacity: number;
  fillRule?: "evenodd";
  stroke?: string;
  strokeOpacity: number;
  strokeWidth: number;
  linecap?: string;
  linejoin?: string;
  opacity: number;
  name: string;
}

export interface SvgDoc { viewBox: Rect; paths: SvgElementPath[]; warnings: string[] }

interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[] }

/** Tiny XML reader, enough for icon SVGs (no DTDs, entities other than the basic ones, or CDATA styles). */
function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      const are = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = are.exec(m[3] || ""))) attrs[a[1]] = (a[2] ?? a[3]).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      const node: XmlNode = { tag: m[2].replace(/^svg:/, ""), attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!m[4]) stack.push(node);
    }
  }
  return root;
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  gray: "#808080", grey: "#808080", orange: "#ffa500", purple: "#800080", transparent: "none",
};

/** "#abc", "#aabbcc", rgb(), a few names, currentColor → "#rrggbb"; "none" → undefined. */
function color(v: string | undefined, current: string, warn: (m: string) => void): string | undefined | null {
  if (v === undefined) return null; // not set here
  const s = v.trim().toLowerCase();
  if (s === "none" || s === "transparent") return undefined;
  if (s === "currentcolor") return current;
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + [...s.slice(1)].map((c) => c + c).join("");
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
  if (rgb) return "#" + rgb.slice(1, 4).map((n) => Math.min(255, +n).toString(16).padStart(2, "0")).join("");
  if (NAMED[s]) return NAMED[s] === "none" ? undefined : NAMED[s];
  warn(`color "${v}" is not supported; black was used`);
  return "#000000";
}

function parseTransform(t: string | undefined): Matrix {
  let m: Matrix = [...IDENTITY_M];
  if (!t) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(t))) {
    const v = (a[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
    let n: Matrix = [...IDENTITY_M];
    switch (a[1]) {
      case "matrix": if (v.length === 6) n = v as Matrix; break;
      case "translate": n = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case "scale": n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case "rotate": {
        const r = ((v[0] || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        n = [c, s, -s, c, 0, 0];
        if (v.length === 3) n = multiply(multiply([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
        break;
      }
      case "skewX": n = [1, 0, Math.tan(((v[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": n = [1, Math.tan(((v[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = multiply(m, n);
  }
  return m;
}

const nums = (s: string | undefined) => (s?.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
const len = (s: string | undefined, d = 0) => { const n = parseFloat(s ?? ""); return isFinite(n) ? n : d; };

/** Path data for the basic shapes. */
function elementPath(n: XmlNode): string | undefined {
  const a = n.attrs;
  switch (n.tag) {
    case "path": return a.d;
    case "rect": {
      const x = len(a.x), y = len(a.y), w = len(a.width), h = len(a.height);
      if (w <= 0 || h <= 0) return undefined;
      let rx = a.rx !== undefined ? len(a.rx) : a.ry !== undefined ? len(a.ry) : 0;
      let ry = a.ry !== undefined ? len(a.ry) : rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
    }
    case "circle":
    case "ellipse": {
      const cx = len(a.cx), cy = len(a.cy);
      const rx = n.tag === "circle" ? len(a.r) : len(a.rx), ry = n.tag === "circle" ? len(a.r) : len(a.ry);
      if (rx <= 0 || ry <= 0) return undefined;
      return `M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`;
    }
    case "line": return `M${len(a.x1)},${len(a.y1)}L${len(a.x2)},${len(a.y2)}`;
    case "polyline":
    case "polygon": {
      const p = nums(a.points);
      if (p.length < 4) return undefined;
      let d = `M${p[0]},${p[1]}`;
      for (let k = 2; k + 1 < p.length; k += 2) d += `L${p[k]},${p[k + 1]}`;
      return n.tag === "polygon" ? d + "Z" : d;
    }
  }
  return undefined;
}

const PRESENTATION = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "fill-opacity", "stroke-opacity", "opacity", "display", "visibility"];

/** Reads an SVG document (paths, basic shapes, groups and transforms) in its own coordinates. */
export function parseSvg(src: string, currentColor = "#000000"): SvgDoc {
  const root = parseXml(src).children.find((c) => c.tag === "svg");
  if (!root) throw new PathError("No <svg> element found.");
  const warnings = new Set<string>();
  const warn = (m: string) => warnings.add(m);
  const vb = nums(root.attrs.viewBox);
  const viewBox: Rect = vb.length === 4 ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] } : { x: 0, y: 0, width: len(root.attrs.width, 0), height: len(root.attrs.height, 0) };
  const paths: SvgElementPath[] = [];
  interface Style { [k: string]: string }
  const styleOf = (n: XmlNode, inherited: Style): Style => {
    const st: Style = { ...inherited };
    delete st.opacity; // opacity is not inherited: it multiplies (handled below)
    for (const k of PRESENTATION) if (n.attrs[k] !== undefined) st[k] = n.attrs[k];
    for (const decl of (n.attrs.style || "").split(";")) {
      const [k, ...v] = decl.split(":");
      if (k && v.length && PRESENTATION.includes(k.trim())) st[k.trim()] = v.join(":").trim();
    }
    return st;
  };
  const walk = (n: XmlNode, inherited: Style, m: Matrix, opacity: number) => {
    if (["defs", "clipPath", "mask", "symbol", "title", "desc", "metadata", "style", "linearGradient", "radialGradient", "pattern", "filter", "marker"].includes(n.tag)) return;
    if (n.tag === "use" || n.tag === "image" || n.tag === "text") { warn(`<${n.tag}> is not supported and was skipped`); return; }
    if (n.attrs["clip-path"] || n.attrs.mask || n.attrs.filter) warn("clip paths, masks and filters were ignored");
    const st = styleOf(n, inherited);
    if (st.display === "none" || st.visibility === "hidden") return;
    const mm = multiply(m, parseTransform(n.attrs.transform));
    const op = opacity * (n.attrs.opacity !== undefined || /(^|;)\s*opacity\s*:/.test(n.attrs.style || "") ? len(st.opacity, 1) : 1);
    if (n.tag === "svg" || n.tag === "g" || n.tag === "a" || n.tag === "switch") {
      for (const c of n.children) walk(c, st, mm, op);
      return;
    }
    const d = elementPath(n);
    if (d === undefined) {
      if (!["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"].includes(n.tag)) warn(`<${n.tag}> is not supported and was skipped`);
      return;
    }
    const segs = transformSegs(parsePath(d), mm);
    if (!segs.length) return;
    const fillV = st.fill ?? "#000000";
    if (/url\(/.test(fillV) || /url\(/.test(st.stroke || "")) warn("gradients and patterns are not supported; black was used");
    const fill = /url\(/.test(fillV) ? "#000000" : color(fillV, currentColor, warn) ?? undefined;
    const strokeV = st.stroke;
    const stroke = strokeV === undefined ? undefined : /url\(/.test(strokeV) ? "#000000" : color(strokeV, currentColor, warn) ?? undefined;
    const scale = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])) || 1;
    paths.push({
      segs,
      fill: ["line", "polyline"].includes(n.tag) && st.fill === undefined ? undefined : fill,
      fillOpacity: len(st["fill-opacity"], 1),
      fillRule: st["fill-rule"] === "evenodd" ? "evenodd" : undefined,
      stroke,
      strokeOpacity: len(st["stroke-opacity"], 1),
      strokeWidth: len(st["stroke-width"], 1) * scale,
      linecap: st["stroke-linecap"],
      linejoin: st["stroke-linejoin"],
      opacity: op,
      name: n.attrs.id || n.tag,
    });
  };
  for (const c of root.children) walk(c, styleOf(root, {}), [...IDENTITY_M], 1);
  if (!viewBox.width || !viewBox.height) {
    const b = segsBounds(paths.flatMap((p) => p.segs));
    if (b) Object.assign(viewBox, b);
  }
  if (!paths.length) throw new PathError("The SVG has nothing that can be drawn as paths.");
  return { viewBox, paths, warnings: [...warnings] };
}

/** Path content (string or {command, params} list) stretched from one box to another. */
export function refitContent(content: unknown, from: Rect, to: Rect): string | undefined {
  const d = typeof content === "string" ? content : Array.isArray(content) ? legacyToString(content) : undefined;
  if (!d) return undefined;
  return formatSegs(transformSegs(parsePath(d), fitMatrix(from, to)));
}

function legacyToString(list: any[]): string {
  return list
    .map((seg) => {
      const p = seg?.params || {};
      switch (seg?.command) {
        case "move-to": return `M${p.x},${p.y}`;
        case "line-to": return `L${p.x},${p.y}`;
        case "curve-to": return `C${p.c1x},${p.c1y} ${p.c2x},${p.c2y} ${p.x},${p.y}`;
        case "close-path": return "Z";
        default: return "";
      }
    })
    .join("");
}
