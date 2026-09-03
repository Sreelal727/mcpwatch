import { useCallback, useEffect, useRef, useState } from "react";

export interface SessionSummary {
  id: string;
  server_name: string;
  command: string;
  args_json: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  stderr_tail: string | null;
  frames: number;
  calls: number;
}

export type CallStatus = "ok" | "rpc_error" | "tool_error" | "pending";

export interface Call {
  id: number;
  session_id: string;
  direction: "c2s" | "s2c";
  method: string;
  tool_name: string | null;
  rpc_id: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: CallStatus;
  error_message: string | null;
}

export interface GarbageFrame {
  id: number;
  ts: number;
  direction: "c2s" | "s2c";
  raw: string;
  truncated: number;
}

export interface SessionDetail {
  session: SessionSummary;
  calls: Call[];
  garbage: GarbageFrame[];
}

export interface CallDetail extends Call {
  request_raw: string | null;
  request_truncated: number;
  response_raw: string | null;
  response_truncated: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return (await res.json()) as T;
}

/**
 * All dashboard data, kept live: an SSE change-signal triggers refetches of
 * the sessions list and the selected session's detail.
 */
export function useLiveData(selectedId: string | null): {
  sessions: SessionSummary[];
  detail: SessionDetail | null;
  live: boolean;
  loaded: boolean;
} {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [live, setLive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const wanted = selectedRef.current;
      const [sessionList, sessionDetail] = await Promise.all([
        getJson<SessionSummary[]>("/api/sessions"),
        wanted !== null ? getJson<SessionDetail>(`/api/sessions/${wanted}`) : Promise.resolve(null),
      ]);
      if (mySeq !== seq.current) return; // a newer refresh finished first
      setSessions(sessionList);
      setDetail(wanted === selectedRef.current ? sessionDetail : null);
      setLoaded(true);
    } catch {
      /* server briefly unavailable; the next signal retries */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, selectedId]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("hello", () => setLive(true));
    source.addEventListener("changed", () => void refresh());
    source.onerror = () => setLive(false);
    source.onopen = () => setLive(true);
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      source.close();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { sessions, detail, live, loaded };
}

export function useCallDetail(callId: number | null): CallDetail | null {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  useEffect(() => {
    if (callId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void getJson<CallDetail>(`/api/calls/${callId}`).then(
      (d) => {
        if (!cancelled) setDetail(d);
      },
      () => {
        if (!cancelled) setDetail(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [callId]);
  return detail;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "…";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}
