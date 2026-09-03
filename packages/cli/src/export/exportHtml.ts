import { Store } from "../store/store.js";

/**
 * Render one session as a single self-contained HTML file: no scripts, no
 * external assets, safe to attach to a bug report or an issue. Collapsible
 * request/response bodies use plain <details> elements.
 */

function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pretty(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function fmtDuration(ms: unknown): string {
  if (typeof ms !== "number") return "…";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const STATUS_COLOR: Record<string, string> = {
  ok: "#3fb950",
  rpc_error: "#f85149",
  tool_error: "#d9a03f",
  pending: "#58a6ff",
};

export function renderSessionHtml(store: Store, sessionId: string): string | undefined {
  const session = store.getSession(sessionId);
  if (session === undefined) return undefined;
  const calls = store.listCalls(sessionId);
  const garbage = store.listGarbageFrames(sessionId, 200);

  const errors = calls.filter((c) => c.status === "rpc_error" || c.status === "tool_error").length;
  const state =
    session.ended_at === null
      ? "unclosed"
      : session.exit_code === 0
        ? "exit 0"
        : (session.exit_signal ?? `exit ${session.exit_code ?? "?"}`);

  const callBlocks = calls
    .map((call) => {
      const detail = store.getCallDetail(Number(call.id));
      const color = STATUS_COLOR[String(call.status)] ?? "#7e8b9c";
      const label =
        call.tool_name !== null && call.tool_name !== undefined
          ? `${esc(call.tool_name)} <span class="m">${esc(call.method)}</span>`
          : esc(call.method);
      const error =
        call.error_message !== null && call.error_message !== undefined
          ? `<div class="err" style="color:${color}">${esc(call.error_message)}</div>`
          : "";
      const section = (title: string, raw: unknown, truncated: unknown): string =>
        typeof raw === "string" && raw.length > 0
          ? `<div class="sec">${title}${truncated ? ' <span class="trunc">stored truncated</span>' : ""}</div><pre>${esc(pretty(raw))}</pre>`
          : "";
      return `<details>
<summary><span class="dot" style="background:${color}"></span><span class="name">${label}</span>${error === "" ? "" : "⚠ "}<span class="dur">${esc(fmtDuration(call.duration_ms))}</span><span class="time">${esc(new Date(Number(call.started_at)).toISOString().slice(11, 23))}</span></summary>
${error}
${section("Request", detail?.request_raw, detail?.request_truncated)}
${section("Response", detail?.response_raw, detail?.response_truncated)}
</details>`;
    })
    .join("\n");

  const garbageBlock =
    garbage.length === 0
      ? ""
      : `<h2>⚠ ${garbage.length} non-protocol stdout line${garbage.length === 1 ? "" : "s"}</h2>
<div class="garbage">${garbage.map((g) => `<div>${esc(g.raw)}</div>`).join("\n")}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcpwatch · ${esc(session.server_name)}</title>
<style>
:root{color-scheme:dark}
body{background:#0b0e14;color:#dbe4ee;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:920px;margin:0 auto;padding:32px 20px 60px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:13px;color:#d9a03f;margin:28px 0 8px}
.meta{color:#7e8b9c;font-size:13px;margin-bottom:6px}
.stats{color:#7e8b9c;font-size:13px;margin-bottom:22px}
.stats b{color:#dbe4ee;font-weight:600}
code,pre,.mono,.dur,.time{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
details{border:1px solid #202939;border-radius:8px;margin:6px 0;background:#10141d;overflow:hidden}
summary{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;list-style:none}
summary::-webkit-details-marker{display:none}
summary:hover{background:#151b26}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.name{font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:600;flex:1;min-width:0}
.name .m{color:#7e8b9c;font-weight:400;font-size:11px;margin-left:7px}
.dur{font-size:12px;color:#7e8b9c}
.time{font-size:12px;color:#7e8b9c}
.err{font-size:12.5px;padding:0 12px 8px}
.sec{font-size:11px;font-weight:650;letter-spacing:1px;text-transform:uppercase;color:#7e8b9c;padding:8px 12px 0}
.trunc{color:#d9a03f;text-transform:none;letter-spacing:0;font-weight:400}
pre{margin:6px 12px 12px;padding:10px 12px;background:#151b26;border:1px solid #202939;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.55}
.garbage{border:1px solid #202939;border-left:3px solid #d9a03f;border-radius:8px;background:#10141d;padding:4px 0}
.garbage div{padding:4px 12px;color:#7e8b9c;font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
footer{margin-top:34px;color:#556172;font-size:12px}
footer a{color:#4da3ff;text-decoration:none}
</style>
</head>
<body>
<h1>${esc(session.server_name)} <span class="mono" style="font-size:12px;color:#7e8b9c">${esc(state)}</span></h1>
<div class="meta"><code>${esc(session.command)} ${esc(JSON.parse(session.args_json).join(" "))}</code></div>
<div class="stats"><b>${calls.length}</b> calls · <b>${errors}</b> errors · started ${esc(new Date(Number(session.started_at)).toISOString())} · session <span class="mono">${esc(session.id)}</span></div>
${callBlocks}
${garbageBlock}
<footer>Recorded with <a href="https://github.com/Sreelal727/mcpwatch">mcpwatch</a> — the flight recorder for AI agents.</footer>
</body>
</html>
`;
}
