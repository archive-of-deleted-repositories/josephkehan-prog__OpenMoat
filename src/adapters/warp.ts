import fs from "node:fs";
import { writeFileSafe } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";
import { readClaudeStyleServers } from "./json-common.js";

/**
 * Warp (terminal): ~/.warp/.mcp.json, top-level `mcpServers` (Claude Code-style
 * keyed object, pure JSON — no comments). Warp reads this global file directly
 * and auto-spawns servers from it — there's no app-driven first-run config to
 * wait for, so (like claurst) we CREATE the file when missing rather than
 * skipping, and only ever touch the mcpServers key.
 * stdio: { command, args, env }   http: { url }
 */
function mapWarp(s: ResolvedServer): Record<string, unknown> {
  return s.transport === "http" ? { url: s.url } : { command: s.command, args: s.args ?? [], env: s.env ?? {} };
}

export const warp: Adapter = {
  id: "warp",
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
    const section = (cfg.mcpServers ?? {}) as Record<string, unknown>;
    const before = JSON.stringify(section);

    for (const name of ctx.prevManaged) {
      if (!servers.some((s) => s.name === name) && name in section) {
        delete section[name];
        notes.push(`removed stale '${name}'`);
      }
    }
    const managed = new Map(servers.map((s) => [s.name, mapWarp(s)]));
    for (const [name, entry] of managed) {
      const existing = JSON.stringify(section[name]);
      if (existing !== JSON.stringify(entry)) {
        section[name] = entry;
        notes.push(`${existing !== undefined ? "updated" : "added"} '${name}'`);
      }
    }
    cfg.mcpServers = section;

    const changed = JSON.stringify(section) !== before;
    if (changed) writeFileSafe(ctx.configPath, JSON.stringify(cfg, null, 2) + "\n", ctx.stateDir, ctx.dryRun);
    return { changed, managed: [...managed.keys()], notes };
  },

  readServers(configPath: string): FoundServer[] {
    return readClaudeStyleServers(configPath);
  },
};
