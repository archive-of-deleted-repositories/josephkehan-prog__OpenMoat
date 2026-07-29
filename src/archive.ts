import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OpenMoatConfig } from "./config.js";
import { openStateDb } from "./db.js";

const HANDLE = /^[a-f0-9]{48}$/;

function ownerKey(owner: string): string {
  return crypto.createHash("sha256").update(owner).digest("hex");
}

export class Archive {
  private db: DatabaseSync;

  constructor(private cfg: OpenMoatConfig) {
    this.db = openStateDb(
      path.join(cfg.stateDir, "archive.db"),
      `CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        content TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blobs_owner_created
        ON blobs(owner, created);`
    );
  }

  private removeExpired(owner?: string): number {
    const cutoff = Date.now() - this.cfg.archiveLimits.ttlMs;
    const result = owner
      ? this.db
          .prepare("DELETE FROM blobs WHERE owner = ? AND created < ?")
          .run(ownerKey(owner), cutoff)
      : this.db.prepare("DELETE FROM blobs WHERE created < ?").run(cutoff);
    return Number(result.changes);
  }

  store(owner: string, text: string): string {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.cfg.archiveLimits.maxBlobBytes) {
      throw new Error(
        `RESULT_TOO_LARGE: ${bytes} bytes exceeds the archive blob limit`
      );
    }
    const key = ownerKey(owner);
    this.removeExpired(owner);

    let usage = this.db
      .prepare(
        "SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM blobs WHERE owner = ?"
      )
      .get(key) as unknown as { entries: number; bytes: number };
    while (
      usage.entries >= this.cfg.archiveLimits.maxCallerEntries ||
      usage.bytes + bytes > this.cfg.archiveLimits.maxCallerBytes
    ) {
      const oldest = this.db
        .prepare(
          "SELECT hash, bytes FROM blobs WHERE owner = ? ORDER BY created, hash LIMIT 1"
        )
        .get(key) as unknown as
        | { hash: string; bytes: number }
        | undefined;
      if (!oldest) {
        throw new Error("ARCHIVE_QUOTA: caller archive quota is exhausted");
      }
      this.db.prepare("DELETE FROM blobs WHERE hash = ?").run(oldest.hash);
      usage = {
        entries: usage.entries - 1,
        bytes: usage.bytes - oldest.bytes,
      };
    }

    const hash = crypto.randomBytes(24).toString("hex");
    this.db
      .prepare(
        "INSERT INTO blobs(hash, owner, content, bytes, created) VALUES(?,?,?,?,?)"
      )
      .run(hash, key, text, bytes, Date.now());
    return hash;
  }

  private read(
    owner: string,
    hash: string
  ): { content: string; bytes: number } | null {
    if (!HANDLE.test(hash)) return null;
    const row = this.db
      .prepare(
        "SELECT content, bytes, created FROM blobs WHERE hash = ? AND owner = ?"
      )
      .get(hash, ownerKey(owner)) as unknown as
      | { content: string; bytes: number; created: number }
      | undefined;
    if (!row) return null;
    if (Date.now() - row.created > this.cfg.archiveLimits.ttlMs) {
      this.db.prepare("DELETE FROM blobs WHERE hash = ?").run(hash);
      return null;
    }
    return row;
  }

  fetch(
    owner: string,
    hash: string,
    offset = 0,
    limit = 8000
  ): { slice: string; total: number; remaining: number } | null {
    const row = this.read(owner, hash);
    if (!row) return null;
    const safeOffset = Math.max(0, Math.min(offset, row.content.length));
    const safeLimit = Math.max(100, Math.min(limit, 30_000));
    const slice = row.content.slice(safeOffset, safeOffset + safeLimit);
    return {
      slice,
      total: row.bytes,
      remaining: Math.max(
        0,
        row.content.length - safeOffset - slice.length
      ),
    };
  }

  find(
    owner: string,
    hash: string,
    pattern: string,
    maxMatches = 20
  ): { offset: number; line: string }[] | null {
    const row = this.read(owner, hash);
    if (!row) return null;
    const needle = pattern.slice(0, 500).toLowerCase();
    if (!needle) return [];
    const out: { offset: number; line: string }[] = [];
    let offset = 0;
    for (const line of row.content.split("\n")) {
      if (line.toLowerCase().includes(needle)) {
        out.push({ offset, line: line.slice(0, 300) });
        if (out.length >= Math.min(Math.max(maxMatches, 1), 100)) break;
      }
      offset += line.length + 1;
    }
    return out;
  }

  prune(): number {
    return this.removeExpired();
  }

  close(): void {
    this.db.close();
  }
}

const cache = new Map<string, Archive>();

export function getArchive(cfg: OpenMoatConfig): Archive {
  const key = path.resolve(cfg.stateDir);
  let archive = cache.get(key);
  if (!archive) {
    archive = new Archive(cfg);
    cache.set(key, archive);
  }
  return archive;
}
