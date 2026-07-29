import fs from "node:fs";
import path from "node:path";

export interface ManagedState {
  /** target id -> server names the OpenMoat wrote there */
  servers: Record<string, string[]>;
  /** target id -> absolute symlink paths the OpenMoat created for that target */
  skillLinks: Record<string, string[]>;
}

const EMPTY: ManagedState = { servers: {}, skillLinks: {} };

export interface LoadStateOptions {
  /** Normal runs preserve corrupt input before a later save. Dry-runs must not. */
  preserveCorrupt?: boolean;
  onWarning?: (message: string) => void;
}

export function loadState(stateDir: string, options: LoadStateOptions = {}): ManagedState {
  const p = path.join(stateDir, "managed.json");
  if (!fs.existsSync(p)) return structuredClone(EMPTY);
  try {
    const raw = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(p, "utf8")) };
    // migrate v1 shape (flat array, claude-code was the only link target)
    if (Array.isArray(raw.skillLinks)) raw.skillLinks = { "claude-code": raw.skillLinks };
    return raw;
  } catch (e) {
    // A later saveState overwrites this file — preserve the original so a
    // corrupt read never silently destroys the record of what the OpenMoat manages.
    if (options.preserveCorrupt ?? true) {
      try {
        fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
    }
    const preservation = (options.preserveCorrupt ?? true)
      ? "original kept as .corrupt-*"
      : "dry-run left original unchanged";
    const message = `could not parse ${p} — using empty managed state (${preservation}): ${e}`;
    if (options.onWarning) options.onWarning(message);
    else console.error(`openmoat: ${message}`);
    return structuredClone(EMPTY);
  }
}

export function saveState(stateDir: string, state: ManagedState, dryRun: boolean): boolean {
  const file = path.join(stateDir, "managed.json");
  const content = JSON.stringify(state, null, 2);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false;
  if (dryRun) return true;
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
  return true;
}
