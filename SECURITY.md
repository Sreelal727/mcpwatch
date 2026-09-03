# Security Policy

mcpwatch records MCP traffic locally and sits in the path between AI clients and MCP
servers, so we take security reports seriously.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** ("Security" tab → "Report a
vulnerability") rather than a public issue. You'll get an acknowledgement within a few
days.

In scope, especially:

- Anything that breaks the passthrough guarantee (proxy modifying/injecting traffic)
- Capture-side content leading to code execution (e.g. via the dashboard or HTML export)
- The dashboard binding beyond 127.0.0.1 or serving files outside its asset directory
- Redaction bypasses worth fixing at the pattern level (note: redaction is documented
  as best-effort, so individual pattern gaps are usually ordinary issues, not
  vulnerabilities)

## Supported versions

Pre-1.0: only the latest release is supported. Please reproduce on the latest version
before reporting.
