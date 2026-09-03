#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runProxy } from "./proxy/proxy.js";
import { Store, defaultDbPath } from "./store/store.js";
import { spawn } from "node:child_process";
import { renderSessionHtml } from "./export/exportHtml.js";
import {
  instrumentInit,
  instrumentStatus,
  instrumentUnwrap,
} from "./instrument/instrument.js";
import { createHttpProxy } from "./proxy/httpProxy.js";
import { Redactor } from "./proxy/redact.js";
import { createUiServer } from "./server/ui.js";

const HELP = `mcpwatch — flight recorder for AI agents (https://github.com/Sreelal727/mcpwatch)

Usage:
  mcpwatch init [--dry-run]
      Instrument your MCP clients (Claude Desktop, Cursor, this project's
      .mcp.json): every stdio server is wrapped to run through the recording
      proxy. Timestamped backups are written next to each changed file.
      Restart your client afterwards. --dry-run only shows what would change.

  mcpwatch unwrap
      Undo init: restore every entry that is still wrapped to its original.

  mcpwatch status
      Show which configs are instrumented.

  mcpwatch ui [--port <n>] [--db <path>] [--no-open]
      Open the local dashboard (default http://127.0.0.1:4680). Local-only:
      the server binds 127.0.0.1 and your data never leaves this machine.

  mcpwatch run [--name <server>] [--db <path>] [--no-redact] -- <command> [args...]
      Run one MCP stdio server through the recording proxy directly.
      Everything after "--" is the real server command.

  mcpwatch http <target-url> [--port <n>] [--name <server>] [--db <path>] [--no-redact]
      Recording reverse proxy for a Streamable HTTP MCP server: point your
      client at http://127.0.0.1:<port> (default 4681) instead of the target.

  mcpwatch export <session-id> [--out <file>] [--db <path>]
      Export one session as a single self-contained HTML file (shareable
      bug report). <session-id> may be a unique prefix.

  mcpwatch gc [--keep-days <n>] [--keep-sessions <n>] [--db <path>]
      Delete old sessions (default: keep 30 days) and compact the database.

  mcpwatch sessions [--json] [--db <path>] [--limit <n>]
      List recorded sessions.

  mcpwatch calls <session-id> [--json] [--db <path>]
      List the calls captured in one session.

  mcpwatch --version | --help

Data lives in ~/.mcpwatch/mcpwatch.db (override with --db or MCPWATCH_DB).
Secrets (API keys, bearer tokens, password fields) are redacted from the
stored copy by default — never from live traffic. Disable with --no-redact.
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

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function redactorFlag(flags: Map<string, string | true>): Redactor | null | undefined {
  return flags.get("no-redact") === true ? null : undefined; // undefined → from env
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
  runProxy({
    serverName: stringFlag(flags, "name") ?? path.basename(command),
    command,
    args,
    dbPath: stringFlag(flags, "db"),
    redactor: redactorFlag(flags),
  });
}

function cmdHttp(argv: string[]): void {
  const { flags, positional } = parseFlags(argv, new Set(["port", "name", "db"]));
  const target = positional[0];
  if (target === undefined) fail(`"http" needs a target URL (see --help)`);
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    fail(`invalid target URL "${target}"`);
  }
  const portFlag = Number(flags.get("port"));
  const port = Number.isFinite(portFlag) && portFlag > 0 ? portFlag : 4681;

  const proxy = createHttpProxy({
    target,
    serverName: stringFlag(flags, "name") ?? parsed.host,
    port,
    dbPath: stringFlag(flags, "db"),
    redactor: redactorFlag(flags),
  });
  proxy.server.on("listening", () => {
    process.stdout.write(
      `mcpwatch recording proxy → http://127.0.0.1:${port}  (forwarding to ${target})\n` +
        `Point your MCP client at the local URL. Ctrl-C to stop.\n`,
    );
  });
  proxy.server.on("error", (err) => {
    fail(`could not listen on port ${port}: ${String(err)}`);
  });
  const shutdown = (): void => {
    void proxy.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdExport(argv: string[]): void {
  const { flags, positional } = parseFlags(argv, new Set(["out", "db"]));
  const idArg = positional[0];
  if (idArg === undefined) fail(`"export" needs a session id (see: mcpwatch sessions)`);
  const store = openStore(flags);
  const session = store.findSessionByPrefix(idArg);
  if (session === undefined) {
    store.close();
    fail(`no session matching "${idArg}"`);
  }
  const html = renderSessionHtml(store, session.id)!;
  store.close();
  const out = stringFlag(flags, "out") ?? `mcpwatch-${session.server_name}-${session.id.slice(0, 8)}.html`;
  fs.writeFileSync(out, html);
  process.stdout.write(`exported ${session.id} → ${out}\n`);
}

function cmdGc(argv: string[]): void {
  const { flags } = parseFlags(argv, new Set(["keep-days", "keep-sessions", "db"]));
  const keepDays = Number(flags.get("keep-days"));
  const keepSessions = Number(flags.get("keep-sessions"));
  const opts = {
    keepDays: Number.isFinite(keepDays) && keepDays >= 0 ? keepDays : undefined,
    keepSessions: Number.isFinite(keepSessions) && keepSessions >= 0 ? keepSessions : undefined,
  };
  if (opts.keepDays === undefined && opts.keepSessions === undefined) opts.keepDays = 30;
  const store = openStore(flags);
  const result = store.gc(opts);
  store.close();
  process.stdout.write(
    `deleted ${result.sessions} sessions (${result.calls} calls, ${result.frames} frames); database compacted\n`,
  );
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

function cmdInit(argv: string[]): void {
  const { flags } = parseFlags(argv, new Set());
  const dryRun = flags.get("dry-run") === true;
  const reports = instrumentInit({ dryRun });

  if (reports.length === 0) {
    process.stdout.write(
      "No known MCP client configs found (Claude Desktop, Cursor, ./.mcp.json).\n",
    );
    return;
  }
  for (const r of reports) {
    process.stdout.write(`${r.client} — ${r.file}\n`);
    if (r.error !== undefined) process.stdout.write(`  ! ${r.error}\n`);
    for (const name of r.wrapped)
      process.stdout.write(`  ${dryRun ? "would wrap" : "wrapped"}: ${name}\n`);
    for (const name of r.alreadyWrapped) process.stdout.write(`  already wrapped: ${name}\n`);
    for (const name of r.skippedRemote)
      process.stdout.write(`  skipped (remote server): ${name}\n`);
    if (r.backupPath !== undefined) process.stdout.write(`  backup: ${r.backupPath}\n`);
  }
  if (!dryRun && reports.some((r) => r.wrapped.length > 0)) {
    process.stdout.write("\nRestart your MCP client(s) to start recording. Undo: mcpwatch unwrap\n");
  }
}

function cmdUnwrap(): void {
  const reports = instrumentUnwrap();
  if (reports.length === 0) {
    process.stdout.write("Nothing is instrumented.\n");
    return;
  }
  for (const r of reports) {
    process.stdout.write(`${r.file}\n`);
    if (r.error !== undefined) process.stdout.write(`  ! ${r.error}\n`);
    for (const name of r.restored) process.stdout.write(`  restored: ${name}\n`);
    for (const name of r.leftAlone)
      process.stdout.write(`  left alone (edited or removed since init): ${name}\n`);
  }
  process.stdout.write("\nRestart your MCP client(s) for the change to take effect.\n");
}

function cmdStatus(): void {
  const entries = instrumentStatus();
  if (entries.length === 0) {
    process.stdout.write("Nothing is instrumented. Run: mcpwatch init\n");
    return;
  }
  for (const e of entries) {
    const state = e.stillWrapped ? "active" : "inactive (config changed?)";
    process.stdout.write(`${state}  ${e.file}\n`);
    process.stdout.write(`  servers: ${e.wrappedNames.join(", ") || "-"}\n`);
    process.stdout.write(`  backup:  ${e.backupPath}\n`);
  }
}

function cmdUi(argv: string[]): void {
  const { flags } = parseFlags(argv, new Set(["port", "db"]));
  const portFlag = Number(flags.get("port"));
  const port = Number.isFinite(portFlag) && portFlag > 0 ? portFlag : 4680;
  const store = openStore(flags);
  const ui = createUiServer({ store, port });

  ui.server.on("listening", () => {
    const url = `http://127.0.0.1:${port}`;
    process.stdout.write(`mcpwatch dashboard → ${url}\n`);
    if (flags.get("no-open") !== true) {
      const opener =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on(
        "error",
        () => {},
      );
    }
  });
  ui.server.on("error", (err) => {
    fail(`could not start dashboard on port ${port}: ${String(err)}`);
  });

  const shutdown = (): void => {
    ui.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "run":
      return cmdRun(rest);
    case "http":
      return cmdHttp(rest);
    case "ui":
      return cmdUi(rest);
    case "export":
      return cmdExport(rest);
    case "gc":
      return cmdGc(rest);
    case "init":
      return cmdInit(rest);
    case "unwrap":
      return cmdUnwrap();
    case "status":
      return cmdStatus();
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
