<div align="center">

# 👁 mcpwatch

**Every MCP server you've installed is charging you tokens on every single session.
See the bill — then cut it.**

mcpwatch records the real traffic between your coding agent (Claude Code, Codex, Cursor,
Claude Desktop) and your MCP servers, then itemises what that setup actually costs you in
context — and tells you exactly what to delete.

*One command. All local. Zero config. No account, ever.*

[![npm](https://img.shields.io/npm/v/%40sreelal727%2Fmcpwatch?label=npm&color=cb3837)](https://www.npmjs.com/package/@sreelal727/mcpwatch)
[![CI](https://github.com/Sreelal727/mcpwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/Sreelal727/mcpwatch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<!-- demo.gif goes here before launch: record with scripts/seed-demo.ts --keep-running + mcpwatch ui -->

</div>

---

Here's what nobody tells you when you install an MCP server: **its tool definitions get
injected into your agent's context at the start of every single session, whether you use
that server or not.** A big vendor integration with 50 tools can cost you 15,000+ tokens
before you type a word. You pay it again on the next session, and the next.

On top of that you're paying for tool responses that return 200 kB when you needed one
row, calls that fail and get retried, and agents re-fetching things they already had.

None of it shows up anywhere. mcpwatch records the actual bytes on the wire and turns
them into an itemised bill.

## See your number in ten seconds

No setup, no restart, no waiting. This starts each MCP server you already have
configured, asks it for its tool list the way your client does, measures it, and shuts
it down:

```
npx @sreelal727/mcpwatch audit
```

```
Every new session pays ~9,262 tokens ($0.05) to load these tool definitions,
before you type a word:

  github         8,825 tokens   52 tools   95%   Cursor
  filesystem       437 tokens    6 tools    5%   Cursor
                 9,262 tokens  every session

At 10 sessions a day that is ~2,778,600 tokens a month ($13.89 at $5/M) spent
before any work happens.

"github" alone is 95% of that. If you do not use it in every project, moving it to
the projects that need it is the single biggest win available to you.
```

That's the fixed cost, and it's knowable without recording anything.

## Then find out what you actually use

Which of those tools you *call* does need real traffic. Instrument once, work normally
for a day, and ask:

```
npx @sreelal727/mcpwatch init     # then restart your client
npx @sreelal727/mcpwatch cost     # a day later
```

```
Your MCP setup costs ~12,486 tokens per session before you type a word ($0.06 at $5/M tokens).

PER-SESSION TAX — tool definitions loaded into every new session:
  github        10,762 tokens   46 tools, none used  ← never called
  filesystem       780 tokens    8 tools, 2 used
  postgres         944 tokens    9 tools, 1 used
                12,486 tokens, every session

AT YOUR ACTUAL PACE — 34.9 server startups/day over 11.3 days:
  ~4,362,755 tokens/month ($21.81) on tool definitions alone, before any work happens
  ~4,939,089 tokens/month ($24.70) all in

BIGGEST SAVINGS — ~1,510,287 tokens ($7.55) of the above bought you nothing:
  1. 1,420,584 tokens (10,762 of them every session) — github: 46 tools loaded into
     every session, never called
     → Remove "github" from your MCP config (or load it only in projects that need it).
  2. 85,523 tokens — filesystem: 132 repeat calls with identical arguments in the same session
     → The agent re-fetched the same thing — usually a sign it lost the earlier result.
  3. 4,180 tokens — postgres: 33 failed calls
     → Fix or remove postgres's failing calls — each one costs context and a retry too.
```

Look at those first two numbers together: **$21.81 of that $24.70 monthly bill is tool
definitions** — the cost of merely having servers configured, before your agent does a
single useful thing. And the largest one has never been called.

That's the point of the whole tool. Not "here is a dashboard, go find something," but
*delete this one line from your config and stop paying 10,762 tokens every session for a
server you have never once used.*

The projection uses **your** observed startup rate from **your** recording — it isn't a
guess, and it doesn't appear at all until there's enough history to be honest about.

(Install once with `npm i -g @sreelal727/mcpwatch` and every command is just `mcpwatch …`.)

## Your agent can read the bill too

`init` also registers mcpwatch as an MCP server, so your agent gets these tools with no
extra setup:

| Tool | The question it answers |
|---|---|
| `token_costs` | "What is my MCP setup costing me, and what should I remove?" |
| `recent_failures` | "What just broke, with what arguments, and what did the server say?" |
| `server_health` | "Is that server crashing, slow, hanging, or corrupting the protocol?" |
| `find_calls` | "Has this tool ever worked? What arguments did I use last time?" |
| `get_call` | "Show me the exact request and response JSON for call #412." |

So you can just ask, in the client you already use:

> **You:** my context keeps filling up, what's eating it?
>
> **Agent:** *(calls `token_costs`)* Your `github` server loads 46 tool definitions —
> 10,762 tokens — into every session, and you haven't called it once in the last 30 days.
> That's about 1.4M tokens over the window. Your filesystem server also re-read identical
> files 132 times. Want me to take github out of your config?

The descriptions are written as trigger conditions, so the agent reaches for them on its
own — `recent_failures` after a failed tool call, `token_costs` when you mention context
or cost — instead of waiting to be told they exist.

## It also tells you what's broken

The same recording answers the reliability questions, in one command:

```
$ mcpwatch doctor
2 error(s) in 19 MCP calls across 3 server(s) in the last 24h.

! web-fetch        5 calls, no errors, avg 152ms   last seen 32s ago
    1 non-protocol stdout line (this server logs to stdout, which corrupts MCP)
✗ database         7 calls, 2 errors (29%), avg 227ms   last seen 34s ago
    high error rate
    slowest: run_query at 1.3s
✓ filesystem       7 calls, no errors, avg 54ms   last seen 36s ago

[#14] 2s ago  database/does_not_exist  tool_error  (2ms)
    error: MCP error -32602: Tool does_not_exist not found
    session fd14d19f · full payloads: get_call(14)
```

`mcpwatch tail` streams calls live, one line each. Everything takes `--json`, so agents
with only shell access (Codex in a VS Code terminal, hooks, CI) can read it too. And
`mcpwatch ui` opens a local dashboard on `127.0.0.1` when you'd rather look yourself.

## What you get

- **A number in ten seconds** — `mcpwatch audit` prices your configured servers with no
  instrumentation, no client restart, and no waiting for traffic.
- **An itemised token bill** — `mcpwatch cost` prices every server's per-session tax,
  projects it forward from your own usage, and ranks what to remove: unused servers,
  bloated tool lists, oversized responses, repeated calls, failed calls.
- **Agent-readable recording** — `token_costs`, `recent_failures`, `server_health`,
  `find_calls`, `get_call` as MCP tools, plus `--json` on everything for agents that
  only have a shell. Your agent stops guessing about its own tool calls.
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
| **Tells you what your setup costs in tokens** | ✅ `cost` | ❌ | ❌ | partial (spend, not per-server tax) |
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
| `mcpwatch audit [--json]` | Measure the per-session cost of your configured servers **right now** — no setup |
| `mcpwatch init [--dry-run]` | Instrument your clients **and** give your agent the mcpwatch tools (backups + reversible) |
| `mcpwatch cost [--since 30d] [--rate N] [--json]` | Itemised token bill: per-session tax, monthly projection, ranked savings |
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

**How accurate are the token numbers?** They're estimated from the recorded byte counts
at roughly 4 characters per token, not run through a real tokenizer — shipping one would
mean a native dependency in a CLI people install globally. They're precise enough to
rank what's expensive and to compare servers against each other, which is what you act
on. Don't reconcile an invoice with them. The dollar figures apply a rate you can set
with `--rate` (default $5 per million tokens), and the assumed rate is always printed.

**Will this lower my hosting or database bill?** Not directly — mcpwatch is a local
recorder, not infrastructure. What it does show is redundant work hitting your backends:
repeated identical calls, oversized queries, retry loops. Fixing those cuts API quota
and database load. But the honest headline is context tokens, and that's where the
savings actually are.

**Does the recording itself cost tokens?** No. Capture is a byte-level tee on your
machine; nothing is added to any prompt. The agent tools only enter context when the
agent actually calls one, and their answers are capped and summarised rather than dumped.

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
