import fs from "node:fs";
import { parseDocument } from "yaml";
import { writeFileSafe } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";

/**
 * Hermes: ~/.hermes/config.yaml, key `mcp_servers`.
 * Edited via yaml Document API so comments/formatting survive.
 * stdio only (http servers are skipped with a note).
 * Reminder after sync: `hermes gateway restart` if the LaunchAgent is live.
 */
export const hermes: Adapter = {
  id: "hermes",
  sync(servers: ResolvedServer[], ctx: AdapterCtx): AdapterResult {
    const notes: string[] = [];
    if (!fs.existsSync(ctx.configPath)) {
      return { changed: false, managed: ctx.prevManaged, notes: [`SKIP: ${ctx.configPath} not found (is Hermes installed?)`] };
    }
    const text = fs.readFileSync(ctx.configPath, "utf8");
    const doc = parseDocument(text);
    let changed = false;
    const managed: string[] = [];

    for (const name of ctx.prevManaged) {
      const stillWanted = servers.some((s) => s.name === name && s.transport !== "http");
      if (!stillWanted && doc.hasIn(["mcp_servers", name])) {
        doc.deleteIn(["mcp_servers", name]);
        notes.push(`removed stale '${name}'`);
        changed = true;
      }
    }

    for (const s of servers) {
      if (s.transport === "http") {
        notes.push(`skipped '${s.name}' (http not supported in hermes adapter yet)`);
        continue;
      }
      // Adapter-only caller identity. This must not live in the shared
      // registry because other harnesses would impersonate this caller.
      const env = s.name === "openmoat" ? { ...(s.env ?? {}), OPENMOAT_CALLER: "hermes" } : (s.env ?? {});
      const entry = { command: s.command, args: s.args ?? [], env };
      const existing = doc.getIn(["mcp_servers", s.name]);
      const existingJson = existing === undefined ? undefined : JSON.stringify(existing);
      if (existingJson !== JSON.stringify(entry)) {
        doc.setIn(["mcp_servers", s.name], entry);
        notes.push(`${existing === undefined ? "added" : "updated"} '${s.name}'`);
        changed = true;
      }
      managed.push(s.name);
    }

    if (changed) {
      writeFileSafe(ctx.configPath, doc.toString(), ctx.stateDir, ctx.dryRun);
      notes.push("hermes: run `hermes gateway restart` to load changes in live sessions");
    }
    return { changed, managed, notes };
  },

  readServers(configPath: string): FoundServer[] {
    if (!fs.existsSync(configPath)) return [];
    const js = (parseDocument(fs.readFileSync(configPath, "utf8")).toJS() ?? {}) as {
      mcp_servers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    return Object.entries(js.mcp_servers ?? {}).map(([name, e]) => ({
      name,
      def: { transport: "stdio" as const, command: e.command, args: e.args ?? [], env: e.env ?? {} },
    }));
  },
};
