// MCP tools to read and edit Penpot designs without the Penpot editor: list designs, read the
// layer tree, apply a batch of edits (written in one go) and take a PNG screenshot.
// No VS Code imports here: the host (the extension) supplies files, the API and the rasterizer.
import { ROOT_ID, Shape } from "../api";
import { EditError, PageEditor, ShapeKind, ShapeProps } from "../design/editor";
import { boxOf } from "../design/geometry";
import { DesignSource, SourceFile, topBoard } from "../design/sources";
import { renderSvg } from "../render";

export interface ToolHost {
  /** .penpot files in the workspace, with ids like "local:designs/app.penpot". */
  listLocal(): Promise<{ id: string; path: string }[]>;
  /** Files of the connected Penpot account (undefined when not connected). */
  listCloud(): Promise<{ id: string; name: string; project: string; team: string }[] | undefined>;
  source(design: string): Promise<DesignSource>;
  /** SVG → base64 PNG (undefined when it cannot rasterize); the host may also show it to the user. */
  rasterize(svg: string, width: number, height: number, caption: string): Promise<string | undefined>;
  /** Called after a design was saved. */
  edited(design: string, fileId: string, pageId: string, boardIds: string[]): void;
}

export interface ToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const DESIGN = { type: "string", description: 'Design id from list_designs, e.g. "local:designs/app.penpot".' };
const FILE = { type: "string", description: "Penpot file id or name inside the design (only when it holds several; defaults to the first)." };
const PAGE = { type: "string", description: "Page id or name (defaults to the first page)." };

const PROPS_SCHEMA = {
  type: "object",
  description:
    "Shape properties. Positions (x, y) are relative to the board that contains the shape, like in Penpot's design panel. Inside a flex board, the layout decides the position unless absolute is true.",
  properties: {
    name: { type: "string" },
    x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
    hidden: { type: "boolean" },
    opacity: { type: "number", minimum: 0, maximum: 1 },
    fill: { description: '"#RRGGBB", {color, opacity}, a list of those, or null for no fill. For texts it sets the text color.' },
    stroke: { description: "{color, width, opacity, alignment: inner|center|outer, style: solid|dotted|dashed} or null." },
    radius: { description: "Corner radius: a number or [topLeft, topRight, bottomRight, bottomLeft]." },
    shadow: { description: "{color, opacity, x, y, blur, spread, inner}, a list of those, or null." },
    clipContent: { type: "boolean", description: "Boards: clip children to the board." },
    layout: { enum: ["flex", "none"], description: "Boards: turn the flex layout on or off." },
    direction: { enum: ["row", "row-reverse", "column", "column-reverse"] },
    gap: { description: "Number, or {row, column}." },
    padding: { description: "Number, or [top, right, bottom, left]." },
    justify: { enum: ["start", "center", "end", "space-between", "space-around", "space-evenly"] },
    align: { enum: ["start", "center", "end", "stretch"] },
    wrap: { type: "boolean" },
    hSizing: { enum: ["fix", "fill", "auto"], description: "Width inside a flex board (auto = hug content; boards with layout and texts)." },
    vSizing: { enum: ["fix", "fill", "auto"] },
    absolute: { type: "boolean", description: "Ignore the parent's flex layout and use x/y." },
    margin: { description: "Number, or [top, right, bottom, left]." },
    alignSelf: { enum: ["start", "center", "end", "stretch", null] },
    minWidth: { type: ["number", "null"] }, maxWidth: { type: ["number", "null"] },
    minHeight: { type: ["number", "null"] }, maxHeight: { type: ["number", "null"] },
    text: { type: "string", description: "Texts: the content; \\n starts a new paragraph." },
    fontFamily: { type: "string", description: 'Google font name like "Inter", or "sourcesanspro".' },
    fontSize: { type: "number" },
    fontWeight: { type: ["number", "string"] },
    fontStyle: { enum: ["normal", "italic"] },
    color: { type: "string", description: "Texts: #RRGGBB." },
    lineHeight: { type: "number", description: "Multiplier, e.g. 1.2." },
    letterSpacing: { type: "number" },
    textAlign: { enum: ["left", "center", "right", "justify"] },
    textDecoration: { enum: ["none", "underline", "line-through"] },
    textTransform: { enum: ["none", "uppercase", "lowercase", "capitalize"] },
    growType: { enum: ["auto-width", "auto-height", "fixed"] },
    verticalAlign: { enum: ["top", "center", "bottom"] },
    raw: { type: "object", description: "Escape hatch: Penpot attributes in camelCase, set as is." },
  },
  additionalProperties: false,
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_designs",
    title: "List Penpot designs",
    description:
      "Lists the .penpot files in the VS Code workspace (editable) and, when the extension is connected to Penpot, the files of that account (read-only for now). Returns design ids for the other tools.",
    inputSchema: { type: "object", properties: { source: { enum: ["all", "local", "cloud"], default: "all" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_structure",
    title: "Pages and boards of a design",
    description: "Files, pages and top-level boards (id, name, size) of a design.",
    inputSchema: { type: "object", properties: { design: DESIGN }, required: ["design"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_layers",
    title: "Layer tree",
    description:
      "Layer tree of a page or of one shape, top of the layers panel first (= first in a flex flow). Each line: name, type, id, position relative to its board, size, layout, sizing, fill and text.",
    inputSchema: {
      type: "object",
      properties: {
        design: DESIGN, file: FILE, page: PAGE,
        root: { type: "string", description: "Shape id to start from (default: the whole page)." },
        depth: { type: "number", description: "Levels to show (default 4)." },
      },
      required: ["design"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_shapes",
    title: "Shape details",
    description: "Details of some shapes (simplified; raw: true gives Penpot's full data with absolute coordinates).",
    inputSchema: {
      type: "object",
      properties: { design: DESIGN, file: FILE, page: PAGE, ids: { type: "array", items: { type: "string" } }, raw: { type: "boolean" } },
      required: ["design", "ids"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "edit",
    title: "Edit a page",
    description:
      'Applies a list of operations to one page and saves once. Flex boards are laid out again afterwards (children positions, fill and auto sizes), as Penpot does. Operations: {op:"create", type:"board"|"rect"|"ellipse"|"text", parent?, index?, ref?, props}, {op:"update", id, props}, {op:"delete", ids}, {op:"move", ids, parent?, index?}, {op:"duplicate", id, parent?, index?, ref?, offset?:{x,y}}. parent defaults to the page; index counts from the top of the layers panel (0 = top / first in a flex flow). A create or duplicate with ref:"card" can be used later in the same call as "$card". Text sizes are estimated until the file is opened in Penpot. Component copies keep their link (changes become overrides); component mains cannot be deleted here.',
    inputSchema: {
      type: "object",
      properties: {
        design: DESIGN, file: FILE, page: PAGE,
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { enum: ["create", "update", "delete", "move", "duplicate"] },
              type: { enum: ["board", "rect", "ellipse", "text"] },
              id: { type: "string" },
              ids: { type: "array", items: { type: "string" } },
              parent: { type: "string" },
              index: { type: "number" },
              ref: { type: "string" },
              offset: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
              props: PROPS_SCHEMA,
            },
            required: ["op"],
          },
        },
      },
      required: ["design", "operations"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "screenshot",
    title: "Screenshot",
    description:
      "PNG of a board, of any shape, or of the whole page, drawn by the extension (an approximation of Penpot's rendering; fonts fall back to system fonts). Also shows it to the user in VS Code.",
    inputSchema: {
      type: "object",
      properties: {
        design: DESIGN, file: FILE, page: PAGE,
        id: { type: "string", description: "Board or shape id (default: the whole page)." },
        scale: { type: "number", description: "1 by default; at most 3. Images are capped at 2000 px." },
      },
      required: ["design"],
    },
    annotations: { readOnlyHint: true },
  },
];

export const INSTRUCTIONS =
  "Edits Penpot designs saved as .penpot files in the VS Code workspace, without a browser or a Penpot server. " +
  "Start with list_designs, then get_structure and get_layers. Make changes with edit (batch many operations in one call) " +
  "and check them with screenshot. Coordinates are relative to the containing board. Prefer flex layouts (layout, direction, gap, " +
  "padding, hSizing/vSizing) over absolute positions: the server lays them out like Penpot. Import the .penpot into Penpot to keep working there.";

const r = (n: number) => Math.round(n * 100) / 100;

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function pickFile(files: SourceFile[], file?: string): SourceFile {
  if (!files.length) throw new EditError("The design has no files.");
  if (!file) return files[0];
  const f = files.find((x) => x.id === file) || files.find((x) => x.name.toLowerCase() === file.toLowerCase());
  if (!f) throw new EditError(`No file "${file}". Files: ${files.map((x) => `${x.name} (${x.id})`).join(", ")}`);
  return f;
}
function pickPage(f: SourceFile, page?: string) {
  if (!f.pages.length) throw new EditError("The file has no pages.");
  if (!page) return f.pages[0];
  const p = f.pages.find((x) => x.id === page) || f.pages.find((x) => x.name.toLowerCase() === page.toLowerCase());
  if (!p) throw new EditError(`No page "${page}". Pages: ${f.pages.map((x) => `${x.name} (${x.id})`).join(", ")}`);
  return p;
}

function color(s: Shape): string | undefined {
  const f = Array.isArray(s.fills) ? s.fills[0] : undefined;
  if (!f) return undefined;
  if (f.fillColor) return f.fillOpacity != null && f.fillOpacity !== 1 ? `${f.fillColor}@${r(f.fillOpacity)}` : f.fillColor;
  if (f.fillColorGradient) return "gradient";
  if (f.fillImage) return "image";
  return undefined;
}

function describe(ed: PageEditor, s: Shape): string {
  const b = ed.relBox(s);
  const parts = [`${s.name} [${s.type === "circle" ? "ellipse" : s.type === "frame" ? "board" : s.type}]`, `id=${s.id}`, `${r(b.x)},${r(b.y)} ${r(b.width)}×${r(b.height)}`];
  if (s.mainInstance) parts.push("component-main");
  else if (s.componentRoot) parts.push("component-copy");
  else if (s.shapeRef) parts.push("in-copy");
  if (s.hidden) parts.push("hidden");
  if (s.layout === "flex") {
    const g = s.layoutGap || {};
    const p = s.layoutPadding || {};
    parts.push(
      `flex ${s.layoutFlexDir || "row"} gap=${s.layoutGap ? (g.rowGap === g.columnGap ? g.rowGap : `${g.rowGap}/${g.columnGap}`) : 0}` +
        ` pad=${[p.p1, p.p2, p.p3, p.p4].map((v) => v ?? 0).join(",")} justify=${s.layoutJustifyContent || "start"} align=${s.layoutAlignItems || "start"}` +
        (s.layoutWrapType === "wrap" ? " wrap" : ""),
    );
  } else if (s.layout === "grid") parts.push("grid");
  if (s.layoutItemHSizing || s.layoutItemVSizing) parts.push(`size=${s.layoutItemHSizing || "fix"}/${s.layoutItemVSizing || "fix"}`);
  if (s.layoutItemAbsolute) parts.push("absolute");
  const c = color(s);
  if (c) parts.push(`fill=${c}`);
  if (s.r1 || s.r2 || s.r3 || s.r4) parts.push(`radius=${s.r1 === s.r2 && s.r2 === s.r3 && s.r3 === s.r4 ? s.r1 : [s.r1, s.r2, s.r3, s.r4].join(",")}`);
  if (Array.isArray(s.strokes) && s.strokes[0]) parts.push(`stroke=${s.strokes[0].strokeColor}/${s.strokes[0].strokeWidth}`);
  const t = PageEditor.describeText(s);
  if (t) {
    const txt = t.text.length > 80 ? t.text.slice(0, 77) + "…" : t.text;
    parts.push(`text=${JSON.stringify(txt)} (${t.fontFamily} ${t.fontSize}/${t.fontWeight} ${t.color}${t.textAlign !== "left" ? " " + t.textAlign : ""}, ${t.growType || "fixed"})`);
  }
  return parts.join("  ");
}

function simplify(ed: PageEditor, s: Shape) {
  const b = ed.relBox(s);
  const out: Record<string, unknown> = {
    id: s.id, name: s.name, type: s.type === "circle" ? "ellipse" : s.type === "frame" ? "board" : s.type,
    parent: s.parentId, x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height),
  };
  const copy = (keys: string[]) => { for (const k of keys) if (s[k] !== undefined && s[k] !== null) out[k] = s[k]; };
  copy(["rotation", "hidden", "opacity", "blendMode", "fills", "strokes", "shadow", "blur", "r1", "r2", "r3", "r4", "showContent"]);
  for (const k of Object.keys(s)) if (k.startsWith("layout")) out[k] = s[k];
  copy(["componentId", "componentFile", "mainInstance", "componentRoot", "shapeRef", "touched", "constraintsH", "constraintsV"]);
  const t = PageEditor.describeText(s);
  if (t) out.text = t;
  if (Array.isArray(s.shapes)) out.children = [...s.shapes].reverse();
  return out;
}

function boardsOf(objects: Record<string, Shape>) {
  return [...(objects[ROOT_ID]?.shapes || [])].reverse().map((id) => objects[id]).filter((s) => s && s.type === "frame");
}

export class Tools {
  /** One write at a time per design. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly host: ToolHost) {}

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  async call(name: string, args: any): Promise<ToolResult> {
    try {
      switch (name) {
        case "list_designs": return await this.listDesigns(args?.source || "all");
        case "get_structure": return await this.structure(args);
        case "get_layers": return await this.layers(args);
        case "get_shapes": return await this.shapes(args);
        case "edit": return await this.serial(String(args?.design), () => this.edit(args));
        case "screenshot": return await this.screenshot(args);
        default: return fail(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async open(args: any) {
    if (typeof args?.design !== "string") throw new EditError('Missing "design" (see list_designs).');
    const src = await this.host.source(args.design);
    const files = await src.files();
    const file = pickFile(files, args.file);
    const page = pickPage(file, args.page);
    const objects = await src.pageObjects(file.id, page.id);
    return { src, file, page, objects };
  }

  private async listDesigns(source: string): Promise<ToolResult> {
    const lines: string[] = [];
    if (source !== "cloud") {
      const local = await this.host.listLocal();
      lines.push(`Workspace .penpot files (editable): ${local.length ? "" : "none"}`);
      for (const f of local) lines.push(`- ${f.id}`);
    }
    if (source !== "local") {
      const cloud = await this.host.listCloud().catch((e) => { lines.push(`Penpot account: ${e instanceof Error ? e.message : e}`); return null; });
      if (cloud === undefined) lines.push("Penpot account: not connected (run “Penpot: Connect to Penpot…” in VS Code).");
      else if (cloud) {
        lines.push(`Penpot account files (read-only): ${cloud.length ? "" : "none"}`);
        for (const f of cloud) lines.push(`- cloud:${f.id}  ${f.team} / ${f.project} / ${f.name}`);
      }
    }
    return ok(lines.join("\n"));
  }

  private async structure(args: any): Promise<ToolResult> {
    const src = await this.host.source(args.design);
    const lines: string[] = [`${args.design}${src.writable ? "" : " (read-only)"}`];
    for (const f of await src.files()) {
      lines.push(`File "${f.name}" id=${f.id}`);
      for (const p of f.pages) {
        lines.push(`  Page "${p.name}" id=${p.id}`);
        const objects = await src.pageObjects(f.id, p.id);
        for (const b of boardsOf(objects)) {
          const box = boxOf(b);
          lines.push(`    - ${b.name}  id=${b.id}  ${r(box.x)},${r(box.y)} ${r(box.width)}×${r(box.height)}${b.layout ? `  ${b.layout}` : ""}${b.mainInstance ? "  component-main" : ""}`);
        }
      }
    }
    return ok(lines.join("\n"));
  }

  private async layers(args: any): Promise<ToolResult> {
    const { page, objects } = await this.open(args);
    const ed = new PageEditor(objects, page.id);
    const depth = Math.max(1, Math.min(20, Number(args.depth) || 4));
    const root = args.root ? ed.get(args.root) : objects[ROOT_ID];
    const lines: string[] = [];
    const MAX = 600;
    const walk = (s: Shape, level: number) => {
      if (lines.length >= MAX) return;
      if (s.id !== ROOT_ID) lines.push(`${"  ".repeat(level)}- ${describe(ed, s)}`);
      const kids = [...(s.shapes || [])].reverse().filter((id: string) => objects[id] && id !== s.id);
      const next = s.id === ROOT_ID ? level : level + 1;
      if (s.id !== ROOT_ID && next >= depth) {
        if (kids.length) lines.push(`${"  ".repeat(next)}… ${kids.length} children (use root=${s.id})`);
        return;
      }
      for (const k of kids) walk(objects[k], next);
    };
    walk(root, 0);
    if (lines.length >= MAX) lines.push(`… truncated at ${MAX} lines; use root and depth to narrow it.`);
    return ok(`Page "${page.name}" id=${page.id}\n${lines.join("\n") || "(empty page)"}`);
  }

  private async shapes(args: any): Promise<ToolResult> {
    const { page, objects } = await this.open(args);
    const ed = new PageEditor(objects, page.id);
    const ids: string[] = Array.isArray(args.ids) ? args.ids : [];
    const out = ids.map((id) => (objects[id] ? (args.raw ? objects[id] : simplify(ed, objects[id])) : { id, error: "not found" }));
    return ok(JSON.stringify(out, null, 1));
  }

  private async edit(args: any): Promise<ToolResult> {
    const { src, file, page, objects } = await this.open(args);
    if (!src.writable) throw new EditError(`${args.design} is read-only.`);
    const ops: any[] = Array.isArray(args.operations) ? args.operations : [];
    if (!ops.length) throw new EditError("No operations.");
    const ed = new PageEditor(objects, page.id);
    const refs = new Map<string, string>();
    const id = (v: unknown, what: string): string => {
      if (typeof v !== "string" || !v) throw new EditError(`Missing ${what}.`);
      if (v.startsWith("$")) {
        const got = refs.get(v.slice(1));
        if (!got) throw new EditError(`Unknown reference ${v} (define it with ref in an earlier create or duplicate).`);
        return got;
      }
      return v;
    };
    const parent = (v: unknown) => (v === undefined || v === null || v === "" || v === "root" ? undefined : id(v, "parent"));
    const created: string[] = [];
    ops.forEach((op, i) => {
      try {
        switch (op?.op) {
          case "create": {
            const kind = op.type as ShapeKind;
            if (!["board", "rect", "ellipse", "text"].includes(kind)) throw new EditError(`type must be board, rect, ellipse or text.`);
            const nid = ed.create(kind, parent(op.parent), (op.props || {}) as ShapeProps, op.index);
            if (op.ref) refs.set(String(op.ref), nid);
            created.push(op.ref ? `$${op.ref}=${nid}` : nid);
            break;
          }
          case "update": ed.update(id(op.id, "id"), (op.props || {}) as ShapeProps); break;
          case "delete": ed.remove((Array.isArray(op.ids) ? op.ids : [op.id]).map((x: unknown) => id(x, "ids"))); break;
          case "move": ed.move((Array.isArray(op.ids) ? op.ids : [op.id]).map((x: unknown) => id(x, "ids")), parent(op.parent), op.index); break;
          case "duplicate": {
            const nid = ed.duplicate(id(op.id, "id"), parent(op.parent), op.index, op.offset);
            if (op.ref) refs.set(String(op.ref), nid);
            created.push(op.ref ? `$${op.ref}=${nid}` : nid);
            break;
          }
          default: throw new EditError(`Unknown op "${op?.op}".`);
        }
      } catch (err) {
        throw new EditError(`Operation ${i + 1} (${op?.op}): ${err instanceof Error ? err.message : err}. Nothing was saved.`);
      }
    });
    const diff = ed.finish();
    if (!diff.added.length && !diff.changed.length && !diff.removed.length) return ok("No changes.");
    await src.write(file.id, diff);
    const boards = new Set<string>();
    for (const s of [...diff.added, ...diff.changed.map((c) => c.after)]) {
      const b = topBoard(ed.objects, s.id);
      if (b) boards.add(b);
    }
    this.host.edited(args.design, file.id, page.id, [...boards]);
    const lines = [`Saved page "${page.name}": ${diff.added.length} created, ${diff.changed.length} changed, ${diff.removed.length} deleted.`];
    if (created.length) lines.push(`New ids: ${created.join(", ")}`);
    if (ed.warnings.length) lines.push("Notes:", ...ed.warnings.map((w) => `- ${w}`));
    return ok(lines.join("\n"));
  }

  private async screenshot(args: any): Promise<ToolResult> {
    const { src, file, page, objects } = await this.open(args);
    const rootId = args.id ? String(args.id) : ROOT_ID;
    if (!objects[rootId]) throw new EditError(`No shape with id ${rootId} on this page.`);
    const res = await renderSvg(objects, rootId, { loadImage: (m, mime) => src.image(file.id, m, mime) });
    if (!res.width || !res.height) return fail("Nothing to draw.");
    const scale = Math.min(Math.max(0.1, Number(args.scale) || 1), 3, 2000 / Math.max(res.width, res.height));
    const w = Math.max(1, Math.round(res.width * scale)), h = Math.max(1, Math.round(res.height * scale));
    const title = rootId === ROOT_ID ? `${page.name} (page)` : objects[rootId].name;
    const png = await this.host.rasterize(res.svg, w, h, `${args.design} · ${title}`);
    if (!png) return fail("Could not draw the image (the VS Code view that rasterizes it is not available).");
    const notes = res.warnings.map((x) => (x.kind === "image" ? "some images did not load" : `not drawn: ${x.detail}`));
    return {
      content: [
        { type: "image", data: png, mimeType: "image/png" },
        { type: "text", text: `${title}: ${r(res.width)}×${r(res.height)} at ${r(scale)}x${notes.length ? ` (${notes.join(", ")})` : ""}` },
      ],
    };
  }
}
