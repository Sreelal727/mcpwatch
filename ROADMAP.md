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

### Phase 4.5 — Agent-native surface ✅ (v0.2.0)
The repositioning that came out of asking "what does this do for someone who is purely
vibe coding?" They never open a dashboard — but their agent is blind to its own tool
calls, and we're already holding the ground truth. So we stopped building only a viewer
for humans and made the recording queryable by the agent itself:
- ✅ `mcpwatch mcp` — mcpwatch as an MCP server: `recent_failures`, `server_health`,
  `find_calls`, `get_call`. Hand-rolled on our own JSON-RPC framing (no server framework
  in a globally-installed CLI's dependency tree), proven against the real SDK client.
- ✅ `init` registers mcpwatch in the client config, so the tools appear with zero extra
  steps — and never wraps itself (self-recording loop).
- ✅ `init` now also works on a client with no `mcpServers` section yet.
- ✅ `mcpwatch doctor [--json]` — one-shot health report for shell-only agents and CI.
- ✅ `mcpwatch tail [--json]` — headless live stream; no browser required.
- ✅ `mcpwatch connect` — copy-paste setup for Claude Code / Codex / Cursor.
- ✅ Tool descriptions written as trigger conditions, so the agent reaches for them
  unprompted after a failed call.

**Acceptance:** an agent that just hit an opaque MCP error can explain what actually
happened without the user opening anything. Covered end to end: real client → proxy →
real server, then real client → `mcpwatch mcp` → that recording.

### Phase 4.6 — The cost frame ✅ (v0.3.0)
Repositioning again, and this one is the launch story. Debugging is episodic — you reach
for it when something breaks. Cost is continuous: every MCP server injects its tool
definitions into every session whether you use it or not, and nobody has ever seen that
bill itemised. We were already recording the exact bytes.
- ✅ `mcpwatch cost` — per-server per-session tax, traffic totals, and a monthly
  projection extrapolated from the user's own observed startup rate (suppressed when
  there is too little history to be honest).
- ✅ Ranked, actionable waste: unused servers, bloated tool lists, oversized responses,
  repeated identical calls, failed calls — each with the specific fix.
- ✅ Reporting floors, so the output stays a short list of things worth doing.
- ✅ `token_costs` MCP tool: the agent answers "why is my context filling up?" itself.
- ✅ Token counts estimated from bytes (~4 chars/token) — no tokenizer dependency in a
  globally installed CLI — and every surface says so.

**Honesty guardrails:** we claim context-token savings, which is what the data supports.
We do not claim to lower hosting or database bills; the FAQ says so explicitly and
points at the real secondary benefit (redundant calls hitting your backends).

### Phase 4.7 — Ten seconds to a number ✅ (v0.4.0)
The adoption bug: time-to-value was a *day*. `init` → restart client → work → `cost`.
Nobody shares a tool before they have seen it do anything, and every step before the
payoff loses people. But the most striking number — the per-session tax — needs no
recording at all: it is just each server's tools/list response, which is exactly what a
client loads on every start.
- ✅ `mcpwatch audit` launches each configured server the way a client would, completes
  the MCP handshake, measures the tool list, and shuts it down. No instrumentation, no
  restart, no waiting.
- ✅ Reads servers from existing client configs, peeling off any mcpwatch wrapping so it
  measures the real server; skips remote servers and our own agent server.
- ✅ Degrades honestly: a server that fails to start, hangs, or logs to stdout is
  reported and the audit continues.
- ✅ Names the single biggest line item when one dominates, because that is the action.

**Why this matters more than a launch post:** it makes the first run produce a
screenshot-worthy number, which is the part that actually travels.

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
