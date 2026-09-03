import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Client instrumentation: rewrite MCP client configs so every stdio server
 * runs through `mcpwatch run`, reversibly.
 *
 * Safety model:
 * - Before the first change to a file, a timestamped backup copy is written
 *   next to it.
 * - Every original entry is also stored in a state sidecar
 *   (~/.mcpwatch/instrumented.json) keyed by config path + server name.
 * - Wrapped entries carry the MCPWATCH_WRAPPED env marker, so init is
 *   idempotent and unwrap only restores entries that are still ours.
 * - Entries we don't understand (remote servers, unparseable files) are left
 *   untouched and reported.
 */

export const WRAP_MARKER = "MCPWATCH_WRAPPED";

interface ServerEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

interface ConfigFile {
  mcpServers?: Record<string, ServerEntry>;
  [key: string]: unknown;
}

export interface ClientConfigPath {
  client: string;
  file: string;
}

export interface InstrumentState {
  version: 1;
  files: Record<
    string,
    {
      backupPath: string;
      wrapped: Record<string, ServerEntry>;
    }
  >;
}

export interface FileChangeReport {
  client: string;
  file: string;
  wrapped: string[];
  alreadyWrapped: string[];
  skippedRemote: string[];
  error?: string;
  backupPath?: string;
}

/** Config files mcpwatch knows how to instrument, for this machine. */
export function knownClientConfigs(home: string = os.homedir(), cwd: string = process.cwd()): ClientConfigPath[] {
  const candidates: ClientConfigPath[] = [
    {
      client: "Claude Desktop",
      file:
        process.platform === "darwin"
          ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
          : path.join(home, ".config", "Claude", "claude_desktop_config.json"),
    },
    { client: "Cursor", file: path.join(home, ".cursor", "mcp.json") },
    { client: "Claude Code (this project)", file: path.join(cwd, ".mcp.json") },
  ];
  return candidates.filter((c) => fs.existsSync(c.file));
}

export function defaultStatePath(): string {
  return process.env.MCPWATCH_STATE ?? path.join(os.homedir(), ".mcpwatch", "instrumented.json");
}

/** Absolute path to our own CLI entry point (dist/index.js when built). */
export function cliEntryPath(): string {
  return fileURLToPath(new URL("../index.js", import.meta.url));
}

function loadState(statePath: string): InstrumentState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as InstrumentState;
    if (parsed.version === 1 && typeof parsed.files === "object") return parsed;
  } catch {
    /* fresh state */
  }
  return { version: 1, files: {} };
}

function saveState(statePath: string, state: InstrumentState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function isWrapped(entry: ServerEntry): boolean {
  return (
    typeof entry.env === "object" &&
    entry.env !== null &&
    (entry.env as Record<string, unknown>)[WRAP_MARKER] === "1"
  );
}

function isRemote(entry: ServerEntry): boolean {
  if (typeof entry.url === "string") return true;
  return entry.type === "http" || entry.type === "sse" || entry.command === undefined;
}

function wrapEntry(name: string, entry: ServerEntry, nodePath: string, entryPoint: string): ServerEntry {
  const origArgs = Array.isArray(entry.args) ? (entry.args as string[]) : [];
  return {
    ...entry,
    command: nodePath,
    args: [entryPoint, "run", "--name", name, "--", String(entry.command), ...origArgs],
    env: { ...(typeof entry.env === "object" && entry.env !== null ? entry.env : {}), [WRAP_MARKER]: "1" },
  };
}

export interface InitOptions {
  home?: string;
  cwd?: string;
  statePath?: string;
  dryRun?: boolean;
  /** Overridable for tests; defaults to this process's node + built entry. */
  nodePath?: string;
  entryPoint?: string;
}

export function instrumentInit(options: InitOptions = {}): FileChangeReport[] {
  const statePath = options.statePath ?? defaultStatePath();
  const nodePath = options.nodePath ?? process.execPath;
  const entryPoint = options.entryPoint ?? cliEntryPath();
  const state = loadState(statePath);
  const reports: FileChangeReport[] = [];

  for (const { client, file } of knownClientConfigs(options.home, options.cwd)) {
    const report: FileChangeReport = {
      client,
      file,
      wrapped: [],
      alreadyWrapped: [],
      skippedRemote: [],
    };
    reports.push(report);

    let config: ConfigFile;
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFile;
    } catch (err) {
      report.error = `could not parse (left untouched): ${String(err)}`;
      continue;
    }
    const servers = config.mcpServers;
    if (typeof servers !== "object" || servers === null) continue;

    const fileState = state.files[file] ?? { backupPath: "", wrapped: {} };
    for (const [name, entry] of Object.entries(servers)) {
      if (typeof entry !== "object" || entry === null) continue;
      if (isWrapped(entry)) {
        report.alreadyWrapped.push(name);
        continue;
      }
      if (isRemote(entry)) {
        report.skippedRemote.push(name);
        continue;
      }
      if (!options.dryRun) {
        fileState.wrapped[name] = JSON.parse(JSON.stringify(entry)) as ServerEntry;
        servers[name] = wrapEntry(name, entry, nodePath, entryPoint);
      }
      report.wrapped.push(name);
    }

    if (report.wrapped.length > 0 && !options.dryRun) {
      if (fileState.backupPath === "") {
        fileState.backupPath = `${file}.mcpwatch-backup-${Date.now()}`;
        fs.copyFileSync(file, fileState.backupPath);
      }
      report.backupPath = fileState.backupPath;
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
      state.files[file] = fileState;
    }
  }

  if (!options.dryRun) saveState(statePath, state);
  return reports;
}

export interface UnwrapReport {
  file: string;
  restored: string[];
  /** Entries we recorded but could not restore (removed or edited by hand). */
  leftAlone: string[];
  error?: string;
}

export function instrumentUnwrap(options: { statePath?: string } = {}): UnwrapReport[] {
  const statePath = options.statePath ?? defaultStatePath();
  const state = loadState(statePath);
  const reports: UnwrapReport[] = [];

  for (const [file, fileState] of Object.entries(state.files)) {
    const report: UnwrapReport = { file, restored: [], leftAlone: [] };
    reports.push(report);

    let config: ConfigFile;
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFile;
    } catch (err) {
      report.error = `could not parse (left untouched, backup at ${fileState.backupPath}): ${String(err)}`;
      continue;
    }
    const servers = config.mcpServers;

    for (const [name, original] of Object.entries(fileState.wrapped)) {
      const current = servers?.[name];
      if (
        typeof servers === "object" &&
        servers !== null &&
        typeof current === "object" &&
        current !== null &&
        isWrapped(current)
      ) {
        servers[name] = original;
        report.restored.push(name);
      } else {
        report.leftAlone.push(name);
      }
    }

    if (report.restored.length > 0) {
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    }
    if (report.error === undefined) delete state.files[file];
  }

  saveState(statePath, state);
  return reports;
}

export interface StatusEntry {
  file: string;
  wrappedNames: string[];
  backupPath: string;
  stillWrapped: boolean;
}

export function instrumentStatus(options: { statePath?: string } = {}): StatusEntry[] {
  const statePath = options.statePath ?? defaultStatePath();
  const state = loadState(statePath);
  return Object.entries(state.files).map(([file, fileState]) => {
    let stillWrapped = false;
    try {
      const config = JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFile;
      stillWrapped = Object.values(config.mcpServers ?? {}).some(
        (entry) => typeof entry === "object" && entry !== null && isWrapped(entry),
      );
    } catch {
      /* unreadable — report as not verifiable */
    }
    return {
      file,
      wrappedNames: Object.keys(fileState.wrapped),
      backupPath: fileState.backupPath,
      stillWrapped,
    };
  });
}
