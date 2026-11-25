// Penpot text content: root → paragraph-set → paragraphs → leaves (runs of text with their style).
// The editor works with plain text plus one style; existing per-run styles are kept when only the
// style or only the text changes where possible.
// No VS Code imports here, so it can be unit-tested with plain Node.

export interface TextStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  fontStyle?: "normal" | "italic";
  color?: string;
  opacity?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right" | "justify";
  textDecoration?: "none" | "underline" | "line-through";
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
}

const DEFAULT: Required<TextStyle> = {
  fontFamily: "sourcesanspro",
  fontSize: 14,
  fontWeight: 400,
  fontStyle: "normal",
  color: "#000000",
  opacity: 1,
  lineHeight: 1.2,
  letterSpacing: 0,
  textAlign: "left",
  textDecoration: "none",
  textTransform: "none",
};

/** Penpot font id: its own Source Sans Pro, otherwise a Google font. */
export function fontId(family: string) {
  const f = family.trim().toLowerCase();
  if (f === "sourcesanspro" || f === "source sans pro") return "sourcesanspro";
  return `gfont-${f.replace(/\s+/g, "-")}`;
}
const familyName = (family: string) => (fontId(family) === "sourcesanspro" ? "sourcesanspro" : family.trim());

function variantId(weight: string, style: string) {
  const italic = style === "italic";
  if (weight === "400") return italic ? "italic" : "regular";
  return italic ? `${weight}italic` : weight;
}

/** Leaf/paragraph attributes in Penpot's format. */
function attrs(st: Required<TextStyle>) {
  const weight = String(st.fontWeight);
  return {
    fontId: fontId(st.fontFamily),
    fontFamily: familyName(st.fontFamily),
    fontVariantId: variantId(weight, st.fontStyle),
    fontSize: String(st.fontSize),
    fontWeight: weight,
    fontStyle: st.fontStyle,
    lineHeight: String(st.lineHeight),
    letterSpacing: String(st.letterSpacing),
    textAlign: st.textAlign,
    textDecoration: st.textDecoration,
    textTransform: st.textTransform,
    textDirection: "ltr",
    typographyRefId: null,
    typographyRefFile: null,
    fills: [{ fillColor: st.color, fillOpacity: st.opacity }],
  };
}

const n = (v: unknown, d: number) => {
  const x = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(x) ? x : d;
};

function paragraphs(content: any): any[] {
  const out: any[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "paragraph") out.push(node);
    else for (const c of node.children || []) walk(c);
  };
  walk(content);
  return out;
}

/** The text of a content tree, one line per paragraph. */
export function textOf(content: any): string {
  return paragraphs(content)
    .map((p) => (p.children || []).map((l: any) => (typeof l.text === "string" ? l.text : "")).join(""))
    .join("\n");
}

/** Style of the first run (what the editor shows for the whole text). */
export function styleOf(content: any): Required<TextStyle> {
  const p = paragraphs(content)[0];
  const leaf = p?.children?.find((l: any) => typeof l.text === "string") || p || {};
  const fill = Array.isArray(leaf.fills) && leaf.fills[0] ? leaf.fills[0] : {};
  return {
    fontFamily: String(leaf.fontFamily || leaf.fontId || DEFAULT.fontFamily),
    fontSize: n(leaf.fontSize, DEFAULT.fontSize),
    fontWeight: String(leaf.fontWeight || DEFAULT.fontWeight),
    fontStyle: leaf.fontStyle === "italic" ? "italic" : "normal",
    color: String(fill.fillColor || DEFAULT.color),
    opacity: n(fill.fillOpacity, 1),
    lineHeight: n(leaf.lineHeight, DEFAULT.lineHeight),
    letterSpacing: n(leaf.letterSpacing, 0),
    textAlign: (p?.textAlign || leaf.textAlign || "left") as any,
    textDecoration: (leaf.textDecoration || "none") as any,
    textTransform: (leaf.textTransform || "none") as any,
  };
}

/** A new content tree with this text (paragraphs split on "\n") in one style. */
export function buildContent(text: string, style: TextStyle = {}, verticalAlign?: string): any {
  const st = { ...DEFAULT, ...clean(style) };
  const a = attrs(st);
  const root: any = {
    type: "root",
    children: [
      {
        type: "paragraph-set",
        children: text.split("\n").map((line) => ({ ...a, type: "paragraph", children: [{ ...a, text: line }] })),
      },
    ],
  };
  if (verticalAlign) root.verticalAlign = verticalAlign;
  return root;
}

function clean(style: TextStyle): TextStyle {
  const out: any = {};
  for (const [k, v] of Object.entries(style)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * Applies a new text and/or style. With only a style, every run keeps its text and gets the style;
 * with a new text, the runs are rebuilt in the style of the first run plus the changes.
 */
export function editContent(content: any, text: string | undefined, style: TextStyle): any {
  const base = styleOf(content);
  const verticalAlign = content?.verticalAlign;
  if (text !== undefined) return buildContent(text, { ...base, ...clean(style) }, verticalAlign);
  const changes = clean(style);
  if (!Object.keys(changes).length) return content;
  const copy = JSON.parse(JSON.stringify(content));
  for (const p of paragraphs(copy)) {
    const own = { ...styleOf({ type: "root", children: [{ type: "paragraph-set", children: [p] }] }), ...changes };
    Object.assign(p, attrs(own));
    p.children = (p.children || []).map((l: any) => {
      const leafStyle = { ...styleOf({ children: [{ type: "paragraph", children: [l] }] }), ...changes };
      return { ...l, ...attrs(leafStyle), text: l.text };
    });
  }
  return copy;
}

/** Rough width of a line (the real metrics come from the font; Penpot fixes them when it opens the file). */
function lineWidth(line: string, st: Required<TextStyle>) {
  const w = n(st.fontWeight, 400);
  let factor = 0.53 + (w - 400) * 0.0002;
  if (st.textTransform === "uppercase") factor *= 1.15;
  return line.length * st.fontSize * factor + Math.max(0, line.length - 1) * st.letterSpacing;
}

/** Estimated size of a text for its grow type ("fixed" keeps the box). */
export function measureText(content: any, growType: string | undefined, box: { width: number; height: number }) {
  const st = styleOf(content);
  const lines = textOf(content).split("\n");
  const lh = st.fontSize * st.lineHeight;
  if (growType === "auto-width") {
    const width = Math.ceil(Math.max(1, ...lines.map((l) => lineWidth(l, st))));
    return { width, height: Math.ceil(lines.length * lh) };
  }
  if (growType === "auto-height") {
    let count = 0;
    for (const line of lines) {
      let cur = "";
      let rows = 1;
      for (const word of line.split(/(\s+)/)) {
        const next = cur + word;
        if (cur && lineWidth(next.trimEnd(), st) > box.width) {
          rows++;
          cur = word.trimStart();
        } else cur = next;
      }
      count += rows;
    }
    return { width: box.width, height: Math.ceil(count * lh) };
  }
  return { width: box.width, height: box.height };
}
