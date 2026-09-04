import type { FailureRow, ServerHealth, StalledRow, CallRow, Overview } from "../query/insights.js";
import type { CostReport } from "../query/cost.js";

/**
 * Rendering for agent readers.
 *
 * These strings are consumed by a coding agent with a context budget, so they
 * are written like a good colleague's answer: the conclusion first, numbers
 * that support it, and the exact next command to get more. Dense prose beats
 * pretty-printed JSON here — it costs a third of the tokens and reads the same
 * to both an agent and the human looking over its shoulder.
 */

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function ms(value: number | null): string {
  if (value === null) return "-";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function indent(text: string, prefix = "    "): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

export const NO_DATA = `No MCP traffic has been recorded yet.

Tell the user to run this once, then restart their editor/client:
  npx @sreelal727/mcpwatch init

That routes every stdio MCP server through the recorder (reversible with
"mcpwatch unwrap"). Until then there is nothing for these tools to read.`;

export function formatFailures(rows: FailureRow[], window: string): string {
  if (rows.length === 0) {
    return `No failed MCP tool calls in the last ${window}. If something still looks wrong, try server_health (a server may be crashing or logging to stdout) or find_calls with status="pending".`;
  }
  const lines = rows.map((r) => {
    const label = r.tool_name ? `${r.server}/${r.tool_name}` : `${r.server} ${r.method}`;
    const head = `[#${r.call_id}] ${ago(r.started_at)}  ${label}  ${r.status}  (${ms(r.duration_ms)})`;
    const body: string[] = [];
    if (r.error_message) body.push(`error: ${r.error_message.replace(/\s+/g, " ").slice(0, 400)}`);
    if (r.args_preview) body.push(`args:  ${r.args_preview}`);
    body.push(`session ${r.session_id.slice(0, 8)} · full payloads: get_call(${r.call_id})`);
    return `${head}\n${indent(body.join("\n"))}`;
  });
  return `${rows.length} failed MCP tool call${rows.length === 1 ? "" : "s"} in the last ${window}, newest first:\n\n${lines.join("\n\n")}`;
}

export function formatStalled(rows: StalledRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => {
    const label = r.tool_name ? `${r.server}/${r.tool_name}` : `${r.server} ${r.method}`;
    return `[#${r.call_id}] ${ago(r.started_at)}  ${label} — request sent, no response before the session ended`;
  });
  return `${rows.length} call${rows.length === 1 ? "" : "s"} never answered (hang or mid-call crash):\n${indent(lines.join("\n"), "  ")}`;
}

export function formatHealth(rows: ServerHealth[], window: string): string {
  if (rows.length === 0) return NO_DATA;
  const lines = rows.map((r) => {
    // Broken (crashing, erroring, hanging) outranks merely misbehaving
    // (protocol-corrupting stdout), which outranks fine.
    const broken: string[] = [];
    const misbehaving: string[] = [];
    if (r.crashes > 0) broken.push(`crashed ${r.crashes}×, last ${r.last_crash_exit}`);
    if (r.never_answered > 0) broken.push(`${r.never_answered} call(s) never answered`);
    if (r.error_rate >= 0.2 && r.calls > 0) broken.push("high error rate");
    if (r.stdout_pollution > 0) {
      misbehaving.push(
        `${r.stdout_pollution} non-protocol stdout line${r.stdout_pollution === 1 ? "" : "s"} (this server logs to stdout, which corrupts MCP)`,
      );
    }
    const problems = [...broken, ...misbehaving];

    const mark = broken.length > 0 ? "✗" : misbehaving.length > 0 ? "!" : r.calls === 0 ? "·" : "✓";
    const stats =
      r.calls === 0
        ? "no calls recorded"
        : `${r.calls} calls, ${r.errors === 0 ? "no errors" : `${r.errors} error${r.errors === 1 ? "" : "s"} (${Math.round(r.error_rate * 100)}%)`}, avg ${ms(r.avg_ms)}`;
    const detail: string[] = [];
    if (problems.length > 0) detail.push(problems.join("; "));
    if (r.last_crash_stderr) {
      detail.push(`stderr: ${r.last_crash_stderr.replace(/\s+/g, " ").slice(-300)}`);
    }
    if (r.slowest_ms !== null && r.slowest_ms >= 1000) {
      detail.push(`slowest: ${r.slowest_tool} at ${ms(r.slowest_ms)}`);
    }
    const head = `${mark} ${r.server.padEnd(16)} ${stats}   last seen ${ago(r.last_seen)}`;
    return detail.length > 0 ? `${head}\n${indent(detail.join("\n"))}` : head;
  });
  return `${rows.length} MCP server${rows.length === 1 ? "" : "s"} recorded in the last ${window}:\n\n${lines.join("\n")}`;
}

export function formatCalls(rows: CallRow[], description: string): string {
  if (rows.length === 0) {
    return `No calls matched ${description}. Widen the time window (since="7d") or drop a filter — recording only covers servers that were wrapped by "mcpwatch init".`;
  }
  const lines = rows.map((r) => {
    const label = r.tool_name ? `${r.server}/${r.tool_name}` : `${r.server} ${r.method}`;
    const head = `[#${r.call_id}] ${ago(r.started_at)}  ${label}  ${r.status}  (${ms(r.duration_ms)})`;
    const body: string[] = [];
    if (r.error_message) body.push(`error: ${r.error_message.replace(/\s+/g, " ").slice(0, 200)}`);
    if (r.args_preview) body.push(`args:  ${r.args_preview}`);
    return body.length > 0 ? `${head}\n${indent(body.join("\n"))}` : head;
  });
  return `${rows.length} call${rows.length === 1 ? "" : "s"} matching ${description}, newest first:\n\n${lines.join("\n\n")}\n\nUse get_call(<id>) for the full request and response payloads.`;
}

function n(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Dollars for a token count at a given USD-per-million-tokens rate. */
function usd(tokens: number, ratePerMillion: number): string {
  const dollars = (tokens / 1_000_000) * ratePerMillion;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(3)}`;
}

export const COST_DISCLAIMER =
  "Token counts are estimated from recorded bytes (~4 chars/token) — use them to compare and " +
  "prioritise, not to reconcile a bill.";

/**
 * The `cost` report. Ends in specific things to delete, because a number
 * nobody can act on is just anxiety.
 */
export function formatCost(report: CostReport, window: string, ratePerMillion: number): string {
  if (report.servers.length === 0) return NO_DATA;
  const out: string[] = [];

  out.push(
    `Your MCP setup costs ~${n(report.per_session_tax)} tokens per session before you type a word ` +
      `(${usd(report.per_session_tax, ratePerMillion)} at $${ratePerMillion}/M tokens).`,
    "",
    "PER-SESSION TAX — tool definitions loaded into every new session:",
  );

  const width = Math.max(...report.servers.map((s) => s.server.length), 8);
  for (const s of report.servers) {
    if (s.definition_tokens === 0) continue;
    const usage =
      s.tool_count === 0
        ? ""
        : s.calls === 0
          ? `   ${s.tool_count} tools, none used`
          : `   ${s.tool_count} tools, ${s.tools_used} used`;
    const flag = s.calls === 0 ? "  ← never called" : "";
    out.push(`  ${s.server.padEnd(width)}  ${n(s.definition_tokens).padStart(8)} tokens${usage}${flag}`);
  }
  out.push(`  ${"".padEnd(width)}  ${n(report.per_session_tax).padStart(8)} tokens, every session`);

  out.push(
    "",
    `TRAFFIC — requests and responses over the last ${window} (${report.sessions} session${report.sessions === 1 ? "" : "s"}):`,
    `  ${n(report.traffic_tokens)} tokens  (${usd(report.traffic_tokens, ratePerMillion)})`,
    `  plus ${n(report.definition_tokens)} tokens of definitions reloaded across those sessions`,
    `  total ${n(report.total_tokens)} tokens  (${usd(report.total_tokens, ratePerMillion)})`,
  );

  if (report.projection !== undefined) {
    const p = report.projection;
    out.push(
      "",
      `AT YOUR ACTUAL PACE — ${p.startups_per_day} server startups/day over ${p.days_observed} days:`,
      `  ~${n(p.monthly_definition_tokens)} tokens/month (${usd(p.monthly_definition_tokens, ratePerMillion)}) ` +
        `on tool definitions alone, before any work happens`,
      `  ~${n(p.monthly_total_tokens)} tokens/month (${usd(p.monthly_total_tokens, ratePerMillion)}) all in`,
    );
  }

  if (report.waste.length > 0) {
    out.push(
      "",
      `BIGGEST SAVINGS — ~${n(report.wasted_tokens)} tokens (${usd(report.wasted_tokens, ratePerMillion)}) ` +
        `of the above bought you nothing:`,
    );
    report.waste.slice(0, 6).forEach((w, i) => {
      const recurring =
        w.per_session_tokens === undefined ? "" : ` (${n(w.per_session_tokens)} of them every session)`;
      out.push(`  ${i + 1}. ${n(w.tokens)} tokens${recurring} — ${w.server}: ${w.detail}`);
      out.push(`     → ${w.action}`);
    });
  } else {
    out.push("", "No obvious waste found: no unused servers, failed calls, or repeated calls.");
  }

  out.push("", COST_DISCLAIMER);
  return out.join("\n");
}

/** The `doctor` report — same content for a human terminal and an agent. */
export function formatOverview(o: Overview, window: string): string {
  if (o.servers.length === 0) return NO_DATA;
  const parts: string[] = [];
  const { calls, errors } = o.totals;
  const verdict =
    errors === 0 && o.stalled.length === 0 && !o.servers.some((s) => s.crashes > 0 || s.stdout_pollution > 0)
      ? `All clear: ${calls} MCP calls across ${o.totals.servers} server(s) in the last ${window}, no errors.`
      : `${errors} error(s) in ${calls} MCP calls across ${o.totals.servers} server(s) in the last ${window}.`;
  parts.push(verdict, "", formatHealth(o.servers, window));
  if (o.failures.length > 0) parts.push("", formatFailures(o.failures, window));
  const stalled = formatStalled(o.stalled);
  if (stalled !== "") parts.push("", stalled);
  return parts.join("\n");
}
