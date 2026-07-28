/**
 * Discovery: turn the punkpeye/awesome-mcp-servers aggregator (~2,800 servers)
 * into a searchable source inside the hub. Idea borrowed from the Aggregators
 * category peers (forage, a2asearch, MCPDiscovery, ncp): agents/humans search
 * the catalog, and adopt a pick straight into the registry — QUARANTINED, of
 * course. The aggregator's API exposes no run command, so we parse the npx/uvx
 * line out of each entry's description (awesome-mcp lists it in backticks) and
 * fall back to the repo URL when absent.
 */

import fs from "node:fs";
import path from "node:path";
import type { HubConfig } from "./config.js";

const RAW = "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface Candidate {
  name: string;
  repo: string;
  description: string;
  command?: string; // parsed npx/uvx line if the entry gave one
  local: boolean; // 🏠
  score: number;
}

function cachePath(cfg: HubConfig): string {
  return path.join(cfg.stateDir, "awesome-mcp.md");
}

async function corpus(cfg: HubConfig, refresh = false): Promise<string> {
  const cache = cachePath(cfg);
  if (!refresh && fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < CACHE_TTL_MS) {
    return fs.readFileSync(cache, "utf8");
  }
  const res = await fetch(RAW);
  if (!res.ok) {
    if (fs.existsSync(cache)) return fs.readFileSync(cache, "utf8"); // stale beats nothing
    throw new Error(`could not fetch aggregator (${res.status})`);
  }
  const text = await res.text();
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(cache, text);
  return text;
}

/** Parse one markdown list line into a candidate, or null if not an entry. */
function parseLine(line: string): Omit<Candidate, "score"> | null {
  const m = line.match(/^\s*-\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)(.*)$/);
  if (!m) return null;
  const [, name, repo, rest] = m;
  // strip inline glama badge links, keep the human description after " - "
  const cleaned = rest.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "");
  const desc = (cleaned.split(/\s+-\s+/).slice(1).join(" - ") || cleaned).trim();
  const cmd = desc.match(/`((?:npx|uvx|uv|bunx)\s+[^`]+)`/);
  return {
    name: name.trim(),
    repo,
    description: desc.replace(/`/g, "").slice(0, 300),
    command: cmd?.[1],
    local: /🏠/.test(rest),
  };
}

export async function discover(
  cfg: HubConfig,
  query: string,
  opts: { k?: number; refresh?: boolean; runnableOnly?: boolean } = {}
): Promise<Candidate[]> {
  const text = await corpus(cfg, opts.refresh);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: Candidate[] = [];
  for (const line of text.split("\n")) {
    const c = parseLine(line);
    if (!c) continue;
    if (opts.runnableOnly && !c.command) continue;
    const hay = `${c.name} ${c.description}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (c.name.toLowerCase().includes(t)) score += 3;
      else if (hay.includes(t)) score += 1;
    }
    if (score === 0) continue;
    if (c.command) score += 2; // spawnable beats a bare repo link
    if (c.local) score += 1;
    out.push({ ...c, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, opts.k ?? 8);
}

/** Turn a chosen candidate into a registry entry (quarantined). Requires a
 *  run command — parsed from the entry or supplied by the caller. */
export function candidateToEntry(c: Candidate, commandOverride?: string): Record<string, unknown> {
  const cmd = commandOverride ?? c.command;
  if (!cmd) {
    throw new Error(
      `'${c.name}' has no run command in the aggregator — check ${c.repo} for how to run it, then add an entry to registry/mcp-servers.json by hand (or re-run discover with --runnable to only see spawnable entries).`
    );
  }
  const parts = cmd.split(/\s+/);
  return {
    name: c.name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 50),
    gatewayOnly: true,
    trusted: false,
    transport: "stdio",
    command: parts[0],
    args: parts.slice(1),
    notes: `discovered from awesome-mcp-servers: ${c.repo}`,
  };
}
