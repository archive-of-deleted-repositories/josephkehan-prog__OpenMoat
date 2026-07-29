/**
 * Circuit breakers + health scoring for gateway children (OmniRoute's layered
 * breaker model, OpenMoat edition): server-scope breaker on spawn/connect failures,
 * tool-scope lockout on repeated call errors. Lazy half-open recovery — no
 * background timers; after the cooldown the next call is the probe.
 * Persisted in SQLite so every OpenMoat process (one per harness) shares state.
 */

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OpenMoatConfig } from "./config.js";
import { openStateDb } from "./db.js";

const THRESHOLD: Record<string, number> = { server: 3, tool: 4 };
const COOLDOWN_MS: Record<string, number> = { server: 10 * 60_000, tool: 5 * 60_000 };

export interface BreakerState {
  open: boolean;
  retryInMs: number;
  reason: string;
}

export interface BreakerPolicy {
  failureThreshold?: number;
  resetAfterMs?: number;
}

export interface ServerHealthStats {
  latencyMs: number;
  failures: number;
  lastErrorCode?: string;
}

function errorCode(message: string): string {
  const value = message.toLowerCase();
  if (value.includes("timeout")) return "TIMEOUT";
  if (value.includes("circuit")) return "CIRCUIT_OPEN";
  if (value.includes("quarantin")) return "QUARANTINED";
  if (value.includes("unauthor") || value.includes("denied")) {
    return "UNAUTHORIZED";
  }
  return "PROCESS_FAILED";
}

function displayServer(key: string): string {
  const asset = key.split("@", 1)[0] ?? key;
  return asset.split("/").at(-1) ?? asset;
}

export class Health {
  private db: DatabaseSync;

  constructor(cfg: OpenMoatConfig) {
    this.db = openStateDb(path.join(cfg.stateDir, "health.db"), `
      CREATE TABLE IF NOT EXISTS breakers (
        scope TEXT NOT NULL, key TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER NOT NULL, last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS stats (
        server TEXT NOT NULL, tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (server, tool)
      );
      CREATE TABLE IF NOT EXISTS agent_calls (
        agent TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
        PRIMARY KEY (agent, server, tool)
      );
    `);
  }

  failure(scope: "server" | "tool", key: string, error: string): void {
    this.db
      .prepare(
        `INSERT INTO breakers(scope, key, failures, last_at, last_error) VALUES(?,?,1,?,?)
         ON CONFLICT(scope, key) DO UPDATE SET failures = failures + 1, last_at = excluded.last_at, last_error = excluded.last_error`
      )
      .run(scope, key, Date.now(), error.slice(0, 200));
  }

  success(scope: "server" | "tool", key: string): void {
    this.db.prepare("DELETE FROM breakers WHERE scope = ? AND key = ?").run(scope, key);
  }

  check(
    scope: "server" | "tool",
    key: string,
    policy: BreakerPolicy = {}
  ): BreakerState {
    const row = this.db
      .prepare("SELECT failures, last_at, last_error FROM breakers WHERE scope = ? AND key = ?")
      .get(scope, key) as unknown as { failures: number; last_at: number; last_error: string } | undefined;
    const threshold = policy.failureThreshold ?? THRESHOLD[scope];
    const cooldown = policy.resetAfterMs ?? COOLDOWN_MS[scope];
    if (!row || row.failures < threshold) return { open: false, retryInMs: 0, reason: "" };
    const elapsed = Date.now() - row.last_at;
    if (elapsed >= cooldown) return { open: false, retryInMs: 0, reason: row.last_error }; // half-open probe
    return { open: true, retryInMs: cooldown - elapsed, reason: row.last_error };
  }

  /** Servers whose breaker is currently open (for tool_search demotion). */
  openServers(): Set<string> {
    const rows = this.db
      .prepare("SELECT key, failures, last_at FROM breakers WHERE scope = 'server'")
      .all() as unknown as { key: string; failures: number; last_at: number }[];
    const now = Date.now();
    return new Set(
      rows
        .filter((r) => r.failures >= THRESHOLD.server && now - r.last_at < COOLDOWN_MS.server)
        .map((r) => r.key)
    );
  }

  recordCall(server: string, tool: string, ms: number, isError: boolean): void {
    this.db
      .prepare(
        `INSERT INTO stats(server, tool, calls, errors, total_ms) VALUES(?,?,1,?,?)
         ON CONFLICT(server, tool) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, total_ms = total_ms + excluded.total_ms`
      )
      .run(server, tool, isError ? 1 : 0, Math.round(ms));
  }

  /** Normalized, secret-free server metrics for the public health contract. */
  serverStats(): Record<string, ServerHealthStats> {
    const stats = this.db
      .prepare(
        `SELECT server, SUM(calls) AS calls, SUM(errors) AS errors,
                SUM(total_ms) AS total_ms
         FROM stats GROUP BY server`
      )
      .all() as unknown as {
      server: string;
      calls: number;
      errors: number;
      total_ms: number;
    }[];
    const breakers = this.db
      .prepare(
        `SELECT key, failures, last_error
         FROM breakers WHERE scope = 'server'`
      )
      .all() as unknown as {
      key: string;
      failures: number;
      last_error: string;
    }[];
    const result: Record<string, ServerHealthStats> = {};
    for (const row of stats) {
      result[row.server] = {
        latencyMs: row.calls ? Math.round(row.total_ms / row.calls) : 0,
        failures: row.errors,
      };
    }
    for (const row of breakers) {
      const server = displayServer(row.key);
      const current = result[server] ?? { latencyMs: 0, failures: 0 };
      current.failures += row.failures;
      current.lastErrorCode = errorCode(row.last_error);
      result[server] = current;
    }
    return result;
  }

  /** Per-agent attribution: which agent (harness) called which tool. */
  recordAgentCall(agent: string, server: string, tool: string, ms: number, isError: boolean): void {
    this.db
      .prepare(
        `INSERT INTO agent_calls(agent, server, tool, calls, errors, total_ms, last_at) VALUES(?,?,?,1,?,?,?)
         ON CONFLICT(agent, server, tool) DO UPDATE SET
           calls = calls + 1, errors = errors + excluded.errors,
           total_ms = total_ms + excluded.total_ms, last_at = excluded.last_at`
      )
      .run(agent, server, tool, isError ? 1 : 0, Math.round(ms), Date.now());
  }

  /** Tracker report: which agent called which tool, volume/errors/latency/recency. */
  usageReport(opts: { agent?: string; server?: string; sinceMs?: number } = {}): string {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.agent) {
      where.push("agent = ?");
      params.push(opts.agent);
    }
    if (opts.server) {
      where.push("server = ?");
      params.push(opts.server);
    }
    if (opts.sinceMs) {
      where.push("last_at >= ?");
      params.push(Date.now() - opts.sinceMs);
    }
    const rows = this.db
      .prepare(
        `SELECT agent, server, tool, calls, errors, total_ms, last_at FROM agent_calls
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY agent, calls DESC`
      )
      .all(...params) as unknown as {
      agent: string;
      server: string;
      tool: string;
      calls: number;
      errors: number;
      total_ms: number;
      last_at: number;
    }[];
    if (!rows.length) return "No tracked calls match. (Tracking starts when agents call tools through a OpenMoat built with agent_calls support.)";

    const ago = (ts: number) => {
      const m = Math.round((Date.now() - ts) / 60_000);
      if (m < 1) return "just now";
      if (m < 60) return `${m}m ago`;
      const h = Math.round(m / 60);
      return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
    };
    const lines: string[] = [];
    let current = "";
    for (const r of rows) {
      if (r.agent !== current) {
        current = r.agent;
        const agentRows = rows.filter((x) => x.agent === current);
        const calls = agentRows.reduce((n, x) => n + x.calls, 0);
        const errors = agentRows.reduce((n, x) => n + x.errors, 0);
        lines.push(`${lines.length ? "\n" : ""}AGENT ${current} — ${calls} call(s), ${errors} error(s):`);
      }
      const avg = r.calls ? Math.round(r.total_ms / r.calls) : 0;
      const errPct = r.calls ? Math.round((r.errors / r.calls) * 100) : 0;
      lines.push(`  ${r.server} › ${r.tool}: ${r.calls} call(s), ${errPct}% errors, ~${avg}ms avg, last ${ago(r.last_at)}`);
    }
    return lines.join("\n");
  }

  close(): void {
    this.db.close();
  }
}

let cached: Health | null = null;
export function getHealth(cfg: OpenMoatConfig): Health {
  if (!cached) cached = new Health(cfg);
  return cached;
}
