import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { backupFile } from "../backup.js";
import type { ResolvedServer } from "../registry.js";
import type { Adapter, AdapterCtx, AdapterResult, FoundServer } from "./types.js";

interface CodexListEntry {
  name: string;
  enabled?: boolean;
  startup_timeout_sec?: number | null;
  tool_timeout_sec?: number | null;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string> | null;
    env_vars?: unknown[];
    cwd?: string | null;
    url?: string;
    bearer_token_env_var?: string | null;
    http_headers?: Record<string, string> | null;
    env_http_headers?: Record<string, string> | null;
  };
}

function codexBin(): string {
  return process.env.OPENMOAT_CODEX_BIN || "codex";
}

function runCodex(configPath: string, args: string[]) {
  return spawnSync(codexBin(), ["mcp", ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: path.dirname(configPath) },
    timeout: 30_000,
  });
}

export function parseCodexList(raw: string): FoundServer[] {
  const entries = JSON.parse(raw) as CodexListEntry[];
  return entries.map((entry) => {
    const transport = entry.transport ?? {};
    const unsupported: string[] = [];
    if (entry.enabled === false) unsupported.push("disabled");
    if (transport.cwd) unsupported.push("cwd");
    if (transport.env_vars?.length) unsupported.push("env_vars");
    if (transport.bearer_token_env_var) unsupported.push("bearer_token_env_var");
    if (transport.http_headers && Object.keys(transport.http_headers).length > 0) unsupported.push("http_headers");
    if (transport.env_http_headers && Object.keys(transport.env_http_headers).length > 0) unsupported.push("env_http_headers");
    if (entry.startup_timeout_sec != null) unsupported.push("startup_timeout_sec");
    if (entry.tool_timeout_sec != null) unsupported.push("tool_timeout_sec");
    const isHttp = transport.type === "streamable_http" || transport.type === "http";
    const isStdio = transport.type === "stdio";
    if (!isHttp && !isStdio) unsupported.push(`transport:${transport.type ?? "missing"}`);
    return {
      name: entry.name,
      active: entry.enabled !== false,
      adoptable: unsupported.length === 0,
      adoptReason: unsupported.length ? `Codex-only fields: ${unsupported.join(", ")}` : undefined,
      def:
        isHttp
          ? { transport: "http" as const, url: transport.url }
          : {
              transport: "stdio" as const,
              command: transport.command,
              args: transport.args ?? [],
              env: transport.env ?? {},
            },
    };
  });
}

function readCodexServers(configPath: string): { servers: FoundServer[]; error?: string } {
  if (!fs.existsSync(configPath)) return { servers: [] };
  const result = runCodex(configPath, ["list", "--json"]);
  if (result.status !== 0) {
    return {
      servers: [],
      error: result.stderr?.trim() || result.error?.message || "codex mcp list failed",
    };
  }
  try {
    return { servers: parseCodexList(result.stdout) };
  } catch (error) {
    return { servers: [], error: `could not parse codex mcp list output: ${error}` };
  }
}

function equivalent(found: FoundServer | undefined, wanted: ResolvedServer): boolean {
  if (!found || found.active === false) return false;
  if (wanted.transport === "http") {
    return found.def.transport === "http" && found.def.url === wanted.url;
  }
  return (
    found.def.transport !== "http" &&
    found.def.command === wanted.command &&
    JSON.stringify(found.def.args ?? []) === JSON.stringify(wanted.args ?? []) &&
    JSON.stringify(found.def.env ?? {}) === JSON.stringify(wanted.env ?? {})
  );
}

function addArgs(server: ResolvedServer): string[] | null {
  if (server.transport === "http") {
    if (!server.url || (server.headers && Object.keys(server.headers).length > 0)) return null;
    return ["add", server.name, "--url", server.url];
  }
  if (!server.command) return null;
  const envArgs = Object.entries(server.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  return ["add", server.name, ...envArgs, "--", server.command, ...(server.args ?? [])];
}

/**
 * Codex owns a TOML config with unrelated UI, model, plugin, and hook state.
 * Use Codex's supported MCP CLI to mutate only named MCP entries instead of
 * parsing and reserializing the whole file in OpenMoat.
 */
export const codex: Adapter = {
  id: "codex",

  sync(servers: ResolvedServer[], ctx: AdapterCtx): AdapterResult {
    const notes: string[] = [];
    if (!fs.existsSync(ctx.configPath)) {
      return { changed: false, managed: ctx.prevManaged, notes: [`SKIP: ${ctx.configPath} not found (is Codex installed?)`] };
    }

    const currentResult = readCodexServers(ctx.configPath);
    if (currentResult.error) {
      return { changed: false, managed: ctx.prevManaged, notes: [`SKIP: ${currentResult.error}`] };
    }
    const current = new Map(currentResult.servers.map((server) => [server.name, server]));
    const wanted = new Map(servers.map((server) => [server.name, server]));
    const stale = ctx.prevManaged.filter((name) => !wanted.has(name) && current.has(name));
    const updates = servers.filter((server) => !equivalent(current.get(server.name), server));

    for (const server of updates) {
      if (!addArgs(server)) {
        notes.push(`skipped '${server.name}' (unsupported Codex transport options)`);
      }
    }
    const actionable = updates.filter((server) => addArgs(server));
    const manageable = servers.filter((server) => addArgs(server));
    const managed = manageable.map((server) => server.name);
    if (!stale.length && !actionable.length) return { changed: false, managed, notes };

    if (ctx.dryRun) {
      for (const name of stale) notes.push(`would remove stale '${name}'`);
      for (const server of actionable) notes.push(`would ${current.has(server.name) ? "update" : "add"} '${server.name}'`);
      return { changed: true, managed, notes };
    }

    const backup = backupFile(ctx.configPath, ctx.stateDir);
    let changed = false;
    let failed = false;
    for (const name of stale) {
      const result = runCodex(ctx.configPath, ["remove", name]);
      if (result.status === 0) {
        notes.push(`removed stale '${name}'`);
        changed = true;
      } else {
        notes.push(`WARN: failed to remove '${name}': ${result.stderr?.trim() || result.error?.message}`);
        failed = true;
      }
    }
    for (const server of actionable) {
      const args = addArgs(server)!;
      const result = runCodex(ctx.configPath, args);
      if (result.status === 0) {
        notes.push(`${current.has(server.name) ? "updated" : "added"} '${server.name}'`);
        changed = true;
      } else {
        notes.push(`WARN: failed to sync '${server.name}': ${result.stderr?.trim() || result.error?.message}`);
        failed = true;
      }
    }
    const finalResult = readCodexServers(ctx.configPath);
    const final = new Map(finalResult.servers.map((server) => [server.name, server]));
    const mismatch = manageable.filter((server) => !equivalent(final.get(server.name), server)).map((server) => server.name);
    const staleLeft = stale.filter((name) => final.has(name));
    if (finalResult.error || failed || mismatch.length || staleLeft.length) {
      if (backup) fs.copyFileSync(backup, ctx.configPath);
      notes.push(
        `ERROR: Codex sync rolled back${finalResult.error ? ` (${finalResult.error})` : ""}` +
          `${mismatch.length ? `; mismatched: ${mismatch.join(", ")}` : ""}` +
          `${staleLeft.length ? `; stale remained: ${staleLeft.join(", ")}` : ""}`
      );
      return { changed: false, managed: ctx.prevManaged, notes };
    }
    return { changed, managed, notes };
  },

  readServers(configPath: string): FoundServer[] {
    const result = readCodexServers(configPath);
    if (result.error) console.error(`openmoat: ${result.error}`);
    return result.servers;
  },
};
