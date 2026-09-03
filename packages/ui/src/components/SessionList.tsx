import { formatAgo, type SessionSummary } from "../api";

function sessionState(s: SessionSummary): { cls: string; label: string } {
  if (s.ended_at === null) return { cls: "running", label: "running" };
  if (s.exit_code === 0) return { cls: "done", label: "exit 0" };
  if (s.exit_signal !== null) return { cls: "failed", label: s.exit_signal };
  return { cls: "failed", label: `exit ${s.exit_code ?? "?"}` };
}

export function SessionList(props: {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
  loaded: boolean;
}): JSX.Element {
  return (
    <aside className="session-list">
      <div className="pane-title">Sessions</div>
      {props.loaded && props.sessions.length === 0 && (
        <div className="empty">
          <p>No sessions recorded yet.</p>
          <p>
            Instrument your MCP clients with <code>mcpwatch init</code>, then use your agent
            normally.
          </p>
        </div>
      )}
      <ul>
        {props.sessions.map((s) => {
          const state = sessionState(s);
          return (
            <li key={s.id}>
              <button
                className={`session-item ${s.id === props.selectedId ? "is-selected" : ""}`}
                onClick={() => props.onSelect(s.id)}
              >
                <span className={`status-dot ${state.cls}`} aria-hidden />
                <span className="session-name" title={s.command}>
                  {s.server_name}
                </span>
                <span className={`session-state ${state.cls}`}>{state.label}</span>
                <span className="session-meta">
                  {formatAgo(s.started_at, props.now)} · {s.calls} calls
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
