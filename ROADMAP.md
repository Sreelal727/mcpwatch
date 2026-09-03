# mcpwatch — Roadmap

> **One-liner:** See everything your AI agents actually do on your machine. One command, all local.
>
> mcpwatch is a flight recorder for AI agents: a transparent proxy that records every MCP
> tool call between your client (Claude Code, Cursor, Claude Desktop) and your MCP servers,
> with a local web dashboard to browse, search, and replay sessions — and, later, guardrails
> to control what agents are allowed to do.

## Design principles (non-negotiable)

1. **Passthrough is sacred.** The proxy never modifies, delays, or reorders protocol bytes.
   Capture is a tee, parsing happens on copies. If our parser breaks, traffic still flows.
2. **All data stays local.** No SaaS, no accounts, no telemetry, no cloud. Ever.
3. **Zero config.** `mcpwatch init` instruments your whole client in one command and
   `mcpwatch unwrap` restores it byte-for-byte. No hand-editing configs.
4. **stdout discipline.** In proxy mode, stdout belongs to the protocol. All of our own
   output goes to stderr or the database.
5. **Small surface.** One CLI, one dashboard. Not an eval framework, not a gateway,
   not an enterprise platform.

## Phases

### Phase 0 — Foundation ✅
TypeScript monorepo (npm workspaces): `packages/cli` (published as `mcpwatch`) and
`packages/ui` (dashboard, Phase 3). MIT license, CI (build + test on Linux/macOS).

### Phase 1 — Transparent stdio proxy (the risky spike) ✅
`mcpwatch run --name <server> -- <command> [args...]` sits between any MCP client and
stdio server:
- Byte-perfect bidirectional passthrough (stdin/stdout/stderr, signals, exit codes).
- Tees traffic to a newline-delimited JSON-RPC frame parser; tolerates non-JSON lines
  (and records them — servers that corrupt the protocol become visible).
- Records to SQLite (`~/.mcpwatch/mcpwatch.db`, WAL): sessions, raw frames, and paired
  calls with duration, status (`ok` / `rpc_error` / `tool_error` / `pending`), tool name.
- Oversized frames stored truncated (default 512 KB) with a flag; passthrough unaffected.

**Acceptance:** an MCP SDK client talks through the proxy to a fixture server with zero
protocol breakage (init handshake, tools/list, tool calls, in-band tool errors), and the
database contains the complete, correctly paired record. Verified by e2e tests.

### Phase 2 — Zero-config client instrumentation
- `mcpwatch init` — detect and wrap MCP server entries for Claude Code, Claude Desktop,
  and Cursor configs (with timestamped backups + originals stored for restore).
- `mcpwatch unwrap` / `mcpwatch status` — restore configs / show what's instrumented.
- Session hygiene: client-name detection, orphaned-session cleanup, `mcpwatch sessions`
  / `mcpwatch calls` CLI views.

**Acceptance:** on a machine with Claude Code, `init` → use the agent normally → sessions
appear; `unwrap` → configs byte-identical to backups.

### Phase 3 — The dashboard (our differentiator) ✅
`mcpwatch ui` serves a local web app (no cloud):
- Live session feed (WebSocket tail) — watch calls stream in as the agent works.
- Session timeline: every call with tool name, status, latency; click → full
  request/response detail with JSON viewers.
- Search & filter across sessions (by server, tool, status, text).
- Fast, beautiful, dark/light. This is the thing nobody else has — polish is the feature.

**Acceptance:** the demo GIF — agent working on the left, calls streaming into the
dashboard on the right — makes people say "I want that."

### Phase 4 — Hardening & polish ✅ (code + README; demo GIF still to record)
- ✅ Streamable HTTP transport: `mcpwatch http <url>` recording reverse proxy (SSE included).
- ✅ Session export as a single self-contained, scriptless HTML file.
- ✅ Secret redaction at capture time, on by default (`--no-redact`, `MCPWATCH_REDACT_EXTRA`).
- ✅ Retention: `mcpwatch gc --keep-days/--keep-sessions` + VACUUM.
- ✅ Windows added to CI matrix (verify on first push). Real README with comparison table.
- ⬜ Record demo GIF for the README (scripts/seed-demo.ts --keep-running + dashboard).

### Phase 5 — Beta & launch prep
- 5–10 beta users from MCP Discord / r/mcp; fix what they hit.
- Issue templates, CONTRIBUTING.md, seeded good-first-issues.
- npm publish (`npx mcpwatch`), versioning, changelog.
- Draft Show HN + per-community Reddit posts (written by the maintainer, not the bot).

### Phase 6 — Launch
Show HN (Tue–Thu, morning US time) → r/ClaudeAI, r/mcp, r/LocalLLaMA, r/selfhosted over
the week → awesome-mcp lists, Glama, mcp.so PRs → "how I built it" post ~2 weeks later.
Maintainer answers everything for 48h.

### Phase 7 — Guardrails (v1.0, the second launch)
The moat — everything else in this space is observation-only:
- Policy rules: allow/deny by server/tool; "require confirmation" for dangerous calls.
- Tool-description drift detection (rug-pull alerts) against recorded baselines.
- Append-only audit log; policy file shareable across a team.

**North star:** 5,000 GitHub stars within ~12 months of launch, via two strong launches
and being genuinely used.
