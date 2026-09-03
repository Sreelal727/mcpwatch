import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import { createUiServer, type UiServer } from "../src/server/ui.js";

describe("ui server", () => {
  let tmpDir: string;
  let store: Store;
  let ui: UiServer;
  let base: string;
  const sessionId = "11111111-2222-3333-4444-555555555555";

  const seed = (): void => {
    store.createSession({
      id: sessionId,
      serverName: "seeded",
      command: "node",
      args: ["server.js"],
      startedAt: Date.now() - 5000,
    });
    const reqId = store.insertFrame({
      sessionId,
      ts: Date.now() - 4000,
      direction: "c2s",
      kind: "request",
      method: "tools/call",
      rpcId: "1",
      toolName: "echo",
      raw: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } }),
      truncated: false,
    });
    const callId = store.insertCall({
      sessionId,
      direction: "c2s",
      method: "tools/call",
      toolName: "echo",
      rpcId: "1",
      startedAt: Date.now() - 4000,
      endedAt: null,
      durationMs: null,
      status: "pending",
      requestFrameId: reqId,
    });
    const resId = store.insertFrame({
      sessionId,
      ts: Date.now() - 3900,
      direction: "s2c",
      kind: "response",
      rpcId: "1",
      raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
      truncated: false,
    });
    store.completeCall({
      callId,
      endedAt: Date.now() - 3900,
      durationMs: 100,
      status: "ok",
      responseFrameId: resId,
    });
    store.insertFrame({
      sessionId,
      ts: Date.now() - 3000,
      direction: "s2c",
      kind: "garbage",
      raw: "accidental console.log",
      truncated: false,
    });
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpwatch-ui-"));
    store = new Store(path.join(tmpDir, "ui.db"));
    seed();
    ui = createUiServer({ store, port: 0, pollMs: 50 });
    await new Promise<void>((resolve) => ui.server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    ui.close();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists sessions", async () => {
    const res = await fetch(`${base}/api/sessions`);
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.server_name).toBe("seeded");
    expect(sessions[0]!.calls).toBe(1);
  });

  it("returns session detail with calls and garbage frames", async () => {
    const res = await fetch(`${base}/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.session.id).toBe(sessionId);
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].tool_name).toBe("echo");
    expect(body.garbage).toHaveLength(1);
    expect(body.garbage[0].raw).toBe("accidental console.log");
  });

  it("returns call detail with raw request and response", async () => {
    const detailRes = await fetch(`${base}/api/sessions/${sessionId}`);
    const callId = ((await detailRes.json()) as Record<string, any>).calls[0].id;
    const res = await fetch(`${base}/api/calls/${callId}`);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("ok");
    expect(JSON.parse(body.request_raw).method).toBe("tools/call");
    expect(JSON.parse(body.response_raw).result).toEqual({ content: [] });
  });

  it("404s unknown resources", async () => {
    expect((await fetch(`${base}/api/sessions/99999999-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await fetch(`${base}/api/calls/999999`)).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("emits an SSE 'changed' event when new traffic arrives", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let received = "";
    const readUntil = async (needle: string, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !received.includes(needle)) {
        const race = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
        ]);
        if (race !== null && !race.done) received += decoder.decode(race.value);
      }
      return received.includes(needle);
    };

    expect(await readUntil("event: hello", 2000)).toBe(true);

    // The first poll after connect may fire once for the seed data; consume it.
    await readUntil("event: changed", 500);
    received = "";

    store.insertFrame({
      sessionId,
      ts: Date.now(),
      direction: "c2s",
      kind: "notification",
      method: "notifications/progress",
      raw: `{"jsonrpc":"2.0","method":"notifications/progress"}`,
      truncated: false,
    });
    expect(await readUntil("event: changed", 3000)).toBe(true);
    controller.abort();
  });

  it("serves a stub page when the frontend is not built", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mcpwatch");
  });
});
