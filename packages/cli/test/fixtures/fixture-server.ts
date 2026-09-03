/**
 * Minimal MCP server used by the e2e tests: one happy tool, one in-band-error
 * tool, one slow tool. Runs over stdio via the official SDK.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "0.0.1" });

server.registerTool(
  "echo",
  { description: "Echo a message back", inputSchema: { msg: z.string() } },
  async ({ msg }) => ({ content: [{ type: "text", text: `echo:${msg}` }] }),
);

server.registerTool("boom", { description: "Always fails in-band" }, async () => ({
  content: [{ type: "text", text: "kaboom" }],
  isError: true,
}));

server.registerTool("slow", { description: "Takes ~150ms" }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { content: [{ type: "text", text: "done" }] };
});

await server.connect(new StdioServerTransport());
