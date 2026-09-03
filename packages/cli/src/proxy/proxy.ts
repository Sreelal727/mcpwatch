import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { NdjsonSplitter, classifyRpc, type Frame } from "./framing.js";
import { Store, type CallStatus, type Direction } from "../store/store.js";

export interface ProxyOptions {
  serverName: string;
  command: string;
  args: string[];
  dbPath?: string;
}

const STDERR_TAIL_LIMIT = 4096;

function storedFrameLimit(): number {
  const env = Number(process.env.MCPWATCH_MAX_FRAME_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 512 * 1024;
}

/** Best-effort extraction of a short error message from a tool result. */
function toolErrorMessage(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const rec = item as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") return rec.text.slice(0, 500);
    }
  }
  return undefined;
}

/**
 * Run the transparent proxy: spawn the real MCP server, pass all stdio through
 * untouched, and tee both directions into the capture store.
 *
 * Passthrough is sacred: piping is wired independently of capture, and every
 * capture-side operation is guarded so a recording failure can never interrupt
 * or alter the protocol stream.
 */
export function runProxy(opts: ProxyOptions): void {
  const sessionId = randomUUID();
  let store: Store | null = null;
  let captureBroken = false;

  const capture = (fn: (s: Store) => void): void => {
    if (captureBroken || store === null) return;
    try {
      fn(store);
    } catch (err) {
      captureBroken = true;
      process.stderr.write(
        `[mcpwatch] capture disabled (passthrough unaffected): ${String(err)}\n`,
      );
    }
  };

  try {
    store = new Store(opts.dbPath);
  } catch (err) {
    captureBroken = true;
    process.stderr.write(`[mcpwatch] could not open capture db (running uncaptured): ${String(err)}\n`);
  }

  capture((s) =>
    s.createSession({
      id: sessionId,
      serverName: opts.serverName,
      command: opts.command,
      args: opts.args,
      startedAt: Date.now(),
    }),
  );

  const child = spawn(opts.command, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  // --- Passthrough (wired first; capture hooks are additive listeners) ---
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  for (const stream of [child.stdin, process.stdout, process.stderr]) {
    stream.on("error", () => {
      /* EPIPE on either side of a closing session is expected; exit handling below. */
    });
  }
  process.stdin.on("error", () => {});

  // --- Capture ---
  const limit = storedFrameLimit();
  const splitters: Record<Direction, NdjsonSplitter> = {
    c2s: new NdjsonSplitter(),
    s2c: new NdjsonSplitter(),
  };
  // In-flight requests awaiting a response from the opposite direction.
  const pending: Record<Direction, Map<string, { callId: number; startedPerf: number }>> = {
    c2s: new Map(),
    s2c: new Map(),
  };
  const stderrChunks: string[] = [];
  let stderrLen = 0;

  const recordFrame = (direction: Direction, frame: Frame): void => {
    if (frame.overflow) {
      capture((s) =>
        s.insertFrame({
          sessionId,
          ts: Date.now(),
          direction,
          kind: "overflow",
          raw: "",
          truncated: true,
        }),
      );
      return;
    }
    if (frame.raw.trim().length === 0) return;

    const ts = Date.now();
    const truncated = frame.raw.length > limit;
    const raw = truncated ? frame.raw.slice(0, limit) : frame.raw;

    if (frame.json === undefined) {
      capture((s) => s.insertFrame({ sessionId, ts, direction, kind: "garbage", raw, truncated }));
      return;
    }

    const info = classifyRpc(frame.json);
    capture((s) => {
      const frameId = s.insertFrame({
        sessionId,
        ts,
        direction,
        kind: info.kind,
        method: info.method,
        rpcId: info.rpcId,
        toolName: info.toolName,
        raw,
        truncated,
      });

      if (info.kind === "request" && info.rpcId !== undefined && info.method !== undefined) {
        const callId = s.insertCall({
          sessionId,
          direction,
          method: info.method,
          toolName: info.toolName,
          rpcId: info.rpcId,
          startedAt: ts,
          endedAt: null,
          durationMs: null,
          status: "pending",
          requestFrameId: frameId,
        });
        pending[direction].set(info.rpcId, { callId, startedPerf: performance.now() });
      }

      if (info.kind === "response" && info.rpcId !== undefined) {
        const requestDirection: Direction = direction === "s2c" ? "c2s" : "s2c";
        const match = pending[requestDirection].get(info.rpcId);
        if (match !== undefined) {
          pending[requestDirection].delete(info.rpcId);
          const msg = frame.json as Record<string, unknown>;
          let status: CallStatus = "ok";
          let errorMessage: string | undefined;
          if (info.isErrorResponse) {
            status = "rpc_error";
            const error = msg.error as Record<string, unknown> | undefined;
            if (error && typeof error.message === "string") errorMessage = error.message.slice(0, 500);
          } else if (
            typeof msg.result === "object" &&
            msg.result !== null &&
            (msg.result as Record<string, unknown>).isError === true
          ) {
            status = "tool_error";
            errorMessage = toolErrorMessage(msg.result);
          }
          s.completeCall({
            callId: match.callId,
            endedAt: ts,
            durationMs: performance.now() - match.startedPerf,
            status,
            errorMessage,
            responseFrameId: frameId,
          });
        }
      }
    });
  };

  process.stdin.on("data", (chunk: Buffer) => {
    for (const frame of splitters.c2s.push(chunk)) recordFrame("c2s", frame);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    for (const frame of splitters.s2c.push(chunk)) recordFrame("s2c", frame);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrChunks.push(text);
    stderrLen += text.length;
    while (stderrLen > STDERR_TAIL_LIMIT && stderrChunks.length > 1) {
      stderrLen -= stderrChunks[0]!.length;
      stderrChunks.shift();
    }
  });

  // --- Lifecycle ---
  const forwardSignal = (signal: NodeJS.Signals): void => {
    process.on(signal, () => {
      child.kill(signal);
    });
  };
  forwardSignal("SIGINT");
  forwardSignal("SIGTERM");
  forwardSignal("SIGHUP");

  const finish = (exitCode: number | null, exitSignal: string | null): void => {
    for (const frame of splitters.c2s.flush()) recordFrame("c2s", frame);
    for (const frame of splitters.s2c.flush()) recordFrame("s2c", frame);
    capture((s) =>
      s.closeSession({
        id: sessionId,
        endedAt: Date.now(),
        exitCode,
        exitSignal,
        stderrTail: stderrChunks.length > 0 ? stderrChunks.join("").slice(-STDERR_TAIL_LIMIT) : null,
      }),
    );
    try {
      store?.close();
    } catch {
      /* already reported via capture guard */
    }
    process.exit(exitCode ?? (exitSignal !== null ? 1 : 0));
  };

  child.on("error", (err) => {
    process.stderr.write(`[mcpwatch] failed to start server "${opts.command}": ${String(err)}\n`);
    stderrChunks.push(String(err));
    finish(1, null);
  });
  child.on("exit", (code, signal) => {
    finish(code, signal);
  });
}
