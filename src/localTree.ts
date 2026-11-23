// Sidebar tree for .penpot files in the workspace: file → (Penpot file) → pages → boards.
// Works offline; a click on a board opens the .penpot preview at that board.
import * as vscode from "vscode";
import { ArchiveBoard, PenpotArchive } from "./archive";

export type LocalKind = "localFile" | "localDesign" | "localPage" | "localBoard" | "message";

/** What to show when opening a .penpot file (boardId "" = whole page, undefined = first board). */
export interface LocalTarget {
  fileId?: string;
  pageId?: string;
  boardId?: string;
}

export class LocalNode extends vscode.TreeItem {
  constructor(
    readonly kind: LocalKind,
    label: string,
    readonly uri?: vscode.Uri,
    readonly target: LocalTarget = {},
    collapsible = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsible);
    this.contextValue = kind;
  }
}

interface Outline {
  files: { id: string; name: string; pages: { id: string; name: string; boards: ArchiveBoard[] }[] }[];
}

const EXCLUDE = "**/{node_modules,.git}/**";

export class LocalTree implements vscode.TreeDataProvider<LocalNode> {
  private readonly changed = new vscode.EventEmitter<LocalNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Pages and boards of each .penpot, read once and kept until the file changes. */
  private readonly outlines = new Map<string, Promise<Outline>>();
  view: vscode.TreeView<LocalNode> | undefined;

  /** Keeps the tree in sync with .penpot files being added, changed or removed. */
  watch(): vscode.Disposable {
    const w = vscode.workspace.createFileSystemWatcher("**/*.penpot");
    let timer: NodeJS.Timeout | undefined;
    const changed = (uri: vscode.Uri) => {
      this.outlines.delete(uri.toString());
      clearTimeout(timer);
      timer = setTimeout(() => this.changed.fire(undefined), 300);
    };
    return vscode.Disposable.from(
      w,
      w.onDidCreate(changed),
      w.onDidChange(changed),
      w.onDidDelete(changed),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      { dispose: () => clearTimeout(timer) },
    );
  }

  refresh() {
    this.outlines.clear();
    this.changed.fire(undefined);
  }

  getTreeItem(node: LocalNode) {
    return node;
  }

  async getChildren(node?: LocalNode): Promise<LocalNode[]> {
    try {
      if (!node) return await this.files();
      const outline = await this.outline(node.uri!);
      switch (node.kind) {
        case "localFile":
          // One Penpot file per export is the usual case: go straight to its pages.
          return outline.files.length === 1
            ? this.pages(node.uri!, outline.files[0])
            : outline.files.map((f) => this.make("localDesign", f.name, node.uri, { fileId: f.id }, true));
        case "localDesign":
          return this.pages(node.uri!, outline.files.find((f) => f.id === node.target.fileId)!);
        case "localPage": {
          const page = outline.files.find((f) => f.id === node.target.fileId)?.pages.find((p) => p.id === node.target.pageId);
          return this.boards(node.uri!, node.target, page?.boards || []);
        }
        default:
          return [];
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = this.make("message", msg, undefined, {}, false);
      m.iconPath = new vscode.ThemeIcon("error");
      m.tooltip = msg;
      return [m];
    }
  }

  private outline(uri: vscode.Uri): Promise<Outline> {
    const key = uri.toString();
    let p = this.outlines.get(key);
    if (!p) {
      p = (async () => {
        const archive = PenpotArchive.open(await vscode.workspace.fs.readFile(uri));
        return {
          files: archive.files.map((f) => ({
            id: f.id,
            name: f.name,
            pages: f.pages.map((pg) => ({ ...pg, boards: archive.pageBoards(f.id, pg.id) })),
          })),
        };
      })();
      p.catch(() => this.outlines.delete(key));
      this.outlines.set(key, p);
    }
    return p;
  }

  private make(kind: LocalKind, label: string, uri: vscode.Uri | undefined, target: LocalTarget, collapsible: boolean, description?: string) {
    const n = new LocalNode(kind, label, uri, target, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    n.iconPath = new vscode.ThemeIcon(
      { localFile: "file-media", localDesign: "file-media", localPage: "files", localBoard: "symbol-misc", message: "info" }[kind],
    );
    if (description) n.description = description;
    return n;
  }

  private async files(): Promise<LocalNode[]> {
    const uris = (await vscode.workspace.findFiles("**/*.penpot", EXCLUDE)).sort((a, b) =>
      vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)),
    );
    if (this.view) this.view.message = uris.length ? undefined : vscode.l10n.t("No .penpot files in this workspace.");
    return uris.map((uri) => {
      const rel = vscode.workspace.asRelativePath(uri);
      const slash = rel.lastIndexOf("/");
      const n = this.make("localFile", rel.slice(slash + 1), uri, {}, true, slash > 0 ? rel.slice(0, slash) : undefined);
      n.resourceUri = uri;
      n.tooltip = rel;
      n.id = `file:${uri.toString()}`;
      return n;
    });
  }

  private pages(uri: vscode.Uri, file: Outline["files"][number]) {
    if (!file.pages.length) return [this.make("message", vscode.l10n.t("No pages"), undefined, {}, false)];
    return file.pages.map((p) => {
      const n = this.make("localPage", p.name, uri, { fileId: file.id, pageId: p.id }, true);
      n.id = `page:${uri.toString()}:${file.id}:${p.id}`;
      return n;
    });
  }

  private boards(uri: vscode.Uri, target: LocalTarget, boards: ArchiveBoard[]) {
    if (!boards.length) return [this.make("message", vscode.l10n.t("No boards on this page"), undefined, {}, false)];
    return boards.map((b) => {
      const size = b.width != null && b.height != null ? `${Math.round(b.width)}×${Math.round(b.height)}` : undefined;
      const n = this.make("localBoard", b.name, uri, { ...target, boardId: b.id }, false, size);
      if (b.component) n.iconPath = new vscode.ThemeIcon("symbol-class");
      n.id = `board:${uri.toString()}:${target.fileId}:${b.id}`;
      n.command = { command: "penpotExplorer.openLocal", title: vscode.l10n.t("Preview"), arguments: [n] };
      return n;
    });
  }
}
