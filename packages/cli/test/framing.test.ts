import { describe, expect, it } from "vitest";
import { NdjsonSplitter, classifyRpc } from "../src/proxy/framing.js";

describe("NdjsonSplitter", () => {
  it("splits multiple frames from one chunk", () => {
    const splitter = new NdjsonSplitter();
    const frames = splitter.push('{"a":1}\n{"b":2}\n');
    expect(frames).toHaveLength(2);
    expect(frames[0]!.json).toEqual({ a: 1 });
    expect(frames[1]!.json).toEqual({ b: 2 });
  });

  it("reassembles a frame split across chunk boundaries", () => {
    const splitter = new NdjsonSplitter();
    expect(splitter.push('{"jsonrpc":"2.0","me')).toHaveLength(0);
    const frames = splitter.push('thod":"ping"}\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.json).toEqual({ jsonrpc: "2.0", method: "ping" });
  });

  it("passes through non-JSON lines as unparsed frames", () => {
    const splitter = new NdjsonSplitter();
    const frames = splitter.push("server started on port 3000\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.json).toBeUndefined();
    expect(frames[0]!.raw).toBe("server started on port 3000");
  });

  it("tolerates \\r\\n line endings", () => {
    const splitter = new NdjsonSplitter();
    const frames = splitter.push('{"a":1}\r\n');
    expect(frames[0]!.json).toEqual({ a: 1 });
  });

  it("drops oversized lines as overflow frames without corrupting the next frame", () => {
    const splitter = new NdjsonSplitter(16);
    const frames = [
      ...splitter.push("x".repeat(100)),
      ...splitter.push("y".repeat(100) + '\n{"ok":true}\n'),
    ];
    expect(frames).toHaveLength(2);
    expect(frames[0]!.overflow).toBe(true);
    expect(frames[1]!.json).toEqual({ ok: true });
  });

  it("flushes a trailing unterminated line", () => {
    const splitter = new NdjsonSplitter();
    splitter.push('{"tail":true}');
    const frames = splitter.flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.json).toEqual({ tail: true });
    expect(splitter.flush()).toHaveLength(0);
  });
});

describe("classifyRpc", () => {
  it("classifies requests, including tool calls", () => {
    const info = classifyRpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "echo", arguments: { msg: "hi" } },
    });
    expect(info).toEqual({ kind: "request", method: "tools/call", rpcId: "7", toolName: "echo" });
  });

  it("classifies notifications", () => {
    const info = classifyRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(info.kind).toBe("notification");
    expect(info.rpcId).toBeUndefined();
  });

  it("classifies success and error responses", () => {
    expect(classifyRpc({ jsonrpc: "2.0", id: "a", result: {} })).toEqual({
      kind: "response",
      rpcId: "a",
      isErrorResponse: false,
    });
    expect(classifyRpc({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "no" } })).toEqual({
      kind: "response",
      rpcId: "1",
      isErrorResponse: true,
    });
  });

  it("marks non-object and shapeless values invalid", () => {
    expect(classifyRpc("hello").kind).toBe("invalid");
    expect(classifyRpc(null).kind).toBe("invalid");
    expect(classifyRpc([1, 2]).kind).toBe("invalid");
    expect(classifyRpc({ jsonrpc: "2.0" }).kind).toBe("invalid");
  });
});
