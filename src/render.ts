// Draws Penpot shapes as SVG (an approximate preview: rectangles, ellipses, paths, texts, images,
// gradients, strokes, shadows and blur). Coordinates from the API are already absolute in the page.
// No VS Code imports here, so it can be unit-tested with plain Node.
import { ROOT_ID, Shape } from "./api";
import { textRows } from "./design/text";

export interface RenderOptions {
  /** Resolves a fill image to a data URI (or undefined when it cannot). */
  loadImage(mediaId: string, mime?: string): Promise<string | undefined>;
}
export interface RenderWarning {
  kind: "image" | "type";
  detail?: string;
}
export interface RenderResult {
  svg: string;
  width: number;
  height: number;
  warnings: RenderWarning[];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: unknown, d = 0) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v !== "" && isFinite(+v) ? +v : d);
const r2 = (v: number) => Math.round(v * 100) / 100;

interface Box { x: number; y: number; w: number; h: number }

class Ctx {
  defs: string[] = [];
  private readonly seen = new Set<string>();
  warnings: RenderWarning[] = [];
  warn(w: RenderWarning) {
    const k = w.kind + "|" + (w.detail || "");
    if (!this.seen.has(k)) { this.seen.add(k); this.warnings.push(w); }
  }
  private n = 0;
  constructor(readonly objects: Record<string, Shape>, readonly opts: RenderOptions) {}
  id(prefix: string) {
    return `${prefix}${++this.n}`;
  }
}

function boxOf(s: Shape): Box | undefined {
  const sr = s.selrect;
  if (sr && isFinite(sr.x) && isFinite(sr.width)) return { x: sr.x, y: sr.y, w: sr.width, h: sr.height };
  if (s.x == null || s.width == null) return undefined;
  return { x: num(s.x), y: num(s.y), w: num(s.width), h: num(s.height) };
}

/** Rectangle path with per-corner radii (r1 top-left, r2 top-right, r3 bottom-right, r4 bottom-left). */
function roundRectPath(b: Box, r: [number, number, number, number]) {
  const max = Math.min(b.w, b.h) / 2;
  const [a, c, d, e] = r.map((v) => Math.max(0, Math.min(v, max)));
  const { x, y, w, h } = b;
  return (
    `M${r2(x + a)},${r2(y)}H${r2(x + w - c)}` + (c ? `A${c},${c} 0 0 1 ${r2(x + w)},${r2(y + c)}` : "") +
    `V${r2(y + h - d)}` + (d ? `A${d},${d} 0 0 1 ${r2(x + w - d)},${r2(y + h)}` : "") +
    `H${r2(x + e)}` + (e ? `A${e},${e} 0 0 1 ${r2(x)},${r2(y + h - e)}` : "") +
    `V${r2(y + a)}` + (a ? `A${a},${a} 0 0 1 ${r2(x + a)},${r2(y)}` : "") + "Z"
  );
}
function radii(s: Shape): [number, number, number, number] {
  if (s.r1 != null || s.r2 != null || s.r3 != null || s.r4 != null) return [num(s.r1), num(s.r2), num(s.r3), num(s.r4)];
  const rx = num(s.rx);
  return [rx, rx, rx, rx];
}

/** Path content: an SVG path string or a list of {command, params}. */
function pathData(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((seg: any) => {
      const p = seg.params || {};
      switch (seg.command) {
        case "move-to": return `M${p.x},${p.y}`;
        case "line-to": return `L${p.x},${p.y}`;
        case "curve-to": return `C${p.c1x},${p.c1y} ${p.c2x},${p.c2y} ${p.x},${p.y}`;
        case "close-path": return "Z";
        default: return "";
      }
    })
    .join("");
}

/** Shape geometry (used to fill, stroke and clip). */
function geometry(s: Shape, b: Box | undefined, inset = 0): string | undefined {
  if (s.type === "path" || s.type === "bool") {
    const d = pathData(s.content);
    return d ? `<path d="${esc(d)}"/>` : undefined;
  }
  if (!b) return undefined;
  const bb = { x: b.x + inset, y: b.y + inset, w: Math.max(0, b.w - 2 * inset), h: Math.max(0, b.h - 2 * inset) };
  if (s.type === "circle") return `<ellipse cx="${r2(bb.x + bb.w / 2)}" cy="${r2(bb.y + bb.h / 2)}" rx="${r2(bb.w / 2)}" ry="${r2(bb.h / 2)}"/>`;
  const r = radii(s).map((v) => Math.max(0, v - inset)) as [number, number, number, number];
  if (r.every((v) => v === 0)) return `<rect x="${r2(bb.x)}" y="${r2(bb.y)}" width="${r2(bb.w)}" height="${r2(bb.h)}"/>`;
  if (r.every((v) => v === r[0])) return `<rect x="${r2(bb.x)}" y="${r2(bb.y)}" width="${r2(bb.w)}" height="${r2(bb.h)}" rx="${r2(r[0])}"/>`;
  return `<path d="${roundRectPath(bb, r)}"/>`;
}
/** Adds attributes to the first tag of a geometry. */
const withAttrs = (geo: string, attrs: string) => geo.replace(/^<(\w+)/, `<$1 ${attrs}`);

function gradientDef(ctx: Ctx, g: any, opacity: number): string {
  const id = ctx.id("g");
  const stops = (g.stops || [])
    .map((st: any) => `<stop offset="${num(st.offset)}" stop-color="${esc(st.color || "#000")}" stop-opacity="${num(st.opacity, 1) * opacity}"/>`)
    .join("");
  if (g.type === "radial") {
    const cx = num(g.startX, 0.5), cy = num(g.startY, 0.5);
    const ry = Math.hypot(num(g.endX, cx) - cx, num(g.endY, cy) - cy) || 0.5;
    const rx = ry * num(g.width, 1);
    ctx.defs.push(
      `<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="${cx}" cy="${cy}" r="${ry}" gradientTransform="translate(${cx} ${cy}) scale(${rx / ry} 1) translate(${-cx} ${-cy})">${stops}</radialGradient>`,
    );
  } else {
    ctx.defs.push(
      `<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${num(g.startX)}" y1="${num(g.startY)}" x2="${num(g.endX, 1)}" y2="${num(g.endY, 1)}">${stops}</linearGradient>`,
    );
  }
  return `url(#${id})`;
}

async function fillLayers(ctx: Ctx, s: Shape, b: Box | undefined, geo: string): Promise<string> {
  const fills: any[] = Array.isArray(s.fills) ? s.fills : [];
  let out = "";
  // In Penpot fills[0] is the top one: draw from last to first.
  for (const f of [...fills].reverse()) {
    if (f.hidden) continue;
    const op = num(f.fillOpacity, 1);
    if (f.fillImage && b) {
      const img = f.fillImage;
      const href = await ctx.opts.loadImage(img.id, img.mtype);
      if (!href) { ctx.warn({ kind: "image" }); continue; }
      const clip = ctx.id("c");
      ctx.defs.push(`<clipPath id="${clip}">${geo}</clipPath>`);
      const ar = img.keepAspectRatio === false ? "none" : "xMidYMid slice";
      out += `<image href="${href}" x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}" preserveAspectRatio="${ar}" clip-path="url(#${clip})" opacity="${op}"/>`;
    } else if (f.fillColorGradient) {
      out += withAttrs(geo, `fill="${gradientDef(ctx, f.fillColorGradient, op)}"`);
    } else if (f.fillColor) {
      out += withAttrs(geo, `fill="${esc(f.fillColor)}" fill-opacity="${op}"`);
    }
  }
  return out;
}

function strokeLayers(ctx: Ctx, s: Shape, b: Box | undefined): string {
  const strokes: any[] = Array.isArray(s.strokes) ? s.strokes : [];
  let out = "";
  for (const st of [...strokes].reverse()) {
    if (st.hidden) continue;
    const w = num(st.strokeWidth, 1);
    if (!w) continue;
    const al = st.strokeAlignment || "center";
    const inset = s.type === "path" || s.type === "bool" ? 0 : al === "inner" ? w / 2 : al === "outer" ? -w / 2 : 0;
    const geo = geometry(s, b, inset);
    if (!geo) continue;
    const color = st.strokeColorGradient ? gradientDef(ctx, st.strokeColorGradient, num(st.strokeOpacity, 1)) : esc(st.strokeColor || "#000");
    const dash = st.strokeStyle === "dashed" ? ` stroke-dasharray="${w * 4} ${w * 2}"` : st.strokeStyle === "dotted" ? ` stroke-dasharray="0 ${w * 2}" stroke-linecap="round"` : "";
    const cap = st.strokeCapStart === "round" || st.strokeCapEnd === "round" ? ` stroke-linecap="round" stroke-linejoin="round"` : "";
    out += withAttrs(geo, `fill="none" stroke="${color}" stroke-opacity="${num(st.strokeOpacity, 1)}" stroke-width="${w}"${dash}${cap}`);
  }
  return out;
}

/** Filter with the shape shadows (drop and inner) and blur. */
function effectFilter(ctx: Ctx, s: Shape): string | undefined {
  const shadows: any[] = (Array.isArray(s.shadow) ? s.shadow : Array.isArray(s.shadows) ? s.shadows : []).filter((x) => !x.hidden);
  const blur = s.blur && !s.blur.hidden ? num(s.blur.value) : 0;
  if (!shadows.length && !blur) return undefined;
  const id = ctx.id("f");
  let body = "";
  const outer: string[] = [];
  const inner: string[] = [];
  shadows.forEach((sh, i) => {
    const color = esc(sh.color?.color || "#000");
    const op = num(sh.color?.opacity, 0.25);
    const dx = num(sh.offsetX), dy = num(sh.offsetY), sd = num(sh.blur) / 2, spread = num(sh.spread);
    if (sh.style === "inner-shadow") {
      body +=
        `<feFlood flood-color="${color}" flood-opacity="${op}" result="if${i}"/>` +
        `<feComposite in="if${i}" in2="SourceAlpha" operator="out" result="ii${i}"/>` +
        `<feOffset in="ii${i}" dx="${dx}" dy="${dy}" result="io${i}"/>` +
        (sd ? `<feGaussianBlur in="io${i}" stdDeviation="${sd}" result="io${i}"/>` : "") +
        `<feComposite in="io${i}" in2="SourceAlpha" operator="in" result="is${i}"/>`;
      inner.push(`is${i}`);
    } else {
      body +=
        (spread ? `<feMorphology in="SourceAlpha" operator="${spread > 0 ? "dilate" : "erode"}" radius="${Math.abs(spread)}" result="om${i}"/>` : "") +
        `<feOffset in="${spread ? `om${i}` : "SourceAlpha"}" dx="${dx}" dy="${dy}" result="oo${i}"/>` +
        `<feGaussianBlur in="oo${i}" stdDeviation="${sd}" result="ob${i}"/>` +
        `<feFlood flood-color="${color}" flood-opacity="${op}"/>` +
        `<feComposite in2="ob${i}" operator="in" result="os${i}"/>`;
      outer.push(`os${i}`);
    }
  });
  if (blur) body += `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur / 2}" result="sg"/>`;
  const merge = [...outer, blur ? "sg" : "SourceGraphic", ...inner].map((r) => `<feMergeNode in="${r}"/>`).join("");
  ctx.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${body}<feMerge>${merge}</feMerge></filter>`);
  return `url(#${id})`;
}

function transformAttr(s: Shape, b: Box | undefined): string {
  const t = s.transform;
  if (!t || !b) return "";
  const { a = 1, b: bb = 0, c = 0, d = 1 } = t;
  if (a === 1 && bb === 0 && c === 0 && d === 1) return "";
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return ` transform="translate(${r2(cx)} ${r2(cy)}) matrix(${a} ${bb} ${c} ${d} 0 0) translate(${r2(-cx)} ${r2(-cy)})"`;
}

function fontStack(family: string | undefined) {
  const f = (family || "Inter").replace(/["']/g, "");
  // Penpot's default font is its own Source Sans Pro ("sourcesanspro"); Source Sans 3 is its successor.
  const alias = /^source ?sans/i.test(f) ? ", 'Source Sans 3'" : "";
  return `'${f}'${alias}, Inter, system-ui, sans-serif`;
}

/** Text: uses positionData (lines already laid out by the editor); falls back to the raw content. */
function renderText(s: Shape, b: Box | undefined): string {
  const pd: any[] = Array.isArray(s.positionData) ? s.positionData : [];
  let out = "";
  if (pd.length) {
    for (const p of pd) {
      const text = String(p.text ?? "");
      if (!text.trim()) continue;
      const fs = parseFloat(String(p.fontSize)) || 14;
      const h = num(p.height, fs * 1.2);
      // positionData y is the bottom of the line box; the baseline sits ~0.24em below its middle.
      const baseline = num(p.y) - h + (h - fs * 1.21) / 2 + fs * 0.97;
      const fill = (p.fills || [])[0] || {};
      const ls = parseFloat(String(p.letterSpacing)) || 0;
      const deco = p.textDecoration && p.textDecoration !== "none" ? ` text-decoration="${esc(p.textDecoration)}"` : "";
      const tt = p.textTransform === "uppercase" ? text.toUpperCase() : p.textTransform === "lowercase" ? text.toLowerCase() : text;
      out +=
        `<text x="${r2(num(p.x))}" y="${r2(baseline)}" font-family="${esc(fontStack(p.fontFamily))}" font-size="${fs}" ` +
        `font-weight="${esc(String(p.fontWeight || 400))}" font-style="${esc(p.fontStyle || "normal")}"` +
        (ls ? ` letter-spacing="${ls}"` : "") + deco +
        ` fill="${esc(fill.fillColor || "#000")}" fill-opacity="${num(fill.fillOpacity, 1)}" xml:space="preserve">${esc(tt)}</text>`;
    }
    return out;
  }
  if (!b) return "";
  // No positions (texts edited outside Penpot): wrap and align the paragraphs like the editor estimates them.
  const content = typeof s.content === "string" ? safeJson(s.content) : s.content;
  const rows = textRows(content, s.growType, b.w);
  const total = rows.reduce((h, r) => h + r.style.fontSize * r.style.lineHeight, 0);
  const va = content?.verticalAlign;
  let y = b.y + (va === "center" ? (b.h - total) / 2 : va === "bottom" ? b.h - total : 0);
  for (const { text, style: st } of rows) {
    const fs = st.fontSize;
    const lh = st.lineHeight * fs;
    const anchor = st.textAlign === "center" ? "middle" : st.textAlign === "right" ? "end" : "start";
    const x = anchor === "middle" ? b.x + b.w / 2 : anchor === "end" ? b.x + b.w : b.x;
    const tt = st.textTransform === "uppercase" ? text.toUpperCase() : st.textTransform === "lowercase" ? text.toLowerCase() : text;
    if (tt.trim()) {
      out +=
        `<text x="${r2(x)}" y="${r2(y + lh / 2 + fs * 0.35)}" text-anchor="${anchor}" font-family="${esc(fontStack(st.fontFamily))}" font-size="${fs}" ` +
        `font-weight="${esc(String(st.fontWeight))}" font-style="${esc(st.fontStyle)}"` +
        (st.letterSpacing ? ` letter-spacing="${st.letterSpacing}"` : "") +
        (st.textDecoration !== "none" ? ` text-decoration="${esc(st.textDecoration)}"` : "") +
        ` fill="${esc(st.color)}" fill-opacity="${st.opacity}" xml:space="preserve">${esc(tt)}</text>`;
    }
    y += lh;
  }
  return out;
}
function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * Order in which a shape's children are painted (first = bottom). Plain shapes keep the `shapes`
 * order. Inside a flex or grid layout Penpot paints absolute-positioned children above the flow
 * children, then sorts by layout z-index, then by list order (like its sort-layout-children-z-index).
 */
function paintOrder(objects: Record<string, Shape>, s: Shape): string[] {
  const ids = s.shapes || [];
  if (!s.layout) return ids;
  const key = (id: string) => {
    const c = objects[id];
    return [c?.layoutItemAbsolute === true ? 1 : 0, num(c?.layoutItemZIndex)];
  };
  return ids
    .map((id, i) => ({ id, i, k: key(id) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i)
    .map((e) => e.id);
}

async function renderShape(ctx: Ctx, s: Shape | undefined, depth: number): Promise<string> {
  if (!s || s.hidden || depth > 200) return "";
  const b = boxOf(s);
  const filter = effectFilter(ctx, s);
  const opacity = s.opacity != null && num(s.opacity, 1) < 1 ? ` opacity="${num(s.opacity, 1)}"` : "";
  const tf = transformAttr(s, b);
  const kids = async () => {
    let o = "";
    for (const id of paintOrder(ctx.objects, s)) o += await renderShape(ctx, ctx.objects[id], depth + 1);
    return o;
  };

  switch (s.type) {
    case "frame": {
      const geo = geometry(s, b) || "";
      let bg = geo ? (await fillLayers(ctx, s, b, geo)) + strokeLayers(ctx, s, b) : "";
      if (filter && bg) bg = `<g filter="${filter}">${bg}</g>`;
      let content = await kids();
      // showContent = true lets content overflow; otherwise clip to the board box.
      if (s.showContent !== true && geo && s.id !== ROOT_ID) {
        const clip = ctx.id("c");
        ctx.defs.push(`<clipPath id="${clip}">${geo}</clipPath>`);
        content = `<g clip-path="url(#${clip})">${content}</g>`;
      }
      return `<g${opacity}${tf}>${bg}${content}</g>`;
    }
    case "group":
      return `<g${opacity}${tf}${filter ? ` filter="${filter}"` : ""}>${await kids()}</g>`;
    case "text":
      return `<g${opacity}${tf}${filter ? ` filter="${filter}"` : ""}>${renderText(s, b)}</g>`;
    case "image": {
      const m = s.metadata;
      if (!m || !b) return "";
      const href = await ctx.opts.loadImage(m.id, m.mtype);
      if (!href) { ctx.warn({ kind: "image" }); return ""; }
      return `<g${opacity}${tf}><image href="${href}" x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}" preserveAspectRatio="none"/></g>`;
    }
    case "rect":
    case "circle":
    case "path":
    case "bool": {
      const geo = geometry(s, b);
      if (!geo) return "";
      const body = (await fillLayers(ctx, s, b, geo)) + strokeLayers(ctx, s, b);
      return `<g${opacity}${tf}${filter ? ` filter="${filter}"` : ""}>${body}</g>`;
    }
    case "svg-raw":
      return `<g${opacity}${tf}>${svgRaw(s.content)}${await kids()}</g>`;
    default:
      ctx.warn({ kind: "type", detail: s.type });
      return await kids();
  }
}

/** SVG attributes that are camelCase in SVG itself (everything else is converted to kebab-case). */
const SVG_CAMEL = new Set([
  "viewBox", "preserveAspectRatio", "gradientUnits", "gradientTransform", "patternUnits", "patternTransform",
  "patternContentUnits", "clipPathUnits", "maskUnits", "maskContentUnits", "markerWidth", "markerHeight",
  "markerUnits", "refX", "refY", "stdDeviation", "spreadMethod", "textLength", "lengthAdjust", "pathLength",
  "filterUnits", "primitiveUnits", "baseFrequency", "numOctaves", "stitchTiles", "tableValues", "kernelMatrix",
]);

/** svg-raw: a {tag, attrs, content} tree from an imported SVG (scripts, handlers and external links are dropped). */
function svgRaw(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return esc(node);
  if (Array.isArray(node)) return node.map(svgRaw).join("");
  if (!node.tag) return "";
  const tag = String(node.tag).replace(/[^\w:-]/g, "");
  if (tag === "script" || tag === "foreignObject") return "";
  const attrs = Object.entries(node.attrs || {})
    .filter(([k]) => !/^on/i.test(k))
    .filter(([k, v]) => !/^(href|xlinkHref|xlink:href)$/i.test(k) || /^(#|data:image\/)/.test(String(v)))
    .map(([k, v]) => ` ${SVG_CAMEL.has(k) ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}="${esc(String(v))}"`)
    .join("");
  return `<${tag}${attrs}>${svgRaw(node.content)}</${tag}>`;
}

/** Box around the visible children (for a whole-page preview). */
function childrenBounds(objects: Record<string, Shape>, ids: string[]): Box | undefined {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const id of ids) {
    const s = objects[id];
    if (!s || s.hidden) continue;
    const b = boxOf(s);
    if (!b) continue;
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : undefined;
}

/** Renders one object (a board) or the whole page (rootId = ROOT_ID). */
export async function renderSvg(objects: Record<string, Shape>, rootId: string, opts: RenderOptions): Promise<RenderResult> {
  const ctx = new Ctx(objects, opts);
  const root = objects[rootId];
  if (!root) throw new Error("Object not found in the page");
  let box: Box | undefined;
  let body: string;
  if (rootId === ROOT_ID) {
    box = childrenBounds(objects, root.shapes || []);
    const pad = 40;
    if (box) box = { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
    body = "";
    for (const id of root.shapes || []) body += await renderShape(ctx, objects[id], 0);
  } else {
    box = boxOf(root);
    body = await renderShape(ctx, root, 0);
  }
  if (!box || box.w <= 0 || box.h <= 0) box = { x: 0, y: 0, w: 100, h: 100 };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(box.x)} ${r2(box.y)} ${r2(box.w)} ${r2(box.h)}" width="${r2(box.w)}" height="${r2(box.h)}">` +
    `<defs>${ctx.defs.join("")}</defs>${body}</svg>`;
  return { svg, width: box.w, height: box.h, warnings: ctx.warnings };
}

/** Font files the extension ships (media/fonts), by the family names Penpot files use. */
const EMBEDDED_FONTS = [
  { families: ["Inter"], file: "inter" },
  { families: ["sourcesanspro", "Source Sans Pro", "Source Sans 3"], file: "source-sans-3" },
];

/**
 * Adds the shipped fonts the SVG uses as data URIs: an SVG drawn as an image cannot reach fonts that
 * are not installed, so otherwise texts fall back to the system font and come out with other widths.
 */
export function embedFonts(svg: string, read: (file: string) => Uint8Array | undefined): string {
  const italic = /font-style="italic"/.test(svg);
  let css = "";
  for (const f of EMBEDDED_FONTS) {
    const used = f.families.filter((name) => svg.includes(`'${name}'`));
    if (!used.length) continue;
    for (const [suffix, style] of italic ? [["", "normal"], ["-italic", "italic"]] : [["", "normal"]]) {
      const data = read(`${f.file}${suffix}.woff2`);
      if (!data) continue;
      const src = `url(data:font/woff2;base64,${Buffer.from(data).toString("base64")}) format('woff2')`;
      for (const name of used) css += `@font-face{font-family:'${name}';src:${src};font-weight:100 900;font-style:${style}}`;
    }
  }
  return css ? svg.replace(/<svg\b[^>]*>/, (open) => `${open}<style>${css}</style>`) : svg;
}
