#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runProxy } from "./proxy/proxy.js";
import { Store, defaultDbPath } from "./store/store.js";

const HELP = `mcpwatch — flight recorder for AI agents (https://github.com/mcpwatch)

Usage:
  mcpwatch run [--name <server>] [--db <path>] -- <command> [args...]
      Run an MCP stdio server through the recording proxy. Everything before
      "--" configures mcpwatch; everything after is the real server command.

  mcpwatch sessions [--json] [--db <path>] [--limit <n>]
      List recorded sessions.

  mcpwatch calls <session-id> [--json] [--db <path>]
      List the calls captured in one session.

  mcpwatch --version | --help

Data lives in ~/.mcpwatch/mcpwatch.db (override with --db or MCPWATCH_DB).
`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version);
  } catch {
    return "unknown";
  }
}

interface ParsedFlags {
  flags: Map<string, string | true>;
  positional: string[];
}

function parseFlags(argv: string[], valueFlags: Set<string>): ParsedFlags {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        const value = argv[++i];
        if (value === undefined) fail(`missing value for --${name}`);
        flags.set(name, value);
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function fail(message: string): never {
  process.stderr.write(`mcpwatch: ${message}\n`);
  process.exit(2);
}

function cmdRun(argv: string[]): void {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) {
    fail(`"run" needs a server command after "--"\n\n${HELP}`);
  }
  const own = argv.slice(0, sep);
  const serverCmd = argv.slice(sep + 1);
  const { flags, positional } = parseFlags(own, new Set(["name", "db"]));
  if (positional.length > 0) fail(`unexpected argument "${positional[0]}" before "--"`);

  const command = serverCmd[0]!;
  const args = serverCmd.slice(1);
  const name = flags.get("name");
  runProxy({
    serverName: typeof name === "string" ? name : path.basename(command),
    command,
    args,
    dbPath: typeof flags.get("db") === "string" ? (flags.get("db") as string) : undefined,
  });
}

function openStore(flags: Map<string, string | true>): Store {
  const db = flags.get("db");
  return new Store(typeof db === "string" ? db : defaultDbPath());
}

function formatTs(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

function cmdSessions(argv: string[]): void {
  const { flags } = parseFlags(argv, new Set(["db", "limit"]));
  const limitFlag = Number(flags.get("limit"));
  const store = openStore(flags);
  const rows = store.listSessions(Number.isFinite(limitFlag) && limitFlag > 0 ? limitFlag : 20);
  store.close();

  if (flags.get("json") === true) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No sessions recorded yet. Wrap a server with: mcpwatch run -- <command>\n");
    return;
  }
  for (const row of rows) {
    const status =
      row.ended_at === null
        ? "running/unclosed"
        : `exit ${row.exit_code ?? `signal:${row.exit_signal ?? "?"}`}`;
    process.stdout.write(
      `${row.id}  ${row.server_name}  ${formatTs(row.started_at)}  ${status}  ` +
        `${row.calls} calls / ${row.frames} frames\n`,
    );
  }
}

function cmdCalls(argv: string[]): void {
  const { flags, positional } = parseFlags(argv, new Set(["db"]));
  const sessionId = positional[0];
  if (sessionId === undefined) fail(`"calls" needs a session id (see: mcpwatch sessions)`);
  const store = openStore(flags);
  const rows = store.listCalls(sessionId);
  store.close();

  if (flags.get("json") === true) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No calls found for that session id.\n");
    return;
  }
  for (const row of rows) {
    const label = row.tool_name ? `${row.method}(${row.tool_name})` : String(row.method);
    const duration = row.duration_ms === null ? "-" : `${Number(row.duration_ms).toFixed(1)}ms`;
    const error = row.error_message ? `  ${String(row.error_message).slice(0, 80)}` : "";
    process.stdout.write(`${String(row.status).padEnd(10)} ${duration.padStart(9)}  ${label}${error}\n`);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "run":
      return cmdRun(rest);
    case "sessions":
      return cmdSessions(rest);
    case "calls":
      return cmdCalls(rest);
    case "--version":
    case "-v":
      process.stdout.write(readVersion() + "\n");
      return;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

main();
