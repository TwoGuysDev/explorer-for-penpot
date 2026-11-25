// Runs the MCP server inside VS Code: settings, commands, status bar item, and the view that turns
// SVG into PNG for the screenshot tool (and shows the last screenshot to the user).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { PenpotApi } from "./api";
import { CloudSource, DesignSource, LocalSource } from "./design/sources";
import { McpServer } from "./mcp/server";
import { ToolHost, Tools } from "./mcp/tools";
import { embedFonts } from "./render";

const EXCLUDE = "**/{node_modules,.git}/**";
const SERVER_NAME = "penpot-explorer";

class RasterView {
  private panel: vscode.WebviewPanel | undefined;
  private ready: Promise<void> | undefined;
  private seq = 0;
  private readonly waiting = new Map<number, (png: string | undefined) => void>();
  private readonly fonts = new Map<string, Uint8Array | undefined>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private open(): Promise<void> {
    if (this.panel && this.ready) return this.ready;
    const panel = vscode.window.createWebviewPanel(
      "penpotExplorer.mcpView",
      vscode.l10n.t("Penpot MCP"),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "penpot.svg");
    this.panel = panel;
    this.ready = new Promise<void>((resolve) => {
      panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === "ready") resolve();
        else if (m?.type === "raster") {
          this.waiting.get(m.seq)?.(typeof m.data === "string" ? m.data.replace(/^data:image\/png;base64,/, "") : undefined);
          this.waiting.delete(m.seq);
        }
      });
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = undefined;
      for (const done of this.waiting.values()) done(undefined);
      this.waiting.clear();
    });
    panel.webview.html = this.html();
    return this.ready;
  }

  async rasterize(svg: string, width: number, height: number, caption: string): Promise<string | undefined> {
    await Promise.race([this.open(), new Promise((r) => setTimeout(r, 10000))]);
    if (!this.panel) return undefined;
    if (!this.panel.visible) this.panel.reveal(undefined, true);
    const seq = ++this.seq;
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(seq);
        resolve(undefined);
      }, 20000);
      this.waiting.set(seq, (png) => {
        clearTimeout(timer);
        resolve(png);
      });
      void this.panel!.webview.postMessage({ type: "raster", seq, svg: embedFonts(svg, (f) => this.font(f)), width, height, caption });
    });
  }

  /** A font file shipped in media/fonts (read once). */
  private font(file: string): Uint8Array | undefined {
    if (!this.fonts.has(file)) {
      try {
        this.fonts.set(file, fs.readFileSync(path.join(this.ctx.extensionPath, "media", "fonts", file)));
      } catch {
        this.fonts.set(file, undefined);
      }
    }
    return this.fonts.get(file);
  }

  dispose() {
    this.panel?.dispose();
  }

  private html() {
    const nonce = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join("");
    const csp = ["default-src 'none'", "img-src data: blob:", "font-src data:", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join("; ");
    const L = {
      waiting: vscode.l10n.t("Screenshots taken through the MCP server appear here."),
      failed: vscode.l10n.t("Could not draw this image."),
    };
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { margin: 0; font: 13px var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { position: sticky; top: 0; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .85; }
  main { padding: 16px; }
  img { display: block; margin: 0 auto; max-width: 100%; height: auto; box-shadow: 0 2px 12px rgba(0,0,0,.35); }
  .err { color: var(--vscode-errorForeground); }
</style></head><body>
<header id="caption">${L.waiting.replace(/</g, "&lt;")}</header>
<main><img id="shot" alt="" hidden></main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const L = ${JSON.stringify(L)};
  const cap = document.getElementById('caption'), shot = document.getElementById('shot');
  window.addEventListener('message', ({ data: m }) => {
    if (m.type !== 'raster') return;
    const url = URL.createObjectURL(new Blob([m.svg], { type: 'image/svg+xml' }));
    const img = new Image();
    const done = (data) => { URL.revokeObjectURL(url); vscode.postMessage({ type: 'raster', seq: m.seq, data }); };
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = m.width; c.height = m.height;
        const g = c.getContext('2d');
        g.fillStyle = '#E8E9EA';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, m.width, m.height);
        const data = c.toDataURL('image/png');
        shot.src = data; shot.hidden = false; shot.alt = m.caption;
        cap.textContent = m.caption; cap.className = '';
        done(data);
      } catch (e) { cap.textContent = L.failed; cap.className = 'err'; done(undefined); }
    };
    img.onerror = () => { cap.textContent = L.failed; cap.className = 'err'; done(undefined); };
    img.src = url;
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}

export class McpHost implements vscode.Disposable {
  private server: McpServer | undefined;
  private port = 0;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  private readonly out = vscode.window.createOutputChannel("Penpot MCP");
  private readonly raster: RasterView;
  /** design id → file, for the .penpot files listed last. */
  private readonly local = new Map<string, vscode.Uri>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly getApi: () => Promise<PenpotApi | undefined>) {
    this.raster = new RasterView(ctx);
    this.status.command = "penpotExplorer.mcp.menu";
    ctx.subscriptions.push(
      this,
      vscode.commands.registerCommand("penpotExplorer.mcp.start", () => this.setEnabled(true)),
      vscode.commands.registerCommand("penpotExplorer.mcp.stop", () => this.setEnabled(false)),
      vscode.commands.registerCommand("penpotExplorer.mcp.copySetup", () => this.copySetup()),
      vscode.commands.registerCommand("penpotExplorer.mcp.menu", () => this.menu()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("penpotExplorer.mcp")) void this.sync();
      }),
    );
    void this.sync();
  }

  private config() {
    const c = vscode.workspace.getConfiguration("penpotExplorer.mcp");
    return { enabled: c.get<boolean>("enabled", false), port: c.get<number>("port", 4410) };
  }

  private url() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  private async setEnabled(on: boolean) {
    await vscode.workspace.getConfiguration("penpotExplorer.mcp").update("enabled", on, vscode.ConfigurationTarget.Global);
    await this.sync();
    if (on && this.server?.running) {
      const copy = vscode.l10n.t("Copy setup for Claude Code");
      const pick = await vscode.window.showInformationMessage(vscode.l10n.t("Penpot MCP server running at {0}.", this.url()), copy);
      if (pick === copy) await this.copySetup();
    }
  }

  /** Starts, stops or restarts the server to match the settings. */
  private async sync() {
    const { enabled, port } = this.config();
    if (this.server && (!enabled || port !== this.port)) {
      await this.server.stop();
      this.server = undefined;
      this.out.appendLine("Server stopped.");
    }
    if (enabled && !this.server) {
      const server = new McpServer(new Tools(this.toolHost()), { name: SERVER_NAME, version: String(this.ctx.extension.packageJSON.version) }, (m) =>
        this.out.appendLine(`${new Date().toLocaleTimeString()} ${m}`),
      );
      try {
        this.port = await server.start(port);
        this.server = server;
        this.out.appendLine(`Server running at ${this.url()}`);
      } catch (err: any) {
        const msg = err?.code === "EADDRINUSE" ? vscode.l10n.t("Port {0} is in use (another VS Code window may be running the server). Change penpotExplorer.mcp.port.", port) : String(err?.message || err);
        vscode.window.showErrorMessage(vscode.l10n.t("Could not start the Penpot MCP server: {0}", msg));
      }
    }
    this.updateStatus();
  }

  private updateStatus() {
    if (this.server?.running) {
      this.status.text = "$(radio-tower) Penpot MCP";
      this.status.tooltip = vscode.l10n.t("Penpot MCP server at {0}", this.url());
      this.status.show();
    } else this.status.hide();
  }

  private async menu() {
    const items = [
      { label: vscode.l10n.t("Copy setup for Claude Code"), run: () => this.copySetup() },
      { label: vscode.l10n.t("Show log"), run: () => this.out.show() },
      { label: vscode.l10n.t("Stop the server"), run: () => this.setEnabled(false) },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Penpot MCP server at {0}", this.url()) });
    await pick?.run();
  }

  private async copySetup() {
    const port = this.server?.running ? this.port : this.config().port;
    const cmd = `claude mcp add --transport http ${SERVER_NAME} http://127.0.0.1:${port}/mcp`;
    await vscode.env.clipboard.writeText(cmd);
    vscode.window.showInformationMessage(vscode.l10n.t("Copied: {0}", cmd));
  }

  private async listLocal() {
    const uris = await vscode.workspace.findFiles("**/*.penpot", EXCLUDE, 500);
    this.local.clear();
    const multi = (vscode.workspace.workspaceFolders?.length || 0) > 1;
    const out = uris
      .map((u) => ({ id: `local:${vscode.workspace.asRelativePath(u, multi)}`, uri: u }))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const f of out) this.local.set(f.id, f.uri);
    return out.map((f) => ({ id: f.id, path: f.uri.fsPath }));
  }

  private toolHost(): ToolHost {
    return {
      listLocal: () => this.listLocal(),
      listCloud: async () => {
        const api = await this.getApi();
        if (!api) return undefined;
        const out: { id: string; name: string; project: string; team: string }[] = [];
        for (const t of await api.getTeams()) {
          for (const p of await api.getProjects(t.id)) {
            for (const f of await api.getProjectFiles(p.id)) {
              out.push({ id: f.id, name: f.name, project: p.isDefault ? "Drafts" : p.name, team: t.isDefault ? "Your Penpot" : t.name });
            }
          }
        }
        return out;
      },
      source: async (design: string): Promise<DesignSource> => {
        if (design.startsWith("cloud:")) {
          const api = await this.getApi();
          if (!api) throw new Error("Not connected to Penpot (run “Penpot: Connect to Penpot…” in VS Code).");
          return new CloudSource(design, api, design.slice(6));
        }
        if (!design.startsWith("local:")) throw new Error(`Unknown design "${design}" (see list_designs).`);
        // Only files found in the workspace: a design id cannot point anywhere else on disk.
        if (!this.local.has(design)) await this.listLocal();
        const uri = this.local.get(design);
        if (!uri) throw new Error(`No ${design.slice(6)} in the workspace (see list_designs).`);
        return new LocalSource(
          design,
          async () => vscode.workspace.fs.readFile(uri),
          async (data) => {
            await vscode.workspace.fs.writeFile(uri, data);
            this.out.appendLine(`${new Date().toLocaleTimeString()} saved ${vscode.workspace.asRelativePath(uri)}`);
          },
        );
      },
      rasterize: (svg, w, h, caption) => this.raster.rasterize(svg, w, h, caption),
      edited: () => undefined,
    };
  }

  dispose() {
    void this.server?.stop();
    this.raster.dispose();
    this.status.dispose();
    this.out.dispose();
  }
}
