import fs from "node:fs";
import { writeFileSafe } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";
import { readClaudeStyleServers } from "./json-common.js";

/**
 * VS Code (built-in MCP, 1.102+): ~/Library/Application Support/Code/User/mcp.json.
 * DISTINCT schema from Claude-style: top-level `servers` (keyed object) where each
 * entry carries an explicit `type`: stdio → {type:"stdio", command, args, env};
 * http → {type:"http", url, headers}. Sibling keys like `inputs` are preserved.
 * VS Code reads this global file directly, so (like warp/claurst) CREATE it when
 * missing rather than skipping. We only ever touch the `servers` key, and only
 * the entries we manage — user-added servers (markitdown, netdata, …) are left intact.
 */
function mapVscode(s: ResolvedServer): Record<string, unknown> {
  return s.transport === "http"
    ? { type: "http", url: s.url }
    : { type: "stdio", command: s.command, args: s.args ?? [], env: s.env ?? {} };
}

export const vscode: Adapter = {
  id: "vscode",
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
    const section = (cfg.servers ?? {}) as Record<string, unknown>;
    const before = JSON.stringify(section);

    for (const name of ctx.prevManaged) {
      if (!servers.some((s) => s.name === name) && name in section) {
        delete section[name];
        notes.push(`removed stale '${name}'`);
      }
    }
    const managed = new Map(servers.map((s) => [s.name, mapVscode(s)]));
    for (const [name, entry] of managed) {
      const existing = JSON.stringify(section[name]);
      if (existing !== JSON.stringify(entry)) {
        section[name] = entry;
        notes.push(`${existing !== undefined ? "updated" : "added"} '${name}'`);
      }
    }
    cfg.servers = section;

    const changed = JSON.stringify(section) !== before;
    if (changed) writeFileSafe(ctx.configPath, JSON.stringify(cfg, null, 2) + "\n", ctx.stateDir, ctx.dryRun);
    return { changed, managed: [...managed.keys()], notes };
  },

  readServers(configPath: string): FoundServer[] {
    // VS Code stores servers under the `servers` key (entries carry type/command/url,
    // which readClaudeStyleServers already handles).
    return readClaudeStyleServers(configPath, "servers");
  },
};
