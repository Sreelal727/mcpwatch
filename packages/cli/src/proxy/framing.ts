/**
 * MCP stdio transport framing: UTF-8 JSON-RPC messages delimited by newlines,
 * with no embedded newlines inside a message.
 *
 * The splitter only ever sees *copies* of the traffic. It must never throw on
 * garbage input — servers that write logs to stdout are a real (and diagnosable)
 * failure mode we want to record, not crash on.
 */

export interface Frame {
  /** The raw line, without the trailing newline. */
  raw: string;
  /** Parsed JSON value, absent when the line is not valid JSON. */
  json?: unknown;
  /** True when the line exceeded maxLineBytes and was dropped from capture. */
  overflow: boolean;
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export class NdjsonSplitter {
  private buffer = "";
  private overflowing = false;
  private readonly maxLineBytes: number;

  constructor(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  /** Feed a chunk of the stream; returns any complete frames it terminated. */
  push(chunk: Buffer | string): Frame[] {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const frames: Frame[] = [];
    let start = 0;

    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl === -1) break;
      const part = text.slice(start, nl);
      start = nl + 1;
      if (this.overflowing) {
        // This newline terminates a line we already gave up on capturing.
        this.overflowing = false;
        frames.push({ raw: "", overflow: true });
      } else {
        frames.push(this.toFrame(this.buffer + part));
        this.buffer = "";
      }
    }

    const rest = text.slice(start);
    if (!this.overflowing) {
      this.buffer += rest;
      if (this.buffer.length > this.maxLineBytes) {
        this.buffer = "";
        this.overflowing = true;
      }
    }
    return frames;
  }

  /** Flush a trailing unterminated line (stream ended without a newline). */
  flush(): Frame[] {
    if (this.overflowing) {
      this.overflowing = false;
      return [{ raw: "", overflow: true }];
    }
    if (this.buffer.length === 0) return [];
    const frame = this.toFrame(this.buffer);
    this.buffer = "";
    return [frame];
  }

  private toFrame(raw: string): Frame {
    // Trailing \r tolerated for servers that emit \r\n.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) return { raw: line, overflow: false };
    try {
      return { raw: line, json: JSON.parse(line), overflow: false };
    } catch {
      return { raw: line, overflow: false };
    }
  }
}

export type RpcKind = "request" | "response" | "notification" | "invalid";

export interface RpcInfo {
  kind: RpcKind;
  method?: string;
  /** JSON-RPC id normalized to a string (ids may be numbers or strings). */
  rpcId?: string;
  /** For tools/call requests: params.name. */
  toolName?: string;
  isErrorResponse?: boolean;
}

/** Classify a parsed frame as a JSON-RPC request/response/notification. */
export function classifyRpc(json: unknown): RpcInfo {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { kind: "invalid" };
  }
  const msg = json as Record<string, unknown>;
  const hasId = msg.id !== undefined && msg.id !== null;
  const rpcId = hasId ? String(msg.id) : undefined;

  if (typeof msg.method === "string") {
    let toolName: string | undefined;
    if (msg.method === "tools/call" && typeof msg.params === "object" && msg.params !== null) {
      const name = (msg.params as Record<string, unknown>).name;
      if (typeof name === "string") toolName = name;
    }
    return hasId
      ? { kind: "request", method: msg.method, rpcId, toolName }
      : { kind: "notification", method: msg.method, toolName };
  }

  if (hasId && ("result" in msg || "error" in msg)) {
    return { kind: "response", rpcId, isErrorResponse: "error" in msg };
  }

  return { kind: "invalid" };
}
