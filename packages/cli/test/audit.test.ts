import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditServers, probeServer } from "../src/audit/audit.js";
import { listConfiguredServers } from "../src/instrument/instrument.js";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureServer = path.join(pkgRoot, "test", "fixtures", "fixture-server.ts");

/** A real MCP server, launched the way a client would launch it. */
function fixture(name = "fixture", env: Record<string, string> = {}) {
  return {
    client: "test",
    file: "test.json",
    name,
    command: process.execPath,
    args: ["--import", "tsx", fixtureServer],
    env,
    remote: false,
  };
}

describe("probeServer", () => {
  it("completes a handshake and measures the real tool list", async () => {
    const probe = await probeServer(fixture());
    expect(probe.tools).toBe(3); // echo, boom, slow
    expect(probe.bytes).toBeGreaterThan(100);
    expect(probe.ms).toBeGreaterThan(0);
  });

  it("reports a command that does not exist instead of hanging", async () => {
    await expect(
      probeServer({ ...fixture(), command: "definitely-not-a-real-binary-xyz", args: [] }),
    ).rejects.toThrow(/could not start/);
  });

  it("gives up on a server that never answers, and says what it saw", async () => {
    await expect(
      probeServer(
        {
          ...fixture(),
          command: process.execPath,
          args: ["-e", "process.stderr.write('booting forever\\n'); setInterval(() => {}, 1000)"],
        },
        1200,
      ),
    ).rejects.toThrow(/no tool list after/);
  });

  it("survives a server that pollutes stdout before speaking protocol", async () => {
    // Non-protocol stdout must not derail the handshake.
    const probe = await probeServer({
      ...fixture(),
      args: ["--import", "tsx", "-e", `console.log("starting up!"); await import(${JSON.stringify(fixtureServer)});`],
    });
    expect(probe.tools).toBe(3);
  });
});

describe("auditServers", () => {
  it("prices each server and keeps going when one fails", async () => {
    const results = await auditServers({
      servers: [
        fixture("good"),
        { ...fixture("broken"), command: "definitely-not-a-real-binary-xyz", args: [] },
        { ...fixture("remote"), remote: true },
      ],
    });

    expect(results).toHaveLength(3);
    const good = results.find((r) => r.name === "good")!;
    expect(good.ok).toBe(true);
    expect(good.tool_count).toBe(3);
    expect(good.definition_tokens).toBeGreaterThan(0);

    const broken = results.find((r) => r.name === "broken")!;
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/could not start/);

    const remote = results.find((r) => r.name === "remote")!;
    expect(remote.ok).toBe(false);
    expect(remote.remote).toBe(true);
    expect(remote.definition_tokens).toBe(0);
  });

  it("reports every server it was given, in order", async () => {
    const results = await auditServers({
      servers: [fixture("a"), fixture("b"), fixture("c")],
      concurrency: 2,
    });
    expect(results.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("listConfiguredServers", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-audit-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-audit-cwd-"));
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function writeConfig(servers: unknown): void {
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  }

  it("reports a wrapped server by its original command, not our proxy", () => {
    writeConfig({
      filesystem: {
        command: "/usr/bin/node",
        args: ["/opt/mcpwatch/index.js", "run", "--name", "filesystem", "--", "npx", "-y", "server-fs", "/tmp"],
        env: { MCPWATCH_WRAPPED: "1", TOKEN: "abc" },
      },
    });

    const [server] = listConfiguredServers(home, cwd);
    expect(server!.command).toBe("npx");
    expect(server!.args).toEqual(["-y", "server-fs", "/tmp"]);
    // Our marker is stripped, the user's own env is preserved.
    expect(server!.env).toEqual({ TOKEN: "abc" });
  });

  it("passes an unwrapped server through untouched", () => {
    writeConfig({ github: { command: "github-mcp", args: ["--stdio"], env: { GH_TOKEN: "x" } } });
    const [server] = listConfiguredServers(home, cwd);
    expect(server!.command).toBe("github-mcp");
    expect(server!.args).toEqual(["--stdio"]);
    expect(server!.env).toEqual({ GH_TOKEN: "x" });
    expect(server!.remote).toBe(false);
  });

  it("marks remote servers rather than trying to launch them", () => {
    writeConfig({ remote: { url: "https://example.com/mcp", type: "http" } });
    expect(listConfiguredServers(home, cwd)[0]!.remote).toBe(true);
  });

  it("leaves mcpwatch's own agent server out of the user's setup", () => {
    writeConfig({
      mcpwatch: { command: "node", args: ["/opt/mcpwatch/index.js", "mcp"], env: { MCPWATCH_AGENT_TOOLS: "1" } },
      real: { command: "real-server" },
    });
    expect(listConfiguredServers(home, cwd).map((s) => s.name)).toEqual(["real"]);
  });
});
