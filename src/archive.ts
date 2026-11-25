// Reads a .penpot export (Penpot 2.x: a ZIP with one JSON per object) so it can be previewed offline,
// and writes it back with changed shapes (used by the MCP server).
// Layout: manifest.json, files/<file>.json, files/<file>/pages/<page>.json (name and index),
// files/<file>/pages/<page>/<shape>.json, files/<file>/media/<id>.json (points to a storage object),
// files/<file>/thumbnails/frame/**.json and objects/<storage id>.<ext> (the image bytes).
// No VS Code imports here, so it can be unit-tested with plain Node.
import { ROOT_ID, Shape } from "./api";
import { ZipError, ZipReader, ZipSource, writeZip } from "./zip";

export interface ArchivePage { id: string; name: string }
export interface ArchiveFile { id: string; name: string; pages: ArchivePage[] }
export interface ArchiveBoard { id: string; name: string; width?: number; height?: number; component: boolean }

export class ArchiveError extends Error {
  constructor(message: string, readonly kind: "format" | "legacy" | "broken") {
    super(message);
  }
}

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp)$/;
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};

const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);

export class PenpotArchive {
  readonly files: ArchiveFile[];
  private readonly zip: ZipReader;
  /** Entries grouped by directory ("files/<f>/pages/<p>/" → shape JSON names). */
  private readonly dirs = new Map<string, string[]>();
  /** Storage object id → entry name of its bytes (objects/<id>.<ext>). */
  private readonly blobs = new Map<string, string>();
  private readonly thumbs = new Map<string, Map<string, string>>();

  static open(buf: Uint8Array): PenpotArchive {
    // Exports from Penpot 1.x use a binary format that starts with "PENPOT".
    if (buf.length >= 6 && new TextDecoder().decode(buf.subarray(0, 6)) === "PENPOT") {
      throw new ArchiveError("This .penpot file uses the old binary format (Penpot 1.x).", "legacy");
    }
    let zip: ZipReader;
    try {
      zip = new ZipReader(buf);
    } catch (err) {
      throw new ArchiveError(err instanceof ZipError ? err.message : String(err), "format");
    }
    if (!zip.has("manifest.json")) throw new ArchiveError("No manifest.json: this is not a Penpot export.", "format");
    return new PenpotArchive(zip);
  }

  private constructor(zip: ZipReader) {
    this.zip = zip;
    for (const name of zip.entries.keys()) {
      const d = dirOf(name);
      let list = this.dirs.get(d);
      if (!list) this.dirs.set(d, (list = []));
      list.push(name);
      if (d === "objects/" && !name.endsWith(".json")) {
        const base = name.slice(d.length);
        const dot = base.lastIndexOf(".");
        this.blobs.set(dot > 0 ? base.slice(0, dot) : base, name);
      }
    }
    let manifest: any;
    try {
      manifest = zip.readJson("manifest.json");
    } catch {
      throw new ArchiveError("manifest.json could not be read.", "broken");
    }
    const listed: { id: string; name?: string }[] = Array.isArray(manifest?.files) ? manifest.files : [];
    this.files = listed
      .filter((f) => typeof f?.id === "string" && zip.has(`files/${f.id}.json`))
      .map((f) => ({ id: f.id, name: this.fileName(f.id, f.name), pages: this.pages(f.id) }));
    if (!this.files.length) throw new ArchiveError("The export has no files.", "broken");
  }

  private fileName(id: string, fallback?: string) {
    try {
      return String(this.zip.readJson(`files/${id}.json`).name || fallback || id);
    } catch {
      return fallback || id;
    }
  }

  private pages(fileId: string): ArchivePage[] {
    const dir = `files/${fileId}/pages/`;
    return (this.dirs.get(dir) || [])
      .filter((n) => n.endsWith(".json"))
      .map((n) => {
        const p = this.zip.readJson(n);
        const id = String(p.id || n.slice(dir.length, -5));
        return { id, name: String(p.name || id), index: typeof p.index === "number" ? p.index : Infinity };
      })
      .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name))
      .map(({ id, name }) => ({ id, name }));
  }

  /** All shapes of a page, keyed by id (the same shape the API returns). */
  pageObjects(fileId: string, pageId: string): Record<string, Shape> {
    const objects: Record<string, Shape> = {};
    for (const n of this.dirs.get(`files/${fileId}/pages/${pageId}/`) || []) {
      if (!n.endsWith(".json")) continue;
      const s = this.zip.readJson<Shape>(n);
      if (s && typeof s.id === "string") objects[s.id] = s;
    }
    return objects;
  }

  /**
   * Top-level boards of a page, in the order of Penpot's layers panel (top-most first). Reads only
   * the page root and its direct children, so listing is cheap even for heavy pages.
   */
  pageBoards(fileId: string, pageId: string): ArchiveBoard[] {
    const dir = `files/${fileId}/pages/${pageId}/`;
    const read = (id: string): Shape | undefined => {
      try { return this.zip.has(`${dir}${id}.json`) ? this.zip.readJson<Shape>(`${dir}${id}.json`) : undefined; } catch { return undefined; }
    };
    const root = read(ROOT_ID);
    return [...(root?.shapes || [])]
      .reverse()
      .map(read)
      .filter((s): s is Shape => !!s && s.type === "frame")
      .map((s) => ({
        id: s.id,
        name: String(s.name || s.id),
        width: typeof s.width === "number" ? s.width : undefined,
        height: typeof s.height === "number" ? s.height : undefined,
        component: !!(s.componentRoot || s.mainInstance),
      }));
  }

  private blobDataUri(storageId: string, mime?: string): string | undefined {
    const entry = this.blobs.get(storageId);
    if (!entry) return undefined;
    let type = mime;
    if (!type || !IMAGE_MIME.test(type)) {
      try { type = this.zip.readJson(`objects/${storageId}.json`).contentType; } catch { type = undefined; }
    }
    if (!type || !IMAGE_MIME.test(type)) type = MIME_BY_EXT[entry.slice(entry.lastIndexOf(".") + 1).toLowerCase()];
    if (!type) return undefined;
    return `data:${type};base64,${Buffer.from(this.zip.read(entry)).toString("base64")}`;
  }

  /** Image used by a shape (fillImage.id / metadata.id are file media ids). */
  imageDataUri(fileId: string, mediaId: string, mime?: string): string | undefined {
    const ref = `files/${fileId}/media/${mediaId}.json`;
    if (this.zip.has(ref)) {
      try {
        const m = this.zip.readJson(ref);
        return this.blobDataUri(String(m.mediaId), m.mtype || mime);
      } catch {
        return undefined;
      }
    }
    return this.blobDataUri(mediaId, mime);
  }

  /** Thumbnail the Penpot editor saved for a board, when the export has one. */
  thumbnailDataUri(fileId: string, frameId: string): string | undefined {
    let map = this.thumbs.get(fileId);
    if (!map) {
      map = new Map();
      const prefix = `files/${fileId}/thumbnails/`;
      for (const [d, names] of this.dirs) {
        if (!d.startsWith(prefix)) continue;
        for (const n of names) {
          if (!n.endsWith(".json")) continue;
          try {
            const t = this.zip.readJson(n);
            if (t.frameId && t.mediaId && (t.tag || "frame") === "frame") map.set(String(t.frameId), String(t.mediaId));
          } catch { /* ignore a broken thumbnail */ }
        }
      }
      this.thumbs.set(fileId, map);
    }
    const media = map.get(frameId);
    return media ? this.blobDataUri(media) : undefined;
  }

  /** ZIP entry that holds a shape of a page. */
  shapeEntry(fileId: string, pageId: string, shapeId: string) {
    return `files/${fileId}/pages/${pageId}/${shapeId}.json`;
  }

  /**
   * Entries of the thumbnails Penpot saved for these boards (the JSON and the image it points to).
   * They go stale when a board changes, so the writer drops them and Penpot draws new ones.
   */
  thumbnailEntries(fileId: string, frameIds: Iterable<string>): string[] {
    const wanted = new Set(frameIds);
    const out: string[] = [];
    if (!wanted.size) return out;
    const prefix = `files/${fileId}/thumbnails/`;
    for (const [d, names] of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        try {
          const t = this.zip.readJson(n);
          if (!wanted.has(String(t.frameId))) continue;
          out.push(n);
          const blob = t.mediaId && this.blobs.get(String(t.mediaId));
          if (blob) out.push(blob, `objects/${t.mediaId}.json`);
        } catch { /* ignore a broken thumbnail */ }
      }
    }
    return out.filter((n) => this.zip.has(n));
  }

  /** A new .penpot with some entries replaced or added (bytes) or removed (null); the rest is copied as is. */
  rewrite(changes: Map<string, Uint8Array | null>): Uint8Array {
    const sources: ZipSource[] = [];
    for (const name of this.zip.entries.keys()) {
      const c = changes.get(name);
      if (c === null) continue;
      sources.push(c ? { name, content: c } : { name, copy: this.zip.raw(name) });
    }
    for (const [name, c] of changes) if (c && !this.zip.has(name)) sources.push({ name, content: c });
    return writeZip(sources);
  }
}
