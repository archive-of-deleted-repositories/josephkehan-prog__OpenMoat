import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import type { HubConfig } from "./config.js";
import {
  getFederationSnapshot,
  requireFederationReady,
} from "./federation.js";
import { makeTransport } from "./mcp-client.js";
import { FileOAuthProvider } from "./oauth.js";
import { loadSecrets, resolveServers, type ResolvedServer } from "./registry.js";
import { HUB_VERSION } from "./version.js";

/**
 * Turn MCP itself into RAG material:
 *  - Tool catalog: connect to every registry server, list its tools, write a
 *    markdown catalog (state/mcp-tools/<server>.md). Indexed by the RAG ->
 *    `tool_search` finds the right tool semantically without loading schemas.
 *  - Resource ingestion: read each server's MCP *resources* (read-only by
 *    design) into state/mcp-ingest/<server>/ so their content is searchable.
 * Tool *calls* are never made — only list/read operations.
 */

const TIMEOUT_MS = 25000;
/** How many servers to catalog at once — most of the wall clock is waiting on
 *  slow/dead servers, which is independent I/O. */
const CONCURRENCY = 5;

async function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timeout: ${what}`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function catalogDirs(cfg: HubConfig): { toolsDir: string; ingestDir: string } {
  return {
    toolsDir: path.join(cfg.stateDir, "mcp-tools"),
    ingestDir: path.join(cfg.stateDir, "mcp-ingest"),
  };
}

export async function refreshMcpCatalog(cfg: HubConfig): Promise<string[]> {
  const snapshot = getFederationSnapshot(cfg, true);
  requireFederationReady(cfg, snapshot);
  const definitions = snapshot.servers.map((asset) => ({
    ...asset.value,
    name: asset.selected ? asset.name : asset.id,
  }));
  const { servers } = resolveServers(definitions, loadSecrets(cfg.secretsEnv));
  const { toolsDir, ingestDir } = catalogDirs(cfg);
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(ingestDir, { recursive: true });

  // Bounded-concurrency worker pool: cataloging ~50 servers strictly serially
  // means every slow/dead server's 25s timeout adds up; per-server notes are
  // kept in registry order.
  const perServer: string[][] = servers.map(() => []);
  let next = 0;
  const worker = async () => {
    while (next < servers.length) {
      const i = next++;
      perServer[i] = await catalogOne(cfg, servers[i], toolsDir, ingestDir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, servers.length) }, worker));
  return perServer.flat();
}

async function catalogOne(cfg: HubConfig, s: ResolvedServer, toolsDir: string, ingestDir: string): Promise<string[]> {
  const notes: string[] = [];
  {
    if (s.name === "openmoat") return notes; // don't spawn ourselves
    if (s.trusted === false) {
      notes.push(`${s.name}: QUARANTINED — not spawned for cataloging until \`hub trust ${s.name}\``);
      return notes;
    }
    const client = new Client({ name: "openmoat-indexer", version: HUB_VERSION });
    try {
      // non-interactive OAuth provider: cached tokens work, otherwise a clear
      // "run hub auth <name>" note instead of popping a browser mid-index
      const authProvider = s.transport === "http" ? new FileOAuthProvider(cfg.stateDir, s.name, false) : undefined;
      await withTimeout(client.connect(makeTransport(s, { authProvider })), `connect ${s.name}`);

      // 1) tool catalog -> markdown, one heading per tool (chunk == tool)
      const tools = await withTimeout(client.listTools(), `listTools ${s.name}`);
      const lines: string[] = [`# MCP tool catalog — ${s.name}`, ""];
      for (const t of tools.tools) {
        const props = (t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
        lines.push(
          `### ${s.name} › ${t.name}`,
          "",
          (t.description ?? "").trim(),
          Object.keys(props).length ? `Parameters: ${Object.keys(props).join(", ")}` : "",
          ""
        );
      }
      fs.writeFileSync(path.join(toolsDir, `${s.name}.md`), lines.join("\n"), "utf8");
      notes.push(`${s.name}: cataloged ${tools.tools.length} tools`);

      // 2) resources -> ingested documents (read-only)
      try {
        const res = await withTimeout(client.listResources(), `listResources ${s.name}`);
        let saved = 0;
        for (const r of (res.resources ?? []).slice(0, 50)) {
          try {
            const read = await withTimeout(client.readResource({ uri: r.uri }), `read ${r.uri}`);
            const text = (read.contents ?? [])
              .map((c) => ("text" in c ? (c.text as string) : ""))
              .filter(Boolean)
              .join("\n\n");
            if (!text.trim()) continue;
            const dir = path.join(ingestDir, s.name);
            fs.mkdirSync(dir, { recursive: true });
            const slug = (r.name ?? r.uri).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "resource";
            fs.writeFileSync(
              path.join(dir, `${slug}.md`),
              `# ${r.name ?? r.uri}\n\nSource: ${r.uri} (server: ${s.name})\n\n${text.slice(0, 100000)}\n`,
              "utf8"
            );
            saved++;
          } catch {
            /* skip unreadable resource */
          }
        }
        if (saved) notes.push(`${s.name}: ingested ${saved} resource(s)`);
      } catch {
        notes.push(`${s.name}: no resources capability`);
      }
    } catch (e) {
      notes.push(`${s.name}: FAILED — ${String(e).slice(0, 140)}`);
    } finally {
      try {
        await client.close();
      } catch {
        /* already closed */
      }
    }
  }
  return notes;
}
