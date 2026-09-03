import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatClock,
  formatDuration,
  type Call,
  type SessionDetail,
} from "../api";

type StatusFilter = "all" | "ok" | "error" | "pending";

function matches(call: Call, text: string, status: StatusFilter): boolean {
  if (status === "ok" && call.status !== "ok") return false;
  if (status === "error" && call.status !== "rpc_error" && call.status !== "tool_error") return false;
  if (status === "pending" && call.status !== "pending") return false;
  if (text !== "") {
    const label = `${call.method} ${call.tool_name ?? ""}`.toLowerCase();
    if (!label.includes(text.toLowerCase())) return false;
  }
  return true;
}

/** Log-ish scale so 5ms and 5s both render meaningfully. */
function durationBarWidth(ms: number | null): string {
  if (ms === null) return "0%";
  const scaled = Math.min(1, Math.log10(1 + ms) / 4); // 10s → full bar
  return `${Math.max(2, scaled * 100)}%`;
}

export function SessionView(props: {
  detail: SessionDetail | null;
  now: number;
  selectedCallId: number | null;
  onSelectCall: (id: number | null) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [showGarbage, setShowGarbage] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);

  const detail = props.detail;
  const calls = useMemo(
    () => (detail?.calls ?? []).filter((c) => matches(c, text, status)),
    [detail, text, status],
  );

  // Live tail: stay pinned to the newest call unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el !== null && pinnedToBottom.current && detail?.session.ended_at === null) {
      el.scrollTop = el.scrollHeight;
    }
  }, [detail]);

  if (detail === null) {
    return (
      <main className="session-view">
        <div className="empty empty-main">
          <p>Select a session to inspect it.</p>
        </div>
      </main>
    );
  }

  const s = detail.session;
  const errors = detail.calls.filter((c) => c.status === "rpc_error" || c.status === "tool_error").length;
  const durationMs = (s.ended_at ?? props.now) - s.started_at;

  return (
    <main className="session-view">
      <div className="session-header">
        <div className="session-header-row">
          <h1>{s.server_name}</h1>
          {s.ended_at === null ? (
            <span className="badge badge-running">running</span>
          ) : s.exit_code === 0 ? (
            <span className="badge badge-ok">exit 0</span>
          ) : (
            <span className="badge badge-err">{s.exit_signal ?? `exit ${s.exit_code ?? "?"}`}</span>
          )}
        </div>
        <div className="session-subline">
          <code className="cmd" title={`${s.command} ${JSON.parse(s.args_json).join(" ")}`}>
            {s.command} {JSON.parse(s.args_json).join(" ")}
          </code>
        </div>
        <div className="session-stats">
          <span>{detail.calls.length} calls</span>
          <span className={errors > 0 ? "stat-err" : ""}>{errors} errors</span>
          <span>{formatDuration(durationMs)} total</span>
          <span className="mono session-id">{s.id.slice(0, 8)}</span>
        </div>
      </div>

      <div className="filter-bar">
        <input
          className="filter-input"
          placeholder="Filter by tool or method…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {(["all", "ok", "error", "pending"] as const).map((f) => (
          <button
            key={f}
            className={`chip ${status === f ? "is-active" : ""}`}
            onClick={() => setStatus(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <div
        className="timeline"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el !== null) {
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }
        }}
      >
        {calls.length === 0 && (
          <div className="empty">
            <p>No calls match.</p>
          </div>
        )}
        {calls.map((call) => (
          <button
            key={call.id}
            className={`call-row status-${call.status} ${call.id === props.selectedCallId ? "is-selected" : ""}`}
            onClick={() => props.onSelectCall(call.id === props.selectedCallId ? null : call.id)}
          >
            <span className={`status-dot ${call.status}`} aria-hidden />
            <span className="call-label">
              {call.tool_name !== null ? (
                <>
                  <span className="call-tool">{call.tool_name}</span>
                  <span className="call-method">{call.method}</span>
                </>
              ) : (
                <span className="call-tool">{call.method}</span>
              )}
              {call.error_message !== null && (
                <span className="call-error">{call.error_message}</span>
              )}
            </span>
            <span className="call-duration">
              <span className="duration-bar" style={{ width: durationBarWidth(call.duration_ms) }} />
              <span className="mono">{formatDuration(call.duration_ms)}</span>
            </span>
            <span className="call-time mono">{formatClock(call.started_at)}</span>
          </button>
        ))}

        {detail.garbage.length > 0 && (
          <div className="garbage">
            <button className="garbage-toggle" onClick={() => setShowGarbage(!showGarbage)}>
              ⚠ {detail.garbage.length} non-protocol stdout line
              {detail.garbage.length === 1 ? "" : "s"} — this server writes where it shouldn't
              <span className="garbage-caret">{showGarbage ? "▾" : "▸"}</span>
            </button>
            {showGarbage &&
              detail.garbage.map((g) => (
                <div key={g.id} className="garbage-line mono">
                  {g.raw}
                </div>
              ))}
          </div>
        )}
      </div>
    </main>
  );
}
