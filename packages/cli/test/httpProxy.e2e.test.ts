/**
 * Streamable HTTP e2e: a real SDK client talks to a real SDK server THROUGH
 * the mcpwatch HTTP recording proxy. Protocol must pass through unmodified
 * (including SSE-streamed responses) and the capture must be complete.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createHttpProxy, SseSplitter, type HttpProxy } from "../src/proxy/httpProxy.js";
import { Store } from "../src/store/store.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: "http-fixture", version: "0.0.1" });
  server.registerTool(
    "echo",
    { description: "Echo", inputSchema: { msg: z.string() } },
    async ({ msg }) => ({ content: [{ type: "text", text: `echo:${msg}` }] }),
  );
  server.registerTool("boom", { description: "Fails in-band" }, async () => ({
    content: [{ type: "text", text: "kaboom" }],
    isError: true,
  }));
  return server;
}

describe("http proxy e2e", () => {
  let upstream: http.Server;
  let proxy: HttpProxy;
  let tmpDir: string;
  let dbPath: string;
  let client: Client;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-http-"));
    dbPath = path.join(tmpDir, "capture.db");

    // Stateless upstream: a fresh server+transport per request.
    upstream = http.createServer((req, res) => {
      void (async () => {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => void transport.close());
        await buildServer().connect(transport);
        await transport.handleRequest(req, res);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    proxy = createHttpProxy({
      target: `http://127.0.0.1:${upstreamPort}/`,
      serverName: "http-fixture",
      port: 0,
      dbPath,
    });
    await new Promise<void>((resolve) => proxy.server.once("listening", () => resolve()));
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    client = new Client({ name: "http-e2e", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${proxyPort}/`)));
  });

  afterAll(async () => {
    await client.close();
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes the protocol through and records both directions", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);

    const echo = await client.callTool({ name: "echo", arguments: { msg: "over-http" } });
    expect(echo.content).toEqual([{ type: "text", text: "echo:over-http" }]);

    const boom = await client.callTool({ name: "boom", arguments: {} });
    expect(boom.isError).toBe(true);

    const store = new Store(dbPath);
    try {
      const sessions = store.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.server_name).toBe("http-fixture");

      const calls = store.listCalls(sessions[0]!.id);
      const byLabel = (method: string, tool?: string) =>
        calls.find((c) => c.method === method && (tool === undefined || c.tool_name === tool));
      expect(byLabel("initialize")?.status).toBe("ok");
      expect(byLabel("tools/list")?.status).toBe("ok");
      expect(byLabel("tools/call", "echo")?.status).toBe("ok");
      expect(byLabel("tools/call", "boom")?.status).toBe("tool_error");

      const frames = store.db
        .prepare(`SELECT direction, kind FROM frames WHERE session_id = ?`)
        .all(sessions[0]!.id) as Array<{ direction: string; kind: string }>;
      expect(frames.some((f) => f.direction === "c2s" && f.kind === "request")).toBe(true);
      expect(frames.some((f) => f.direction === "s2c" && f.kind === "response")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("closes the recorder session on proxy shutdown", async () => {
    // covered in afterAll ordering; assert behavior explicitly with a scratch proxy
    const scratch = createHttpProxy({
      target: "http://127.0.0.1:9/",
      serverName: "scratch",
      port: 0,
      dbPath,
    });
    await new Promise<void>((resolve) => scratch.server.once("listening", () => resolve()));
    await scratch.close();
    const store = new Store(dbPath);
    try {
      const session = store.getSession(scratch.recorder.sessionId);
      expect(session?.ended_at).not.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("SseSplitter", () => {
  it("parses events across chunk boundaries and multi-line data", () => {
    const splitter = new SseSplitter();
    expect(splitter.push("event: message\ndata: {\"a\":")).toEqual([]);
    expect(splitter.push("1}\n\n")).toEqual(['{"a":1}']);
    expect(splitter.push("data: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
    expect(splitter.push(": comment\nid: 7\n\n")).toEqual([]);
    expect(splitter.push("data:no-space\r\n\r\n")).toEqual(["no-space"]);
  });
});
