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

server.registerTool(
  "dump_table",
  { description: "Export an entire table as JSON", inputSchema: { table: z.string() } },
  async ({ table }) => {
    await sleep(jitter(400));
    // The failure mode nobody notices: one call that eats the context window.
    const rows = Array.from({ length: 900 }, (_, i) => ({
      id: i,
      email: `user${i}@example.com`,
      name: `Customer Number ${i}`,
      plan: i % 3 === 0 ? "enterprise" : "team",
      created_at: new Date(Date.UTC(2024, i % 12, (i % 27) + 1)).toISOString(),
      notes: "imported from legacy billing system during the 2024 migration",
    }));
    return { content: [{ type: "text", text: JSON.stringify({ table, rows }, null, 2) }] };
  },
);

/**
 * DEMO_BLOAT=<n> registers n extra tools with the kind of verbose descriptions
 * and schemas real integration servers ship. This is what a big vendor MCP
 * server does to your context on every single session, and it is the whole
 * point of `mcpwatch cost` — so the demo has to show it honestly.
 */
const bloat = Number(process.env.DEMO_BLOAT ?? 0);
if (Number.isFinite(bloat) && bloat > 0) {
  const areas = ["issue", "pull_request", "repo", "branch", "release", "workflow", "gist", "team"];
  const verbs = ["list", "get", "create", "update", "delete", "search"];
  let made = 0;
  for (const area of areas) {
    for (const verb of verbs) {
      if (made >= bloat) break;
      made += 1;
      server.registerTool(
        `${verb}_${area}`,
        {
          description:
            `${verb[0]!.toUpperCase()}${verb.slice(1)} a ${area.replace(/_/g, " ")}. ` +
            `Use this tool when the user asks you to ${verb} a ${area.replace(/_/g, " ")} in their ` +
            `repository. Supports pagination via the page and per_page parameters, filtering by owner ` +
            `and state, and returns the full object including timestamps, author metadata and URLs. ` +
            `Requires the repository to be accessible with the configured credentials.`,
          inputSchema: {
            owner: z.string(),
            repo: z.string(),
            identifier: z.string().optional(),
            state: z.string().optional(),
            page: z.number().optional(),
            per_page: z.number().optional(),
          },
        },
        async () => {
          await sleep(jitter(120));
          return { content: [{ type: "text", text: "{}" }] };
        },
      );
    }
  }
}

await server.connect(new StdioServerTransport());
