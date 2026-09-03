import type { Store } from "../store/store.js";

/**
 * Analytical read layer for the agent-facing surfaces (`mcpwatch mcp`,
 * `mcpwatch doctor`).
 *
 * Everything here is read-only and shaped for a reader on a token budget: rows
 * are capped, payloads previewed rather than dumped, and the questions an agent
 * actually asks ("what just broke?", "is that server healthy?") are answered
 * directly. The capture-side queries in store.ts serve the dashboard, which can
 * afford to page through raw data; these cannot.
 */

export interface FailureRow {
  call_id: number;
  session_id: string;
  server: string;
  method: string;
  tool_name: string | null;
  status: string;
  error_message: string | null;
  duration_ms: number | null;
  started_at: number;
  args_preview: string | null;
}

export interface StalledRow {
  call_id: number;
  session_id: string;
  server: string;
  method: string;
  tool_name: string | null;
  started_at: number;
  args_preview: string | null;
  session_ended: boolean;
}

export interface ServerHealth {
  server: string;
  sessions: number;
  last_seen: number;
  calls: number;
  errors: number;
  error_rate: number;
  avg_ms: number | null;
  slowest_tool: string | null;
  slowest_ms: number | null;
  crashes: number;
  last_crash_exit: string | null;
  last_crash_stderr: string | null;
  stdout_pollution: number;
  never_answered: number;
}

export interface CallRow {
  call_id: number;
  session_id: string;
  server: string;
  method: string;
  tool_name: string | null;
  status: string;
  duration_ms: number | null;
  started_at: number;
  error_message: string | null;
  args_preview: string | null;
}

export interface CallDetail extends CallRow {
  request: string | null;
  response: string | null;
  request_truncated: boolean;
  response_truncated: boolean;
}

const ERROR_STATUSES = ["rpc_error", "tool_error"] as const;

/** Parse "30m" / "2h" / "7d" / "90" (minutes) into a millisecond cutoff. */
export function parseSince(since: string | undefined, now = Date.now()): number {
  if (since === undefined || since.trim() === "") return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(since.trim());
  if (match === null) return 0;
  const value = Number(match[1]);
  const unit = (match[2] || "m").toLowerCase();
  const scale = unit === "s" ? 1e3 : unit === "h" ? 3.6e6 : unit === "d" ? 8.64e7 : 6e4;
  return now - value * scale;
}

/** Short, safe preview of a tools/call argument object (already redacted on disk). */
export function argsPreview(requestRaw: string | null, limit = 300): string | null {
  if (requestRaw === null) return null;
  try {
    const msg = JSON.parse(requestRaw) as Record<string, unknown>;
    const params = msg.params as Record<string, unknown> | undefined;
    if (params === undefined || params === null) return null;
    const args = "arguments" in params ? params.arguments : params;
    if (args === undefined || args === null) return null;
    const text = JSON.stringify(args);
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  } catch {
    return null;
  }
}

function withPreview<T extends { request_raw?: string | null }>(
  row: T,
): Omit<T, "request_raw"> & { args_preview: string | null } {
  const { request_raw, ...rest } = row;
  return { ...rest, args_preview: argsPreview(request_raw ?? null) };
}

export interface FailureQuery {
  sinceMs?: number;
  limit?: number;
  server?: string;
}

/** Calls that came back as an error, newest first. */
export function recentFailures(store: Store, q: FailureQuery = {}): FailureRow[] {
  const rows = store.db
    .prepare(
      `SELECT c.id AS call_id, c.session_id, s.server_name AS server, c.method, c.tool_name,
              c.status, c.error_message, c.duration_ms, c.started_at,
              (SELECT raw FROM frames WHERE id = c.request_frame_id) AS request_raw
       FROM calls c JOIN sessions s ON s.id = c.session_id
       WHERE c.status IN (${ERROR_STATUSES.map(() => "?").join(",")})
         AND c.started_at >= ?
         AND (? IS NULL OR s.server_name = ?)
       ORDER BY c.started_at DESC LIMIT ?`,
    )
    .all(
      ...ERROR_STATUSES,
      q.sinceMs ?? 0,
      q.server ?? null,
      q.server ?? null,
      q.limit ?? 20,
    ) as Array<FailureRow & { request_raw: string | null }>;
  return rows.map(withPreview) as FailureRow[];
}

/**
 * Requests that never got a response. In an ended session this is a hang or a
 * server crash mid-call — the failure mode clients hide most completely.
 */
export function stalledCalls(store: Store, q: FailureQuery = {}): StalledRow[] {
  const rows = store.db
    .prepare(
      `SELECT c.id AS call_id, c.session_id, s.server_name AS server, c.method, c.tool_name,
              c.started_at, s.ended_at IS NOT NULL AS session_ended,
              (SELECT raw FROM frames WHERE id = c.request_frame_id) AS request_raw
       FROM calls c JOIN sessions s ON s.id = c.session_id
       WHERE c.status = 'pending' AND c.started_at >= ?
         AND (? IS NULL OR s.server_name = ?)
       ORDER BY c.started_at DESC LIMIT ?`,
    )
    .all(q.sinceMs ?? 0, q.server ?? null, q.server ?? null, q.limit ?? 20) as Array<
    Omit<StalledRow, "args_preview" | "session_ended"> & {
      request_raw: string | null;
      session_ended: number;
    }
  >;
  return rows.map(({ request_raw, session_ended, ...rest }) => ({
    ...rest,
    args_preview: argsPreview(request_raw),
    session_ended: session_ended === 1,
  }));
}

export interface SearchQuery {
  sinceMs?: number;
  limit?: number;
  server?: string;
  tool?: string;
  method?: string;
  status?: string;
  text?: string;
}

/** Filtered call search; `text` matches the recorded request/response payloads. */
export function findCalls(store: Store, q: SearchQuery = {}): CallRow[] {
  const where: string[] = ["c.started_at >= ?"];
  const params: unknown[] = [q.sinceMs ?? 0];

  if (q.server !== undefined) {
    where.push("s.server_name = ?");
    params.push(q.server);
  }
  if (q.tool !== undefined) {
    where.push("c.tool_name = ?");
    params.push(q.tool);
  }
  if (q.method !== undefined) {
    where.push("c.method = ?");
    params.push(q.method);
  }
  if (q.status !== undefined) {
    where.push(q.status === "error" ? "c.status IN ('rpc_error','tool_error')" : "c.status = ?");
    if (q.status !== "error") params.push(q.status);
  }
  if (q.text !== undefined && q.text !== "") {
    where.push(
      `EXISTS (SELECT 1 FROM frames f WHERE f.id IN (c.request_frame_id, c.response_frame_id)
               AND f.raw LIKE ? ESCAPE '\\')`,
    );
    params.push("%" + q.text.replace(/[\\%_]/g, "\\$&") + "%");
  }

  const rows = store.db
    .prepare(
      `SELECT c.id AS call_id, c.session_id, s.server_name AS server, c.method, c.tool_name,
              c.status, c.duration_ms, c.started_at, c.error_message,
              (SELECT raw FROM frames WHERE id = c.request_frame_id) AS request_raw
       FROM calls c JOIN sessions s ON s.id = c.session_id
       WHERE ${where.join(" AND ")}
       ORDER BY c.started_at DESC LIMIT ?`,
    )
    .all(...params, q.limit ?? 20) as Array<CallRow & { request_raw: string | null }>;
  return rows.map(withPreview) as CallRow[];
}

/** One call with its full recorded request and response payloads. */
export function getCall(store: Store, callId: number): CallDetail | undefined {
  const row = store.db
    .prepare(
      `SELECT c.id AS call_id, c.session_id, s.server_name AS server, c.method, c.tool_name,
              c.status, c.duration_ms, c.started_at, c.error_message,
              req.raw AS request, req.truncated AS request_truncated,
              res.raw AS response, res.truncated AS response_truncated
       FROM calls c
       JOIN sessions s ON s.id = c.session_id
       LEFT JOIN frames req ON req.id = c.request_frame_id
       LEFT JOIN frames res ON res.id = c.response_frame_id
       WHERE c.id = ?`,
    )
    .get(callId) as
    | (Omit<CallDetail, "args_preview" | "request_truncated" | "response_truncated"> & {
        request_truncated: number | null;
        response_truncated: number | null;
      })
    | undefined;
  if (row === undefined) return undefined;
  return {
    ...row,
    args_preview: argsPreview(row.request),
    request_truncated: row.request_truncated === 1,
    response_truncated: row.response_truncated === 1,
  };
}

/** Per-server rollup: is this server working, slow, crashing, or misbehaving? */
export function serverHealth(store: Store, sinceMs = 0): ServerHealth[] {
  const sessions = store.db
    .prepare(
      `SELECT server_name AS server, COUNT(*) AS sessions, MAX(started_at) AS last_seen,
              SUM(CASE WHEN (exit_code IS NOT NULL AND exit_code != 0) OR exit_signal IS NOT NULL
                       THEN 1 ELSE 0 END) AS crashes
       FROM sessions WHERE started_at >= ? GROUP BY server_name`,
    )
    .all(sinceMs) as Array<{ server: string; sessions: number; last_seen: number; crashes: number }>;

  const callStats = new Map(
    (
      store.db
        .prepare(
          `SELECT s.server_name AS server, COUNT(*) AS calls,
                  SUM(CASE WHEN c.status IN ('rpc_error','tool_error') THEN 1 ELSE 0 END) AS errors,
                  SUM(CASE WHEN c.status = 'pending' AND s.ended_at IS NOT NULL THEN 1 ELSE 0 END)
                    AS never_answered,
                  AVG(c.duration_ms) AS avg_ms
           FROM calls c JOIN sessions s ON s.id = c.session_id
           WHERE c.started_at >= ? GROUP BY s.server_name`,
        )
        .all(sinceMs) as Array<{
        server: string;
        calls: number;
        errors: number;
        never_answered: number;
        avg_ms: number | null;
      }>
    ).map((r) => [r.server, r]),
  );

  const slowest = new Map(
    (
      store.db
        .prepare(
          `SELECT s.server_name AS server, c.tool_name, c.method, c.duration_ms
           FROM calls c JOIN sessions s ON s.id = c.session_id
           WHERE c.started_at >= ? AND c.duration_ms IS NOT NULL
             AND c.duration_ms = (SELECT MAX(c2.duration_ms) FROM calls c2
                                  JOIN sessions s2 ON s2.id = c2.session_id
                                  WHERE s2.server_name = s.server_name AND c2.started_at >= ?)
           GROUP BY s.server_name`,
        )
        .all(sinceMs, sinceMs) as Array<{
        server: string;
        tool_name: string | null;
        method: string;
        duration_ms: number;
      }>
    ).map((r) => [r.server, r]),
  );

  const pollution = new Map(
    (
      store.db
        .prepare(
          `SELECT s.server_name AS server, COUNT(*) AS n
           FROM frames f JOIN sessions s ON s.id = f.session_id
           WHERE f.kind IN ('garbage','overflow','invalid') AND f.ts >= ?
           GROUP BY s.server_name`,
        )
        .all(sinceMs) as Array<{ server: string; n: number }>
    ).map((r) => [r.server, r.n]),
  );

  const lastCrash = store.db.prepare(
    `SELECT exit_code, exit_signal, stderr_tail FROM sessions
     WHERE server_name = ? AND started_at >= ?
       AND ((exit_code IS NOT NULL AND exit_code != 0) OR exit_signal IS NOT NULL)
     ORDER BY started_at DESC LIMIT 1`,
  );

  return sessions
    .map((s): ServerHealth => {
      const calls = callStats.get(s.server);
      const slow = slowest.get(s.server);
      const crash =
        s.crashes > 0
          ? (lastCrash.get(s.server, sinceMs) as
              | { exit_code: number | null; exit_signal: string | null; stderr_tail: string | null }
              | undefined)
          : undefined;
      const total = calls?.calls ?? 0;
      const errors = calls?.errors ?? 0;
      return {
        server: s.server,
        sessions: s.sessions,
        last_seen: s.last_seen,
        calls: total,
        errors,
        error_rate: total === 0 ? 0 : errors / total,
        avg_ms: calls?.avg_ms ?? null,
        slowest_tool: slow ? (slow.tool_name ?? slow.method) : null,
        slowest_ms: slow?.duration_ms ?? null,
        crashes: s.crashes,
        last_crash_exit: crash
          ? crash.exit_signal !== null
            ? `signal ${crash.exit_signal}`
            : `exit ${crash.exit_code}`
          : null,
        last_crash_stderr: crash?.stderr_tail ? crash.stderr_tail.slice(-600) : null,
        stdout_pollution: pollution.get(s.server) ?? 0,
        never_answered: calls?.never_answered ?? 0,
      };
    })
    .sort((a, b) => b.last_seen - a.last_seen);
}

export interface Overview {
  since_ms: number;
  servers: ServerHealth[];
  failures: FailureRow[];
  stalled: StalledRow[];
  totals: { calls: number; errors: number; servers: number; sessions: number };
}

/** Everything `doctor` and the agent's first question need, in one pass. */
export function overview(store: Store, opts: { sinceMs?: number; limit?: number } = {}): Overview {
  const sinceMs = opts.sinceMs ?? 0;
  const servers = serverHealth(store, sinceMs);
  return {
    since_ms: sinceMs,
    servers,
    failures: recentFailures(store, { sinceMs, limit: opts.limit ?? 10 }),
    stalled: stalledCalls(store, { sinceMs, limit: 5 }).filter((s) => s.session_ended),
    totals: {
      calls: servers.reduce((n, s) => n + s.calls, 0),
      errors: servers.reduce((n, s) => n + s.errors, 0),
      servers: servers.length,
      sessions: servers.reduce((n, s) => n + s.sessions, 0),
    },
  };
}
