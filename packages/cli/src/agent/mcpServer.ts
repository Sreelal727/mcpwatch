import { NdjsonSplitter } from "../proxy/framing.js";
import { Store, defaultDbPath } from "../store/store.js";
import {
  findCalls,
  getCall,
  parseSince,
  recentFailures,
  serverHealth,
  stalledCalls,
} from "../query/insights.js";
import { costReport } from "../query/cost.js";
import { formatCalls, formatCost, formatFailures, formatHealth, formatStalled, ms, NO_DATA } from "./format.js";

/**
 * mcpwatch as an MCP server: the recorder, exposed to the coding agent that is
 * generating the traffic.
 *
 * The dashboard answers "what happened?" for a human who goes looking. This
 * answers the same question for the agent, in the moment, without the human
 * having to look anything up — the agent that just got an opaque error can read
 * its own flight recorder and explain itself.
 *
 * Implemented directly on the JSON-RPC framing we already have rather than the
 * MCP SDK: this is three methods, and a recording proxy people install globally
 * has no business dragging a server framework into its dependency tree. The
 * end-to-end test drives it with the real SDK client to prove compliance.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "mcpwatch";

/** Marks this process as mcpwatch's own MCP server so `init` never wraps it. */
export const AGENT_SERVER_MARKER = "MCPWATCH_AGENT_TOOLS";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (store: Store, args: Record<string, unknown>) => string;
}

const sinceProp = {
  type: "string",
  description: 'Time window, e.g. "30m", "6h", "7d". Default "6h".',
} as const;

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function windowOf(args: Record<string, unknown>, fallback = "6h"): { label: string; sinceMs: number } {
  const label = str(args, "since") ?? fallback;
  return { label, sinceMs: parseSince(label) };
}

function hasAnyData(store: Store): boolean {
  const row = store.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
  return row.n > 0;
}

export const TOOLS: ToolDef[] = [
  {
    name: "recent_failures",
    title: "Recent failed MCP calls",
    description:
      "Show MCP tool calls that recently failed, with the error message and the arguments that caused them. " +
      "Call this FIRST whenever an MCP tool call you just made returned an error, returned something unexpected, " +
      "or when the user says anything like 'that failed', 'why did that break', 'the server isn't working', or " +
      "'try again'. It sees the real request and response on the wire, including in-band tool errors that MCP " +
      "clients often surface to you only as vague text.",
    inputSchema: {
      type: "object",
      properties: {
        since: sinceProp,
        server: { type: "string", description: "Only this MCP server (see server_health for names)." },
        limit: { type: "number", description: "Max rows (default 10)." },
      },
    },
    run: (store, args) => {
      if (!hasAnyData(store)) return NO_DATA;
      const { label, sinceMs } = windowOf(args);
      const rows = recentFailures(store, {
        sinceMs,
        limit: num(args, "limit") ?? 10,
        server: str(args, "server"),
      });
      const stalled = stalledCalls(store, { sinceMs, limit: 5 }).filter((s) => s.session_ended);
      const parts = [formatFailures(rows, label)];
      const stalledText = formatStalled(stalled);
      if (stalledText !== "") parts.push("", stalledText);
      return parts.join("\n");
    },
  },
  {
    name: "server_health",
    title: "MCP server health",
    description:
      "Health of every MCP server on this machine: call volume, error rate, latency, crashes (with the server's " +
      "own stderr), and servers that corrupt the protocol by logging to stdout. Call this when a server's tools " +
      "are missing or unavailable, when a server keeps disconnecting, when the user says a server 'isn't working' " +
      "or 'won't connect', or before telling the user their MCP setup is fine.",
    inputSchema: {
      type: "object",
      properties: { since: sinceProp },
    },
    run: (store, args) => {
      if (!hasAnyData(store)) return NO_DATA;
      const { label, sinceMs } = windowOf(args, "24h");
      return formatHealth(serverHealth(store, sinceMs), label);
    },
  },
  {
    name: "token_costs",
    title: "What this MCP setup costs in tokens",
    description:
      "Itemise what the user's MCP servers cost in context tokens: the per-session tax each server " +
      "charges just by being configured (its tool definitions are injected into every session whether " +
      "used or not), the request/response traffic on top, and a ranked list of what to remove. Call this " +
      "when the user asks about token usage, context filling up, running out of context, slow or " +
      "expensive sessions, cutting their bill, or which MCP servers are worth keeping.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: 'Time window, e.g. "7d", "30d". Default "30d".' },
        usd_per_million: {
          type: "number",
          description: "Token price used for the dollar estimates (default 5).",
        },
      },
    },
    run: (store, args) => {
      if (!hasAnyData(store)) return NO_DATA;
      const label = str(args, "since") ?? "30d";
      const rate = num(args, "usd_per_million") ?? 5;
      return formatCost(costReport(store, { sinceMs: parseSince(label) }), label, rate);
    },
  },
  {
    name: "find_calls",
    title: "Search recorded MCP calls",
    description:
      "Search recorded MCP calls by tool name, server, status, or free text inside the request/response payloads. " +
      "Use it to answer questions about what actually happened: whether a tool was ever called, what arguments were " +
      "used the last time it worked, which server returned a particular string, or how slow a tool has been. " +
      'Set status="error" for failures only, or status="pending" for calls that never got a response.',
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Substring to find in the recorded request or response payload." },
        tool: { type: "string", description: "Exact tool name, e.g. 'read_file'." },
        server: { type: "string", description: "MCP server name." },
        method: { type: "string", description: "JSON-RPC method, e.g. 'tools/call', 'tools/list'." },
        status: {
          type: "string",
          enum: ["ok", "error", "rpc_error", "tool_error", "pending"],
          description: '"error" matches both rpc_error and tool_error.',
        },
        since: sinceProp,
        limit: { type: "number", description: "Max rows (default 20)." },
      },
    },
    run: (store, args) => {
      if (!hasAnyData(store)) return NO_DATA;
      const { label, sinceMs } = windowOf(args, "7d");
      const rows = findCalls(store, {
        sinceMs,
        limit: num(args, "limit") ?? 20,
        server: str(args, "server"),
        tool: str(args, "tool"),
        method: str(args, "method"),
        status: str(args, "status"),
        text: str(args, "text"),
      });
      const filters = ["tool", "server", "method", "status", "text"]
        .map((k) => (str(args, k) === undefined ? null : `${k}="${str(args, k)!}"`))
        .filter((f): f is string => f !== null);
      return formatCalls(rows, `${filters.join(" ") || "any call"} in the last ${label}`);
    },
  },
  {
    name: "get_call",
    title: "Full payloads for one call",
    description:
      "Return the complete recorded request and response JSON for one call id (the [#123] shown by the other " +
      "tools). Use it when the summary is not enough — to see the exact arguments you sent, the full error object, " +
      "or the response shape a server actually returns so you can fix a call instead of guessing.",
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "number", description: "Call id from recent_failures/find_calls." } },
      required: ["call_id"],
    },
    run: (store, args) => {
      const callId = num(args, "call_id");
      if (callId === undefined) throw new Error("call_id (number) is required");
      const call = getCall(store, callId);
      if (call === undefined) {
        throw new Error(`No call #${callId}. Use recent_failures or find_calls to get a valid id.`);
      }
      const label = call.tool_name ? `${call.server}/${call.tool_name}` : `${call.server} ${call.method}`;
      const lines = [
        `Call #${call.call_id} — ${label}`,
        `status ${call.status} · ${ms(call.duration_ms)} · session ${call.session_id.slice(0, 8)}`,
      ];
      if (call.error_message) lines.push(`error: ${call.error_message}`);
      lines.push(
        "",
        `REQUEST${call.request_truncated ? " (truncated by size cap)" : ""}:`,
        call.request ?? "(not recorded)",
        "",
        `RESPONSE${call.response_truncated ? " (truncated by size cap)" : ""}:`,
        call.response ?? "(no response was ever recorded — the call hung or the server died mid-call)",
      );
      return lines.join("\n");
    },
  },
];

export interface HandleResult {
  /** Absent for notifications, which take no reply. */
  response?: Record<string, unknown>;
}

/** Pure request handler — the transport-free core, so tests can drive it directly. */
export function handleRequest(store: Store, req: JsonRpcRequest, version: string): HandleResult {
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;
  const reply = (result: Record<string, unknown>): HandleResult =>
    isNotification ? {} : { response: { jsonrpc: "2.0", id, result } };
  const error = (code: number, message: string): HandleResult =>
    isNotification ? {} : { response: { jsonrpc: "2.0", id, error: { code, message } } };

  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      const negotiated =
        typeof asked === "string" && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL_VERSION;
      return reply({
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version },
        instructions:
          "mcpwatch is the flight recorder for this machine's MCP traffic. When an MCP tool call fails or " +
          "behaves oddly, call recent_failures before guessing; when a server seems missing or broken, call " +
          "server_health. These read a local recording of the real wire traffic, so they are ground truth.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return {};
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = req.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) return error(-32602, `Unknown tool "${String(name)}"`);
      const args =
        typeof req.params?.arguments === "object" && req.params.arguments !== null
          ? (req.params.arguments as Record<string, unknown>)
          : {};
      try {
        return reply({ content: [{ type: "text", text: tool.run(store, args) }], isError: false });
      } catch (err) {
        // Tool-level failures belong in the result, not the protocol: the agent
        // should read the message and adjust, not see a transport error.
        return reply({
          content: [{ type: "text", text: `mcpwatch: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
    }
    default:
      return error(-32601, `Method not found: ${String(req.method)}`);
  }
}

export interface AgentServerOptions {
  dbPath?: string;
  version: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

/**
 * Run the stdio MCP server. Stdout carries protocol frames and nothing else —
 * the failure mode this very tool exists to detect.
 */
export function runAgentServer(opts: AgentServerOptions): { close: () => void } {
  const store = new Store(opts.dbPath ?? defaultDbPath());
  const input = opts.stdin ?? process.stdin;
  const output = opts.stdout ?? process.stdout;
  const splitter = new NdjsonSplitter();

  const send = (message: Record<string, unknown>): void => {
    output.write(JSON.stringify(message) + "\n");
  };

  const onFrame = (raw: string, json: unknown): void => {
    if (raw.trim() === "") return;
    if (json === undefined) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const messages = Array.isArray(json) ? json : [json];
    for (const message of messages) {
      const { response } = handleRequest(store, message as JsonRpcRequest, opts.version);
      if (response !== undefined) send(response);
    }
  };

  const onData = (chunk: Buffer): void => {
    for (const frame of splitter.push(chunk)) onFrame(frame.raw, frame.json);
  };
  const onEnd = (): void => {
    for (const frame of splitter.flush()) onFrame(frame.raw, frame.json);
    close();
    process.exit(0);
  };

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    input.off("data", onData);
    try {
      store.close();
    } catch {
      /* nothing useful to do while shutting down */
    }
  };

  input.on("data", onData);
  input.once("end", onEnd);
  input.once("close", onEnd);
  process.on("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    close();
    process.exit(0);
  });

  return { close };
}
