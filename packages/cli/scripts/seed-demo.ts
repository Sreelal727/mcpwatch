/**
 * Seed a demo database by driving real traffic through the real proxy:
 *   npx tsx scripts/seed-demo.ts /path/to/demo.db [--keep-running]
 *
 * Three sessions with distinct shapes (fast file ops, a database session with
 * errors and a slow join, a web session with stdout noise). With
 * --keep-running, a fourth session stays open and keeps making calls until
 * the process is killed — used for live-tail demos and GIF recording.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dbPath = process.argv[2];
if (dbPath === undefined) {
  console.error("usage: tsx scripts/seed-demo.ts <db-path> [--keep-running]");
  process.exit(2);
}
const keepRunning = process.argv.includes("--keep-running");

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

async function connect(name: string, env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.join(pkgRoot, "src", "index.ts"),
      "run",
      "--name",
      name,
      "--db",
      dbPath!,
      "--",
      process.execPath,
      "--import",
      "tsx",
      path.join(pkgRoot, "scripts", "demo-server.ts"),
    ],
    cwd: pkgRoot,
    env: cleanEnv(env),
  });
  const client = new Client({ name: "seed-demo", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<void> => {
  await client.callTool({ name, arguments: args });
  await sleep(60 + Math.random() * 250);
};

// Session 1: filesystem-flavored work.
{
  const client = await connect("filesystem");
  await client.listTools();
  await call(client, "read_file", { path: "src/index.ts" });
  await call(client, "read_file", { path: "src/store/store.ts" });
  await call(client, "search_docs", { query: "how do transactions work" });
  await call(client, "write_file", { path: "src/fix.ts", contents: "export {}" });
  await call(client, "read_file", { path: "package.json" });
  // The most common duplicate of all: re-reading a file it already has.
  await call(client, "read_file", { path: "src/index.ts" });
  await call(client, "search_docs", { query: "how do transactions work" });
  await call(client, "read_file", { path: "src/index.ts" });
  await client.close();
}

// Session 2: database work with a denied query and a slow join.
{
  const client = await connect("database");
  await client.listTools();
  await call(client, "run_query", { sql: "SELECT count(*) FROM users" });
  await call(client, "run_query", { sql: "DROP TABLE users" });
  await call(client, "run_query", {
    sql: "SELECT * FROM orders JOIN users ON users.id = orders.user_id WHERE total > 100",
  });
  await call(client, "run_query", { sql: "SELECT id FROM orders LIMIT 10" });
  try {
    // The SDK reports unknown tools in-band (result.isError) → tool_error.
    await client.callTool({ name: "does_not_exist", arguments: {} });
  } catch {
    /* some client versions throw instead */
  }
  await client.close();
}

// Session 3: web fetching, with stdout noise from the server.
{
  const client = await connect("web-fetch", { DEMO_STDOUT_NOISE: "1" });
  await client.listTools();
  await call(client, "fetch_url", { url: "https://example.com/pricing" });
  await call(client, "fetch_url", { url: "https://example.com/docs/api" });
  await call(client, "search_docs", { query: "rate limits" });
  await client.close();
}

// Session 4: a big vendor integration server, configured and never used.
// Its 40 tool definitions are injected into every session regardless.
{
  const client = await connect("github", { DEMO_BLOAT: "40" });
  await client.listTools();
  await client.close();
}

// Session 5: the two cheap habits that quietly cost the most — asking for the
// same thing twice, and pulling far more data than the question needed.
{
  const client = await connect("analytics");
  await client.listTools();
  // An agent that lost the earlier result asks the same question four times.
  for (let i = 0; i < 4; i++) {
    await call(client, "run_query", { sql: "SELECT count(*) FROM signups WHERE week = 12" });
  }
  await call(client, "dump_table", { table: "customers" });
  await client.close();
}

console.error(`seeded ${dbPath}`);

// Optional: a session that stays alive and keeps working, for live demos.
if (keepRunning) {
  const client = await connect("agent-live");
  await client.listTools();
  const loop = async (): Promise<void> => {
    const actions: Array<[string, Record<string, unknown>]> = [
      ["read_file", { path: `src/mod${Math.floor(Math.random() * 9)}.ts` }],
      ["search_docs", { query: "retry policy" }],
      ["run_query", { sql: "SELECT 1" }],
      ["fetch_url", { url: "https://example.com/health" }],
    ];
    for (;;) {
      const [name, args] = actions[Math.floor(Math.random() * actions.length)]!;
      await call(client, name, args);
      await sleep(500 + Math.random() * 1200);
    }
  };
  console.error("live session running — ctrl-c to stop");
  await loop();
}

process.exit(0);
