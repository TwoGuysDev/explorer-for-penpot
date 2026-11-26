// Where a design comes from: a .penpot file in the workspace (read and write) or a file in a
// Penpot account through the API (read; writing goes through update-file, see CloudSource.write).
// No VS Code imports here, so it can be unit-tested with plain Node.
import { PenpotApi, ROOT_ID, Shape } from "../api";
import { PenpotArchive } from "../archive";
import type { PageDiff } from "./editor";
import { assetEntries } from "./image";

export interface SourcePage { id: string; name: string }
export interface SourceFile { id: string; name: string; pages: SourcePage[] }

export interface DesignSource {
  readonly id: string;
  readonly writable: boolean;
  files(): Promise<SourceFile[]>;
  pageObjects(fileId: string, pageId: string): Promise<Record<string, Shape>>;
  image(fileId: string, mediaId: string, mime?: string): Promise<string | undefined>;
  write(fileId: string, diff: PageDiff): Promise<void>;
}

/** Top-level board that contains a shape (undefined for shapes directly on the page). */
export function topBoard(objects: Record<string, Shape>, id: string): string | undefined {
  let cur: Shape | undefined = objects[id];
  let board: string | undefined;
  for (let guard = 0; cur && cur.id !== ROOT_ID && guard < 1000; guard++) {
    if (cur.type === "frame") board = cur.id;
    cur = cur.parentId ? objects[cur.parentId] : undefined;
  }
  return board;
}

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));

export class LocalSource implements DesignSource {
  readonly writable = true;
  private archive: PenpotArchive | undefined;

  constructor(
    readonly id: string,
    private readonly readBytes: () => Promise<Uint8Array>,
    private readonly writeBytes: (data: Uint8Array) => Promise<void>,
  ) {}

  /** Reads the file again on each request, so edits made elsewhere are not lost. */
  private async open() {
    this.archive = PenpotArchive.open(await this.readBytes());
    return this.archive;
  }

  async files() {
    return (await this.open()).files;
  }

  async pageObjects(fileId: string, pageId: string) {
    return (await this.open()).pageObjects(fileId, pageId);
  }

  async image(fileId: string, mediaId: string, mime?: string) {
    return (this.archive || (await this.open())).imageDataUri(fileId, mediaId, mime);
  }

  async write(fileId: string, diff: PageDiff) {
    const archive = await this.open();
    const before = archive.pageObjects(fileId, diff.pageId);
    const changes = new Map<string, Uint8Array | null>();
    const boards = new Set<string>();
    const after: Record<string, Shape> = { ...before };
    for (const s of diff.added) after[s.id] = s;
    for (const c of diff.changed) after[c.after.id] = c.after;
    for (const s of [...diff.added, ...diff.changed.map((c) => c.after)]) {
      changes.set(archive.shapeEntry(fileId, diff.pageId, s.id), encode(s));
      const b = topBoard(after, s.id);
      if (b) boards.add(b);
    }
    for (const id of diff.removed) {
      changes.set(archive.shapeEntry(fileId, diff.pageId, id), null);
      const b = topBoard(before, id);
      if (b) boards.add(b);
    }
    for (const e of archive.thumbnailEntries(fileId, boards)) changes.set(e, null);
    for (const a of diff.media || []) for (const [name, bytes] of assetEntries(fileId, a)) changes.set(name, bytes);
    await this.writeBytes(archive.rewrite(changes));
  }
}

export class CloudSource implements DesignSource {
  readonly writable = false;

  constructor(readonly id: string, private readonly api: PenpotApi, private readonly fileId: string) {}

  async files(): Promise<SourceFile[]> {
    const f = await this.api.getFile(this.fileId);
    const index = (f.data?.pagesIndex || {}) as Record<string, any>;
    const pages = (f.data?.pages || []).map((id) => ({ id, name: String(index[id]?.name || id) }));
    return [{ id: f.id, name: f.name, pages }];
  }

  async pageObjects(fileId: string, pageId: string) {
    return (await this.api.getPage(fileId, pageId)).objects;
  }

  image(_fileId: string, mediaId: string, mime?: string) {
    return this.api.fileMediaDataUri(mediaId, mime);
  }

  async write(): Promise<void> {
    throw new Error(
      "Editing Penpot Cloud files is not available yet: export the file as .penpot into the workspace and edit it there, or use the official Penpot MCP for live edits.",
    );
  }
}
