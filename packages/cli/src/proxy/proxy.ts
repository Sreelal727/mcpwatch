import { spawn } from "node:child_process";
import { NdjsonSplitter } from "./framing.js";
import { SessionRecorder } from "./recorder.js";
import { Redactor } from "./redact.js";
import type { Direction } from "../store/store.js";

export interface ProxyOptions {
  serverName: string;
  command: string;
  args: string[];
  dbPath?: string;
  /** undefined → resolve from environment; null → redaction off. */
  redactor?: Redactor | null;
}

const STDERR_TAIL_LIMIT = 4096;

/**
 * Run the transparent stdio proxy: spawn the real MCP server, pass all stdio
 * through untouched, and tee both directions into the capture recorder.
 *
 * Passthrough is sacred: piping is wired independently of capture, and every
 * capture-side operation is guarded so a recording failure can never interrupt
 * or alter the protocol stream.
 */
export function runProxy(opts: ProxyOptions): void {
  const recorder = new SessionRecorder({
    serverName: opts.serverName,
    command: opts.command,
    args: opts.args,
    dbPath: opts.dbPath,
    redactor: opts.redactor === undefined ? Redactor.fromEnv() : opts.redactor,
  });
  recorder.open();

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
  const splitters: Record<Direction, NdjsonSplitter> = {
    c2s: new NdjsonSplitter(),
    s2c: new NdjsonSplitter(),
  };
  const stderrChunks: string[] = [];
  let stderrLen = 0;

  process.stdin.on("data", (chunk: Buffer) => {
    for (const frame of splitters.c2s.push(chunk)) recorder.recordFrame("c2s", frame);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    for (const frame of splitters.s2c.push(chunk)) recorder.recordFrame("s2c", frame);
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
    for (const frame of splitters.c2s.flush()) recorder.recordFrame("c2s", frame);
    for (const frame of splitters.s2c.flush()) recorder.recordFrame("s2c", frame);
    recorder.finish({
      exitCode,
      exitSignal,
      stderrTail: stderrChunks.length > 0 ? stderrChunks.join("").slice(-STDERR_TAIL_LIMIT) : null,
    });
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
