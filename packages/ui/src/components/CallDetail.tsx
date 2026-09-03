import { useState } from "react";
import { formatClock, formatDuration, useCallDetail } from "../api";

function prettyJson(raw: string | null): string {
  if (raw === null) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function JsonBlock(props: { title: string; raw: string | null; truncated: number }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const pretty = prettyJson(props.raw);
  return (
    <section className="json-section">
      <div className="json-section-head">
        <span>{props.title}</span>
        {props.truncated !== 0 && <span className="badge badge-warn">stored truncated</span>}
        {props.raw !== null && (
          <button
            className="ghost-btn small"
            onClick={() => {
              void navigator.clipboard.writeText(pretty).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
        )}
      </div>
      {props.raw === null ? (
        <div className="json-none">no message</div>
      ) : (
        <pre className="json-pre mono">{pretty}</pre>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<string, string> = {
  ok: "ok",
  rpc_error: "rpc error",
  tool_error: "tool error",
  pending: "pending",
};

export function CallDetailPanel(props: { callId: number; onClose: () => void }): JSX.Element {
  const detail = useCallDetail(props.callId);

  return (
    <aside className="call-detail">
      {detail === null ? (
        <div className="empty">
          <p>Loading…</p>
        </div>
      ) : (
        <>
          <div className="detail-head">
            <span className={`status-dot ${detail.status}`} aria-hidden />
            <h2>{detail.tool_name ?? detail.method}</h2>
            <button className="ghost-btn" onClick={props.onClose} title="Close">
              ✕
            </button>
          </div>
          <div className="detail-meta mono">
            <span className={`badge status-badge-${detail.status}`}>{STATUS_LABEL[detail.status]}</span>
            <span>{formatDuration(detail.duration_ms)}</span>
            <span>{formatClock(detail.started_at)}</span>
            <span>{detail.direction === "c2s" ? "client → server" : "server → client"}</span>
            <span>id {detail.rpc_id}</span>
          </div>
          {detail.error_message !== null && (
            <div className="detail-error">{detail.error_message}</div>
          )}
          <JsonBlock title="Request" raw={detail.request_raw} truncated={detail.request_truncated} />
          <JsonBlock title="Response" raw={detail.response_raw} truncated={detail.response_truncated} />
        </>
      )}
    </aside>
  );
}
