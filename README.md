<div align="center">

# 👁 mcpwatch

**See everything your AI agents actually do on your machine.**

A flight recorder for AI agents: a transparent proxy that records every MCP tool call
between your client (Claude Code, Cursor, Claude Desktop) and your MCP servers —
with a local dashboard to watch it live.

*One command. All local. Zero config.*

[![npm](https://img.shields.io/npm/v/%40sreelal727%2Fmcpwatch?label=npm&color=cb3837)](https://www.npmjs.com/package/@sreelal727/mcpwatch)
[![CI](https://github.com/Sreelal727/mcpwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/Sreelal727/mcpwatch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<!-- demo.gif goes here before launch: record with scripts/seed-demo.ts --keep-running + mcpwatch ui -->

</div>

---

Your agent just called a tool. Which one? With what arguments? Why did it take four
seconds? Did that server just see your `.env` file? Today the answer lives in an opaque
JSON-RPC stream between your client and your MCP servers. mcpwatch records that stream
and turns it into something you can actually read.

## Quick start

```
npx @sreelal727/mcpwatch init
```

That's it — every stdio MCP server in your Claude Code, Cursor, and Claude Desktop
configs now runs through the recording proxy (with timestamped backups, fully reversible
with `npx @sreelal727/mcpwatch unwrap`). Restart your client, use your agent normally, then:

```
npx @sreelal727/mcpwatch ui
```

(Install once with `npm i -g @sreelal727/mcpwatch` and every command is just `mcpwatch …`.)

…and watch your agent work, live: every session, every tool call, every request and
response, with status and latency. All of it stored in a SQLite file in your home
directory, served on `127.0.0.1`, never leaving your machine.

## What you get

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
Claude Code ──stdio──▶ mcpwatch run ──stdio──▶ your MCP server
                          │
                          └─ tee ─▶ SQLite (~/.mcpwatch) ◀─ mcpwatch ui (127.0.0.1)
```

`mcpwatch init` rewrites each stdio server entry in your client's config to route
through `mcpwatch run`. The proxy pipes bytes through untouched and parses a *copy* of
the stream — capture is wired independently of passthrough, so even if recording fails,
your agent keeps working. **Passthrough is sacred** is design principle #1, enforced in
code and covered by end-to-end tests that drive a real MCP client through the proxy.

## How it compares

| | mcpwatch | MCP Inspector | mcpsnoop | SaaS agent observability |
|---|---|---|---|---|
| Real sessions from your actual client | ✅ | ❌ manual dev tool | ✅ | ✅ |
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
| `mcpwatch init [--dry-run]` | Instrument Claude Desktop / Cursor / project `.mcp.json` (backups + reversible) |
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
bound to `127.0.0.1`, secrets redacted at write time by default.

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
