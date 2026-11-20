// Minimal client for the Penpot RPC API (POST /api/rpc/command/<name>, camelCase JSON).
// No VS Code imports here, so it can be unit-tested with plain Node.

export type PenpotErrorKind = "connection" | "auth" | "api";

export class PenpotError extends Error {
  constructor(
    message: string,
    readonly kind: PenpotErrorKind,
    readonly status = 0,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface Team {
  id: string;
  name: string;
  isDefault?: boolean;
}
export interface Project {
  id: string;
  teamId: string;
  name: string;
  isDefault?: boolean;
}
export interface FileSummary {
  id: string;
  projectId: string;
  name: string;
  modifiedAt?: string;
}
export interface Profile {
  id: string;
  fullname?: string;
  email?: string;
}
/** A Penpot shape as the API returns it (only the fields the extension reads are typed). */
export interface Shape {
  id: string;
  name: string;
  type: string;
  parentId?: string;
  frameId?: string;
  shapes?: string[];
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  hidden?: boolean;
  [key: string]: any;
}
export interface PageData {
  id: string;
  name: string;
  objects: Record<string, Shape>;
}
export interface FileData {
  id: string;
  name: string;
  projectId?: string;
  data?: {
    pages?: string[];
    pagesIndex?: Record<string, { id?: string; name?: string } | unknown>;
  };
}

export const ROOT_ID = "00000000-0000-0000-0000-000000000000";

/** Penpot answers requests with an unknown token as the anonymous user (all-zero id). */
export const isAnonymous = (p: Profile | undefined) => !p?.id || p.id === ROOT_ID;

export class PenpotApi {
  /** Base used for requests: "localhost" may resolve to ::1 (IPv6) while a Docker Penpot often listens on 127.0.0.1 only. */
  private apiBase: string;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.apiBase = baseUrl;
  }

  get url() {
    return this.baseUrl;
  }

  private authHeaders() {
    return { Authorization: `Token ${this.token}` };
  }

  /** fetch with a second attempt on 127.0.0.1 when "localhost" does not connect. */
  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, init);
    } catch (err) {
      const alt = this.apiBase.replace(/\/\/localhost(?=[:/]|$)/, "//127.0.0.1");
      if (alt === this.apiBase) throw err;
      const res = await this.fetchImpl(`${alt}${path}`, init);
      this.apiBase = alt;
      return res;
    }
  }

  async rpc<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.send(`/api/rpc/command/${command}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...this.authHeaders() },
        body: JSON.stringify(params),
      });
    } catch (err: any) {
      const cause = err?.cause?.code || err?.cause?.message || err?.message || String(err);
      throw new PenpotError(`Could not reach ${this.baseUrl} (${cause})`, "connection");
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const code = body?.code as string | undefined;
      if (code === "authentication-required" || res.status === 401) throw new PenpotError("Invalid or expired token", "auth", res.status, code);
      throw new PenpotError(body?.hint || body?.code || `HTTP ${res.status} on ${command}`, "api", res.status, code);
    }
    return body as T;
  }

  getProfile() {
    return this.rpc<Profile>("get-profile");
  }
  getTeams() {
    return this.rpc<Team[]>("get-teams");
  }
  getProjects(teamId: string) {
    return this.rpc<Project[]>("get-projects", { teamId });
  }
  getProjectFiles(projectId: string) {
    return this.rpc<FileSummary[]>("get-project-files", { projectId });
  }
  getFile(id: string) {
    return this.rpc<FileData>("get-file", { id });
  }
  /** Page data; with objectId, only that object and its descendants. */
  getPage(fileId: string, pageId: string, objectId?: string) {
    const params: Record<string, unknown> = { fileId, pageId };
    if (objectId) params.objectId = objectId;
    return this.rpc<PageData>("get-page", params);
  }
  /** Thumbnails the editor already generated: key "<fileId>/<pageId>/<objectId>/<tag>" → relative URL. */
  getThumbnails(fileId: string) {
    return this.rpc<Record<string, string>>("get-file-object-thumbnails", { fileId });
  }

  /** Downloads an asset with the token and returns it as a data URI (webviews cannot send the token). */
  async fetchDataUri(pathOrUrl: string, mime?: string): Promise<string | undefined> {
    try {
      const init = { headers: this.authHeaders() };
      const res = /^https?:/.test(pathOrUrl)
        ? await this.fetchImpl(pathOrUrl, init)
        : await this.send(`${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`, init);
      if (!res.ok) return undefined;
      const type = mime || res.headers.get("content-type") || "application/octet-stream";
      const buf = Buffer.from(await res.arrayBuffer());
      return `data:${type};base64,${buf.toString("base64")}`;
    } catch {
      return undefined;
    }
  }
  /** Image used by a fill (fillImage.id). */
  fileMediaDataUri(mediaId: string, mime?: string) {
    return this.fetchDataUri(`/assets/by-file-media-id/${mediaId}`, mime);
  }

  /** Link to open in the browser editor (board-id focuses a board). */
  workspaceUrl(teamId: string, fileId: string, pageId?: string, boardId?: string) {
    const q = new URLSearchParams({ "team-id": teamId, "file-id": fileId });
    if (pageId) q.set("page-id", pageId);
    if (boardId) q.set("board-id", boardId);
    return `${this.baseUrl}/#/workspace?${q.toString()}`;
  }
}
