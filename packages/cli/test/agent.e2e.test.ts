/**
 * The agent-tools acceptance test, end to end and with nothing faked:
 *
 *   real MCP client → mcpwatch proxy → real MCP server   (traffic is recorded)
 *   real MCP client → `mcpwatch mcp` → that recording     (the agent reads it)
 *
 * The second client is the coding agent. If this passes, an agent that just got
 * an opaque tool error can find out what actually happened on the wire.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = path.join(pkgRoot, "src", "index.ts");
const fixtureServer = path.join(pkgRoot, "test", "fixtures", "fixture-server.ts");

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function textOf(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("agent tools e2e", () => {
  let tmpDir: string;
  let dbPath: string;
  let agent: Client;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-agent-"));
    dbPath = path.join(tmpDir, "capture.db");

    // Phase 1: generate genuine recorded traffic, including a real failure.
    const recorded = new Client({ name: "traffic", version: "0.0.0" });
    await recorded.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import", "tsx", cliEntry,
          "run", "--name", "fixture", "--db", dbPath,
          "--", process.execPath, "--import", "tsx", fixtureServer,
        ],
        cwd: pkgRoot,
        env: env(),
        stderr: "pipe",
      }),
    );
    await recorded.listTools();
    await recorded.callTool({ name: "echo", arguments: { msg: "hello world" } });
    await recorded.callTool({ name: "boom", arguments: { why: "on purpose" } });
    await recorded.callTool({ name: "slow", arguments: {} });
    await recorded.close();

    // Phase 2: the agent connects to mcpwatch itself.
    agent = new Client({ name: "coding-agent", version: "0.0.0" });
    await agent.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", cliEntry, "mcp", "--db", dbPath],
        cwd: pkgRoot,
        env: env(),
        stderr: "pipe",
      }),
    );
  });

  afterAll(async () => {
    await agent.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a protocol-compliant MCP server the SDK can drive", async () => {
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "find_calls",
      "get_call",
      "recent_failures",
      "server_health",
    ]);
    // Descriptions are the whole interface for an agent: they must say when to call.
    const failures = tools.find((t) => t.name === "recent_failures")!;
    expect(failures.description).toMatch(/fail/i);
    expect(failures.inputSchema.type).toBe("object");
  });

  it("recent_failures surfaces the in-band tool error with its arguments", async () => {
    const text = await textOf(agent, "recent_failures", { since: "1h" });
    expect(text).toContain("fixture/boom");
    expect(text).toContain("tool_error");
    expect(text).toContain("kaboom");
    expect(text).toContain('"why":"on purpose"');
    // It must not report the successful calls as failures.
    expect(text).not.toContain("fixture/echo");
  });

  it("server_health reports the recorded server", async () => {
    const text = await textOf(agent, "server_health", { since: "1h" });
    expect(text).toContain("fixture");
    expect(text).toMatch(/\d+ calls/);
    expect(text).toContain("error");
  });

  it("find_calls searches recorded payloads by free text", async () => {
    const text = await textOf(agent, "find_calls", { text: "hello world", since: "1h" });
    expect(text).toContain("fixture/echo");
    expect(text).toContain("hello world");

    const byTool = await textOf(agent, "find_calls", { tool: "slow", since: "1h" });
    expect(byTool).toContain("fixture/slow");
    expect(byTool).not.toContain("fixture/echo");

    const errorsOnly = await textOf(agent, "find_calls", { status: "error", since: "1h" });
    expect(errorsOnly).toContain("boom");
    expect(errorsOnly).not.toContain("fixture/slow");
  });

  it("get_call returns the full request and response payloads", async () => {
    const failures = await textOf(agent, "recent_failures", { since: "1h" });
    const callId = Number(/\[#(\d+)\]/.exec(failures)![1]);

    const text = await textOf(agent, "get_call", { call_id: callId });
    expect(text).toContain("REQUEST");
    expect(text).toContain("RESPONSE");
    expect(text).toContain('"name":"boom"');
    expect(text).toContain("kaboom");
    expect(text).toContain('"isError":true');
  });

  it("reports a bad call id as a tool error, not a protocol error", async () => {
    const result = await agent.callTool({ name: "get_call", arguments: { call_id: 999999 } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("999999");
  });
});
