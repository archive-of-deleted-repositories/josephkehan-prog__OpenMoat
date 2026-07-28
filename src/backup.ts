import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function stamp(): string {
  // Millisecond resolution: all adapters back up within the same runSync loop,
  // so second resolution alone can collide.
  return new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
}

/** Collision-proof backup name: encodes the path (relative to home when
 *  possible), not just the basename — cursor/pi/omp all manage an "mcp.json". */
function backupName(filePath: string): string {
  const home = os.homedir();
  const rel = filePath.startsWith(home) ? filePath.slice(home.length) : filePath;
  return rel.replace(/^[/\\]+/, "").replace(/[/\\]+/g, "-");
}

const GENERATED_BACKUP = /^(.*\.bak-)(?:\d{8}(?:-\d{6,9}|T\d{6})|\d{10,16})$/;
const FILE_BACKUPS_KEEP = 3;

/** Keep bounded timestamped sync backups per managed file. Named milestone
 *  backups such as .bak-pre-abandon are intentionally preserved. */
export function pruneFileBackups(stateDir: string, keep = FILE_BACKUPS_KEEP): number {
  const dir = path.join(stateDir, "backups");
  if (!fs.existsSync(dir)) return 0;
  const groups = new Map<string, string[]>();
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(GENERATED_BACKUP);
    if (!match) continue;
    const files = groups.get(match[1]) ?? [];
    files.push(name);
    groups.set(match[1], files);
  }
  let pruned = 0;
  for (const files of groups.values()) {
    files.sort();
    const retained = Math.max(0, keep);
    const stale = retained === 0 ? files : files.slice(0, -retained);
    for (const name of stale) {
      fs.unlinkSync(path.join(dir, name));
      pruned++;
    }
  }
  return pruned;
}

/** Copy file to state/backups/<path-slug>.bak-<stamp> before modifying. Returns backup path or null. */
export function backupFile(filePath: string, stateDir: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.join(stateDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${backupName(filePath)}.bak-${stamp()}`);
  fs.copyFileSync(filePath, dest);
  pruneFileBackups(stateDir);
  return dest;
}

export function writeFileSafe(filePath: string, content: string, stateDir: string, dryRun: boolean): string | null {
  if (dryRun) return null;
  const backup = backupFile(filePath, stateDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic write: some targets (~/.claude.json) hold the tool's ENTIRE state;
  // a crash mid-write must never leave a truncated file behind.
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
  return backup;
}

/** What in state/ is NOT rebuildable: instincts, managed-keys map, archived
 *  tool results, health history, oauth tokens, usage telemetry, eval reports.
 *  rag.db is deliberately excluded — a full reindex rebuilds it. */
const STATE_BACKUP_ITEMS = ["instincts.json", "managed.json", "archive.db", "health.db", "usage.jsonl", "oauth", "evals"];
const STATE_BACKUPS_KEEP = 14;

/** Tarball the non-rebuildable parts of state/ into the XDG state directory. */
export function backupState(stateDir: string, destDir?: string): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const dest = destDir ?? path.join(stateHome, "openmoat", "backups");
  fs.mkdirSync(dest, { recursive: true });
  const present = STATE_BACKUP_ITEMS.filter((f) => fs.existsSync(path.join(stateDir, f)));
  if (!present.length) throw new Error(`nothing to back up in ${stateDir}`);
  const out = path.join(dest, `state-${stamp()}.tar.gz`);
  const res = spawnSync("tar", ["-czf", out, "-C", stateDir, ...present], { stdio: "pipe" });
  if (res.status !== 0) throw new Error(`tar failed: ${res.stderr?.toString().trim() || res.error?.message}`);
  const old = fs
    .readdirSync(dest)
    .filter((f) => f.startsWith("state-") && f.endsWith(".tar.gz"))
    .sort()
    .slice(0, -STATE_BACKUPS_KEEP);
  for (const f of old) fs.unlinkSync(path.join(dest, f));
  return out;
}
