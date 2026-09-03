import { describe, expect, it } from "vitest";
import { Redactor } from "../src/proxy/redact.js";

describe("Redactor", () => {
  const r = new Redactor();

  it("redacts well-known key shapes", () => {
    const cases: Array<[string, string]> = [
      ["sk-abcdefghijklmnop1234", "api-key"],
      ["sk-ant-api03-abcdefghijklmnop1234", "api-key"],
      ["AKIAIOSFODNN7EXAMPLE", "aws-key-id"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
      ["xoxb-1234567890-abcdefghijk", "slack-token"],
    ];
    for (const [secret, label] of cases) {
      const { text, count } = r.redact(`prefix ${secret} suffix`);
      expect(text, secret).toContain(`[REDACTED:${label}]`);
      expect(text, secret).not.toContain(secret);
      expect(count, secret).toBe(1);
    }
  });

  it("redacts bearer tokens and JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    expect(r.redact(`Authorization: Bearer ${jwt}`).text).not.toContain(jwt);
    expect(r.redact(`"auth":"Bearer abcdefghijklmnopqrstuvwxyz123456"`).text).toContain(
      "[REDACTED:bearer]",
    );
  });

  it("redacts credential-named JSON fields and keeps the JSON valid", () => {
    const input = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "login", arguments: { username: "sree", password: "hunter2!@#" } },
    });
    const { text, count } = r.redact(input);
    expect(count).toBe(1);
    expect(text).not.toContain("hunter2!@#");
    const parsed = JSON.parse(text) as {
      params: { arguments: { username: string; password: string } };
    };
    expect(parsed.params.arguments.username).toBe("sree");
    expect(parsed.params.arguments.password).toBe("[REDACTED:credential]");
  });

  it("leaves ordinary content alone", () => {
    const input = JSON.stringify({
      result: { content: [{ type: "text", text: "The token count is 512, task done." }] },
    });
    const { text, count } = r.redact(input);
    expect(count).toBe(0);
    expect(text).toBe(input);
  });

  it("supports a custom extra pattern", () => {
    const custom = new Redactor(/INTERNAL-[0-9]{6}/);
    const { text } = custom.redact("ref INTERNAL-123456 ok");
    expect(text).toBe("ref [REDACTED:custom] ok");
  });

  it("fromEnv respects the kill switch", () => {
    expect(Redactor.fromEnv({ MCPWATCH_REDACT: "0" })).toBeNull();
    expect(Redactor.fromEnv({})).toBeInstanceOf(Redactor);
  });
});
