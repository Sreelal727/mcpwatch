import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../store/store.js";

/**
 * The local dashboard server: JSON API + SSE change signal + static assets.
 *
 * Binds to 127.0.0.1 only — the dashboard is never exposed to the network.
 * Live updates are deliberately simple: the server polls the database's cheap
 * version tuple and emits a bare "changed" SSE event; clients refetch the
 * plain GET endpoints they care about. All data flows through testable HTTP
 * GETs, and a dropped SSE connection self-heals via EventSource reconnect.
 */

export interface UiServerOptions {
  store: Store;
  host?: string;
  port?: number;
  /** Directory of built frontend assets; omitted → API-only with a stub page. */
  uiDist?: string;
  pollMs?: number;
}

export interface UiServer {
  server: http.Server;
  close(): void;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function defaultUiDist(): string {
  return fileURLToPath(new URL("../../ui-dist", import.meta.url));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

const STUB_PAGE = `<!doctype html><meta charset="utf-8"><title>mcpwatch</title>
<body style="font-family:system-ui;background:#0b0e14;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>mcpwatch API is running</h1>
<p>The dashboard assets are not built. Run <code>npm run build</code> in the repo, or use the published package.</p></div>`;

export function createUiServer(options: UiServerOptions): UiServer {
  const { store } = options;
  const uiDist = options.uiDist ?? defaultUiDist();
  const uiDistReal = fs.existsSync(uiDist) ? fs.realpathSync(uiDist) : null;
  const sseClients = new Set<http.ServerResponse>();

  let lastVersion = "";
  const poll = setInterval(() => {
    let version: string;
    try {
      version = store.version();
    } catch {
      return;
    }
    if (version === lastVersion) return;
    lastVersion = version;
    for (const client of sseClients) client.write(`event: changed\ndata: {}\n\n`);
  }, options.pollMs ?? 400);
  poll.unref();
  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(`: keepalive\n\n`);
  }, 15_000);
  heartbeat.unref();

  const serveStatic = (urlPath: string, res: http.ServerResponse): void => {
    if (uiDistReal === null) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(STUB_PAGE);
      return;
    }
    const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
    let filePath = path.resolve(uiDistReal, rel);
    if (!filePath.startsWith(uiDistReal + path.sep) && filePath !== uiDistReal) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback: unknown paths get the app shell.
      filePath = path.join(uiDistReal, "index.html");
      if (!fs.existsSync(filePath)) {
        res.writeHead(404).end("not found");
        return;
      }
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "cache-control": urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (p === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (p === "/api/sessions") {
      const limit = Number(url.searchParams.get("limit"));
      sendJson(res, 200, store.listSessions(Number.isFinite(limit) && limit > 0 ? limit : 50));
      return;
    }

    const sessionMatch = p.match(/^\/api\/sessions\/([0-9a-f-]+)$/);
    if (sessionMatch !== null) {
      const session = store.getSession(sessionMatch[1]!);
      if (session === undefined) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      sendJson(res, 200, {
        session,
        calls: store.listCalls(session.id),
        garbage: store.listGarbageFrames(session.id),
      });
      return;
    }

    const callMatch = p.match(/^\/api\/calls\/(\d+)$/);
    if (callMatch !== null) {
      const detail = store.getCallDetail(Number(callMatch[1]));
      if (detail === undefined) {
        sendJson(res, 404, { error: "call not found" });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (p.startsWith("/api/")) {
      sendJson(res, 404, { error: "unknown endpoint" });
      return;
    }

    serveStatic(p, res);
  });

  server.listen(options.port ?? 4680, options.host ?? "127.0.0.1");

  return {
    server,
    close(): void {
      clearInterval(poll);
      clearInterval(heartbeat);
      for (const client of sseClients) client.end();
      sseClients.clear();
      server.close();
    },
  };
}
