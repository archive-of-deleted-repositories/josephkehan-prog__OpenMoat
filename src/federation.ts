import fs from "node:fs";
import path from "node:path";
import type {
  FederationSourceConfig,
  OpenMoatConfig,
  PluginStoreConfig,
} from "./config.js";
import {
  readPlugins,
  type MarketplaceInfo,
  type PluginInfo,
  type PluginSurface,
} from "./plugins.js";
import { loadRegistry, type ServerDef } from "./registry.js";
import { discoverSkills, type SkillInfo } from "./skills.js";

export type FederationAssetKind = "skill" | "mcp" | "plugin";

export interface FederationSource {
  id: string;
  priority: number;
  allowNative: boolean;
  skillRoots: string[];
  mcpRegistries: string[];
  pluginStores: PluginStoreConfig[];
  pluginCatalogs: string[];
}

export interface FederatedAsset<T> {
  id: string;
  name: string;
  source: string;
  priority: number;
  selected: boolean;
  value: T;
}

export interface FederatedPlugin {
  name: string;
  ecosystem: string;
  collection: string;
  version: string;
  scopes: string[];
  projects: string[];
  installPath: string;
  skills: string[];
  agents: number;
  commands: number;
  hooks: boolean;
  missing: boolean;
}

export interface FederationConflict {
  kind: FederationAssetKind;
  name: string;
  selected: string;
  alternatives: string[];
}

export interface FederationSnapshot {
  sources: FederationSource[];
  skills: FederatedAsset<SkillInfo>[];
  servers: FederatedAsset<ServerDef>[];
  plugins: FederatedAsset<FederatedPlugin>[];
  conflicts: FederationConflict[];
  warnings: string[];
}

interface PluginCatalog {
  plugins?: Partial<FederatedPlugin>[];
}

const CACHE_TTL_MS = 30_000;
const cache = new WeakMap<OpenMoatConfig, { at: number; snapshot: FederationSnapshot }>();

function normalizeSource(source: FederationSourceConfig): FederationSource {
  return {
    id: source.id,
    priority: source.priority ?? 0,
    allowNative: source.allowNative ?? false,
    skillRoots: source.skillRoots ?? [],
    mcpRegistries: source.mcpRegistries ?? [],
    pluginStores: source.pluginStores ?? [],
    pluginCatalogs: source.pluginCatalogs ?? [],
  };
}

export function federationSources(cfg: OpenMoatConfig): FederationSource[] {
  const sources: FederationSource[] = [];
  if (cfg.federation?.includeLocal !== false) {
    sources.push({
      id: "local",
      priority: 100,
      allowNative: true,
      skillRoots: [cfg.skillsDir, ...(cfg.extraSkillsDirs ?? [])],
      mcpRegistries: [cfg.registry],
      pluginStores: [{ type: "claude", path: cfg.pluginsDir! }],
      pluginCatalogs: [],
    });
  }
  for (const source of cfg.federation?.sources ?? []) {
    if (source.enabled === false) continue;
    sources.push(normalizeSource(source));
  }
  const ids = new Set<string>();
  for (const source of sources) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source.id)) {
      throw new Error(`invalid federation source id '${source.id}'`);
    }
    if (ids.has(source.id)) throw new Error(`duplicate federation source id '${source.id}'`);
    ids.add(source.id);
  }
  return sources;
}

function pluginKey(plugin: FederatedPlugin): string {
  return `${plugin.ecosystem}:${plugin.collection}:${plugin.name}`;
}

function catalogPlugin(raw: Partial<FederatedPlugin>): FederatedPlugin {
  if (!raw.name) throw new Error("federation plugin catalog entry is missing name");
  return {
    name: raw.name,
    ecosystem: raw.ecosystem ?? "generic",
    collection: raw.collection ?? "default",
    version: raw.version ?? "?",
    scopes: raw.scopes ?? ["available"],
    projects: raw.projects ?? [],
    installPath: raw.installPath ?? "",
    skills: raw.skills ?? [],
    agents: raw.agents ?? 0,
    commands: raw.commands ?? 0,
    hooks: raw.hooks ?? false,
    missing: raw.missing ?? false,
  };
}

function select<T>(
  kind: FederationAssetKind,
  assets: Omit<FederatedAsset<T>, "selected">[],
  conflicts: FederationConflict[]
): FederatedAsset<T>[] {
  const groups = new Map<string, Omit<FederatedAsset<T>, "selected">[]>();
  const ids = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id)) {
      throw new Error(`duplicate ${kind} asset id '${asset.id}' within one federation source`);
    }
    ids.add(asset.id);
    const entries = groups.get(asset.name) ?? [];
    entries.push(asset);
    groups.set(asset.name, entries);
  }
  const out: FederatedAsset<T>[] = [];
  for (const [name, entries] of groups) {
    entries.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const winner = entries[0];
    if (entries.length > 1) {
      conflicts.push({
        kind,
        name,
        selected: winner.id,
        alternatives: entries.slice(1).map((entry) => entry.id),
      });
    }
    out.push(...entries.map((entry, index) => ({ ...entry, selected: index === 0 })));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function readPluginCatalog(file: string): FederatedPlugin[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PluginCatalog;
  return (raw.plugins ?? []).map(catalogPlugin);
}

function countFiles(
  dir: string,
  predicate: (name: string) => boolean,
  depth = 3
): number {
  if (!fs.existsSync(dir) || depth < 0) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(file, predicate, depth - 1);
    else if (predicate(entry.name)) count++;
  }
  return count;
}

function listSkillNames(dir: string, depth = 4): string[] {
  if (!fs.existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, "SKILL.md"))) out.push(entry.name);
    else out.push(...listSkillNames(child, depth - 1));
  }
  return out;
}

function hasPluginComponents(dir: string): boolean {
  return ["skills", "agents", "commands", "hooks", "mcp", "apps", ".codex-plugin"].some(
    (name) => fs.existsSync(path.join(dir, name))
  );
}

function codexInstallRoot(pluginDir: string): string {
  if (hasPluginComponents(pluginDir)) return pluginDir;
  const children = fs
    .readdirSync(pluginDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(pluginDir, entry.name))
    .filter(hasPluginComponents)
    .sort();
  return children.at(-1) ?? pluginDir;
}

function readCodexPluginStore(storePath: string): FederatedPlugin[] {
  if (!fs.existsSync(storePath)) return [];
  const out: FederatedPlugin[] = [];
  for (const marketplace of fs.readdirSync(storePath, { withFileTypes: true })) {
    if (!marketplace.isDirectory() || marketplace.name.startsWith(".")) continue;
    const marketplaceDir = path.join(storePath, marketplace.name);
    for (const entry of fs.readdirSync(marketplaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const pluginDir = path.join(marketplaceDir, entry.name);
      const installPath = codexInstallRoot(pluginDir);
      let manifest: { name?: string; version?: string } = {};
      const manifestPath = path.join(installPath, ".codex-plugin", "plugin.json");
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
        } catch {
          /* malformed manifest remains visible with inferred metadata */
        }
      }
      const inferredVersion =
        installPath !== pluginDir && /^\d+\.\d+\.\d+/.test(path.basename(installPath))
          ? path.basename(installPath)
          : "?";
      out.push({
        name: manifest.name ?? entry.name,
        ecosystem: "codex",
        collection: marketplace.name,
        version: manifest.version ?? inferredVersion,
        scopes: ["installed"],
        projects: [],
        installPath,
        skills: listSkillNames(path.join(installPath, "skills")).sort(),
        agents: countFiles(path.join(installPath, "agents"), (name) => name.endsWith(".md")),
        commands: countFiles(path.join(installPath, "commands"), (name) => name.endsWith(".md")),
        hooks: fs.existsSync(path.join(installPath, "hooks")),
        missing: false,
      });
    }
  }
  return out;
}

export function buildFederationSnapshot(cfg: OpenMoatConfig): FederationSnapshot {
  const sources = federationSources(cfg);
  const warnings: string[] = [];
  const conflicts: FederationConflict[] = [];
  const skills: Omit<FederatedAsset<SkillInfo>, "selected">[] = [];
  const servers: Omit<FederatedAsset<ServerDef>, "selected">[] = [];
  const plugins: Omit<FederatedAsset<FederatedPlugin>, "selected">[] = [];

  for (const source of sources) {
    const presentSkillRoots = source.skillRoots.filter((root) => {
      if (fs.existsSync(root)) return true;
      warnings.push(`${source.id}: skill root missing: ${root}`);
      return false;
    });
    for (const skill of discoverSkills(presentSkillRoots)) {
      skills.push({
        id: `${source.id}/${skill.name}`,
        name: skill.name,
        source: source.id,
        priority: source.priority,
        value: skill,
      });
    }
    if (source.id === "local") {
      for (const server of cfg.inlineServers) {
        servers.push({
          id: `local/${server.name}`,
          name: server.name,
          source: "local",
          priority: source.priority,
          value: server,
        });
      }
    }
    for (const registry of source.mcpRegistries) {
      if (!fs.existsSync(registry)) {
        warnings.push(`${source.id}: MCP registry missing: ${registry}`);
        continue;
      }
      for (const server of loadRegistry(registry)) {
        const value: ServerDef =
          source.id === "local"
            ? server
            : {
                ...server,
                trusted: server.trusted === true,
                gatewayOnly: source.allowNative ? server.gatewayOnly : true,
              };
        servers.push({
          id: `${source.id}/${server.name}`,
          name: server.name,
          source: source.id,
          priority: source.priority,
          value,
        });
      }
    }
    for (const store of source.pluginStores) {
      if (!fs.existsSync(store.path)) {
        warnings.push(`${source.id}: ${store.type} plugin store missing: ${store.path}`);
        continue;
      }
      const values =
        store.type === "claude"
          ? readPlugins(store.path).plugins.map(
              (plugin): FederatedPlugin => ({
                name: plugin.name,
                ecosystem: "claude-code",
                collection: plugin.marketplace,
                version: plugin.version,
                scopes: plugin.scopes,
                projects: plugin.projects,
                installPath: plugin.installPath,
                skills: plugin.skills,
                agents: plugin.agents,
                commands: plugin.commands,
                hooks: plugin.hooks,
                missing: plugin.missing,
              })
            )
          : readCodexPluginStore(store.path);
      for (const value of values) {
        const name = pluginKey(value);
        plugins.push({
          id: `${source.id}/${name}`,
          name,
          source: source.id,
          priority: source.priority,
          value,
        });
      }
    }
    for (const catalog of source.pluginCatalogs) {
      if (!fs.existsSync(catalog)) {
        warnings.push(`${source.id}: plugin catalog missing: ${catalog}`);
        continue;
      }
      for (const value of readPluginCatalog(catalog)) {
        const name = pluginKey(value);
        plugins.push({
          id: `${source.id}/${name}`,
          name,
          source: source.id,
          priority: source.priority,
          value,
        });
      }
    }
  }

  return {
    sources,
    skills: select("skill", skills, conflicts),
    servers: select("mcp", servers, conflicts),
    plugins: select("plugin", plugins, conflicts),
    conflicts,
    warnings,
  };
}

export function getFederationSnapshot(cfg: OpenMoatConfig, fresh = false): FederationSnapshot {
  const hit = cache.get(cfg);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.snapshot;
  const snapshot = buildFederationSnapshot(cfg);
  cache.set(cfg, { at: Date.now(), snapshot });
  return snapshot;
}

export function invalidateFederationCache(cfg: OpenMoatConfig): void {
  cache.delete(cfg);
}

export function requireFederationReady(cfg: OpenMoatConfig, snapshot: FederationSnapshot): void {
  if ((cfg.federation?.conflictPolicy ?? "error") !== "error" || !snapshot.conflicts.length) return;
  const summary = snapshot.conflicts
    .map((conflict) => `${conflict.kind} '${conflict.name}': ${[conflict.selected, ...conflict.alternatives].join(", ")}`)
    .join("; ");
  throw new Error(`federation conflicts block resolution: ${summary}`);
}

function selected<T>(assets: FederatedAsset<T>[]): FederatedAsset<T>[] {
  return assets.filter((asset) => asset.selected);
}

export function federatedSkills(cfg: OpenMoatConfig, strict = true): FederatedAsset<SkillInfo>[] {
  const snapshot = getFederationSnapshot(cfg);
  if (strict) requireFederationReady(cfg, snapshot);
  return selected(snapshot.skills);
}

export function federatedServers(cfg: OpenMoatConfig, strict = true): FederatedAsset<ServerDef>[] {
  const snapshot = getFederationSnapshot(cfg);
  if (strict) requireFederationReady(cfg, snapshot);
  return selected(snapshot.servers);
}

export function federatedPlugins(cfg: OpenMoatConfig, strict = true): FederatedAsset<FederatedPlugin>[] {
  const snapshot = getFederationSnapshot(cfg);
  if (strict) requireFederationReady(cfg, snapshot);
  return selected(snapshot.plugins);
}

function resolveAsset<T>(
  assets: FederatedAsset<T>[],
  reference: string
): FederatedAsset<T> | undefined {
  return (
    assets.find((asset) => asset.id === reference) ??
    assets.find((asset) => asset.name === reference && asset.selected)
  );
}

export function resolveFederatedSkill(
  cfg: OpenMoatConfig,
  reference: string
): FederatedAsset<SkillInfo> | undefined {
  const snapshot = getFederationSnapshot(cfg);
  requireFederationReady(cfg, snapshot);
  return resolveAsset(snapshot.skills, reference);
}

export function resolveFederatedServer(
  cfg: OpenMoatConfig,
  reference: string
): FederatedAsset<ServerDef> | undefined {
  const snapshot = getFederationSnapshot(cfg);
  requireFederationReady(cfg, snapshot);
  return resolveAsset(snapshot.servers, reference);
}

export function renderFederation(snapshot: FederationSnapshot): string {
  const selectedCount = <T>(assets: FederatedAsset<T>[]) =>
    assets.filter((asset) => asset.selected).length;
  const lines = [
    `sources: ${snapshot.sources.length}`,
    `skills: ${selectedCount(snapshot.skills)} selected / ${snapshot.skills.length} total`,
    `MCP servers: ${selectedCount(snapshot.servers)} selected / ${snapshot.servers.length} total`,
    `plugins: ${selectedCount(snapshot.plugins)} selected / ${snapshot.plugins.length} total`,
  ];
  for (const source of snapshot.sources) {
    lines.push(
      `- ${source.id} priority=${source.priority} native=${source.allowNative ? "allowed" : "blocked"} skills=${source.skillRoots.length} registries=${source.mcpRegistries.length} plugin-sources=${source.pluginStores.length + source.pluginCatalogs.length}`
    );
  }
  if (snapshot.conflicts.length) {
    lines.push("conflicts:");
    for (const conflict of snapshot.conflicts) {
      lines.push(
        `- ${conflict.kind} ${conflict.name}: selected ${conflict.selected}; shadowed ${conflict.alternatives.join(", ")}`
      );
    }
  }
  for (const warning of snapshot.warnings) lines.push(`WARN: ${warning}`);
  return lines.join("\n");
}

export function renderFederatedPlugins(
  plugins: FederatedAsset<FederatedPlugin>[]
): string {
  if (!plugins.length) return "No federated plugins found.";
  return plugins
    .map((asset) => {
      const plugin = asset.value;
      const provides = [
        plugin.skills.length ? `${plugin.skills.length} skills` : "",
        plugin.agents ? `${plugin.agents} agents` : "",
        plugin.commands ? `${plugin.commands} commands` : "",
        plugin.hooks ? "hooks" : "",
      ]
        .filter(Boolean)
        .join(", ") || "metadata only";
      return `${asset.id} v${plugin.version} [${plugin.scopes.join("+")}] — ${provides}${plugin.missing ? " (MISSING)" : ""}`;
    })
    .join("\n");
}

export function federatedPluginSurface(
  plugins: FederatedAsset<FederatedPlugin>[]
): PluginSurface {
  const marketplaces = new Map<string, MarketplaceInfo>();
  const mapped: PluginInfo[] = [];
  for (const asset of plugins) {
    const plugin = asset.value;
    const marketplace = `${asset.source}/${plugin.ecosystem}/${plugin.collection}`;
    marketplaces.set(marketplace, {
      name: marketplace,
      source: `federation:${asset.source}`,
    });
    mapped.push({
      name: plugin.name,
      marketplace,
      version: plugin.version,
      scopes: plugin.scopes,
      projects: plugin.projects,
      installPath: plugin.installPath,
      skills: plugin.skills,
      agents: plugin.agents,
      commands: plugin.commands,
      hooks: plugin.hooks,
      missing: plugin.missing,
    });
  }
  return {
    marketplaces: [...marketplaces.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    plugins: mapped.sort(
      (a, b) =>
        a.marketplace.localeCompare(b.marketplace) || a.name.localeCompare(b.name)
    ),
  };
}
