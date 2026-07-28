import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import type { ServerDef } from "./registry.js";

export const CONFIG_ENV = "OPENMOAT_FILE";

export interface FeatureFlags {
  reconcile: boolean;
  gateway: boolean;
  profile: boolean;
  handoffs: boolean;
  rag: boolean;
  embeddings: boolean;
  skills: boolean;
  plugins: boolean;
  instincts: boolean;
}

const FEATURE_DEFAULTS: FeatureFlags = {
  reconcile: true,
  gateway: true,
  profile: true,
  handoffs: true,
  rag: false,
  embeddings: false,
  skills: false,
  plugins: false,
  instincts: false,
};

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

export function resolveConfigFile(
  cliFile?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = os.homedir()
): string {
  const selected =
    cliFile ??
    env[CONFIG_ENV] ??
    path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "openmoat", "Moatfile");
  return path.resolve(expandHome(selected));
}

export function configFile(root?: string): string {
  if (process.env[CONFIG_ENV]) return resolveConfigFile();
  if (root && path.resolve(root) !== repoRoot()) return path.join(path.resolve(root), "Moatfile");
  return resolveConfigFile();
}

export interface TargetConfig {
  enabled: boolean;
  config: string;
  skillsLink?: string;
  memoryFile?: string;
  [key: string]: unknown;
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
  id: string;
  enabled?: boolean;
  priority?: number;
  allowNative?: boolean;
  skillRoots?: string[];
  mcpRegistries?: string[];
  pluginStores?: PluginStoreConfig[];
  pluginCatalogs?: string[];
}

export interface FederationConfig {
  includeLocal?: boolean;
  conflictPolicy?: "error" | "prefer-priority";
  sources?: FederationSourceConfig[];
}

export interface HubConfig {
  features: FeatureFlags;
  configFile: string;
  registry: string;
  inlineServers: ServerDef[];
  secretsEnv: string;
  stateDir: string;
  skillsDir: string;
  extraSkillsDirs?: string[];
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
  prewarm?: string[];
  gatewayPolicy: GatewayPolicy;
  federation?: FederationConfig;
  autoApproveTrust?: boolean;
}

interface GatewayServerDocument {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  trust?: "trusted" | "quarantined" | "disabled";
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
  limits?: {
    failureThreshold?: number;
    resetAfterMs?: number;
    maxConcurrentCalls?: number;
  };
}

interface MoatfileDocument {
  apiVersion: "openmoat.dev/v1";
  kind: "Moatfile";
  features?: Partial<FeatureFlags>;
  paths?: { state?: string; profile?: string; handoffs?: string };
  targets?: Record<string, TargetConfig>;
  gateway?: {
    callers?: Record<string, GatewayPolicyRule>;
    servers?: Record<string, GatewayServerDocument>;
  };
  profile?: Record<string, unknown>;
  handoffs?: Record<string, unknown>;
  rag?: {
    include?: string[];
    embeddings?: { provider?: "ollama" | "openai" | "none"; model?: string; url?: string };
  };
  federation?: FederationConfig;
  prewarm?: string[];
  autoApproveTrust?: boolean;
}

let validateMoatfile: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (validateMoatfile) return validateMoatfile;
  const schemaPath = path.join(repoRoot(), "vendor", "spec", "schemas", "moatfile-v1.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as object;
  const compiled = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  validateMoatfile = compiled;
  return compiled;
}

function absoluteFrom(base: string, value: string): string {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
}

function normalizeTargets(
  targets: Record<string, TargetConfig>,
  base: string
): Record<string, TargetConfig> {
  return Object.fromEntries(
    Object.entries(targets).map(([id, target]) => [
      id,
      {
        ...target,
        enabled: target.enabled === true,
        config: absoluteFrom(base, target.config),
        ...(target.skillsLink ? { skillsLink: absoluteFrom(base, target.skillsLink) } : {}),
        ...(target.memoryFile ? { memoryFile: absoluteFrom(base, target.memoryFile) } : {}),
      },
    ])
  );
}

function normalizeInlineServers(
  servers: Record<string, GatewayServerDocument>
): ServerDef[] {
  return Object.entries(servers).map(([name, server]) => ({
    name,
    transport: "stdio",
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
    cwd: server.cwd,
    trusted: server.trust === "trusted",
    disabled: server.trust === "disabled",
    gatewayOnly: true,
    startupTimeoutMs: server.startupTimeoutMs,
    callTimeoutMs: server.callTimeoutMs,
    limits: server.limits,
  }));
}

function normalizeMoatfile(document: MoatfileDocument, file: string): HubConfig {
  const base = path.dirname(file);
  const stateHome =
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const stateDir = absoluteFrom(
    base,
    document.paths?.state ?? path.join(stateHome, "openmoat")
  );
  const profilePath = absoluteFrom(base, document.paths?.profile ?? "./profile/AGENTS.md");
  const contextDir = absoluteFrom(
    base,
    document.paths?.handoffs ?? path.join(stateDir, "handoffs")
  );
  const embedding = document.rag?.embeddings;
  return {
    features: { ...FEATURE_DEFAULTS, ...(document.features ?? {}) },
    configFile: file,
    registry: path.join(base, "registry", "mcp-servers.json"),
    inlineServers: normalizeInlineServers(document.gateway?.servers ?? {}),
    secretsEnv: path.join(base, "secrets.env"),
    stateDir,
    skillsDir: path.join(base, "skills"),
    extraSkillsDirs: [],
    pluginsDir: path.join(base, "plugins"),
    profileFiles: [profilePath],
    memoryImport: profilePath,
    contextDir,
    rag: {
      db: path.join(stateDir, "rag.db"),
      include: (document.rag?.include ?? [path.dirname(profilePath), contextDir]).map((entry) =>
        absoluteFrom(base, entry)
      ),
      embeddings: {
        provider: embedding?.provider ?? "none",
        model: embedding?.model ?? "",
        ...(embedding?.url ? { url: embedding.url } : {}),
      },
    },
    targets: normalizeTargets(document.targets ?? {}, base),
    prewarm: document.prewarm ?? [],
    gatewayPolicy: {
      default: "deny",
      agents: document.gateway?.callers ?? {},
    },
    federation: document.federation ?? {
      includeLocal: true,
      conflictPolicy: "error",
      sources: [],
    },
    autoApproveTrust: document.autoApproveTrust ?? false,
  };
}

function normalizeLegacy(raw: HubConfig, file: string): HubConfig {
  const base = path.dirname(file);
  const absolute = (value: string) => absoluteFrom(base, value);
  const normalized: HubConfig = {
    ...raw,
    features: raw.features ?? FEATURE_DEFAULTS,
    configFile: file,
    inlineServers: raw.inlineServers ?? [],
    registry: absolute(raw.registry),
    secretsEnv: absolute(raw.secretsEnv),
    stateDir: absolute(raw.stateDir),
    skillsDir: absolute(raw.skillsDir),
    pluginsDir: absolute(raw.pluginsDir ?? "~/.claude/plugins"),
    profileFiles: raw.profileFiles.map(absolute),
    memoryImport: absolute(raw.memoryImport),
    contextDir: absolute(raw.contextDir),
    targets: normalizeTargets(raw.targets, base),
    gatewayPolicy: raw.gatewayPolicy ?? { default: "deny", agents: {} },
    rag: {
      ...raw.rag,
      db: absolute(raw.rag.db),
      include: raw.rag.include.map(absolute),
    },
  };
  normalized.rag.include.push(
    path.join(normalized.stateDir, "mcp-tools"),
    path.join(normalized.stateDir, "mcp-ingest")
  );
  return normalized;
}

export function skillRoots(config: HubConfig): string[] {
  return [config.skillsDir, ...(config.extraSkillsDirs ?? [])];
}

export function loadConfig(root?: string): HubConfig {
  return loadConfigFile(configFile(root));
}

export function loadConfigFile(input: string): HubConfig {
  const file = path.resolve(expandHome(input));
  const source = fs.readFileSync(file, "utf8");
  if (path.extname(file).toLowerCase() === ".json") {
    return normalizeLegacy(JSON.parse(source) as HubConfig, file);
  }
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    throw new Error(`invalid Moatfile: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validate = validator();
  if (!validate(document)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new Error(`invalid Moatfile: ${details}`);
  }
  const normalized = normalizeMoatfile(document as MoatfileDocument, file);
  normalized.rag.include.push(
    path.join(normalized.stateDir, "mcp-tools"),
    path.join(normalized.stateDir, "mcp-ingest")
  );
  return normalized;
}
