import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WRAP_MARKER,
  instrumentInit,
  instrumentStatus,
  instrumentUnwrap,
  knownClientConfigs,
} from "../src/instrument/instrument.js";

const NODE = "/fake/node";
const ENTRY = "/fake/mcpwatch/dist/index.js";

describe("client instrumentation", () => {
  let home: string;
  let cwd: string;
  let statePath: string;
  let cursorConfig: string;

  const originalConfig = {
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { FOO: "bar" },
      },
      github: { command: "github-mcp" },
      remote: { url: "https://example.com/mcp", type: "http" },
    },
    otherTopLevelKey: { keep: true },
  };

  const init = () =>
    instrumentInit({ home, cwd, statePath, nodePath: NODE, entryPoint: ENTRY });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-cwd-"));
    statePath = path.join(home, ".mcpwatch", "instrumented.json");
    cursorConfig = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
    fs.writeFileSync(cursorConfig, JSON.stringify(originalConfig, null, 2) + "\n");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("finds only configs that exist", () => {
    const found = knownClientConfigs(home, cwd);
    expect(found.map((c) => c.client)).toEqual(["Cursor"]);

    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{}");
    expect(knownClientConfigs(home, cwd).map((c) => c.client)).toEqual([
      "Cursor",
      "Claude Code (this project)",
    ]);
  });

  it("wraps stdio servers, skips remote ones, and writes a backup", () => {
    const reports = init();
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.wrapped.sort()).toEqual(["filesystem", "github"]);
    expect(report.skippedRemote).toEqual(["remote"]);
    expect(fs.existsSync(report.backupPath!)).toBe(true);

    const rewritten = JSON.parse(fs.readFileSync(cursorConfig, "utf8"));
    const wrappedFs = rewritten.mcpServers.filesystem;
    expect(wrappedFs.command).toBe(NODE);
    expect(wrappedFs.args).toEqual([
      ENTRY,
      "run",
      "--name",
      "filesystem",
      "--",
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(wrappedFs.env).toEqual({ FOO: "bar", [WRAP_MARKER]: "1" });
    expect(rewritten.mcpServers.remote).toEqual(originalConfig.mcpServers.remote);
    expect(rewritten.otherTopLevelKey).toEqual({ keep: true });

    const backup = JSON.parse(fs.readFileSync(report.backupPath!, "utf8"));
    expect(backup).toEqual(originalConfig);
  });

  it("is idempotent: a second init wraps nothing new", () => {
    init();
    const second = init();
    expect(second[0]!.wrapped).toEqual([]);
    expect(second[0]!.alreadyWrapped.sort()).toEqual(["filesystem", "github"]);
  });

  it("dry-run reports without touching anything", () => {
    const before = fs.readFileSync(cursorConfig, "utf8");
    const reports = instrumentInit({
      home,
      cwd,
      statePath,
      dryRun: true,
      nodePath: NODE,
      entryPoint: ENTRY,
    });
    expect(reports[0]!.wrapped.sort()).toEqual(["filesystem", "github"]);
    expect(fs.readFileSync(cursorConfig, "utf8")).toBe(before);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("unwrap restores originals exactly and preserves later additions", () => {
    init();

    // The user adds a server and hand-edits a wrapped one after init.
    const config = JSON.parse(fs.readFileSync(cursorConfig, "utf8"));
    config.mcpServers.added_later = { command: "new-server" };
    config.mcpServers.github = { command: "hand-edited" };
    fs.writeFileSync(cursorConfig, JSON.stringify(config, null, 2) + "\n");

    const reports = instrumentUnwrap({ statePath });
    expect(reports[0]!.restored).toEqual(["filesystem"]);
    expect(reports[0]!.leftAlone).toEqual(["github"]);

    const after = JSON.parse(fs.readFileSync(cursorConfig, "utf8"));
    expect(after.mcpServers.filesystem).toEqual(originalConfig.mcpServers.filesystem);
    expect(after.mcpServers.github).toEqual({ command: "hand-edited" });
    expect(after.mcpServers.added_later).toEqual({ command: "new-server" });
    expect(after.mcpServers.remote).toEqual(originalConfig.mcpServers.remote);

    expect(instrumentStatus({ statePath })).toEqual([]);
  });

  it("status reflects instrumented files", () => {
    init();
    const status = instrumentStatus({ statePath });
    expect(status).toHaveLength(1);
    expect(status[0]!.stillWrapped).toBe(true);
    expect(status[0]!.wrappedNames.sort()).toEqual(["filesystem", "github"]);
  });
});
