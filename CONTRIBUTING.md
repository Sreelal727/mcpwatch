# Contributing to mcpwatch

Thanks for wanting to help! This project is young and contributions of every size are
welcome — bug reports, docs fixes, features, design feedback.

## Getting started

```
git clone https://github.com/mcpwatch/mcpwatch
cd mcpwatch
npm install
npm run build
npm test
```

- Node 20+ required. The monorepo has two packages: [`packages/cli`](packages/cli)
  (proxy, recorder, CLI, dashboard server) and [`packages/ui`](packages/ui) (React
  dashboard, which builds into `packages/cli/ui-dist`).
- Hack on the dashboard with live demo data:

  ```
  cd packages/cli
  npx tsx scripts/seed-demo.ts /tmp/mcpwatch-demo.db --keep-running &
  node dist/index.js ui --db /tmp/mcpwatch-demo.db
  ```

  For UI hot reload, also run `npm run dev` in `packages/ui` (it proxies `/api` to
  port 4680).

## The one rule that outranks all others

**Passthrough is sacred.** The proxy must never modify, delay, or reorder protocol
bytes, and no capture-side failure may ever break a user's agent. If your change
touches `proxy.ts`, `httpProxy.ts`, or `recorder.ts`, keep capture on the copy side of
the tee and guard it. The e2e tests enforce this — please keep them passing and add to
them.

Related principles (see [ROADMAP.md](ROADMAP.md)): all data stays local (never add
telemetry or cloud calls), zero-config UX, stdout discipline in proxy mode (stderr
only), and a small dependency footprint — new runtime dependencies need a strong
reason.

## Pull requests

1. Fork, branch from `main`, make your change.
2. `npm run build && npm test && npm run typecheck` must pass.
3. Add tests for behavior changes (unit tests are great; the e2e suites in
   `packages/cli/test/*.e2e.test.ts` show how to drive a real client through the proxy).
4. Keep PRs focused — one change per PR reviews fastest.
5. Describe *why*, not just what.

Not sure where to start? Look for
[`good first issue`](https://github.com/mcpwatch/mcpwatch/labels/good%20first%20issue)
or open a discussion — happy to help you scope something.

## Reporting bugs

`mcpwatch export <session-id>` produces a self-contained HTML file of the affected
session — attaching one (after checking it for anything sensitive) makes most bugs
trivially reproducible.

## Security

Please don't open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
