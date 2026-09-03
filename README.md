<div align="center">

# 👁 mcpwatch

**Your coding agent can't see what its tools actually did. Now it can.**

A flight recorder for AI agents: a transparent proxy that records every MCP tool call
between your client (Claude Code, Codex, Cursor, Claude Desktop) and your MCP servers —
then hands that recording back to the agent as MCP tools, so it can debug itself.

*One command. All local. Zero config.*

[![npm](https://img.shields.io/npm/v/%40sreelal727%2Fmcpwatch?label=npm&color=cb3837)](https://www.npmjs.com/package/@sreelal727/mcpwatch)
[![CI](https://github.com/Sreelal727/mcpwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/Sreelal727/mcpwatch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<!-- demo.gif goes here before launch: record with scripts/seed-demo.ts --keep-running + mcpwatch ui -->

</div>

---

Your agent just called a tool and it failed. Which tool? With what arguments? What did
the server actually say? Your agent doesn't know either — MCP clients swallow errors,
truncate payloads, and forget everything when the session ends. So it guesses, retries
the same broken call, and you burn twenty minutes watching it flail.

mcpwatch records the real wire traffic and gives it back to the agent.

## Quick start

```
npx @sreelal727/mcpwatch init
```

Restart your client. That's the whole setup. Two things just happened:

1. Every stdio MCP server in your Claude Code, Codex, Cursor, and Claude Desktop configs
   now runs through the recording proxy (timestamped backups, fully reversible with
   `unwrap`).
2. **mcpwatch registered itself as an MCP server**, so your agent now has tools to read
   that recording.

Then just talk to your agent the way you already do:

> **You:** that github tool call failed, figure out why
>
> **Agent:** *(calls `mcpwatch / recent_failures`)*
> The `create_issue` call failed 40 seconds ago with `Validation Failed: body is too
> long (65536 max)` — the body you sent was 71,204 characters. I'll split it into an
> issue plus a follow-up comment.

No dashboard to open, no logs to paste, no "can you show me the error?" The agent looks
it up itself, because the ground truth is sitting on disk and it finally has a key.

(Install once with `npm i -g @sreelal727/mcpwatch` and every command is just `mcpwatch …`.)

### The four tools your agent gets

| Tool | The question it answers |
|---|---|
| `recent_failures` | "What just broke, with what arguments, and what did the server say?" |
| `server_health` | "Is that server crashing, slow, hanging, or corrupting the protocol?" |
| `find_calls` | "Has this tool ever worked? What arguments did I use last time?" |
| `get_call` | "Show me the exact request and response JSON for call #412." |

They're described so the agent knows *when* to reach for them — it calls
`recent_failures` on its own after a failed tool call, without being asked.

### Prefer the terminal? Never open a browser

```
mcpwatch doctor     # one-shot health report: what's erroring, crashing, hanging
mcpwatch tail       # live one-line-per-call stream
```

`doctor` is written to be read by a human *or* pasted to an agent — and `--json` makes
it machine-readable for agents that only have shell access (Codex in a VS Code terminal,
CI, hooks).

```
$ mcpwatch doctor
2 error(s) in 19 MCP calls across 3 server(s) in the last 24h.

! web-fetch        5 calls, no errors, avg 152ms   last seen 32s ago
    1 non-protocol stdout line (this server logs to stdout, which corrupts MCP)
✗ database         7 calls, 2 errors (29%), avg 227ms   last seen 34s ago
    high error rate
    slowest: run_query at 1.3s
✓ filesystem       7 calls, no errors, avg 54ms   last seen 36s ago

2 failed MCP tool calls in the last 24h, newest first:

[#14] 2s ago  database/does_not_exist  tool_error  (2ms)
    error: MCP error -32602: Tool does_not_exist not found
    args:  {}
    session fd14d19f · full payloads: get_call(14)
```

### And the dashboard, when you want to look yourself

```
npx @sreelal727/mcpwatch ui
```

Every session, every tool call, every request and response, with status and latency,
live. All of it in a SQLite file in your home directory, served on `127.0.0.1`, never
leaving your machine.

## What you get

- **Agent-readable recording** — `recent_failures`, `server_health`, `find_calls`,
  `get_call` as MCP tools, plus `doctor --json` and `tail --json` for agents that only
  have a shell. Your agent stops guessing about its own tool calls.
- **Live dashboard** — sessions stream in as your agent works: call timeline, status
  dots, latency bars, full request/response JSON inspection, filtering, dark/light.
- **Every call recorded** — paired request/response with duration and status
  (`ok` / `rpc_error` / `tool_error`), including in-band tool failures that clients
  often swallow silently.
- **Misbehaving-server detection** — servers that write logs to stdout corrupt the MCP
  protocol; mcpwatch records those lines and flags them instead of breaking.
- **Secret redaction, on by default** — API keys, bearer tokens, JWTs, and
  password-shaped JSON fields are scrubbed from the *stored copy* (never the live
  stream). `--no-redact` to disable, `MCPWATCH_REDACT_EXTRA` to add patterns.
- **Session export** — `mcpwatch export <id>` produces one self-contained HTML file:
  a shareable, scriptless bug report of exactly what happened.
- **HTTP servers too** — `mcpwatch http <url>` is a recording reverse proxy for
  Streamable HTTP servers (SSE responses included).
- **Your data, your disk** — `mcpwatch gc` for retention; delete `~/.mcpwatch` and
  it's gone. No SaaS, no accounts, no telemetry, ever.

## How it works

```
your agent ──stdio──▶ mcpwatch run ──stdio──▶ your MCP server
    ▲                      │
    │                      └── tee ──▶  SQLite (~/.mcpwatch)
    │                                        │
    └──── mcpwatch mcp ◀─────────────────────┤   the agent reads its own history
                                             │
          mcpwatch ui / doctor / tail ◀──────┘   you read it, when you want to
```

`mcpwatch init` rewrites each stdio server entry in your client's config to route
through `mcpwatch run`. The proxy pipes bytes through untouched and parses a *copy* of
the stream — capture is wired independently of passthrough, so even if recording fails,
your agent keeps working. **Passthrough is sacred** is design principle #1, enforced in
code and covered by end-to-end tests that drive a real MCP client through the proxy.

`init` also adds mcpwatch itself to your client as an MCP server, which closes the loop:
the recorder becomes a tool the agent can call. It is never wrapped by its own proxy —
otherwise every question the agent asked about the traffic would become more traffic.

## How it compares

| | mcpwatch | MCP Inspector | mcpsnoop | SaaS agent observability |
|---|---|---|---|---|
| **Your agent can query the recording** | ✅ **MCP tools** | ❌ | ❌ | ❌ |
| Real sessions from your actual client | ✅ | ❌ manual dev tool | ✅ | ✅ |
| Headless / terminal-only workflow | ✅ `doctor`, `tail` | ❌ | ✅ | ❌ |
| Web dashboard | ✅ | ✅ | ❌ terminal TUI | ✅ |
| One-command whole-client setup | ✅ `init` | ❌ | ❌ per-server | ❌ SDK/agent changes |
| Live tail | ✅ | ❌ | ✅ | ✅ |
| Self-contained HTML session export | ✅ | ❌ | ❌ | ❌ |
| 100% local, no account | ✅ | ✅ | ✅ | ❌ |
| Policy guardrails | 🔜 v1.0 | ❌ | ❌ | varies |

(All good tools — this is about which job each one is for. Inspector is great for
poking a server you're developing; mcpsnoop is a solid terminal viewer; SaaS platforms
add fleet features on their infrastructure.)

## Commands

| Command | What it does |
|---|---|
| `mcpwatch init [--dry-run]` | Instrument your clients **and** give your agent the mcpwatch tools (backups + reversible) |
| `mcpwatch doctor [--json]` | One-shot health report: erroring, crashing, hanging, slow, or protocol-corrupting servers |
| `mcpwatch tail [--json]` | Follow calls live in the terminal, one line each |
| `mcpwatch mcp` | Run mcpwatch as an MCP server (your client starts this; you normally won't) |
| `mcpwatch connect` | Print copy-paste setup for Claude Code / Codex / Cursor |
| `mcpwatch unwrap` | Restore original configs |
| `mcpwatch status` | Show what's instrumented |
| `mcpwatch ui [--port 4680]` | Local dashboard |
| `mcpwatch run --name X -- <cmd>` | Wrap one stdio server manually |
| `mcpwatch http <url> [--port 4681]` | Recording reverse proxy for a Streamable HTTP server |
| `mcpwatch sessions` / `calls <id>` | CLI views of recorded data |
| `mcpwatch export <id> [--out f.html]` | Self-contained HTML session export |
| `mcpwatch gc [--keep-days 30]` | Prune old sessions, compact the database |

## FAQ

**Overhead?** The proxy is a byte-level tee; parsing and storage happen on copies, off
the protocol's critical path. If capture ever fails (full disk, whatever), it disables
itself and traffic keeps flowing.

**Is my data safe?** It never leaves your machine: SQLite in `~/.mcpwatch`, dashboard
bound to `127.0.0.1`, secrets redacted at write time by default. The agent tools read
that same redacted local database — giving your agent the recording doesn't send it
anywhere it wasn't already going.

**My client wasn't auto-detected.** Run `mcpwatch connect` for a copy-paste snippet for
Claude Code (`claude mcp add`), Codex (`~/.codex/config.toml`), Cursor, or any other MCP
client. Nothing about the agent tools is Claude-specific — it's a plain MCP server.

**Does the agent read my whole history every time?** No. The tools return capped,
summarized answers (a dozen rows, previewed arguments) and default to a recent time
window. Full payloads only come back when the agent asks for one specific call.

**What about guardrails?** That's v1.0: allow/deny rules per server/tool, confirmation
prompts for dangerous calls, and tool-description drift alerts (the "rug pull" attack).
The recorder you're using today is the foundation for it. See [ROADMAP.md](ROADMAP.md).

## Development

```
npm install && npm run build && npm test
```

Monorepo: [`packages/cli`](packages/cli) (proxy + CLI + dashboard server),
[`packages/ui`](packages/ui) (React dashboard, builds into the CLI package).
Demo data for hacking on the UI:

```
cd packages/cli
npx tsx scripts/seed-demo.ts /tmp/mcpwatch-demo.db --keep-running &
node dist/index.js ui --db /tmp/mcpwatch-demo.db
```

Contributions welcome — see the roadmap for where things are headed.

## License

[MIT](LICENSE)
