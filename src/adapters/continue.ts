import fs from "node:fs";
import { parseDocument } from "yaml";
import { writeFileSafe } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";

/**
 * Continue (VS Code/JetBrains): ~/.continue/config.yaml, key `mcpServers`.
 * Continue's config.yaml schema (v1) puts MCP servers in a top-level ARRAY
 * where each entry carries its own `name` (like claurst, unlike the keyed
 * mcpServers object most harnesses use):
 *   { name, command, args?, env?, cwd? }
 * Continue also supports sse/streamable-http servers via different fields,
 * but the registry's http shape doesn't map cleanly yet, so http servers are
 * skipped with a note (same policy as the hermes adapter).
 * Edited via yaml Document API so the user's models/rules/comments survive —
 * only the mcpServers array is touched.
 */
interface McpEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function mapContinue(s: ResolvedServer): McpEntry {
  return {
    name: s.name,
    command: s.command as string,
    args: s.args ?? [],
    ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
  };
}

export const continueAdapter: Adapter = {
  id: "continue",
  sync(servers: ResolvedServer[], ctx: AdapterCtx): AdapterResult {
    const notes: string[] = [];
    if (!fs.existsSync(ctx.configPath)) {
      return { changed: false, managed: ctx.prevManaged, notes: [`SKIP: ${ctx.configPath} not found (is Continue installed?)`] };
    }
    const text = fs.readFileSync(ctx.configPath, "utf8");
    const doc = parseDocument(text);
    const js = (doc.toJS() ?? {}) as { mcpServers?: McpEntry[] };
    const arr: McpEntry[] = Array.isArray(js.mcpServers) ? js.mcpServers : [];
    const before = JSON.stringify(arr);

    for (const s of servers) {
      if (s.transport === "http") notes.push(`skipped '${s.name}' (http not supported in continue adapter yet)`);
    }
    const stdioServers = servers.filter((s) => s.transport !== "http");

    const managed = new Map(stdioServers.map((s) => [s.name, mapContinue(s)]));
    const existingNames = new Set(arr.map((e) => e.name));
    const kept = arr.filter((e) => !managed.has(e.name) && !ctx.prevManaged.includes(e.name));
    for (const name of ctx.prevManaged) {
      if (!managed.has(name) && existingNames.has(name)) notes.push(`removed stale '${name}'`);
    }
    for (const [name, entry] of managed) {
      kept.push(entry);
      notes.push(`${existingNames.has(name) ? "updated" : "added"} '${name}'`);
    }

    const changed = JSON.stringify(kept) !== before;
    if (changed) {
      doc.setIn(["mcpServers"], kept);
      writeFileSafe(ctx.configPath, doc.toString(), ctx.stateDir, ctx.dryRun);
    }
    return { changed, managed: [...managed.keys()], notes };
  },

  readServers(configPath: string): FoundServer[] {
    if (!fs.existsSync(configPath)) return [];
    let js: { mcpServers?: McpEntry[] };
    try {
      js = (parseDocument(fs.readFileSync(configPath, "utf8")).toJS() ?? {}) as { mcpServers?: McpEntry[] };
    } catch (e) {
      console.error(`openmoat: could not parse ${configPath} while scanning for servers: ${e}`);
      return [];
    }
    const arr = js.mcpServers;
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => ({
      name: e.name,
      def: { transport: "stdio" as const, command: e.command, args: e.args ?? [], env: e.env ?? {} },
    }));
  },
};
