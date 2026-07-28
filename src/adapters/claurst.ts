import fs from "node:fs";
import { writeFileSafe } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";

/**
 * Claurst (Rust TUI agent, clean-room Claude Code reimpl): ~/.claurst/settings.json.
 * Servers live in a `config.mcp_servers` ARRAY where each entry carries its own
 * `name` (unlike the keyed mcpServers object every other harness uses):
 *   stdio: { name, command, args, env?, type: "stdio" }
 *   http:  { name, url, type: "http" }
 * Plain JSON (serde, no comments). We CREATE the file when missing — claurst only
 * writes settings.json after first auth, but the user wired it up now.
 */
interface McpEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type: "stdio" | "http";
}

function mapClaurst(s: ResolvedServer): McpEntry {
  return s.transport === "http"
    ? { name: s.name, url: s.url, type: "http" }
    : {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
        type: "stdio",
      };
}

export const claurst: Adapter = {
  id: "claurst",
  sync(servers: ResolvedServer[], ctx: AdapterCtx): AdapterResult {
    const notes: string[] = [];
    let cfg: Record<string, unknown> = {};
    if (fs.existsSync(ctx.configPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(ctx.configPath, "utf8")) as Record<string, unknown>;
      } catch (e) {
        return { changed: false, managed: ctx.prevManaged, notes: [`SKIP: could not parse ${ctx.configPath}: ${e}`] };
      }
    }
    const config = (cfg.config && typeof cfg.config === "object" ? cfg.config : {}) as Record<string, unknown>;
    const arr: McpEntry[] = Array.isArray(config.mcp_servers) ? (config.mcp_servers as McpEntry[]) : [];
    const before = JSON.stringify(arr);

    const managed = new Map(servers.map((s) => [s.name, mapClaurst(s)]));
    const existingNames = new Set(arr.map((e) => e.name));
    // Keep user-authored entries; drop our managed names (re-added below) and any
    // previously-managed name no longer in the registry.
    const kept = arr.filter((e) => !managed.has(e.name) && !ctx.prevManaged.includes(e.name));
    for (const name of ctx.prevManaged) {
      if (!managed.has(name) && existingNames.has(name)) notes.push(`removed stale '${name}'`);
    }
    for (const [name, entry] of managed) {
      kept.push(entry);
      notes.push(`${existingNames.has(name) ? "updated" : "added"} '${name}'`);
    }

    config.mcp_servers = kept;
    cfg.config = config;
    const changed = JSON.stringify(kept) !== before;
    if (changed) writeFileSafe(ctx.configPath, JSON.stringify(cfg, null, 2) + "\n", ctx.stateDir, ctx.dryRun);
    return { changed, managed: [...managed.keys()], notes };
  },

  readServers(configPath: string): FoundServer[] {
    if (!fs.existsSync(configPath)) return [];
    let cfg: { config?: { mcp_servers?: McpEntry[] } };
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      console.error(`openmoat: could not parse ${configPath} while scanning for servers: ${e}`);
      return [];
    }
    const arr = cfg.config?.mcp_servers;
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => ({
      name: e.name,
      def:
        e.url || e.type === "http"
          ? { transport: "http" as const, url: e.url }
          : { transport: "stdio" as const, command: e.command, args: e.args ?? [], env: e.env ?? {} },
    }));
  },
};
