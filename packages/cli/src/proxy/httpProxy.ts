import http from "node:http";
import { SessionRecorder } from "./recorder.js";
import { Redactor } from "./redact.js";
import type { Frame } from "./framing.js";
import type { Direction } from "../store/store.js";

/**
 * Recording reverse proxy for Streamable HTTP MCP servers: point the client
 * at 127.0.0.1:<port>, we forward to the real server and tee every JSON-RPC
 * message (plain JSON responses and SSE streams alike) into the recorder.
 *
 * One mcpwatch session per proxy process; concurrent protocol sessions are
 * disambiguated for request/response pairing via the Mcp-Session-Id header.
 */

export interface HttpProxyOptions {
  target: string;
  serverName: string;
  host?: string;
  port?: number;
  dbPath?: string;
  redactor?: Redactor | null;
}

export interface HttpProxy {
  server: http.Server;
  recorder: SessionRecorder;
  close(): Promise<void>;
}

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  // fetch negotiates its own encoding and transparently decompresses.
  "accept-encoding",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
]);

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** SSE stream parser: emits the data payload of each completed event. */
export class SseSplitter {
  private buffer = "";
  private dataLines: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.dataLines.length > 0) events.push(this.dataLines.join("\n"));
        this.dataLines = [];
      } else if (line.startsWith("data:")) {
        this.dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // event:, id:, retry:, and comment lines carry no JSON-RPC payload.
    }
    return events;
  }
}

function toFrame(raw: string): Frame {
  try {
    return { raw, json: JSON.parse(raw), overflow: false };
  } catch {
    return { raw, overflow: false };
  }
}

/** Record an HTTP body: a single JSON-RPC message or a batch array. */
function recordBody(recorder: SessionRecorder, direction: Direction, text: string, scope: string): void {
  const frame = toFrame(text.trim());
  if (Array.isArray(frame.json)) {
    for (const message of frame.json) {
      recorder.recordFrame(direction, { raw: JSON.stringify(message), json: message, overflow: false }, scope);
    }
  } else if (frame.raw.length > 0) {
    recorder.recordFrame(direction, frame, scope);
  }
}

export function createHttpProxy(options: HttpProxyOptions): HttpProxy {
  const recorder = new SessionRecorder({
    serverName: options.serverName,
    command: options.target,
    args: [],
    dbPath: options.dbPath,
    redactor: options.redactor === undefined ? Redactor.fromEnv() : options.redactor,
  });
  recorder.open();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    const requestScope = String(req.headers["mcp-session-id"] ?? "");
    if (body.length > 0) recordBody(recorder, "c2s", body.toString("utf8"), requestScope);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (SKIP_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
    }

    const upstream = await fetch(options.target, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
      signal: abort.signal,
    });

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!SKIP_RESPONSE_HEADERS.has(key)) responseHeaders[key] = value;
    });
    res.writeHead(upstream.status, responseHeaders);

    const responseScope = upstream.headers.get("mcp-session-id") ?? requestScope;
    const contentType = upstream.headers.get("content-type") ?? "";

    if (upstream.body === null) {
      res.end();
      return;
    }

    if (contentType.includes("text/event-stream")) {
      const splitter = new SseSplitter();
      const decoder = new TextDecoder();
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        for (const data of splitter.push(decoder.decode(value, { stream: true }))) {
          recordBody(recorder, "s2c", data, responseScope);
        }
      }
      res.end();
    } else {
      const payload = Buffer.from(await upstream.arrayBuffer());
      if (payload.length > 0 && contentType.includes("json")) {
        recordBody(recorder, "s2c", payload.toString("utf8"), responseScope);
      }
      res.end(payload);
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (abortLike(err)) return;
      process.stderr.write(`[mcpwatch] http proxy error: ${String(err)}\n`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: `mcpwatch: upstream ${options.target} unreachable` }));
      }
    });
  });

  server.listen(options.port ?? 4681, options.host ?? "127.0.0.1");

  return {
    server,
    recorder,
    close(): Promise<void> {
      recorder.finish({ exitCode: 0, exitSignal: null, stderrTail: null });
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function abortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}
