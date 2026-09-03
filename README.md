# mcpwatch

> 🚧 **Pre-alpha.** Under active development — not ready for users yet. Watch the repo for the launch.

**See everything your AI agents actually do on your machine. One command, all local.**

mcpwatch is a flight recorder for AI agents: a transparent proxy that records every MCP
tool call between your client (Claude Code, Cursor, Claude Desktop) and your MCP servers,
with a local web dashboard to browse, search, and live-tail sessions.

- **Zero config** — `mcpwatch init` instruments your whole client; `mcpwatch unwrap` undoes it.
- **Live dashboard** — `mcpwatch ui`: watch calls stream in as your agent works, inspect any
  request/response, spot slow tools and errors at a glance.
- **All local** — SQLite on your disk, dashboard bound to 127.0.0.1. No SaaS, no accounts, no telemetry.
- **Passthrough is sacred** — capture is a tee; the protocol bytes are never touched.
- **Coming in v1.0** — guardrails: approve/block rules and tool-drift (rug-pull) alerts.

See [ROADMAP.md](ROADMAP.md) for the plan.

## Development

```
npm install
npm run build
npm test
```

Try the dashboard with demo data (three recorded sessions + one live agent):

```
cd packages/cli
npx tsx scripts/seed-demo.ts /tmp/mcpwatch-demo.db --keep-running &
node dist/index.js ui --db /tmp/mcpwatch-demo.db
```

Monorepo layout: [`packages/cli`](packages/cli) (the `mcpwatch` CLI + proxy),
[`packages/ui`](packages/ui) (local dashboard — coming in Phase 3).

## License

[MIT](LICENSE)
