// Sidebar tree: teams → projects → files → pages → boards.
import * as vscode from "vscode";
import { PenpotApi, ROOT_ID, Shape } from "./api";
import { describeError } from "./messages";

export type NodeKind = "team" | "project" | "file" | "page" | "frame" | "message";

export interface NodeIds {
  teamId?: string;
  projectId?: string;
  fileId?: string;
  pageId?: string;
  frameId?: string;
}

export class PenpotNode extends vscode.TreeItem {
  constructor(
    readonly kind: NodeKind,
    label: string,
    readonly ids: NodeIds = {},
    collapsible = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsible);
    this.contextValue = kind;
  }
}

const ICONS: Record<NodeKind, string> = {
  team: "organization",
  project: "folder",
  file: "file-media",
  page: "files",
  frame: "symbol-misc",
  message: "info",
};

/** Top-level boards of a page, in the same order as Penpot's layers panel (top-most first). */
export function pageBoards(objects: Record<string, Shape>): Shape[] {
  const root = objects[ROOT_ID];
  return [...(root?.shapes || [])].reverse().map((id) => objects[id]).filter((s): s is Shape => !!s && s.type === "frame");
}

export class PenpotTree implements vscode.TreeDataProvider<PenpotNode> {
  private readonly changed = new vscode.EventEmitter<PenpotNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Pages already loaded, so expanding and previewing do not fetch them again. */
  private readonly pageCache = new Map<string, Promise<Record<string, Shape>>>();

  constructor(private readonly getApi: () => Promise<PenpotApi | undefined>) {}

  refresh() {
    this.pageCache.clear();
    this.changed.fire(undefined);
  }

  getTreeItem(node: PenpotNode) {
    return node;
  }

  async getChildren(node?: PenpotNode): Promise<PenpotNode[]> {
    const api = await this.getApi();
    if (!api) return [];
    try {
      if (!node) return await this.teams(api);
      switch (node.kind) {
        case "team": return await this.projects(api, node);
        case "project": return await this.files(api, node);
        case "file": return await this.pages(api, node);
        case "page": return await this.frames(api, node);
        default: return [];
      }
    } catch (err) {
      const msg = describeError(err);
      const m = new PenpotNode("message", msg);
      m.iconPath = new vscode.ThemeIcon("error");
      m.tooltip = msg;
      return [m];
    }
  }

  /** Objects of a page (cached per file/page). */
  pageObjects(api: PenpotApi, fileId: string, pageId: string) {
    const key = `${fileId}/${pageId}`;
    let p = this.pageCache.get(key);
    if (!p) {
      p = api.getPage(fileId, pageId).then((pg) => pg.objects || {});
      p.catch(() => this.pageCache.delete(key));
      this.pageCache.set(key, p);
    }
    return p;
  }

  private make(kind: NodeKind, label: string, ids: NodeIds, collapsible: boolean, description?: string) {
    const n = new PenpotNode(kind, label, ids, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    n.iconPath = new vscode.ThemeIcon(ICONS[kind]);
    if (description) n.description = description;
    return n;
  }

  private message(text: string) {
    return this.make("message", text, {}, false);
  }

  private async teams(api: PenpotApi) {
    const teams = await api.getTeams();
    return teams.map((t) => this.make("team", t.isDefault ? vscode.l10n.t("Your Penpot") : t.name, { teamId: t.id }, true));
  }

  private async projects(api: PenpotApi, node: PenpotNode) {
    const projects = await api.getProjects(node.ids.teamId!);
    return projects
      .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name))
      .map((p) => this.make("project", p.isDefault ? vscode.l10n.t("Drafts") : p.name, { teamId: node.ids.teamId, projectId: p.id }, true));
  }

  private async files(api: PenpotApi, node: PenpotNode) {
    const files = await api.getProjectFiles(node.ids.projectId!);
    if (!files.length) return [this.message(vscode.l10n.t("No files"))];
    return files
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => {
        const n = this.make("file", f.name, { ...node.ids, fileId: f.id }, true);
        if (f.modifiedAt) n.tooltip = `${f.name}\n${vscode.l10n.t("Modified {0}", new Date(f.modifiedAt).toLocaleString())}`;
        return n;
      });
  }

  private async pages(api: PenpotApi, node: PenpotNode) {
    const fileId = node.ids.fileId!;
    const file = await api.getFile(fileId);
    const ids = file.data?.pages || [];
    const index = (file.data?.pagesIndex || {}) as Record<string, any>;
    const out: PenpotNode[] = [];
    for (const pageId of ids) {
      let name: string | undefined = index[pageId]?.name;
      // With fragmented file data the index may not carry the name: fetch the page.
      if (!name) name = (await api.getPage(fileId, pageId).catch(() => undefined))?.name;
      out.push(this.make("page", name || pageId, { ...node.ids, pageId }, true));
    }
    return out.length ? out : [this.message(vscode.l10n.t("No pages"))];
  }

  private async frames(api: PenpotApi, node: PenpotNode) {
    const { fileId, pageId } = node.ids;
    const boards = pageBoards(await this.pageObjects(api, fileId!, pageId!));
    if (!boards.length) return [this.message(vscode.l10n.t("No boards on this page"))];
    return boards.map((f) => {
      const size = f.width != null && f.height != null ? `${Math.round(f.width)}×${Math.round(f.height)}` : undefined;
      const n = this.make("frame", f.name, { ...node.ids, frameId: f.id }, false, size);
      if (f.componentRoot || f.mainInstance) n.iconPath = new vscode.ThemeIcon("symbol-class");
      n.command = { command: "penpotExplorer.preview", title: vscode.l10n.t("Preview"), arguments: [n] };
      return n;
    });
  }
}
