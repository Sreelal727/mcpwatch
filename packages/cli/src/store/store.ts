import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Direction = "c2s" | "s2c";
export type CallStatus = "ok" | "rpc_error" | "tool_error" | "pending";

export interface SessionRow {
  id: string;
  server_name: string;
  command: string;
  args_json: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  stderr_tail: string | null;
}

export interface FrameInput {
  sessionId: string;
  ts: number;
  direction: Direction;
  kind: string;
  method?: string;
  rpcId?: string;
  toolName?: string;
  raw: string;
  truncated: boolean;
}

export interface CallInput {
  sessionId: string;
  direction: Direction;
  method: string;
  toolName?: string;
  rpcId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: CallStatus;
  errorMessage?: string;
  requestFrameId: number;
  responseFrameId?: number;
}

export function defaultDbPath(): string {
  return process.env.MCPWATCH_DB ?? path.join(os.homedir(), ".mcpwatch", "mcpwatch.db");
}

export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string = defaultDbPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        server_name TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER,
        exit_signal TEXT,
        stderr_tail TEXT
      );
      CREATE TABLE IF NOT EXISTS frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        ts INTEGER NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        method TEXT,
        rpc_id TEXT,
        tool_name TEXT,
        raw TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_frames_session ON frames(session_id, id);
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        direction TEXT NOT NULL,
        method TEXT NOT NULL,
        tool_name TEXT,
        rpc_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms REAL,
        status TEXT NOT NULL,
        error_message TEXT,
        request_frame_id INTEGER NOT NULL REFERENCES frames(id),
        response_frame_id INTEGER REFERENCES frames(id)
      );
      CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id, id);
    `);
  }

  createSession(input: {
    id: string;
    serverName: string;
    command: string;
    args: string[];
    startedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, server_name, command, args_json, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.serverName, input.command, JSON.stringify(input.args), input.startedAt);
  }

  closeSession(input: {
    id: string;
    endedAt: number;
    exitCode: number | null;
    exitSignal: string | null;
    stderrTail: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE sessions SET ended_at = ?, exit_code = ?, exit_signal = ?, stderr_tail = ?
         WHERE id = ?`,
      )
      .run(input.endedAt, input.exitCode, input.exitSignal, input.stderrTail, input.id);
  }

  insertFrame(f: FrameInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO frames (session_id, ts, direction, kind, method, rpc_id, tool_name, raw, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.sessionId,
        f.ts,
        f.direction,
        f.kind,
        f.method ?? null,
        f.rpcId ?? null,
        f.toolName ?? null,
        f.raw,
        f.truncated ? 1 : 0,
      );
    return Number(res.lastInsertRowid);
  }

  insertCall(c: CallInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO calls (session_id, direction, method, tool_name, rpc_id, started_at, ended_at,
                            duration_ms, status, error_message, request_frame_id, response_frame_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.sessionId,
        c.direction,
        c.method,
        c.toolName ?? null,
        c.rpcId,
        c.startedAt,
        c.endedAt,
        c.durationMs,
        c.status,
        c.errorMessage ?? null,
        c.requestFrameId,
        c.responseFrameId ?? null,
      );
    return Number(res.lastInsertRowid);
  }

  completeCall(input: {
    callId: number;
    endedAt: number;
    durationMs: number;
    status: CallStatus;
    errorMessage?: string;
    responseFrameId: number;
  }): void {
    this.db
      .prepare(
        `UPDATE calls SET ended_at = ?, duration_ms = ?, status = ?, error_message = ?, response_frame_id = ?
         WHERE id = ?`,
      )
      .run(
        input.endedAt,
        input.durationMs,
        input.status,
        input.errorMessage ?? null,
        input.responseFrameId,
        input.callId,
      );
  }

  listSessions(limit = 20): Array<SessionRow & { frames: number; calls: number }> {
    return this.db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM frames f WHERE f.session_id = s.id) AS frames,
                (SELECT COUNT(*) FROM calls c WHERE c.session_id = s.id) AS calls
         FROM sessions s ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(limit) as Array<SessionRow & { frames: number; calls: number }>;
  }

  listCalls(sessionId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM calls WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<Record<string, unknown>>;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
  }

  /** Non-protocol stdout lines — servers logging where they shouldn't. */
  listGarbageFrames(sessionId: string, limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, ts, direction, substr(raw, 1, 500) AS raw, truncated
         FROM frames WHERE session_id = ? AND kind IN ('garbage', 'overflow', 'invalid')
         ORDER BY id LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
  }

  getCallDetail(callId: number): Record<string, unknown> | undefined {
    const call = this.db.prepare(`SELECT * FROM calls WHERE id = ?`).get(callId) as
      | Record<string, unknown>
      | undefined;
    if (call === undefined) return undefined;
    const frame = this.db.prepare(`SELECT raw, truncated FROM frames WHERE id = ?`);
    const request = frame.get(call.request_frame_id) as Record<string, unknown> | undefined;
    const response =
      call.response_frame_id === null
        ? undefined
        : (frame.get(call.response_frame_id) as Record<string, unknown> | undefined);
    return {
      ...call,
      request_raw: request?.raw ?? null,
      request_truncated: request?.truncated ?? 0,
      response_raw: response?.raw ?? null,
      response_truncated: response?.truncated ?? 0,
    };
  }

  /**
   * Cheap change-detection tuple for live updates: any insert or session
   * close changes at least one component.
   */
  version(): string {
    const row = this.db
      .prepare(
        `SELECT (SELECT COALESCE(MAX(id), 0) FROM frames) AS f,
                (SELECT COALESCE(MAX(id), 0) FROM calls) AS c,
                (SELECT COUNT(*) FROM sessions) AS s,
                (SELECT COALESCE(MAX(COALESCE(ended_at, 0)), 0) FROM sessions) AS e`,
      )
      .get() as { f: number; c: number; s: number; e: number };
    return `${row.f}:${row.c}:${row.s}:${row.e}`;
  }

  close(): void {
    this.db.close();
  }
}
