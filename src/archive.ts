/**
 * CCR-style archive: oversized tool results are stored content-addressed in
 * SQLite instead of being truncated away. The agent gets the head plus a
 * hash, and can page through the rest with tool_result_fetch.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OpenMoatConfig } from "./config.js";
import { openStateDb } from "./db.js";

export class Archive {
  private db: DatabaseSync;

  constructor(cfg: OpenMoatConfig) {
    this.db = openStateDb(
      path.join(cfg.stateDir, "archive.db"),
      "CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, content TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL)"
    );
    const columns = this.db
      .prepare("PRAGMA table_info(blobs)")
      .all() as unknown as { name: string }[];
    if (!columns.some((column) => column.name === "owner")) {
      this.db.exec(
        "ALTER TABLE blobs ADD COLUMN owner TEXT NOT NULL DEFAULT 'legacy-unscoped'"
      );
    }
  }

  store(owner: string, text: string): string {
    const hash = crypto
      .createHash("sha256")
      .update(owner)
      .update("\0")
      .update(text)
      .digest("hex")
      .slice(0, 16);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO blobs(hash, content, bytes, created, owner) VALUES(?,?,?,?,?)"
      )
      .run(hash, text, text.length, Date.now(), owner);
    return hash;
  }

  fetch(
    owner: string,
    hash: string,
    offset = 0,
    limit = 8000
  ): { slice: string; total: number; remaining: number } | null {
    const row = this.db
      .prepare("SELECT content, bytes FROM blobs WHERE hash = ? AND owner = ?")
      .get(hash, owner) as
      | unknown as { content: string; bytes: number }
      | undefined;
    if (!row) return null;
    const slice = row.content.slice(offset, offset + limit);
    return { slice, total: row.bytes, remaining: Math.max(0, row.bytes - offset - slice.length) };
  }

  /** Content-aware retrieval (jmunch-style): search inside an archived blob
   *  instead of paging blindly. Returns matching lines with char offsets. */
  find(
    owner: string,
    hash: string,
    pattern: string,
    maxMatches = 20
  ): { offset: number; line: string }[] | null {
    const row = this.db
      .prepare("SELECT content FROM blobs WHERE hash = ? AND owner = ?")
      .get(hash, owner) as
      | unknown as { content: string }
      | undefined;
    if (!row) return null;
    const needle = pattern.toLowerCase();
    const out: { offset: number; line: string }[] = [];
    let offset = 0;
    for (const line of row.content.split("\n")) {
      if (line.toLowerCase().includes(needle)) {
        out.push({ offset, line: line.slice(0, 300) });
        if (out.length >= maxMatches) break;
      }
      offset += line.length + 1;
    }
    return out;
  }

  prune(days = 14): number {
    const cutoff = Date.now() - days * 86400_000;
    const before = (this.db.prepare("SELECT COUNT(*) n FROM blobs").get() as unknown as { n: number }).n;
    this.db.prepare("DELETE FROM blobs WHERE created < ?").run(cutoff);
    const after = (this.db.prepare("SELECT COUNT(*) n FROM blobs").get() as unknown as { n: number }).n;
    return before - after;
  }

  close(): void {
    this.db.close();
  }
}

let cached: Archive | null = null;
export function getArchive(cfg: OpenMoatConfig): Archive {
  if (!cached) cached = new Archive(cfg);
  return cached;
}
