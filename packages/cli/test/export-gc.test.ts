import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSessionHtml } from "../src/export/exportHtml.js";
import { Store } from "../src/store/store.js";

function seedSession(store: Store, id: string, startedAt: number, toolText: string): void {
  store.createSession({ id, serverName: "seeded", command: "node", args: ["s.js"], startedAt });
  const reqId = store.insertFrame({
    sessionId: id,
    ts: startedAt,
    direction: "c2s",
    kind: "request",
    method: "tools/call",
    rpcId: "1",
    toolName: "echo",
    raw: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } }),
    truncated: false,
  });
  const callId = store.insertCall({
    sessionId: id,
    direction: "c2s",
    method: "tools/call",
    toolName: "echo",
    rpcId: "1",
    startedAt,
    endedAt: null,
    durationMs: null,
    status: "pending",
    requestFrameId: reqId,
  });
  const resId = store.insertFrame({
    sessionId: id,
    ts: startedAt + 40,
    direction: "s2c",
    kind: "response",
    rpcId: "1",
    raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: toolText }] } }),
    truncated: false,
  });
  store.completeCall({ callId, endedAt: startedAt + 40, durationMs: 40, status: "ok", responseFrameId: resId });
  store.closeSession({ id, endedAt: startedAt + 1000, exitCode: 0, exitSignal: null, stderrTail: null });
}

describe("export + gc", () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-exp-"));
    store = new Store(path.join(tmpDir, "x.db"));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders a self-contained HTML export with escaped content", () => {
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    seedSession(store, id, Date.now() - 60_000, `<script>alert("xss")</script>`);
    store.insertFrame({
      sessionId: id,
      ts: Date.now(),
      direction: "s2c",
      kind: "garbage",
      raw: "<b>noise</b>",
      truncated: false,
    });

    const html = renderSessionHtml(store, id)!;
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("echo");
    expect(html).toContain("tools/call");
    // Raw payloads must be escaped — no live tags from recorded content.
    expect(html).not.toContain(`<script>alert`);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>noise</b>");
    expect(html).toContain("non-protocol stdout line");
    // No external requests: no src/href to http(s) besides the footer link.
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("<link");

    expect(renderSessionHtml(store, "missing-id")).toBeUndefined();
  });

  it("finds sessions by unique prefix", () => {
    const id = "bbbbbbbb-1111-2222-3333-444444444444";
    seedSession(store, id, Date.now(), "hi");
    expect(store.findSessionByPrefix("bbbbbbbb")?.id).toBe(id);
    expect(store.findSessionByPrefix(id)?.id).toBe(id);
    expect(store.findSessionByPrefix("zzz")).toBeUndefined();
  });

  it("gc deletes by age and by count, and reports totals", () => {
    const day = 24 * 60 * 60 * 1000;
    seedSession(store, "old-1111-2222-3333-444444444444", Date.now() - 40 * day, "old");
    seedSession(store, "mid-1111-2222-3333-444444444444", Date.now() - 10 * day, "mid");
    seedSession(store, "new-1111-2222-3333-444444444444", Date.now(), "new");

    const byAge = store.gc({ keepDays: 30 });
    expect(byAge.sessions).toBe(1);
    expect(byAge.frames).toBe(2);
    expect(byAge.calls).toBe(1);
    expect(store.listSessions().map((s) => s.id)).toHaveLength(2);

    const byCount = store.gc({ keepSessions: 1 });
    expect(byCount.sessions).toBe(1);
    const left = store.listSessions();
    expect(left).toHaveLength(1);
    expect(left[0]!.id).toBe("new-1111-2222-3333-444444444444");
  });
});
