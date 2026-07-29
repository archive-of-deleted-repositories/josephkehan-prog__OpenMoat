import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Open a shared state DB. Every OpenMoat process (one per harness) writes the same
 * files, so WAL alone is not enough: node:sqlite's default busy timeout is 0,
 * which turns concurrent writes into immediate SQLITE_BUSY throws. busy_timeout
 * makes contending writers queue briefly instead.
 */
export function openStateDb(dbPath: string, schema: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(schema);
  return db;
}
