import fs from "node:fs";
import { applyEdits, modify, parse } from "jsonc-parser";
import { writeFileSafe } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";

const FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/**
 * Zed: ~/.config/zed/settings.json, key `context_servers` (keyed object).
 * JSONC — edited with jsonc-parser so the user's comments survive.
 *   stdio: { command, args, env? }
 *   http:  { url, headers? }
 * Zed forwards these to external ACP agents too, so wiring the hub here also
 * hands it to claurst-as-editor-agent.
 */
function mapZed(s: ResolvedServer): unknown {
  return s.transport === "http"
    ? { url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
    : { command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) };
}

export const zed: Adapter = {
  id: "zed",
  sync(servers: ResolvedServer[], ctx: AdapterCtx): AdapterResult {
    const notes: string[] = [];
    let text = fs.existsSync(ctx.configPath) ? fs.readFileSync(ctx.configPath, "utf8") : "{}\n";
    const current = (parse(text) ?? {}) as { context_servers?: Record<string, unknown> };
    const section = current.context_servers ?? {};

    const entries: Record<string, unknown> = {};
    for (const s of servers) entries[s.name] = mapZed(s);

    let changed = false;
    for (const name of ctx.prevManaged) {
      if (!(name in entries) && name in section) {
        text = applyEdits(text, modify(text, ["context_servers", name], undefined, FMT));
        notes.push(`removed stale '${name}'`);
        changed = true;
      }
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (JSON.stringify(section[name]) !== JSON.stringify(entry)) {
        text = applyEdits(text, modify(text, ["context_servers", name], entry, FMT));
        notes.push(`${name in section ? "updated" : "added"} '${name}'`);
        changed = true;
      }
    }
    if (changed) writeFileSafe(ctx.configPath, text, ctx.stateDir, ctx.dryRun);
    return { changed, managed: Object.keys(entries), notes };
  },

  readServers(configPath: string): FoundServer[] {
    if (!fs.existsSync(configPath)) return [];
    const parsed = (parse(fs.readFileSync(configPath, "utf8")) ?? {}) as {
      context_servers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }>;
    };
    return Object.entries(parsed.context_servers ?? {}).map(([name, e]) => ({
      name,
      def: e.url
        ? { transport: "http" as const, url: e.url }
        : { transport: "stdio" as const, command: e.command, args: e.args ?? [], env: e.env ?? {} },
    }));
  },
};
