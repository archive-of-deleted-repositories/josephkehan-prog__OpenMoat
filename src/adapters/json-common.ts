import fs from "node:fs";
import { writeFileSafe } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";

/**
 * Generic JSON merge for clients whose config is plain JSON with an
 * mcpServers-style object. Reads the whole file, patches only managed
 * entries, preserves everything else.
 */
export function syncJsonMcpServers(
  key: string,
  entries: Record<string, unknown>,
  ctx: AdapterCtx
): AdapterResult {
  const notes: string[] = [];
  // Never manufacture a config for a tool that isn't installed — a hub-created
  // file would preempt the tool's own first-run setup. Sync again after install.
  if (!fs.existsSync(ctx.configPath)) {
    return { changed: false, managed: ctx.prevManaged, notes: [`SKIP: ${ctx.configPath} not found (is the tool installed?)`] };
  }
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(fs.readFileSync(ctx.configPath, "utf8"));
  } catch (e) {
    return { changed: false, managed: ctx.prevManaged, notes: [`SKIP: could not parse ${ctx.configPath}: ${e}`] };
  }

  const section = (cfg[key] ?? {}) as Record<string, unknown>;
  const before = JSON.stringify(section);

  // Remove entries we previously managed that are no longer in the registry.
  for (const name of ctx.prevManaged) {
    if (!(name in entries) && name in section) {
      delete section[name];
      notes.push(`removed stale '${name}'`);
    }
  }
  for (const [name, entry] of Object.entries(entries)) {
    const existing = JSON.stringify(section[name]);
    if (existing !== JSON.stringify(entry)) {
      section[name] = entry;
      notes.push(`${existing !== undefined ? "updated" : "added"} '${name}'`);
    }
  }
  cfg[key] = section;

  const changed = JSON.stringify(section) !== before;
  if (changed) writeFileSafe(ctx.configPath, JSON.stringify(cfg, null, 2) + "\n", ctx.stateDir, ctx.dryRun);
  return { changed, managed: Object.keys(entries), notes };
}

/** Read a Claude-style JSON config (`mcpServers` map) into FoundServer[]. */
export function readClaudeStyleServers(configPath: string, key = "mcpServers"): FoundServer[] {
  if (!fs.existsSync(configPath)) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`openmoat: could not parse ${configPath} while scanning for servers: ${e}`);
    return [];
  }
  const servers = (obj[key] ?? {}) as Record<
    string,
    { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: string }
  >;
  return Object.entries(servers).map(([name, e]) => ({
    name,
    def:
      e.url || e.type === "http" || e.type === "sse"
        ? { transport: "http" as const, url: e.url }
        : { transport: "stdio" as const, command: e.command, args: e.args ?? [], env: e.env ?? {} },
  }));
}

/**
 * Factory for the JSON-config adapters (claude-code, claude-desktop, cursor,
 * pi, omp): they share the whole sync/read skeleton and differ only in the
 * per-server entry shape.
 */
export function jsonMcpAdapter(id: string, mapServer: (s: ResolvedServer) => unknown, key = "mcpServers"): Adapter {
  return {
    id,
    sync(servers, ctx) {
      const entries: Record<string, unknown> = {};
      for (const s of servers) entries[s.name] = mapServer(s);
      return syncJsonMcpServers(key, entries, ctx);
    },
    readServers(configPath) {
      return readClaudeStyleServers(configPath, key);
    },
  };
}
