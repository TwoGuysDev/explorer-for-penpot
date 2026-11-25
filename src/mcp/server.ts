// A small MCP server over Streamable HTTP (JSON responses, no SSE), listening on 127.0.0.1 only.
// Requests from web pages are refused (Origin check), so a site cannot drive it through the browser.
// No VS Code imports here, so it can be unit-tested with plain Node.
import * as http from "node:http";
import { INSTRUCTIONS, TOOLS, Tools } from "./tools";

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 8 * 1024 * 1024;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }

export class McpServer {
  private server: http.Server | undefined;

  constructor(
    private readonly tools: Tools,
    private readonly info: { name: string; version: string },
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  get running() {
    return !!this.server?.listening;
  }

  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.onRequest(req, res));
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, body === undefined ? headers : { "Content-Type": "application/json", ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!LOCAL_HOSTS.has(host)) return send(403, { error: "Only local requests are accepted." });
    const origin = req.headers.origin;
    if (origin && !/^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?|vscode-webview:\/\/.*|null)$/.test(origin)) {
      return send(403, { error: "Requests from web pages are not accepted." });
    }
    const path = (req.url || "/").split("?")[0];
    if (path !== "/mcp") return send(404, { error: "Not found. The MCP endpoint is /mcp." });
    if (req.method === "GET" || req.method === "DELETE") return send(405, undefined, { Allow: "POST" });
    if (req.method !== "POST") return send(405, undefined, { Allow: "POST" });

    let raw = "";
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: String(err instanceof Error ? err.message : err) } });
    }
    let msg: RpcMessage | RpcMessage[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const list = Array.isArray(msg) ? msg : [msg];
    const out = (await Promise.all(list.map((m) => this.handle(m)))).filter((x) => x !== undefined);
    if (!out.length) return send(202);
    send(200, Array.isArray(msg) ? out : out[0]);
  }

  private async handle(m: RpcMessage): Promise<unknown> {
    if (!m || typeof m !== "object" || typeof m.method !== "string") {
      return m && "id" in m ? { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32600, message: "Invalid request" } } : undefined;
    }
    const isNotification = !("id" in m) || m.id === undefined;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id, error: { code, message } });
    try {
      switch (m.method) {
        case "initialize": {
          const asked = m.params?.protocolVersion;
          return reply({
            protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.info.name, title: "Explorer for Penpot", version: this.info.version },
            instructions: INSTRUCTIONS,
          });
        }
        case "ping":
          return isNotification ? undefined : reply({});
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call": {
          const name = String(m.params?.name || "");
          this.log(`tool ${name}`);
          const result = await this.tools.call(name, m.params?.arguments || {});
          if (result.isError) this.log(`tool ${name} failed: ${result.content.map((c) => (c.type === "text" ? c.text : "")).join(" ")}`);
          return reply(result);
        }
        default:
          if (isNotification) return undefined;
          return error(-32601, `Method not found: ${m.method}`);
      }
    } catch (err) {
      return isNotification ? undefined : error(-32603, err instanceof Error ? err.message : String(err));
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
