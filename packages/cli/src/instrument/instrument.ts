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

/** Env marker on the mcpwatch MCP server entry that `init` adds for the agent. */
export const AGENT_MARKER = "MCPWATCH_AGENT_TOOLS";

/** Name of the server entry that gives the coding agent the mcpwatch tools. */
export const AGENT_SERVER_NAME = "mcpwatch";

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
      /** True when init added the mcpwatch agent-tools server to this file. */
      addedAgentServer?: boolean;
    }
  >;
}

export interface FileChangeReport {
  client: string;
  file: string;
  wrapped: string[];
  alreadyWrapped: string[];
  skippedRemote: string[];
  /** True when this run added the mcpwatch MCP server for the agent. */
  addedAgentServer?: boolean;
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

/**
 * True for mcpwatch's own agent-tools server. Wrapping it would point the
 * recorder at itself: every question the agent asks about the traffic would
 * become more traffic.
 */
function isAgentServer(entry: ServerEntry): boolean {
  if (
    typeof entry.env === "object" &&
    entry.env !== null &&
    (entry.env as Record<string, unknown>)[AGENT_MARKER] === "1"
  ) {
    return true;
  }
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return args.includes("mcp") && args.some((a) => a.includes("mcpwatch"));
}

/** The server entry that hands the coding agent the mcpwatch tools. */
function agentServerEntry(nodePath: string, entryPoint: string): ServerEntry {
  return {
    command: nodePath,
    args: [entryPoint, "mcp"],
    env: { [AGENT_MARKER]: "1" },
  };
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
  /** Skip registering the mcpwatch MCP server that gives agents the tools. */
  noAgentTools?: boolean;
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
    let servers = config.mcpServers;
    if (typeof servers !== "object" || servers === null) {
      if (servers !== undefined) {
        report.error = `"mcpServers" is not an object (left untouched)`;
        continue;
      }
      // A client with no servers configured yet still wants the agent tools:
      // create the section so the recorder is there before the traffic is.
      if (options.noAgentTools === true) continue;
      servers = {};
      config.mcpServers = servers;
    }

    const fileState = state.files[file] ?? { backupPath: "", wrapped: {} };
    for (const [name, entry] of Object.entries(servers)) {
      if (typeof entry !== "object" || entry === null) continue;
      if (isAgentServer(entry)) continue;
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

    // Give the agent its own eyes: the recorder, exposed as an MCP server the
    // client will connect to on its next start.
    if (options.noAgentTools !== true && servers[AGENT_SERVER_NAME] === undefined) {
      report.addedAgentServer = true;
      if (!options.dryRun) {
        servers[AGENT_SERVER_NAME] = agentServerEntry(nodePath, entryPoint);
        fileState.addedAgentServer = true;
      }
    }

    if ((report.wrapped.length > 0 || report.addedAgentServer === true) && !options.dryRun) {
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
  /** True when the mcpwatch agent-tools server was removed from this file. */
  removedAgentServer?: boolean;
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

    // Only remove the agent-tools server if we added it and it is still ours.
    const agentEntry = servers?.[AGENT_SERVER_NAME];
    if (
      fileState.addedAgentServer === true &&
      typeof servers === "object" &&
      servers !== null &&
      typeof agentEntry === "object" &&
      agentEntry !== null &&
      isAgentServer(agentEntry)
    ) {
      delete servers[AGENT_SERVER_NAME];
      report.removedAgentServer = true;
    }

    if (report.restored.length > 0 || report.removedAgentServer === true) {
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    }
    if (report.error === undefined) delete state.files[file];
  }

  saveState(statePath, state);
  return reports;
}

export interface ConfiguredServer {
  client: string;
  file: string;
  name: string;
  /** The real server command, with any mcpwatch wrapping peeled off. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Remote servers have no local command to launch. */
  remote: boolean;
}

/**
 * Every stdio server a client would start, as it would really start it.
 *
 * Wrapped entries are reported by their original command: callers want to
 * measure the server itself, not our proxy around it. mcpwatch's own agent
 * server is left out — it is ours, not part of the user's setup.
 */
export function listConfiguredServers(
  home: string = os.homedir(),
  cwd: string = process.cwd(),
): ConfiguredServer[] {
  const out: ConfiguredServer[] = [];
  for (const { client, file } of knownClientConfigs(home, cwd)) {
    let config: ConfigFile;
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFile;
    } catch {
      continue;
    }
    const servers = config.mcpServers;
    if (typeof servers !== "object" || servers === null) continue;

    for (const [name, entry] of Object.entries(servers)) {
      if (typeof entry !== "object" || entry === null) continue;
      if (isAgentServer(entry)) continue;

      const rawEnv = typeof entry.env === "object" && entry.env !== null ? entry.env : {};
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
        if (key === WRAP_MARKER || key === AGENT_MARKER) continue;
        if (typeof value === "string") env[key] = value;
      }

      if (isRemote(entry)) {
        out.push({ client, file, name, command: "", args: [], env, remote: true });
        continue;
      }

      let command = String(entry.command);
      let args = Array.isArray(entry.args) ? entry.args.map(String) : [];
      if (isWrapped(entry)) {
        // node <mcpwatch> run --name X -- <real command> [args...]
        const sep = args.indexOf("--");
        if (sep !== -1 && sep + 1 < args.length) {
          command = args[sep + 1]!;
          args = args.slice(sep + 2);
        }
      }
      out.push({ client, file, name, command, args, env, remote: false });
    }
  }
  return out;
}

/**
 * Paste-ready ways to give an agent the mcpwatch tools when we can't edit a
 * config ourselves — Claude Code and Codex keep MCP servers in places that are
 * either CLI-managed or too stateful for us to rewrite safely.
 */
export function agentSetupSnippets(pkg = "@sreelal727/mcpwatch"): string {
  return `Claude Code — run:
  claude mcp add mcpwatch -- npx -y ${pkg} mcp

Codex CLI — add to ~/.codex/config.toml:
  [mcp_servers.mcpwatch]
  command = "npx"
  args = ["-y", "${pkg}", "mcp"]

Cursor / Claude Desktop / any MCP client — add to the "mcpServers" object:
  "mcpwatch": { "command": "npx", "args": ["-y", "${pkg}", "mcp"] }

Then restart the client and ask your agent: "check mcpwatch for recent failures".`;
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
