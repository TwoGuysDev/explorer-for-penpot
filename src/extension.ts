// Explorer for Penpot: a sidebar with your Penpot designs and a preview for boards.
import * as vscode from "vscode";
import { PenpotApi, PenpotError, isAnonymous } from "./api";
import { describeError } from "./messages";
import { PenpotFileEditor } from "./fileEditor";
import { LocalNode, LocalTree } from "./localTree";
import { McpHost } from "./mcpHost";
import { PreviewPanel } from "./preview";
import { PenpotNode, PenpotTree } from "./tree";

const SECRET_KEY = "penpotExplorer.accessToken";
const CLOUD_URL = "https://design.penpot.app";

const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, "");

export function activate(ctx: vscode.ExtensionContext) {
  let cached: { key: string; api: PenpotApi } | undefined;

  const serverUrl = () => normalizeUrl(vscode.workspace.getConfiguration("penpotExplorer").get<string>("serverUrl") || CLOUD_URL);

  /** API using the token kept in VS Code's secret storage (undefined when not connected). */
  const getApi = async () => {
    const token = await ctx.secrets.get(SECRET_KEY);
    await vscode.commands.executeCommand("setContext", "penpotExplorer.hasToken", !!token);
    if (!token) return undefined;
    const key = `${serverUrl()}|${token}`;
    if (cached?.key !== key) cached = { key, api: new PenpotApi(serverUrl(), token) };
    return cached.api;
  };

  ctx.subscriptions.push(PenpotFileEditor.register(ctx));

  // MCP server for AI assistants (off until enabled in the settings or with “Penpot: Start MCP Server”).
  new McpHost(ctx, getApi);

  // .penpot files in the workspace (offline, no token needed).
  const localTree = new LocalTree();
  localTree.view = vscode.window.createTreeView("penpotExplorer.localFiles", { treeDataProvider: localTree, showCollapseAll: true });
  ctx.subscriptions.push(
    localTree.view,
    localTree.watch(),
    vscode.commands.registerCommand("penpotExplorer.refreshLocal", () => localTree.refresh()),
    vscode.commands.registerCommand("penpotExplorer.openLocal", (arg?: LocalNode | vscode.Uri) => {
      if (arg instanceof vscode.Uri) return PenpotFileEditor.open(arg);
      if (!arg?.uri) return;
      // A page opens as a whole; a board opens at that board; a file opens at its first board.
      const target = arg.kind === "localPage" ? { ...arg.target, boardId: "" } : arg.target;
      return PenpotFileEditor.open(arg.uri, target);
    }),
  );

  const tree = new PenpotTree(getApi);
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider("penpotExplorer.tree", tree));
  void getApi(); // sets penpotExplorer.hasToken for the welcome view

  /** Asks which Penpot to use: Penpot Cloud, the current one or another address. */
  const pickServer = async (): Promise<string | undefined> => {
    const current = serverUrl();
    const items: (vscode.QuickPickItem & { url?: string })[] = [
      { label: "Penpot Cloud", description: CLOUD_URL, url: CLOUD_URL },
    ];
    if (current !== CLOUD_URL) items.push({ label: vscode.l10n.t("Current server"), description: current, url: current });
    items.push({ label: vscode.l10n.t("Self-hosted Penpot…"), description: vscode.l10n.t("Enter the address") });
    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Which Penpot do you use?"),
      placeHolder: current,
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.url) return pick.url;
    const url = await vscode.window.showInputBox({
      title: vscode.l10n.t("Address of your Penpot"),
      value: current === CLOUD_URL ? "http://localhost:9001" : current,
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : vscode.l10n.t("Use a full address, like http://localhost:9001")),
    });
    return url ? normalizeUrl(url) : undefined;
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("penpotExplorer.connect", async () => {
      const url = await pickServer();
      if (!url) return;
      const token = await vscode.window.showInputBox({
        title: vscode.l10n.t("Penpot access token"),
        prompt: vscode.l10n.t("Create one in {0} → Your account → Integrations → Access tokens", url),
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t("Paste the token")),
      });
      if (!token) return;
      const probe = new PenpotApi(url, token.trim());
      try {
        const me = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Checking the token…") },
          () => probe.getProfile(),
        );
        // An invalid token is not an error for Penpot: it answers with the anonymous user.
        if (isAnonymous(me)) throw new PenpotError(vscode.l10n.t("Penpot did not recognize this token (check that it was copied whole and has not expired)."), "auth", 401);
        await vscode.workspace.getConfiguration("penpotExplorer").update("serverUrl", url, vscode.ConfigurationTarget.Global);
        await ctx.secrets.store(SECRET_KEY, token.trim());
        cached = undefined;
        await getApi();
        tree.refresh();
        vscode.window.showInformationMessage(
          me.fullname ? vscode.l10n.t("Connected to Penpot as {0}.", me.fullname) : vscode.l10n.t("Connected to Penpot."),
        );
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t("Could not connect: {0}", describeError(err)));
      }
    }),

    vscode.commands.registerCommand("penpotExplorer.disconnect", async () => {
      await ctx.secrets.delete(SECRET_KEY);
      cached = undefined;
      await getApi();
      tree.refresh();
    }),

    vscode.commands.registerCommand("penpotExplorer.refresh", () => tree.refresh()),

    vscode.commands.registerCommand("penpotExplorer.openInBrowser", async (node?: PenpotNode) => {
      const api = await getApi();
      if (!api || !node?.ids.teamId || !node.ids.fileId) return;
      const { teamId, fileId, pageId, frameId } = node.ids;
      void vscode.env.openExternal(vscode.Uri.parse(api.workspaceUrl(teamId, fileId, pageId, frameId)));
    }),

    vscode.commands.registerCommand("penpotExplorer.preview", async (node?: PenpotNode) => {
      const api = await getApi();
      if (!api || !node) return;
      PreviewPanel.show(ctx, api, tree, node);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("penpotExplorer.serverUrl")) {
        cached = undefined;
        tree.refresh();
      }
    }),
  );
}

export function deactivate() {}
