// User-facing text for errors and preview notes (translated with vscode.l10n).
import * as vscode from "vscode";
import { PenpotError } from "./api";
import type { RenderWarning } from "./render";

export function describeError(err: unknown): string {
  if (err instanceof PenpotError) {
    switch (err.kind) {
      case "connection":
        return vscode.l10n.t("{0}. Is Penpot running and is the server address right?", err.message);
      case "blocked":
        return vscode.l10n.t("The Penpot server blocked the request with a browser check. Try again later; if it keeps happening, please open an issue.");
      case "auth":
        return vscode.l10n.t("The token is invalid or expired. Run “Penpot: Connect to Penpot…” with a new token.");
      default:
        return vscode.l10n.t("Penpot answered with an error: {0}", err.message);
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function describeWarning(w: RenderWarning): string {
  switch (w.kind) {
    case "image":
      return vscode.l10n.t("some images did not load");
    case "type":
      return vscode.l10n.t("not drawn: {0}", w.detail || "?");
  }
}
