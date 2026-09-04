import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import { CHARS_PER_TOKEN, costReport, estimateTokens } from "../src/query/cost.js";

describe("estimateTokens", () => {
  it("converts bytes at the documented ratio", () => {
    expect(estimateTokens(4000)).toBe(4000 / CHARS_PER_TOKEN);
    expect(estimateTokens(0)).toBe(0);
  });
});

describe("costReport", () => {
  let dir: string;
  let store: Store;
  let rpc = 0;

  function session(id: string, server: string, startedAt = Date.now()): void {
    store.createSession({ id, serverName: server, command: server, args: [], startedAt });
  }

  /** Record a tools/list exchange whose response advertises `tools` tools. */
  function listTools(sessionId: string, toolCount: number, descriptionLength = 200): void {
    const tools = Array.from({ length: toolCount }, (_, i) => ({
      name: `tool_${i}`,
      description: "d".repeat(descriptionLength),
      inputSchema: { type: "object", properties: {} },
    }));
    exchange(sessionId, "tools/list", undefined, {}, { tools });
  }

  function exchange(
    sessionId: string,
    method: string,
    toolName: string | undefined,
    args: unknown,
    result: unknown,
    status: "ok" | "tool_error" = "ok",
  ): number {
    const ts = Date.now();
    const id = String(++rpc);
    const requestFrameId = store.insertFrame({
      sessionId,
      ts,
      direction: "c2s",
      kind: "request",
      method,
      rpcId: id,
      toolName,
      raw: JSON.stringify({ jsonrpc: "2.0", id, method, params: { name: toolName, arguments: args } }),
      truncated: false,
    });
    const responseFrameId = store.insertFrame({
      sessionId,
      ts,
      direction: "s2c",
      kind: "response",
      rpcId: id,
      raw: JSON.stringify({ jsonrpc: "2.0", id, result }),
      truncated: false,
    });
    return store.insertCall({
      sessionId,
      direction: "c2s",
      method,
      toolName,
      rpcId: id,
      startedAt: ts,
      endedAt: ts + 5,
      durationMs: 5,
      status,
      requestFrameId,
      responseFrameId,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-cost-"));
    store = new Store(path.join(dir, "cost.db"));
    rpc = 0;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prices the per-session tax from the tool definitions each server loads", () => {
    session("s1", "small");
    listTools("s1", 3);
    session("s2", "huge");
    listTools("s2", 60);

    const report = costReport(store);
    const small = report.servers.find((s) => s.server === "small")!;
    const huge = report.servers.find((s) => s.server === "huge")!;

    expect(small.tool_count).toBe(3);
    expect(huge.tool_count).toBe(60);
    expect(huge.definition_tokens).toBeGreaterThan(small.definition_tokens * 10);
    expect(report.per_session_tax).toBe(small.definition_tokens + huge.definition_tokens);
  });

  it("flags a configured server that is never called, and prices it per session", () => {
    session("s1", "github");
    listTools("s1", 50);
    session("s2", "github");
    listTools("s2", 50);

    const report = costReport(store);
    const unused = report.waste.find((w) => w.kind === "unused_server")!;
    expect(unused.server).toBe("github");
    expect(unused.detail).toContain("50 tools");
    // Two sessions each paid the tax.
    expect(unused.tokens).toBe(unused.per_session_tokens! * 2);
    expect(unused.action).toMatch(/Remove/);
  });

  it("does not flag a server that is actually used", () => {
    session("s1", "filesystem");
    listTools("s1", 4);
    exchange("s1", "tools/call", "read_file", { path: "a.ts" }, { content: [] });

    const report = costReport(store);
    expect(report.waste.some((w) => w.kind === "unused_server")).toBe(false);
    const fsys = report.servers.find((s) => s.server === "filesystem")!;
    expect(fsys.calls).toBe(1);
    expect(fsys.tools_used).toBe(1);
  });

  it("counts repeated identical calls in one session as waste", () => {
    session("s1", "db");
    listTools("s1", 3);
    const args = { sql: "SELECT ".padEnd(400, "x") };
    for (let i = 0; i < 4; i++) exchange("s1", "tools/call", "run_query", args, { rows: 1 });
    // A different argument is not a repeat.
    exchange("s1", "tools/call", "run_query", { sql: "SELECT 2" }, { rows: 1 });

    const dup = costReport(store).waste.find((w) => w.kind === "duplicate_calls")!;
    expect(dup.detail).toContain("3 repeat calls");
  });

  it("treats the same call in a different session as legitimate", () => {
    session("s1", "db");
    session("s2", "db");
    const args = { sql: "SELECT ".padEnd(400, "x") };
    exchange("s1", "tools/call", "run_query", args, { rows: 1 });
    exchange("s2", "tools/call", "run_query", args, { rows: 1 });

    expect(costReport(store).waste.some((w) => w.kind === "duplicate_calls")).toBe(false);
  });

  it("flags a single response big enough to swallow the context window", () => {
    session("s1", "analytics");
    listTools("s1", 3);
    exchange("s1", "tools/call", "dump_table", { table: "customers" }, { blob: "x".repeat(200_000) });

    const big = costReport(store).waste.find((w) => w.kind === "oversized_response")!;
    expect(big.detail).toContain("dump_table");
    expect(big.tokens).toBeGreaterThan(40_000);
  });

  it("stays quiet about trivia so the real savings stay visible", () => {
    // A server with a few unused tools is normal and not worth reporting.
    session("s1", "tidy");
    listTools("s1", 6, 20);
    exchange("s1", "tools/call", "tool_0", { a: 1 }, { ok: true });

    const report = costReport(store);
    expect(report.waste.some((w) => w.kind === "unused_tools")).toBe(false);

    // A genuinely bloated one is.
    session("s2", "bloated");
    listTools("s2", 60, 400);
    exchange("s2", "tools/call", "tool_0", { a: 1 }, { ok: true });

    const bloated = costReport(store).waste.find((w) => w.kind === "unused_tools")!;
    expect(bloated.server).toBe("bloated");
    expect(bloated.per_session_tokens).toBeGreaterThanOrEqual(1000);
  });

  it("counts failed calls as spend that bought nothing", () => {
    session("s1", "db");
    listTools("s1", 3);
    for (let i = 0; i < 3; i++) {
      exchange(
        "s1",
        "tools/call",
        "run_query",
        { sql: `SELECT ${i} `.padEnd(500, "x") },
        { content: [{ type: "text", text: "permission denied".padEnd(200, ".") }], isError: true },
        "tool_error",
      );
    }

    const failed = costReport(store).waste.find((w) => w.kind === "failed_calls")!;
    expect(failed.detail).toContain("3 failed calls");
    expect(failed.tokens).toBeGreaterThan(0);
  });

  it("ignores a lone cheap failure — a cost report is a list of things worth doing", () => {
    session("s1", "db");
    listTools("s1", 3);
    exchange("s1", "tools/call", "run_query", { sql: "SELECT 1" }, { isError: true }, "tool_error");

    // Still counted in the server totals, just not surfaced as an action.
    expect(costReport(store).waste.some((w) => w.kind === "failed_calls")).toBe(false);
    expect(costReport(store).servers.find((s) => s.server === "db")!.failed_calls).toBe(1);
  });

  describe("monthly projection", () => {
    const DAY = 86_400_000;

    it("extrapolates from the observed session rate", () => {
      // 20 sessions over 10 days = 2/day.
      const start = Date.now() - 10 * DAY;
      for (let i = 0; i < 20; i++) {
        const id = `s${i}`;
        session(id, "github", start + (i / 2) * DAY);
        listTools(id, 50);
      }

      const p = costReport(store).projection!;
      expect(p.days_observed).toBeCloseTo(9.5, 0);
      expect(p.startups_per_day).toBeCloseTo(2.1, 0);

      const report = costReport(store);
      const expected = (report.definition_tokens / p.days_observed) * 30;
      expect(Math.abs(p.monthly_definition_tokens - expected) / expected).toBeLessThan(0.01);
    });

    it("never projects definitions costing more than everything combined", () => {
      // One client launch starts every configured server, so each launch adds
      // one session row per server. Extrapolating the all-servers per-session
      // tax by that rate once claimed definitions cost more than the total.
      const start = Date.now() - 10 * DAY;
      let i = 0;
      for (let day = 0; day < 10; day++) {
        for (const server of ["github", "filesystem", "postgres", "slack"]) {
          const id = `s${i++}`;
          session(id, server, start + day * DAY);
          listTools(id, server === "github" ? 50 : 6, 300);
          exchange(id, "tools/call", "tool_0", { a: 1 }, { ok: true });
        }
      }

      const report = costReport(store);
      const p = report.projection!;
      expect(p.monthly_definition_tokens).toBeLessThanOrEqual(p.monthly_total_tokens);
      expect(report.definition_tokens).toBeLessThanOrEqual(report.total_tokens);
    });

    it("refuses to extrapolate a month from one afternoon", () => {
      const now = Date.now();
      for (let i = 0; i < 8; i++) {
        const id = `s${i}`;
        session(id, "github", now + i * 1000);
        listTools(id, 50);
      }
      expect(costReport(store).projection).toBeUndefined();
    });

    it("refuses to extrapolate from too few sessions", () => {
      const start = Date.now() - 10 * DAY;
      for (let i = 0; i < 3; i++) {
        const id = `s${i}`;
        session(id, "github", start + i * 3 * DAY);
        listTools(id, 50);
      }
      expect(costReport(store).projection).toBeUndefined();
    });
  });

  it("reports nothing rather than guessing when there is no data", () => {
    const report = costReport(store);
    expect(report.servers).toEqual([]);
    expect(report.waste).toEqual([]);
    expect(report.total_tokens).toBe(0);
    expect(report.per_session_tax).toBe(0);
  });
});
