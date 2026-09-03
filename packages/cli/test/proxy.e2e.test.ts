/**
 * The Phase 1 acceptance test: a real MCP SDK client talks to a real MCP SDK
 * server THROUGH the mcpwatch proxy. The protocol must work unmodified, and
 * the database must contain the complete, correctly paired record.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/store/store.js";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = path.join(pkgRoot, "src", "index.ts");
const fixtureServer = path.join(pkgRoot, "test", "fixtures", "fixture-server.ts");

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for condition");
}

describe("proxy e2e", () => {
  let tmpDir: string;
  let dbPath: string;
  let client: Client;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-e2e-"));
    dbPath = path.join(tmpDir, "capture.db");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        cliEntry,
        "run",
        "--name",
        "fixture",
        "--db",
        dbPath,
        "--",
        process.execPath,
        "--import",
        "tsx",
        fixtureServer,
      ],
      cwd: pkgRoot,
      env: cleanEnv({}),
      stderr: "pipe",
    });

    client = new Client({ name: "e2e-client", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes the protocol through unmodified and records everything", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["boom", "echo", "slow"]);

    const echoResult = await client.callTool({ name: "echo", arguments: { msg: "hi" } });
    expect(echoResult.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(echoResult.isError ?? false).toBe(false);

    const boomResult = await client.callTool({ name: "boom", arguments: {} });
    expect(boomResult.isError).toBe(true);

    const slowResult = await client.callTool({ name: "slow", arguments: {} });
    expect(slowResult.isError ?? false).toBe(false);

    // Capture writes happen synchronously as frames arrive, so by the time the
    // client has each response, the paired call must already be recorded.
    const store = new Store(dbPath);
    try {
      const sessions = store.listSessions();
      expect(sessions).toHaveLength(1);
      const session = sessions[0]!;
      expect(session.server_name).toBe("fixture");
      expect(session.frames).toBeGreaterThanOrEqual(8);

      const calls = store.listCalls(session.id);
      const byLabel = (method: string, tool?: string) =>
        calls.find((c) => c.method === method && (tool === undefined || c.tool_name === tool));

      const init = byLabel("initialize");
      expect(init?.status).toBe("ok");

      const list = byLabel("tools/list");
      expect(list?.status).toBe("ok");

      const echo = byLabel("tools/call", "echo");
      expect(echo?.status).toBe("ok");
      expect(Number(echo?.duration_ms)).toBeGreaterThanOrEqual(0);

      const boom = byLabel("tools/call", "boom");
      expect(boom?.status).toBe("tool_error");
      expect(String(boom?.error_message)).toContain("kaboom");

      const slow = byLabel("tools/call", "slow");
      expect(slow?.status).toBe("ok");
      expect(Number(slow?.duration_ms)).toBeGreaterThanOrEqual(100);

      const frames = store.db
        .prepare(`SELECT direction, kind FROM frames WHERE session_id = ?`)
        .all(session.id) as Array<{ direction: string; kind: string }>;
      expect(frames.some((f) => f.direction === "c2s" && f.kind === "request")).toBe(true);
      expect(frames.some((f) => f.direction === "s2c" && f.kind === "response")).toBe(true);
      expect(frames.some((f) => f.kind === "notification")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("closes the session with exit metadata when the client disconnects", async () => {
    await client.close();

    const store = new Store(dbPath);
    try {
      await waitFor(() => {
        const sessions = store.listSessions();
        return sessions.length === 1 && sessions[0]!.ended_at !== null;
      });
      const session = store.listSessions()[0]!;
      expect(session.ended_at).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
