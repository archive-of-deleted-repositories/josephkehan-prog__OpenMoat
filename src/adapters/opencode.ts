import fs from "node:fs";
import { applyEdits, modify, parse } from "jsonc-parser";
import { writeFileSafe } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";

const FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/**
 * OpenCode: ~/.config/opencode/opencode.jsonc, key `mcp`.
 * JSONC — edited with jsonc-parser so user comments survive.
 * local: { type:"local", command:[cmd,...args], enabled, environment }
 * remote: { type:"remote", url, enabled }
 */
export const opencode: Adapter = {
  id: "opencode",
  sync(servers: ResolvedServer[], ctx: AdapterCtx): AdapterResult {
    const notes: string[] = [];
    let text = fs.existsSync(ctx.configPath) ? fs.readFileSync(ctx.configPath, "utf8") : "{}\n";
    const current = (parse(text) ?? {}) as Record<string, unknown>;
    const mcp = (current["mcp"] ?? {}) as Record<string, unknown>;

    const entries: Record<string, unknown> = {};
    for (const s of servers) {
      entries[s.name] =
        s.transport === "http"
          ? { type: "remote", url: s.url, enabled: true, ...(s.headers ? { headers: s.headers } : {}) }
          : {
              type: "local",
              command: [s.command, ...(s.args ?? [])],
              enabled: true,
              ...(s.env && Object.keys(s.env).length ? { environment: s.env } : {}),
            };
    }

    let changed = false;
    for (const name of ctx.prevManaged) {
      if (!(name in entries) && name in mcp) {
        text = applyEdits(text, modify(text, ["mcp", name], undefined, FMT));
        notes.push(`removed stale '${name}'`);
        changed = true;
      }
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (JSON.stringify(mcp[name]) !== JSON.stringify(entry)) {
        text = applyEdits(text, modify(text, ["mcp", name], entry, FMT));
        notes.push(`${name in mcp ? "updated" : "added"} '${name}'`);
        changed = true;
      }
    }
    if (changed) writeFileSafe(ctx.configPath, text, ctx.stateDir, ctx.dryRun);
    return { changed, managed: Object.keys(entries), notes };
  },

  readServers(configPath: string): FoundServer[] {
    if (!fs.existsSync(configPath)) return [];
    const parsed = (parse(fs.readFileSync(configPath, "utf8")) ?? {}) as {
      mcp?: Record<string, { type?: string; command?: string[]; url?: string; environment?: Record<string, string> }>;
    };
    return Object.entries(parsed.mcp ?? {}).map(([name, e]) => ({
      name,
      def:
        e.type === "remote"
          ? { transport: "http" as const, url: e.url }
          : { transport: "stdio" as const, command: e.command?.[0], args: e.command?.slice(1) ?? [], env: e.environment ?? {} },
    }));
  },
};
