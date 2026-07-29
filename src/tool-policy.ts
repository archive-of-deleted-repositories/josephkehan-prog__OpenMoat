/**
 * Tool-name collision handling for `tool_search`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tool_call(server, tool, args)` takes an explicit server, so DISPATCH is never
 * ambiguous. The damage from duplicate tool names is entirely in RANKING:
 * `tool_search` is FTS over the catalog, so `fetch›fetch` and `wigolo›fetch`
 * score near-identically and the only tiebreaker was the health breaker. The
 * agent then picks essentially at random — including picking the thinner tool
 * when the registry has a designated preferred one.
 *
 * Two distinct relations, because "one winner" is the wrong model for half the
 * collisions:
 *
 *   prefer       — same job, one is better.      → demote the losers.
 *   disambiguate — same name, different domain.  → keep both, annotate each.
 *
 * Treating `github›list_issues` vs `linear›list_issues` as a preference would
 * actively mislead: both are correct, for different targets.
 *
 * Policy data lives in `registry/mcp-servers.json` under `toolPolicy`.
 */

import fs from "node:fs";

export interface PreferRule {
  tool: string;
  winner: string;
  over: string[];
  why?: string;
}

export interface DisambiguateRule {
  tool: string;
  domains: Record<string, string>;
}

export interface ToolPolicy {
  prefer: PreferRule[];
  disambiguate: DisambiguateRule[];
}

const EMPTY: ToolPolicy = { prefer: [], disambiguate: [] };

/**
 * Load the policy from the registry file, cached on mtime.
 *
 * `tool_search` runs on essentially every agent turn, and the registry is
 * ~100 KB — re-parsing it per call is pure waste. Keyed on mtimeMs so an edit
 * to the registry takes effect without restarting the OpenMoat.
 *
 * A malformed or missing registry yields an empty policy rather than throwing:
 * collision hints are an enhancement, and losing them must never take
 * `tool_search` itself down.
 */
let policyCache: { mtimeMs: number; path: string; policy: ToolPolicy } | null = null;

export function loadToolPolicy(registryPath: string): ToolPolicy {
  try {
    const { mtimeMs } = fs.statSync(registryPath);
    if (policyCache && policyCache.path === registryPath && policyCache.mtimeMs === mtimeMs) {
      return policyCache.policy;
    }
    const policy = readToolPolicy(JSON.parse(fs.readFileSync(registryPath, "utf8")));
    policyCache = { mtimeMs, path: registryPath, policy };
    return policy;
  } catch {
    return EMPTY;
  }
}

/** Read `toolPolicy` out of an already-parsed registry document. */
export function readToolPolicy(registryDoc: unknown): ToolPolicy {
  const doc = registryDoc as { toolPolicy?: Partial<ToolPolicy> } | null;
  const p = doc?.toolPolicy;
  if (!p) return EMPTY;
  return {
    prefer: Array.isArray(p.prefer) ? p.prefer : [],
    disambiguate: Array.isArray(p.disambiguate) ? p.disambiguate : [],
  };
}

/** Split a catalog heading ("server › tool") into its parts. */
export function splitHeading(heading: string): { server: string; tool: string } {
  const [server = "", tool = ""] = heading.split("›").map((s) => s.trim());
  return { server, tool };
}

export interface RankedHit {
  heading: string;
  score: number;
  snippet: string;
}

export interface AnnotatedHit<T extends RankedHit> {
  hit: T;
  /** Appended to the result line. Empty when the hit needs no annotation. */
  note: string;
  /** True when a `prefer` rule demoted this hit below its winner. */
  demoted: boolean;
}

/**
 * Re-rank search hits so preferred tools outrank their alternatives, and
 * annotate collisions so the agent can tell them apart.
 *
 * Deliberately does NOT drop anything. A demoted tool is still reachable —
 * the registry's preference is advice, and the agent may have a reason to
 * want the other one. Silent removal would make that impossible to discover.
 *
 * Stable: hits keep their relative order except where a rule applies.
 */
export function applyToolPolicy<T extends RankedHit>(hits: T[], policy: ToolPolicy): AnnotatedHit<T>[] {
  if (!hits.length) return [];

  const preferByTool = new Map<string, PreferRule>();
  for (const r of policy.prefer) preferByTool.set(r.tool, r);
  const domainsByTool = new Map<string, Record<string, string>>();
  for (const r of policy.disambiguate) domainsByTool.set(r.tool, r.domains);

  // Which tool names actually collide *within this result set*? A preference
  // only matters when the alternatives are both on screen; annotating a lone
  // result with "preferred over X" is noise when X was never returned.
  const serversByTool = new Map<string, Set<string>>();
  for (const h of hits) {
    const { server, tool } = splitHeading(h.heading);
    if (!serversByTool.has(tool)) serversByTool.set(tool, new Set());
    serversByTool.get(tool)!.add(server);
  }

  const annotated: AnnotatedHit<T>[] = hits.map((hit) => {
    const { server, tool } = splitHeading(hit.heading);
    const colliding = (serversByTool.get(tool)?.size ?? 0) > 1;
    let note = "";
    let demoted = false;

    const pref = preferByTool.get(tool);
    if (pref && colliding) {
      if (pref.over.includes(server)) {
        demoted = true;
        note = ` [registry prefers ${pref.winner}›${tool}${pref.why ? ` — ${pref.why}` : ""}]`;
      } else if (pref.winner === server) {
        note = " [registry-preferred for this name]";
      }
    }

    // Domain hints apply even to a lone hit: knowing that longhand›search is
    // session history and not the web prevents a wrong call on its own.
    const domains = domainsByTool.get(tool);
    if (domains?.[server]) note += ` [${domains[server]}]`;

    return { hit, note, demoted };
  });

  // Stable partition: non-demoted first.
  return [...annotated.filter((a) => !a.demoted), ...annotated.filter((a) => a.demoted)];
}

/**
 * Suggest the real tool name when an agent calls one that doesn't exist.
 *
 * WHY: 39% of all recorded gateway calls (42 of 109 on 2026-07-21) were failed
 * calls to tools that were never in the catalog — agents guessing names from
 * memory instead of running tool_search. All three offenders:
 *
 *   dbx›query          20 calls, 20 errors   (real name: dbx_execute_query)
 *   project-memory server›x           20 calls, 20 errors   (no such tool)
 *   brave-search›search 2 calls,  2 errors   (real name: brave_web_search)
 *
 * `gatewayCall` passed the downstream "Tool query not found" straight through,
 * giving the agent nothing to correct with — so it retried, 20 times. Naming
 * the near-miss turns an unrecoverable dead end into a one-step fix.
 *
 * PARAMETERS ARE EVOLVED, NOT HAND-PICKED. `scripts/evolve/` runs a GA over a
 * 5,426-case corpus built by replaying real mis-naming patterns against the
 * live 648-tool catalog, with a held-out 30% test split. Selection pressure is
 * asymmetric on purpose: a confidently wrong suggestion scores −0.5 (positives)
 * or −1.0 (negatives), a silent miss scores 0. Silence beats a bad guess,
 * because silence routes the agent to tool_search, which works.
 *
 * 5 generations moved held-out fitness 0.9588 → 0.9678. Almost all of that is
 * misleading suggestions falling 10 → 3; hit-rate barely moved. Notably the GA
 * raised the substring gate 3 → 6: my hand-tuned 3 was too permissive, exactly
 * the bug that made "x" match "squish_conte(x)t".
 *
 * Ranks are ordinal (lower wins). Re-run `node scripts/evolve/evolve.mjs`
 * after any change to the catalog shape.
 */
const SUGGEST = {
  minSubstring: 6,     // was 3 — GA raised it; short substrings are noise
  jaccardMin: 0.75,    // token-set overlap needed to count
  distRatio: 0.2,      // was 0.5 — GA tightened it hard
  distFloor: 2,
  limit: 4,            // was 3
  rankJaccard: 1,      // best signal
  rankSubstring: 2,
  rankEdit: 2,
  rankTokenTail: 3,    // weakest — fires on dbx_execute_query <- query
  minToken: 3,
} as const;

const tokens = (s: string): string[] => s.split(/[_\-\s]+/).filter(Boolean);

export function suggestToolName(wanted: string, available: string[], limit = SUGGEST.limit): string[] {
  const w = wanted.toLowerCase();
  const wt = tokens(w);
  const scored: { name: string; rank: number; dist: number }[] = [];

  for (const name of available) {
    const n = name.toLowerCase();
    if (n === w) return [name];
    const nt = tokens(n);
    let rank = Infinity;

    // token-set overlap — strongest signal per the GA
    if (wt.length && nt.length) {
      const A = new Set(wt);
      const B = new Set(nt);
      const inter = [...A].filter((x) => B.has(x)).length;
      if (inter / (A.size + B.size - inter) >= SUGGEST.jaccardMin) rank = Math.min(rank, SUGGEST.rankJaccard);
    }
    // substring, gated at 6 chars
    if (w.length >= SUGGEST.minSubstring && (n.includes(w) || w.includes(n))) {
      rank = Math.min(rank, SUGGEST.rankSubstring);
    }
    // normalised edit distance
    const d = editDistance(w, n);
    if (d <= Math.max(SUGGEST.distFloor, Math.floor(Math.max(w.length, n.length) * SUGGEST.distRatio))) {
      rank = Math.min(rank, SUGGEST.rankEdit);
    }
    // shared trailing token: dbx_execute_query <- query
    if (wt.length && nt.length && nt[nt.length - 1] === wt[wt.length - 1] && wt[wt.length - 1]!.length >= SUGGEST.minToken) {
      rank = Math.min(rank, SUGGEST.rankTokenTail);
    }

    if (rank !== Infinity) scored.push({ name, rank, dist: d });
  }

  scored.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/** Levenshtein, two-row. Only ever runs over one server's tool list. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** True when an upstream error means "that tool does not exist here". */
export function isToolNotFoundError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    (m.includes("not found") || m.includes("unknown tool") || m.includes("no such tool")) &&
    m.includes("tool")
  );
}

/**
 * Collisions present in the catalog as a whole, for docs and audits.
 * `catalog` maps tool name -> servers exposing it.
 */
export function auditCollisions(
  catalog: Map<string, string[]>,
  policy: ToolPolicy
): { tool: string; servers: string[]; covered: "prefer" | "disambiguate" | "UNCOVERED" }[] {
  const preferred = new Set(policy.prefer.map((r) => r.tool));
  const disambiguated = new Set(policy.disambiguate.map((r) => r.tool));
  const out: { tool: string; servers: string[]; covered: "prefer" | "disambiguate" | "UNCOVERED" }[] = [];
  for (const [tool, servers] of catalog) {
    if (servers.length < 2) continue;
    out.push({
      tool,
      servers: [...servers].sort(),
      covered: preferred.has(tool) ? "prefer" : disambiguated.has(tool) ? "disambiguate" : "UNCOVERED",
    });
  }
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}
