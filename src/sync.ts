import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileSafe } from "./backup.js";
import type { HubConfig } from "./config.js";
import {
  federatedSkills,
  getFederationSnapshot,
  requireFederationReady,
} from "./federation.js";
import { promotedInstincts } from "./instincts.js";
import { loadSecrets, resolveServers, serversFor } from "./registry.js";
import { syncSkillLinks } from "./skills.js";
import { loadState, saveState } from "./state.js";
import type { Adapter } from "./adapters/types.js";
import { claudeCode } from "./adapters/claude-code.js";
import { codex } from "./adapters/codex.js";
import { claudeDesktop } from "./adapters/claude-desktop.js";
import { cursor } from "./adapters/cursor.js";
import { hermes } from "./adapters/hermes.js";
import { opencode } from "./adapters/opencode.js";
import { pi, senpi } from "./adapters/pi-family.js";
import { zed } from "./adapters/zed.js";
import { continueAdapter } from "./adapters/continue.js";
import { warp } from "./adapters/warp.js";
import { vscode } from "./adapters/vscode.js";
import { factory } from "./adapters/factory.js";
import { kimiCode, kimiDesktop } from "./adapters/kimi.js";

export const ADAPTERS: Adapter[] = [codex, claudeCode, claudeDesktop, hermes, opencode, cursor, pi, senpi, zed, continueAdapter, warp, factory, vscode, kimiCode, kimiDesktop];

export type DoctorStatus = "ok" | "disabled" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  target?: string;
  path?: string;
}

export interface DoctorReport {
  readOnly: true;
  healthy: boolean;
  ready: boolean;
  summary: Record<DoctorStatus, number>;
  checks: DoctorCheck[];
}

const BEGIN = "<!-- openmoat:begin -->";
const END = "<!-- openmoat:end -->";

/** Shorten an absolute path to ~/… for display. */
function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Keep adapter detail lines honest when their write was only simulated. */
function previewNote(note: string, dryRun: boolean): string {
  if (!dryRun) return note;
  return note
    .replace(/^updated\b/, "would update")
    .replace(/^added\b/, "would add")
    .replace(/^removed\b/, "would remove");
}

/** Write through a live symlink without replacing the ownership link itself. */
function writableTarget(file: string): string {
  try {
    return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file;
  } catch {
    return file;
  }
}

/** Count cataloged tools (### headings) across state/mcp-tools/*.md. */
function countCatalogTools(cfg: HubConfig): number {
  const dir = path.join(cfg.stateDir, "mcp-tools");
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    n += (fs.readFileSync(path.join(dir, f), "utf8").match(/^### /gm) ?? []).length;
  }
  return n;
}

/** Standing instructions injected into the shared AGENTS.md so every agent
 *  knows the gateway exists. Base rules + promoted instincts (ECC-style
 *  learned triggers from the self-evaluation loop). Facts (roster, counts,
 *  path) are derived from live state so they can't go stale. */
function buildGatewayBlock(cfg: HubConfig): string {
  const learned = promotedInstincts(cfg);
  const learnedSection = learned.length
    ? `\nLearned triggers (self-tuned from past misses — confidence-scored):\n${learned
        .map((i) => `- [${i.confidence.toFixed(2)}] ${i.rule}`)
        .join("\n")}\n`
    : "";
  const roster = Object.entries(cfg.targets)
    .filter(([, t]) => t.enabled)
    .map(([id]) => id)
    .join(", ");
  const snapshot = getFederationSnapshot(cfg);
  const serverCount = snapshot.servers.filter(
    (asset) => asset.selected && !asset.value.disabled
  ).length;
  const toolCount = countCatalogTools(cfg);
  const hubPath = tildify(path.dirname(cfg.registry).replace(/\/registry$/, ""));
  return `${BEGIN}
## This machine's shared brain (openmoat) — system map

Every agent here (${roster}) shares one hub at ${hubPath}. Harnesses carry the
Hub gateway plus only deliberately native helpers; ${serverCount} selected MCP
servers sit behind the federated catalog, invisible until needed.

THE REFLEX — for web research, scraping, browser automation, docs lookup,
images, GitHub, data files, or ANY external capability, even unnamed:
1. \`tool_search("what you need")\` — semantic search over ${toolCount || "the"} cataloged tools
2. \`tool_describe(server, tool)\` — exact schema
3. \`tool_call(server, tool, arguments)\` — hub spawns on demand and proxies
Never say a tool is unavailable before tool_search.

tool_call extras: pass \`cwd\` for per-project servers (squish, git). Oversized
results return a 4K head + archive hash — continue with \`tool_result_fetch\`
{hash, offset} or search inside via {hash, find}. Failures/slowness → \`hub_health\`
(circuit breakers + latency stats). QUARANTINED servers need the human's
approval — suggest \`hub trust <name>\`, never self-approve. OAuth remotes
(github…) work through the hub; if auth is requested: \`hub auth <name>\`.

MEMORY — three layers, use the right one:
- \`squish_remember\`/\`squish_recall\`: structured project facts & learnings
- \`rag_search\`: configured workspace documents, profiles, skills, and guides;
  the full operator guide: rag_search "operator guide for agents")
- \`context_save\`/\`context_latest\`: session handoffs to the NEXT agent

Session start: \`hub_bootstrap\`. Skills are PULL-ONLY — not preloaded; when a
task matches one, \`skills_list\` to find it then \`skill_read\` to load it (or
\`rag_search\`). Self-improvement: noticed you missed a gateway tool? One-line
\`instinct_report\` — proven instincts auto-publish here.
${learnedSection}${END}`;
}

/** Inject/refresh the gateway instructions in the shared AGENTS.md. */
function syncGatewayInstructions(cfg: HubConfig, dryRun: boolean): boolean {
  const file = cfg.memoryImport;
  const block = buildGatewayBlock(cfg);
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  // Replacer function: the block embeds agent-supplied instinct text, and a
  // string replacement would expand $-patterns ($&, $', $1…) inside it.
  const next = re.test(text)
    ? text.replace(re, () => block)
    : text.trimEnd() + (text.trim() ? "\n\n" : "") + block + "\n";
  if (next === text) return false;
  writeFileSafe(writableTarget(file), next, cfg.stateDir, dryRun);
  return true;
}

/** Inject/refresh a managed import block in a memory file (CLAUDE.md / AGENTS.md). */
function syncMemoryBlock(memoryFile: string, importPath: string, cfg: HubConfig, dryRun: boolean): string | null {
  const block = `${BEGIN}\nShared profile & identity (managed by openmoat — do not edit between markers):\n@${importPath}\n${END}`;
  let text = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, "utf8") : "";
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  let next: string;
  if (re.test(text)) {
    next = text.replace(re, () => block);
  } else {
    next = text.trimEnd() + (text.trim() ? "\n\n" : "") + block + "\n";
  }
  if (next === text) return null;
  writeFileSafe(writableTarget(memoryFile), next, cfg.stateDir, dryRun);
  return memoryFile;
}

export interface SyncReport {
  dryRun: boolean;
  readOnly: boolean;
  hasChanges: boolean;
  lines: string[];
  warnings: string[];
}

export function runSync(cfg: HubConfig, opts: { dryRun?: boolean; only?: string } = {}): SyncReport {
  const dryRun = opts.dryRun ?? false;
  const lines: string[] = [];
  let hasChanges = false;
  const snapshot = getFederationSnapshot(cfg, true);
  requireFederationReady(cfg, snapshot);
  const defs = snapshot.servers.filter((asset) => asset.selected).map((asset) => asset.value);
  const secrets = loadSecrets(cfg.secretsEnv, { enforcePermissions: !dryRun });
  const { servers, warnings: resolutionWarnings } = resolveServers(defs, secrets);
  const warnings = [...resolutionWarnings];
  const state = loadState(cfg.stateDir, {
    preserveCorrupt: !dryRun,
    onWarning: (warning) => warnings.push(warning),
  });

  lines.push(
    `federation: ${snapshot.sources.length} sources, ${defs.length} selected servers (${servers.length} enabled)${dryRun ? "  [DRY RUN]" : ""}`
  );

  // 1) MCP server configs per target
  for (const adapter of ADAPTERS) {
    const target = cfg.targets[adapter.id];
    if (!target?.enabled || (opts.only && opts.only !== adapter.id)) continue;
    const applicable = serversFor(servers, adapter.id);
    const res = adapter.sync(applicable, {
      configPath: target.config,
      stateDir: cfg.stateDir,
      dryRun,
      prevManaged: state.servers[adapter.id] ?? [],
    });
    state.servers[adapter.id] = res.managed;
    hasChanges ||= res.changed;
    const status = res.changed ? (dryRun ? "would update" : "updated") : "no changes";
    lines.push(`[${adapter.id}] ${status} — ${target.config}`);
    for (const n of res.notes) lines.push(`  · ${previewNote(n, dryRun)}`);
  }

  // 2) Skills are PULL-ONLY. The hub does not push skill symlinks into any
  //    harness — agents fetch skills on demand via skills_list / skill_read /
  //    rag_search when a task needs one. If a target still has skillsLink set,
  //    or the hub created links in a past run, tear them down here.
  for (const adapter of ADAPTERS) {
    const target = cfg.targets[adapter.id];
    if (opts.only && opts.only !== adapter.id) continue;
    const prev = state.skillLinks[adapter.id] ?? [];
    // If linking is (still) configured, honor it; otherwise remove what we made.
    const linkDir = target?.enabled ? target.skillsLink : undefined;
    if (linkDir) {
      const skills = federatedSkills(cfg).map((asset) => asset.value);
      const res = syncSkillLinks(skills, linkDir, prev, dryRun);
      state.skillLinks[adapter.id] = res.links;
      hasChanges ||= res.linked.length > 0 || res.removed.length > 0;
      if (res.linked.length) lines.push(`  · [${adapter.id}] ${dryRun ? "would link" : "linked"} ${res.linked.length} skill(s)`);
      if (res.removed.length) lines.push(`  · [${adapter.id}] ${dryRun ? "would remove" : "removed"} ${res.removed.length} stale skill link(s)`);
    } else if (prev.length) {
      let removed = 0;
      for (const link of prev) {
        try {
          if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) {
            if (!dryRun) fs.unlinkSync(link);
            removed++;
          }
        } catch {
          /* ignore */
        }
      }
      state.skillLinks[adapter.id] = [];
      hasChanges ||= removed > 0;
      if (removed) lines.push(`  · [${adapter.id}] ${dryRun ? "would remove" : "removed"} ${removed} pushed skill link(s) — skills are now pull-only`);
    }
  }

  // 3) Gateway instructions in the shared AGENTS.md (read by all harnesses)
  const gw = syncGatewayInstructions(cfg, dryRun);
  hasChanges ||= gw;
  lines.push(`gateway instructions ${gw ? (dryRun ? "would update" : "updated") : "already current"} — ${cfg.memoryImport}`);

  // 4) Shared profile import block in each harness memory file
  for (const [id, target] of Object.entries(cfg.targets)) {
    if (!target.enabled || !target.memoryFile || (opts.only && opts.only !== id)) continue;
    const touched = syncMemoryBlock(target.memoryFile, cfg.memoryImport, cfg, dryRun);
    hasChanges ||= Boolean(touched);
    lines.push(`[${id}] memory block ${touched ? (dryRun ? "would update" : "updated") : "already current"} — ${target.memoryFile}`);
  }

  const managedStateChanged = saveState(cfg.stateDir, state, dryRun);
  hasChanges ||= managedStateChanged;
  lines.push(`managed state ${managedStateChanged ? (dryRun ? "would update" : "updated") : "already current"} — ${path.join(cfg.stateDir, "managed.json")}`);
  for (const w of warnings) lines.push(`WARN: ${w}`);
  return { dryRun, readOnly: dryRun, hasChanges, lines, warnings };
}

function inspectRagFile(dbPath: string): DoctorCheck {
  if (!fs.existsSync(dbPath)) {
    return {
      id: "rag",
      status: "warning",
      path: dbPath,
      message: `rag: not indexed — ${dbPath} missing (run hub index)`,
    };
  }
  try {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(dbPath, "r");
    let bytes: number;
    try {
      bytes = fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (bytes !== 16 || header.toString("utf8") !== "SQLite format 3\u0000") {
      return { id: "rag", status: "error", path: dbPath, message: `rag: invalid SQLite header — ${dbPath}` };
    }
    return {
      id: "rag",
      status: "ok",
      path: dbPath,
      message: `rag: database present (${fs.statSync(dbPath).size} bytes) — ${dbPath}`,
    };
  } catch (error) {
    return { id: "rag", status: "error", path: dbPath, message: `rag: unreadable — ${dbPath}: ${error}` };
  }
}

/** Structured sanity checks that never write Hub or harness state. */
export function runDoctorReport(cfg: HubConfig): DoctorReport {
  const checks: DoctorCheck[] = [];
  const snapshot = getFederationSnapshot(cfg, true);
  const defs = snapshot.servers.filter((asset) => asset.selected).map((asset) => asset.value);
  checks.push({
    id: "federation",
    status: "ok",
    message: `federation: ${snapshot.sources.length} sources — ${defs.length} selected servers (${defs.filter((d) => !d.disabled).length} enabled), ${snapshot.skills.filter((asset) => asset.selected).length} selected skills, ${snapshot.plugins.filter((asset) => asset.selected).length} selected plugins`,
  });
  for (const conflict of snapshot.conflicts) {
    const blocked = (cfg.federation?.conflictPolicy ?? "error") === "error";
    checks.push({
      id: `federation-conflict:${conflict.kind}:${conflict.name}`,
      status: blocked ? "error" : "warning",
      message: `federation ${blocked ? "BLOCKED" : "resolved"}: ${conflict.kind} '${conflict.name}' selected ${conflict.selected}; shadowed ${conflict.alternatives.join(", ")}`,
    });
  }
  for (const [index, warning] of snapshot.warnings.entries()) {
    checks.push({ id: `federation-warning:${index}`, status: "warning", message: `WARN: ${warning}` });
  }
  const contextExists = fs.existsSync(cfg.contextDir);
  checks.push({
    id: "context",
    status: contextExists ? "ok" : "error",
    path: cfg.contextDir,
    message: `context dir: ${cfg.contextDir} ${contextExists ? "ok" : "MISSING"}`,
  });
  for (const [index, file] of cfg.profileFiles.entries()) {
    const exists = fs.existsSync(file);
    checks.push({
      id: `profile:${index}`,
      status: exists ? "ok" : "error",
      path: file,
      message: `profile: ${file} ${exists ? "ok" : "MISSING"}`,
    });
  }

  if (!fs.existsSync(cfg.secretsEnv)) {
    checks.push({ id: "secrets", status: "warning", path: cfg.secretsEnv, message: `secrets: ${cfg.secretsEnv} missing` });
  } else {
    const privateMode = (fs.statSync(cfg.secretsEnv).mode & 0o077) === 0;
    checks.push({
      id: "secrets",
      status: privateMode ? "ok" : "warning",
      path: cfg.secretsEnv,
      message: `secrets: ${cfg.secretsEnv} ${privateMode ? "permissions ok" : "permissions too broad (expected 0600)"}`,
    });
  }

  // Expected native servers come from the registry (non-gatewayOnly + targets),
  // and each config is checked with its adapter's own parser — no magic names,
  // no substring matching.
  const { servers: resolved, warnings: secretWarnings } = resolveServers(
    defs,
    loadSecrets(cfg.secretsEnv, { enforcePermissions: false })
  );
  for (const [index, warning] of secretWarnings.entries()) {
    checks.push({ id: `secret-resolution:${index}`, status: "error", message: `WARN: ${warning}` });
  }
  for (const [id, t] of Object.entries(cfg.targets)) {
    if (!t.enabled) {
      checks.push({ id: `target:${id}`, target: id, status: "disabled", path: t.config, message: `[${id}] disabled` });
      continue;
    }
    const exists = fs.existsSync(t.config);
    const adapter = ADAPTERS.find((a) => a.id === id);
    if (!exists) {
      checks.push({
        id: `target:${id}`,
        target: id,
        status: "warning",
        path: t.config,
        message: `[${id}] ${t.config} not found`,
      });
      continue;
    }
    if (!adapter) {
      const memoryExists = Boolean(t.memoryFile && fs.existsSync(t.memoryFile));
      const profileOnly = Boolean(t.memoryFile);
      checks.push({
        id: `target:${id}`,
        target: id,
        status: profileOnly && memoryExists ? "ok" : "warning",
        path: t.memoryFile ?? t.config,
        message: profileOnly
          ? `[${id}] profile-only target · ${t.memoryFile} ${memoryExists ? "ok" : "not found"}`
          : `[${id}] ${t.config} ok · no adapter available for native-server validation`,
      });
      continue;
    }
    try {
      const found = new Set(adapter.readServers(t.config).filter((f) => f.active !== false).map((f) => f.name));
      const missing = serversFor(resolved, id).map((s) => s.name).filter((name) => !found.has(name));
      checks.push({
        id: `target:${id}`,
        target: id,
        status: missing.length ? "warning" : "ok",
        path: t.config,
        message: `[${id}] ${t.config} ok${missing.length ? ` · missing native: ${missing.join(", ")} (run hub sync)` : " · native servers ✓"}`,
      });
    } catch (error) {
      checks.push({
        id: `target:${id}`,
        target: id,
        status: "error",
        path: t.config,
        message: `[${id}] ${t.config} unreadable: ${error}`,
      });
    }
  }
  checks.push(inspectRagFile(cfg.rag.db));

  const summary: Record<DoctorStatus, number> = { ok: 0, disabled: 0, warning: 0, error: 0 };
  for (const check of checks) summary[check.status]++;
  return {
    readOnly: true,
    healthy: summary.error === 0,
    ready: summary.error === 0 && summary.warning === 0,
    summary,
    checks,
  };
}

/** Backward-compatible human lines for callers that do not need structure. */
export function runDoctor(cfg: HubConfig): string[] {
  return runDoctorReport(cfg).checks.map((check) => check.message);
}
