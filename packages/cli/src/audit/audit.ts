import { spawn } from "node:child_process";
import { NdjsonSplitter } from "../proxy/framing.js";
import { estimateTokens } from "../query/cost.js";
import { listConfiguredServers, type ConfiguredServer } from "../instrument/instrument.js";

/**
 * The instant audit: what your configured MCP servers cost per session, with
 * no instrumentation, no client restart, and no waiting for a day of traffic.
 *
 * The per-session tax is knowable without recording anything — it is just the
 * size of each server's tools/list response, which is exactly what a client
 * loads into the model's context on every start. So we do what the client
 * does: launch the server, complete the handshake, ask for its tools, measure
 * the answer, and shut it down. Ten seconds instead of a day.
 *
 * `mcpwatch cost` still answers the harder question afterwards — which of
 * these you actually *use* — because that genuinely requires recording.
 */

export interface AuditResult {
  name: string;
  client: string;
  ok: boolean;
  /** Bytes of the tools/list response: what a session pays to load this server. */
  definition_bytes: number;
  definition_tokens: number;
  tool_count: number;
  /** Milliseconds from spawn to a usable tool list — the client's startup cost. */
  startup_ms: number;
  remote: boolean;
  error?: string;
}

const HANDSHAKE_TIMEOUT_MS = 20_000;

interface Probe {
  bytes: number;
  tools: number;
  ms: number;
}

/** Launch one server, complete an MCP handshake, and measure its tool list. */
export function probeServer(server: ConfiguredServer, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const splitter = new NdjsonSplitter();
    let settled = false;
    let stderrTail = "";

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
        // Some servers ignore SIGTERM; don't leave one running behind us.
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1500).unref();
      } catch {
        /* already gone */
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `no tool list after ${Math.round(timeoutMs / 1000)}s` +
              (stderrTail.trim() === "" ? "" : `: ${stderrTail.trim().slice(-160)}`),
          ),
        ),
      );
    }, timeoutMs);

    const send = (message: unknown): void => {
      try {
        child.stdin.write(JSON.stringify(message) + "\n");
      } catch {
        /* handled by close/error */
      }
    };

    child.on("error", (err) => finish(() => reject(new Error(`could not start: ${err.message}`))));
    child.on("close", () =>
      finish(() =>
        reject(
          new Error(
            `exited before answering` +
              (stderrTail.trim() === "" ? "" : `: ${stderrTail.trim().slice(-160)}`),
          ),
        ),
      ),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      for (const frame of splitter.push(chunk)) {
        if (frame.json === undefined) continue; // servers that log to stdout
        const msg = frame.json as { id?: unknown; result?: { tools?: unknown[] } };
        if (msg.id === 1 && msg.result !== undefined) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          continue;
        }
        if (msg.id === 2 && msg.result !== undefined) {
          const tools = Array.isArray(msg.result.tools) ? msg.result.tools.length : 0;
          finish(() =>
            resolve({
              bytes: Buffer.byteLength(frame.raw, "utf8"),
              tools,
              ms: Date.now() - startedAt,
            }),
          );
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcpwatch-audit", version: "1" },
      },
    });
  });
}

export interface AuditOptions {
  home?: string;
  cwd?: string;
  concurrency?: number;
  timeoutMs?: number;
  servers?: ConfiguredServer[];
  /** Called as each server finishes, for progress output. */
  onResult?: (result: AuditResult) => void;
}

/** Probe every configured stdio server and price its per-session tax. */
export async function auditServers(options: AuditOptions = {}): Promise<AuditResult[]> {
  const servers = options.servers ?? listConfiguredServers(options.home, options.cwd);
  const limit = Math.max(1, options.concurrency ?? 4);
  const results: AuditResult[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const server = servers[index];
      if (server === undefined) return;

      let result: AuditResult;
      if (server.remote) {
        result = {
          name: server.name,
          client: server.client,
          ok: false,
          definition_bytes: 0,
          definition_tokens: 0,
          tool_count: 0,
          startup_ms: 0,
          remote: true,
          error: "remote server (not launched locally)",
        };
      } else {
        try {
          const probe = await probeServer(server, options.timeoutMs);
          result = {
            name: server.name,
            client: server.client,
            ok: true,
            definition_bytes: probe.bytes,
            definition_tokens: estimateTokens(probe.bytes),
            tool_count: probe.tools,
            startup_ms: probe.ms,
            remote: false,
          };
        } catch (err) {
          result = {
            name: server.name,
            client: server.client,
            ok: false,
            definition_bytes: 0,
            definition_tokens: 0,
            tool_count: 0,
            startup_ms: 0,
            remote: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      results[index] = result;
      options.onResult?.(result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, servers.length) }, worker));
  return results.filter((r) => r !== undefined);
}
