// Read-only editor for .penpot exports in the workspace: pick a page and a board and see it drawn,
// offline (no Penpot connection needed). Reloads when the file changes on disk.
import * as vscode from "vscode";
import { ROOT_ID, Shape } from "./api";
import { ArchiveError, PenpotArchive } from "./archive";
import type { LocalTarget } from "./localTree";
import { describeWarning } from "./messages";
import { renderSvg } from "./render";
import { pageBoards } from "./tree";

class PenpotDocument implements vscode.CustomDocument {
  archive: PenpotArchive | undefined;
  error: string | undefined;
  private readonly pages = new Map<string, Record<string, Shape>>();
  private readonly images = new Map<string, string | undefined>();

  constructor(readonly uri: vscode.Uri) {}

  async load() {
    this.pages.clear();
    this.images.clear();
    try {
      this.archive = PenpotArchive.open(await vscode.workspace.fs.readFile(this.uri));
      this.error = undefined;
    } catch (err) {
      this.archive = undefined;
      this.error = describeArchiveError(err);
    }
  }

  pageObjects(fileId: string, pageId: string) {
    const key = `${fileId}/${pageId}`;
    let objects = this.pages.get(key);
    if (!objects) this.pages.set(key, (objects = this.archive!.pageObjects(fileId, pageId)));
    return objects;
  }

  image(fileId: string, mediaId: string, mime?: string) {
    const key = `${fileId}/${mediaId}`;
    if (!this.images.has(key)) this.images.set(key, this.archive!.imageDataUri(fileId, mediaId, mime));
    return this.images.get(key);
  }

  dispose() {}
}

function describeArchiveError(err: unknown): string {
  if (err instanceof ArchiveError) {
    switch (err.kind) {
      case "legacy":
        return vscode.l10n.t("This .penpot file uses the old format from Penpot 1.x. Import it into Penpot and export it again to preview it here.");
      case "format":
        return vscode.l10n.t("This is not a Penpot export (.penpot from Penpot 2.x): {0}", err.message);
      default:
        return vscode.l10n.t("The .penpot file is damaged: {0}", err.message);
    }
  }
  return vscode.l10n.t("Could not read the file: {0}", err instanceof Error ? err.message : String(err));
}

interface ShowRequest {
  type: "show";
  seq: number;
  fileId?: string;
  pageId?: string;
  /** Board id, "" for the whole page, undefined to pick the first board. */
  boardId?: string;
}

export class PenpotFileEditor implements vscode.CustomReadonlyEditorProvider<PenpotDocument> {
  static readonly viewType = "penpotExplorer.penpotFile";

  static register(ctx: vscode.ExtensionContext) {
    return vscode.window.registerCustomEditorProvider(PenpotFileEditor.viewType, new PenpotFileEditor(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  /** Open previews by document URI (the most recent one), so the tree can move them to a board. */
  private static readonly panels = new Map<string, { panel: vscode.WebviewPanel; select(t: LocalTarget): void }>();
  /** Where a preview that is about to open should start. */
  private static readonly pending = new Map<string, LocalTarget>();

  /** Opens a .penpot file in this editor, showing the given page or board. */
  static async open(uri: vscode.Uri, target: LocalTarget = {}) {
    const open = PenpotFileEditor.panels.get(uri.toString());
    if (open) {
      open.panel.reveal(undefined, false);
      open.select(target);
      return;
    }
    PenpotFileEditor.pending.set(uri.toString(), target);
    await vscode.commands.executeCommand("vscode.openWith", uri, PenpotFileEditor.viewType);
  }

  private constructor(private readonly ctx: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<PenpotDocument> {
    const doc = new PenpotDocument(uri);
    await doc.load();
    return doc;
  }

  async resolveCustomEditor(doc: PenpotDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    panel.webview.html = this.html();

    const post = (msg: unknown) => void panel.webview.postMessage(msg);
    const key = doc.uri.toString();
    let initial = PenpotFileEditor.pending.get(key);
    PenpotFileEditor.pending.delete(key);
    const sendStructure = () => {
      post(doc.archive ? { type: "structure", files: doc.archive.files, target: initial } : { type: "error", message: doc.error });
      initial = undefined;
    };
    const entry = { panel, select: (target: LocalTarget) => post({ type: "select", target }) };
    PenpotFileEditor.panels.set(key, entry);
    panel.onDidChangeViewState(() => { if (panel.active) PenpotFileEditor.panels.set(key, entry); });

    let last: ShowRequest | undefined;
    const show = async (req: ShowRequest) => {
      last = req;
      const archive = doc.archive;
      if (!archive) return sendStructure();
      try {
        const file = archive.files.find((f) => f.id === req.fileId) || archive.files[0];
        const page = file.pages.find((p) => p.id === req.pageId) || file.pages[0];
        if (!page) return post({ type: "render", seq: req.seq, fileId: file.id, boards: [], boardId: "", svg: "", info: vscode.l10n.t("No pages") });
        const objects = doc.pageObjects(file.id, page.id);
        const boards = pageBoards(objects).map((b) => ({
          id: b.id,
          name: b.name,
          size: b.width && b.height ? `${Math.round(b.width)}×${Math.round(b.height)}` : "",
        }));
        let boardId = req.boardId;
        if (boardId === undefined || (boardId && !objects[boardId])) boardId = boards[0]?.id || "";
        const res = await renderSvg(objects, boardId || ROOT_ID, {
          loadImage: async (mediaId, mime) => doc.image(file.id, mediaId, mime),
        });
        const thumb = boardId ? archive.thumbnailDataUri(file.id, boardId) || "" : "";
        const notes = res.warnings.map(describeWarning);
        const info = `${Math.round(res.width)} × ${Math.round(res.height)}` + (notes.length ? ` · ${notes.join(", ")}` : "");
        post({ type: "render", seq: req.seq, fileId: file.id, pageId: page.id, boards, boardId, svg: res.svg, info, thumb });
      } catch (err) {
        post({ type: "renderError", seq: req.seq, message: vscode.l10n.t("Could not draw: {0}", err instanceof Error ? err.message : String(err)) });
      }
    };

    const subs: vscode.Disposable[] = [];
    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === "ready") sendStructure();
        else if (msg?.type === "show") void show(msg as ShowRequest);
      },
      null,
      subs,
    );

    // Follow changes on disk (a new export, a git pull…).
    if (doc.uri.scheme === "file") {
      const dir = vscode.Uri.joinPath(doc.uri, "..");
      const name = doc.uri.path.slice(doc.uri.path.lastIndexOf("/") + 1);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, name));
      let timer: NodeJS.Timeout | undefined;
      const reload = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          await doc.load();
          sendStructure();
          if (last && doc.archive) post({ type: "reshow" });
        }, 300);
      };
      subs.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), { dispose: () => clearTimeout(timer) });
    }
    panel.onDidDispose(
      () => {
        if (PenpotFileEditor.panels.get(key) === entry) PenpotFileEditor.panels.delete(key);
        subs.forEach((d) => d.dispose());
      },
      null,
      this.ctx.subscriptions,
    );
  }

  private html() {
    const webFonts = vscode.workspace.getConfiguration("penpotExplorer").get<boolean>("preview.loadWebFonts", true);
    const nonce = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join("");
    const csp = [
      "default-src 'none'",
      "img-src data:",
      `style-src 'unsafe-inline'${webFonts ? " https://fonts.googleapis.com" : ""}`,
      webFonts ? "font-src https://fonts.gstatic.com" : "",
      `script-src 'nonce-${nonce}'`,
    ]
      .filter(Boolean)
      .join("; ");
    const L = {
      file: vscode.l10n.t("File"),
      page: vscode.l10n.t("Page"),
      board: vscode.l10n.t("Board"),
      wholePage: vscode.l10n.t("Whole page"),
      fit: vscode.l10n.t("Fit"),
      actual: vscode.l10n.t("100%"),
      fitTitle: vscode.l10n.t("Switch between fit to window and 100%"),
      thumb: vscode.l10n.t("Thumbnail"),
      thumbTitle: vscode.l10n.t("Compare with the thumbnail generated by the Penpot editor"),
      loading: vscode.l10n.t("Loading…"),
      noBoards: vscode.l10n.t("No boards on this page"),
    };
    return `<!doctype html><html lang="${esc(vscode.env.language)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${webFonts ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=JetBrains+Mono:wght@400;700&display=swap">` : ""}
<style>
  body { margin: 0; font: 13px var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px;
    background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  label { display: flex; gap: 6px; align-items: center; opacity: .9; }
  select { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 3px 6px; max-width: 320px; }
  select:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .info { flex: 1; text-align: right; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 80px; }
  button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  main { padding: 16px; overflow: auto; }
  .stage svg, .stage img { display: block; margin: 0 auto; box-shadow: 0 2px 12px rgba(0,0,0,.35); }
  .fit svg, .fit img { max-width: 100%; height: auto; }
  .msg { opacity: .8; } .err { color: var(--vscode-errorForeground); }
  [hidden] { display: none !important; }
</style></head><body>
<header>
  <label id="fileBox" hidden>${esc(L.file)} <select id="file"></select></label>
  <label>${esc(L.page)} <select id="page"></select></label>
  <label>${esc(L.board)} <select id="board"></select></label>
  <span class="info" id="info"></span>
  <button id="zoom" aria-pressed="true" title="${esc(L.fitTitle)}">${esc(L.fit)}</button>
  <button id="thumb" aria-pressed="false" title="${esc(L.thumbTitle)}" hidden>${esc(L.thumb)}</button>
</header>
<main class="stage fit" id="stage">
  <p class="msg" id="msg">${esc(L.loading)}</p>
  <div id="render"></div>
  <div id="thumbView" hidden><img id="thumbImg" alt=""></div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const L = ${JSON.stringify(L)};
  const $ = (id) => document.getElementById(id);
  const fileSel = $('file'), pageSel = $('page'), boardSel = $('board');
  let files = [], seq = 0;
  let state = vscode.getState() || {};

  function options(sel, items, value) {
    sel.replaceChildren(...items.map((it) => { const o = document.createElement('option'); o.value = it.id; o.textContent = it.label; return o; }));
    if (value !== undefined && items.some((it) => it.id === value)) sel.value = value;
  }
  function fillPages() {
    const f = files.find((x) => x.id === fileSel.value) || files[0];
    options(pageSel, (f ? f.pages : []).map((p) => ({ id: p.id, label: p.name })), state.pageId);
  }
  function show(boardId) {
    state = { fileId: fileSel.value, pageId: pageSel.value, boardId };
    vscode.setState(state);
    $('msg').textContent = L.loading; $('msg').className = 'msg'; $('msg').hidden = false;
    vscode.postMessage({ type: 'show', seq: ++seq, fileId: fileSel.value, pageId: pageSel.value, boardId });
  }
  fileSel.onchange = () => { state.pageId = undefined; fillPages(); show(undefined); };
  pageSel.onchange = () => show(undefined);
  boardSel.onchange = () => show(boardSel.value);
  $('zoom').onclick = () => {
    const fit = $('stage').classList.toggle('fit');
    $('zoom').setAttribute('aria-pressed', String(fit));
    $('zoom').textContent = fit ? L.fit : L.actual;
  };
  $('thumb').onclick = () => setThumb($('thumb').getAttribute('aria-pressed') !== 'true');
  function setThumb(on) {
    $('thumb').setAttribute('aria-pressed', String(on));
    $('render').hidden = on;
    $('thumbView').hidden = !on;
  }

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'error') {
      $('msg').textContent = m.message; $('msg').className = 'msg err'; $('msg').hidden = false;
      $('render').replaceChildren(); $('info').textContent = '';
    } else if (m.type === 'structure' || m.type === 'select') {
      if (m.target) state = m.target;
      if (m.type === 'structure') files = m.files;
      $('fileBox').hidden = files.length < 2;
      options(fileSel, files.map((f) => ({ id: f.id, label: f.name })), state.fileId);
      fillPages();
      show(state.pageId === pageSel.value ? state.boardId : undefined);
    } else if (m.type === 'reshow') {
      show(state.boardId);
    } else if (m.type === 'render' && m.seq === seq) {
      const boards = [{ id: '', label: L.wholePage }, ...m.boards.map((b) => ({ id: b.id, label: b.size ? b.name + '  ·  ' + b.size : b.name }))];
      options(boardSel, boards, m.boardId);
      state.boardId = m.boardId; vscode.setState(state);
      $('msg').hidden = !!m.svg || m.boards.length > 0;
      if (!m.svg && !m.boards.length) { $('msg').textContent = L.noBoards; $('msg').className = 'msg'; }
      $('render').innerHTML = m.svg;
      $('info').textContent = m.info;
      $('thumb').hidden = !m.thumb;
      if (m.thumb) $('thumbImg').src = m.thumb;
      setThumb(false);
    } else if (m.type === 'renderError' && m.seq === seq) {
      $('msg').textContent = m.message; $('msg').className = 'msg err'; $('msg').hidden = false;
      $('render').replaceChildren();
    }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
