import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import {
  argsPreview,
  findCalls,
  getCall,
  overview,
  parseSince,
  recentFailures,
  serverHealth,
  stalledCalls,
} from "../src/query/insights.js";
import { handleRequest } from "../src/agent/mcpServer.js";

const NOW = 1_700_000_000_000;

describe("parseSince", () => {
  it("understands the units an agent will actually pass", () => {
    expect(parseSince("30m", NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince("2h", NOW)).toBe(NOW - 2 * 3_600_000);
    expect(parseSince("7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseSince("45s", NOW)).toBe(NOW - 45_000);
    expect(parseSince("90", NOW)).toBe(NOW - 90 * 60_000); // bare number = minutes
  });

  it("falls back to the beginning of time rather than throwing", () => {
    for (const bad of [undefined, "", "yesterday", "-5m", "3 weeks"]) {
      expect(parseSince(bad, NOW)).toBe(0);
    }
  });
});

describe("argsPreview", () => {
  it("pulls out tools/call arguments", () => {
    const raw = JSON.stringify({ method: "tools/call", params: { name: "q", arguments: { sql: "SELECT 1" } } });
    expect(argsPreview(raw)).toBe('{"sql":"SELECT 1"}');
  });

  it("truncates long arguments and survives anything malformed", () => {
    const raw = JSON.stringify({ params: { arguments: { blob: "x".repeat(1000) } } });
    expect(argsPreview(raw, 50)!.length).toBe(51); // 50 chars + ellipsis
    expect(argsPreview("not json at all")).toBeNull();
    expect(argsPreview(null)).toBeNull();
    expect(argsPreview("{}")).toBeNull();
  });
});

describe("insights over a recorded database", () => {
  let dir: string;
  let store: Store;

  /** Record one paired call the way the recorder does. */
  function call(opts: {
    session: string;
    method: string;
    tool?: string;
    status: "ok" | "rpc_error" | "tool_error" | "pending";
    ms?: number;
    error?: string;
    args?: unknown;
    at?: number;
  }): number {
    const ts = opts.at ?? Date.now();
    const requestFrameId = store.insertFrame({
      sessionId: opts.session,
      ts,
      direction: "c2s",
      kind: "request",
      method: opts.method,
      rpcId: String(ts),
      toolName: opts.tool,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: opts.method,
        params: { name: opts.tool, arguments: opts.args ?? {} },
      }),
      truncated: false,
    });
    const responseFrameId =
      opts.status === "pending"
        ? undefined
        : store.insertFrame({
            sessionId: opts.session,
            ts,
            direction: "s2c",
            kind: "response",
            raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
            truncated: false,
          });
    return store.insertCall({
      sessionId: opts.session,
      direction: "c2s",
      method: opts.method,
      toolName: opts.tool,
      rpcId: String(ts),
      startedAt: ts,
      endedAt: opts.status === "pending" ? null : ts + (opts.ms ?? 10),
      durationMs: opts.status === "pending" ? null : (opts.ms ?? 10),
      status: opts.status,
      errorMessage: opts.error,
      requestFrameId,
      responseFrameId,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-insights-"));
    store = new Store(path.join(dir, "test.db"));

    store.createSession({ id: "s-db", serverName: "database", command: "db", args: [], startedAt: Date.now() });
    store.createSession({ id: "s-fs", serverName: "filesystem", command: "fs", args: [], startedAt: Date.now() });

    call({ session: "s-db", method: "tools/call", tool: "run_query", status: "ok", ms: 20, args: { sql: "SELECT 1" } });
    call({
      session: "s-db",
      method: "tools/call",
      tool: "run_query",
      status: "tool_error",
      ms: 15,
      error: "permission denied: DDL statements are not allowed here",
      args: { sql: "DROP TABLE users" },
    });
    call({ session: "s-db", method: "tools/call", tool: "slow_report", status: "ok", ms: 4200 });
    call({ session: "s-fs", method: "tools/call", tool: "read_file", status: "ok", ms: 5 });
    call({ session: "s-fs", method: "tools/call", tool: "read_file", status: "pending" });

    // The filesystem server logs to stdout and then dies — the two failure
    // modes a client hides completely.
    store.insertFrame({
      sessionId: "s-fs",
      ts: Date.now(),
      direction: "s2c",
      kind: "garbage",
      raw: "INFO: watching /Users/me/project",
      truncated: false,
    });
    store.closeSession({
      id: "s-fs",
      endedAt: Date.now(),
      exitCode: 1,
      exitSignal: null,
      stderrTail: "Error: ENOSPC: no space left on device",
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recentFailures returns the failure with its arguments, newest first", () => {
    const rows = recentFailures(store, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.server).toBe("database");
    expect(rows[0]!.tool_name).toBe("run_query");
    expect(rows[0]!.error_message).toContain("permission denied");
    expect(rows[0]!.args_preview).toBe('{"sql":"DROP TABLE users"}');
  });

  it("stalledCalls finds requests abandoned when the session ended", () => {
    const rows = stalledCalls(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("read_file");
    expect(rows[0]!.session_ended).toBe(true);
  });

  it("serverHealth separates broken, misbehaving and healthy servers", () => {
    const health = serverHealth(store);
    const db = health.find((h) => h.server === "database")!;
    const fsys = health.find((h) => h.server === "filesystem")!;

    expect(db.calls).toBe(3);
    expect(db.errors).toBe(1);
    expect(db.error_rate).toBeCloseTo(1 / 3);
    expect(db.slowest_tool).toBe("slow_report");
    expect(db.slowest_ms).toBe(4200);
    expect(db.crashes).toBe(0);

    expect(fsys.crashes).toBe(1);
    expect(fsys.last_crash_exit).toBe("exit 1");
    expect(fsys.last_crash_stderr).toContain("ENOSPC");
    expect(fsys.stdout_pollution).toBe(1);
    expect(fsys.never_answered).toBe(1);
  });

  it("findCalls filters by tool, status and payload text", () => {
    expect(findCalls(store, { tool: "read_file" })).toHaveLength(2);
    expect(findCalls(store, { status: "error" })).toHaveLength(1);
    expect(findCalls(store, { status: "pending" })).toHaveLength(1);
    expect(findCalls(store, { server: "database" })).toHaveLength(3);

    const found = findCalls(store, { text: "DROP TABLE" });
    expect(found).toHaveLength(1);
    expect(found[0]!.tool_name).toBe("run_query");

    // LIKE wildcards in user text must not match everything.
    expect(findCalls(store, { text: "%" })).toHaveLength(0);
  });

  it("getCall returns full payloads, and nothing for an unknown id", () => {
    const id = recentFailures(store)[0]!.call_id;
    const detail = getCall(store, id)!;
    expect(detail.request).toContain("DROP TABLE users");
    expect(detail.response).toContain("jsonrpc");
    expect(detail.request_truncated).toBe(false);
    expect(getCall(store, 999999)).toBeUndefined();
  });

  it("overview totals the whole picture", () => {
    const o = overview(store);
    expect(o.totals.servers).toBe(2);
    expect(o.totals.calls).toBe(5);
    expect(o.totals.errors).toBe(1);
    expect(o.stalled).toHaveLength(1);
  });

  it("the agent server answers tools/list and tools/call over JSON-RPC", () => {
    const list = handleRequest(store, { id: 1, method: "tools/list" }, "test").response!;
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(5);

    const called = handleRequest(
      store,
      { id: 2, method: "tools/call", params: { name: "recent_failures", arguments: { since: "1h" } } },
      "test",
    ).response!;
    const result = called.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("permission denied");

    // Notifications get no reply; unknown methods get a JSON-RPC error.
    expect(handleRequest(store, { method: "notifications/initialized" }, "test").response).toBeUndefined();
    const unknown = handleRequest(store, { id: 3, method: "nope/nope" }, "test").response!;
    expect((unknown.error as { code: number }).code).toBe(-32601);
  });
});
