import fs from "node:fs";
import path from "node:path";
import type { OpenMoatConfig } from "./config.js";
import type { GatewayRuntime } from "./gateway-runtime.js";
import {
  MAX_DESCRIBED_TOOLS,
  TOOL_NAME_PATTERN,
} from "./tool-metadata.js";
import {
  rankToolCatalog,
  type ToolCatalogEntry,
  type ToolCatalogHit,
} from "./tool-catalog.js";

interface CatalogDocument {
  version: 1;
  generatedAt: string;
  entries: ToolCatalogEntry[];
}

const MAX_CATALOG_BYTES = 10 * 1024 * 1024;

export function catalogFile(cfg: OpenMoatConfig): string {
  return path.join(cfg.stateDir, "tool-catalog.json");
}

function parseDescription(
  server: string,
  description: string
): ToolCatalogEntry[] {
  const matches = [...description.matchAll(/^Tool: ([^\n]+)$/gm)]
    .filter((match) => TOOL_NAME_PATTERN.test(match[1].trim()))
    .slice(0, MAX_DESCRIBED_TOOLS);
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? description.length;
    return {
      server,
      tool: match[1].trim(),
      description: description.slice(start, end).trim().slice(0, 8192),
      provenance: "trusted-local-refresh",
    };
  });
}

function writePrivateAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export async function refreshCatalog(
  cfg: OpenMoatConfig,
  runtime: GatewayRuntime
): Promise<string[]> {
  const entries: ToolCatalogEntry[] = [];
  const notes: string[] = [];
  for (const server of cfg.inlineServers) {
    if (server.disabled) {
      notes.push(`${server.name}: disabled`);
      continue;
    }
    if (server.trusted === false) {
      notes.push(`${server.name}: quarantined`);
      continue;
    }
    try {
      const description = await runtime.inspect(server.name);
      const parsed = parseDescription(server.name, description);
      entries.push(...parsed);
      notes.push(`${server.name}: cataloged ${parsed.length} tool(s)`);
    } catch (error) {
      notes.push(
        `${server.name}: failed (${String(
          error instanceof Error ? error.message : error
        ).slice(0, 160)})`
      );
    }
  }
  const document: CatalogDocument = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };
  writePrivateAtomic(
    catalogFile(cfg),
    `${JSON.stringify(document, null, 2)}\n`
  );
  return notes;
}

export function loadCatalog(cfg: OpenMoatConfig): CatalogDocument {
  const file = catalogFile(cfg);
  if (!fs.existsSync(file)) {
    return { version: 1, generatedAt: "", entries: [] };
  }
  if (fs.statSync(file).size > MAX_CATALOG_BYTES) {
    throw new Error("CATALOG_TOO_LARGE: remove it and run `moat catalog --refresh`");
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogDocument;
  if (
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 100_000 ||
    !value.entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.server === "string" &&
        entry.server.length > 0 &&
        entry.server.length <= 128 &&
        typeof entry.tool === "string" &&
        entry.tool.length > 0 &&
        entry.tool.length <= 256 &&
        typeof entry.description === "string" &&
        entry.description.length <= 8192 &&
        typeof entry.provenance === "string" &&
        entry.provenance.length <= 128
    )
  ) {
    throw new Error("INVALID_CATALOG: run `moat catalog --refresh`");
  }
  return value;
}

export function searchCatalog(
  cfg: OpenMoatConfig,
  query: string,
  limit: number
): ToolCatalogHit[] {
  return rankToolCatalog(loadCatalog(cfg).entries, query, limit);
}
