import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_ENV = "OPENMOAT_CONFIG";

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Repo root = directory containing hub.config.json (parent of dist/ or src/). */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

export function configFile(root = repoRoot()): string {
  const override = process.env[CONFIG_ENV];
  return override
    ? path.resolve(expandHome(override))
    : path.join(root, "hub.config.json");
}

export interface TargetConfig {
  enabled: boolean;
  config: string;
  skillsLink?: string;
  memoryFile?: string;
}

export interface GatewayPolicyRule {
  allow?: string[];
  deny?: string[];
}

export interface GatewayPolicy {
  default: "allow" | "deny";
  agents: Record<string, GatewayPolicyRule>;
}

export interface PluginStoreConfig {
  type: "claude" | "codex";
  path: string;
}

export interface FederationSourceConfig {
  /** Stable namespace used in qualified asset ids: source/name. */
  id: string;
  enabled?: boolean;
  /** Higher priority wins unqualified-name conflicts. Default 0. */
  priority?: number;
  /** Permit non-gateway MCP definitions from this source to enter harness configs. */
  allowNative?: boolean;
  skillRoots?: string[];
  mcpRegistries?: string[];
  pluginStores?: PluginStoreConfig[];
  /** Portable plugin catalogs using the federation plugin schema. */
  pluginCatalogs?: string[];
}

export interface FederationConfig {
  /** Include the legacy top-level registry/skills/plugins as source "local". */
  includeLocal?: boolean;
  /** Strict mode blocks runtime/sync on collisions; priority mode reports and resolves. */
  conflictPolicy?: "error" | "prefer-priority";
  sources?: FederationSourceConfig[];
}

export interface HubConfig {
  registry: string;
  secretsEnv: string;
  stateDir: string;
  skillsDir: string;
  extraSkillsDirs?: string[];
  /** Claude Code plugin store (installed_plugins.json etc.). Default ~/.claude/plugins. */
  pluginsDir?: string;
  profileFiles: string[];
  memoryImport: string;
  contextDir: string;
  rag: {
    db: string;
    include: string[];
    embeddings: { provider: "ollama" | "openai" | "none"; model: string; url?: string };
  };
  targets: Record<string, TargetConfig>;
  /** Servers eagerly spawned on hub boot so their first tool_call is warm. */
  prewarm?: string[];
  /** Caller-scoped gateway authorization. Targets use `server:tool`,
   *  `server:*`, `server`, or `*` patterns. Deny rules take precedence. */
  gatewayPolicy?: GatewayPolicy;
  /** Read-only capability federation across skill roots, MCP registries, and
   *  plugin stores/catalogs. Legacy top-level paths remain the local source. */
  federation?: FederationConfig;
  /** Allow agents to approve quarantined servers via the registry_trust MCP
   *  tool. Default false: only the human-run `hub trust <name>` CLI can
   *  approve (tool-poisoning defense — an agent must never self-approve). */
  autoApproveTrust?: boolean;
}

/** All skill roots: the primary dir plus any extras. */
export function skillRoots(cfg: HubConfig): string[] {
  return [cfg.skillsDir, ...(cfg.extraSkillsDirs ?? [])];
}

export function loadConfig(root = repoRoot()): HubConfig {
  return loadConfigFile(configFile(root));
}

/** Load a specific config without mutating OPENMOAT_CONFIG. This is useful
 * for isolated demos and tests that must never redirect the caller's live Hub. */
export function loadConfigFile(file: string): HubConfig {
  file = path.resolve(expandHome(file));
  const configRoot = path.dirname(file);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as HubConfig;
  const abs = (p: string) => path.resolve(configRoot, expandHome(p));
  raw.registry = abs(raw.registry);
  raw.secretsEnv = abs(raw.secretsEnv);
  raw.stateDir = abs(raw.stateDir);
  raw.skillsDir = abs(raw.skillsDir);
  raw.extraSkillsDirs = (raw.extraSkillsDirs ?? []).map(abs);
  raw.pluginsDir = abs(raw.pluginsDir ?? "~/.claude/plugins");
  raw.profileFiles = raw.profileFiles.map(abs);
  raw.memoryImport = abs(raw.memoryImport);
  raw.contextDir = abs(raw.contextDir);
  raw.rag.db = abs(raw.rag.db);
  raw.rag.include = raw.rag.include.map(abs);
  // MCP-derived corpus (tool catalogs + ingested resources) is always searchable
  raw.rag.include.push(path.join(raw.stateDir, "mcp-tools"), path.join(raw.stateDir, "mcp-ingest"));
  for (const t of Object.values(raw.targets)) {
    t.config = abs(t.config);
    if (t.skillsLink) t.skillsLink = abs(t.skillsLink);
    if (t.memoryFile) t.memoryFile = abs(t.memoryFile);
  }
  if (raw.federation?.sources) {
    raw.federation.sources = raw.federation.sources.map((source) => ({
      ...source,
      skillRoots: (source.skillRoots ?? []).map(abs),
      mcpRegistries: (source.mcpRegistries ?? []).map(abs),
      pluginStores: (source.pluginStores ?? []).map((store) => ({
        ...store,
        path: abs(store.path),
      })),
      pluginCatalogs: (source.pluginCatalogs ?? []).map(abs),
    }));
  }
  return raw;
}
