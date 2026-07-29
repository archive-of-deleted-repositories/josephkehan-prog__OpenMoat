/**
 * Bidirectional sync, the missing direction (abridge-style): scan every
 * harness config for MCP servers that are NOT in the registry (drift — added
 * by hand, by another tool, by an installer) and pull them INTO the registry
 * as gatewayOnly + quarantined (trusted:false). Harness configs are left
 * untouched; sync will keep them since only registry-managed names are pruned.
 */

import fs from "node:fs";
import { backupFile } from "./backup.js";
import type { OpenMoatConfig } from "./config.js";
import {
  getFederationSnapshot,
  invalidateFederationCache,
} from "./federation.js";
import type { ServerDef } from "./registry.js";
import { ADAPTERS } from "./sync.js";

interface Found {
  name: string;
  def: Partial<ServerDef>;
  source: string;
  active?: boolean;
  adoptable?: boolean;
  adoptReason?: string;
}

export function scanHarnesses(cfg: OpenMoatConfig): Found[] {
  const out: Found[] = [];
  for (const [id, t] of Object.entries(cfg.targets)) {
    if (!t.enabled) continue;
    // Each adapter owns its own config format (read AND write) — no per-format
    // parsing here. A target without an adapter is skipped loudly, never
    // guessed at.
    const adapter = ADAPTERS.find((a) => a.id === id);
    if (!adapter) {
      console.error(`openmoat: no adapter for target '${id}' — skipping drift scan for ${t.config}`);
      continue;
    }
    for (const f of adapter.readServers(t.config)) out.push({ ...f, source: id });
  }
  return out;
}

export function adopt(cfg: OpenMoatConfig, dryRun: boolean): string[] {
  const lines: string[] = [];
  const known = new Set(
    getFederationSnapshot(cfg, true).servers.flatMap((asset) => [
      asset.name,
      asset.id,
    ])
  );
  const found = scanHarnesses(cfg);
  const drift = new Map<string, Found>();
  const skipped: string[] = [];
  for (const f of found) {
    if (known.has(f.name) || drift.has(f.name)) continue;
    if (f.active === false) {
      skipped.push(`skipped '${f.name}' from ${f.source}: configured but disabled`);
      continue;
    }
    if (f.adoptable === false) {
      skipped.push(`skipped '${f.name}' from ${f.source}: ${f.adoptReason ?? "definition is not safely representable"}`);
      continue;
    }
    if (!f.def.command && f.def.transport !== "http") continue; // unparseable entry
    drift.set(f.name, f);
  }
  if (!drift.size) {
    lines.push(...skipped);
    lines.push("no drift: every safely-adoptable active server is already in the registry");
    return lines;
  }
  lines.push(...skipped);
  const raw = JSON.parse(fs.readFileSync(cfg.registry, "utf8")) as { servers: ServerDef[] };
  for (const [name, f] of drift) {
    lines.push(`${dryRun ? "[DRY RUN] would adopt" : "adopted"} '${name}' from ${f.source} (gatewayOnly, QUARANTINED until \`moat trust ${name}\`)`);
    if (!dryRun) {
      raw.servers.push({
        gatewayOnly: true,
        trusted: false,
        ...(f.def as Omit<ServerDef, "name">),
        name,
        notes: `adopted from ${f.source} ${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }
  if (!dryRun) {
    backupFile(cfg.registry, cfg.stateDir);
    fs.writeFileSync(cfg.registry, JSON.stringify(raw, null, 2) + "\n", "utf8");
    invalidateFederationCache(cfg);
  }
  return lines;
}

/** Approve a quarantined server. */
export function trust(cfg: OpenMoatConfig, name: string): string {
  const raw = JSON.parse(fs.readFileSync(cfg.registry, "utf8")) as { servers: ServerDef[] };
  const s = raw.servers.find((x) => x.name === name);
  if (!s) return `'${name}' is not in the registry`;
  if (s.trusted !== false) return `'${name}' is already trusted`;
  s.trusted = true;
  backupFile(cfg.registry, cfg.stateDir);
  fs.writeFileSync(cfg.registry, JSON.stringify(raw, null, 2) + "\n", "utf8");
  invalidateFederationCache(cfg);
  return `'${name}' is now trusted — callable through the gateway`;
}
