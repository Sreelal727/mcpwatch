/**
 * Demo MCP server with realistic tools, used by seed-demo.ts to produce
 * demo/screenshot data. Latencies are simulated; one tool fails in-band.
 * With DEMO_STDOUT_NOISE=1 it also logs to stdout at startup, demonstrating
 * mcpwatch's non-protocol-output detection.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (base: number): number => base * (0.6 + Math.random() * 0.8);

if (process.env.DEMO_STDOUT_NOISE === "1") {
  console.log("[server] ready, listening for requests");
}

const server = new McpServer({ name: "demo", version: "0.0.1" });

server.registerTool(
  "read_file",
  { description: "Read a file from the workspace", inputSchema: { path: z.string() } },
  async ({ path }) => {
    await sleep(jitter(18));
    return { content: [{ type: "text", text: `// contents of ${path}\nexport const answer = 42;\n` }] };
  },
);

server.registerTool(
  "search_docs",
  { description: "Full-text search over indexed docs", inputSchema: { query: z.string() } },
  async ({ query }) => {
    await sleep(jitter(120));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { query, hits: [{ title: "Getting started", score: 0.92 }, { title: "API reference", score: 0.77 }] },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "write_file",
  { description: "Write a file", inputSchema: { path: z.string(), contents: z.string() } },
  async ({ path }) => {
    await sleep(jitter(30));
    return { content: [{ type: "text", text: `wrote ${path}` }] };
  },
);

server.registerTool(
  "run_query",
  { description: "Run a SQL query", inputSchema: { sql: z.string() } },
  async ({ sql }) => {
    if (/drop\s/i.test(sql)) {
      await sleep(jitter(15));
      return {
        content: [{ type: "text", text: `permission denied: DDL statements are not allowed here` }],
        isError: true,
      };
    }
    await sleep(/join/i.test(sql) ? jitter(950) : jitter(85));
    return { content: [{ type: "text", text: JSON.stringify({ rows: 42, elapsed_ms: 84 }) }] };
  },
);

server.registerTool(
  "fetch_url",
  { description: "Fetch a URL and return the body", inputSchema: { url: z.string() } },
  async ({ url }) => {
    await sleep(jitter(320));
    return { content: [{ type: "text", text: `<html><!-- 48kb from ${url} --></html>` }] };
  },
);

await server.connect(new StdioServerTransport());
