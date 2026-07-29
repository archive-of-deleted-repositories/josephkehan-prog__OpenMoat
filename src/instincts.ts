import fs from "node:fs";
import path from "node:path";
import type { OpenMoatConfig } from "./config.js";

/**
 * ECC-style instincts (everything-claude-code Continuous Learning v2 pattern):
 * atomic learned rules about when agents should reach for the gateway.
 * Confidence 0.3–0.9: reinforced by evidence (transcript misses, agent
 * self-reports), decayed when stale, pruned below 0.25, promoted into the
 * synced AGENTS.md gateway block at >= 0.5.
 */

export interface Evidence {
  ts: string;
  source: "evaluate" | "self-report";
  snippet: string;
  agent?: string;
}

export interface Instinct {
  id: string; // stable key, usually the target server name + category
  rule: string; // one-line trigger rule rendered into AGENTS.md when promoted
  category: string;
  confidence: number;
  evidence: Evidence[];
  created: string;
  lastReinforced: string;
}

const START_CONFIDENCE = 0.3;
const SELF_REPORT_START = 0.4;
const REINFORCE = 0.1;
const DECAY = 0.03;
const PRUNE_BELOW = 0.25;
const PROMOTE_AT = 0.5;
const CAP = 0.9;
/** Free-slug self-reports (no server named) are unbounded ids — cap them so
 *  one chatty agent can't flood instincts.json. Server-keyed reports dedup
 *  naturally on `gateway-miss:<server>` (one instinct per server). */
const MAX_FREE_SELF_REPORTS = 12;

/** Truncate at a word boundary (never mid-word/mid-sentence), ellipsis when cut. */
export function truncateAtWord(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max / 2 ? cut.slice(0, at) : cut).replace(/[,;:.!?'"-]+$/, "") + "…";
}

/** Sanitize agent-supplied text before it can be templated into a rule that
 *  `moat sync` publishes into AGENTS.md. Published rules must read as DATA
 *  (a task description), never as an instruction to future agents: strip
 *  markup that could break out of the list item, quote characters that could
 *  escape the template, and leading imperative framing. */
export function sanitizeObservation(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[`*_#>|{}[\]$\\"]/g, "")
    .replace(/^(?:always|never|you must|do not|don'?t|ignore|disregard|important:?)\s*[:,-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Count of free-slug self-report instincts (id `self-report:*`). */
export function freeSelfReportCount(cfg: OpenMoatConfig): number {
  return loadInstincts(cfg).filter((i) => i.id.startsWith("self-report:")).length;
}

export function isAtFreeSelfReportCap(cfg: OpenMoatConfig, id: string): boolean {
  if (!id.startsWith("self-report:")) return false;
  if (loadInstincts(cfg).some((i) => i.id === id)) return false; // reinforcing existing is fine
  return freeSelfReportCount(cfg) >= MAX_FREE_SELF_REPORTS;
}

/** Prevent one agent from manufacturing publication confidence by repeating
 * the same report. Independent agents, or the same agent after the review
 * window, may reinforce it. */
export function hasRecentSelfReport(cfg: OpenMoatConfig, id: string, agent: string, withinMs = 24 * 3600_000): boolean {
  const cutoff = Date.now() - withinMs;
  const instinct = loadInstincts(cfg).find((i) => i.id === id);
  return (
    instinct?.evidence.some(
      (e) => e.source === "self-report" && e.agent === agent && Date.parse(e.ts) >= cutoff
    ) ?? false
  );
}

function file(cfg: OpenMoatConfig): string {
  return path.join(cfg.stateDir, "instincts.json");
}

export function loadInstincts(cfg: OpenMoatConfig): Instinct[] {
  const f = file(cfg);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`openmoat: could not parse ${f} — treating as no instincts: ${e}`);
    return [];
  }
}

export function saveInstincts(cfg: OpenMoatConfig, instincts: Instinct[]): void {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(file(cfg), JSON.stringify(instincts, null, 2), "utf8");
}

/** Create or reinforce an instinct. Returns the updated instinct. */
export function reinforceInstinct(
  cfg: OpenMoatConfig,
  input: { id: string; rule: string; category: string; evidence: Evidence }
): Instinct {
  const all = loadInstincts(cfg);
  const now = new Date().toISOString();
  let inst = all.find((i) => i.id === input.id);
  if (inst) {
    inst.confidence = Math.min(CAP, inst.confidence + REINFORCE);
    inst.rule = input.rule; // latest phrasing wins
    inst.evidence.push(input.evidence);
    if (inst.evidence.length > 10) inst.evidence = inst.evidence.slice(-10);
    inst.lastReinforced = now;
  } else {
    inst = {
      id: input.id,
      rule: input.rule,
      category: input.category,
      confidence: input.evidence.source === "self-report" ? SELF_REPORT_START : START_CONFIDENCE,
      evidence: [input.evidence],
      created: now,
      lastReinforced: now,
    };
    all.push(inst);
  }
  saveInstincts(cfg, all);
  return inst;
}

/** Decay instincts not in `reinforcedIds`, prune the dead. Returns pruned rules. */
export function decayAndPrune(cfg: OpenMoatConfig, reinforcedIds: Set<string>): string[] {
  const all = loadInstincts(cfg);
  const pruned: string[] = [];
  const kept = all.filter((i) => {
    if (!reinforcedIds.has(i.id)) i.confidence = Math.round((i.confidence - DECAY) * 100) / 100;
    if (i.confidence < PRUNE_BELOW) {
      pruned.push(i.rule);
      return false;
    }
    return true;
  });
  saveInstincts(cfg, kept);
  return pruned;
}

/** Instincts strong enough to render into the synced gateway block. */
export function promotedInstincts(cfg: OpenMoatConfig, max = 10): Instinct[] {
  return loadInstincts(cfg)
    .filter((i) => i.confidence >= PROMOTE_AT)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, max);
}

/** ECC-style instinct pack: portable export/import for sharing learned rules
 *  across machines (or with other people's hubs). Import merges by id,
 *  keeping the higher confidence and unioning evidence. */
export function exportPack(cfg: OpenMoatConfig): string {
  return JSON.stringify(
    {
      format: "openmoat-instinct-pack",
      version: 1,
      exported: new Date().toISOString(),
      instincts: loadInstincts(cfg),
    },
    null,
    2
  );
}

export function importPack(cfg: OpenMoatConfig, json: string): { added: number; merged: number } {
  const pack = JSON.parse(json) as { format?: string; instincts?: Instinct[] };
  if (pack.format !== "openmoat-instinct-pack" || !Array.isArray(pack.instincts)) {
    throw new Error("not an openmoat instinct pack");
  }
  const all = loadInstincts(cfg);
  let added = 0;
  let merged = 0;
  for (const incoming of pack.instincts) {
    const existing = all.find((i) => i.id === incoming.id);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, incoming.confidence);
      existing.evidence = [...existing.evidence, ...incoming.evidence].slice(-10);
      if (incoming.lastReinforced > existing.lastReinforced) {
        existing.rule = incoming.rule;
        existing.lastReinforced = incoming.lastReinforced;
      }
      merged++;
    } else {
      all.push(incoming);
      added++;
    }
  }
  saveInstincts(cfg, all);
  return { added, merged };
}

const USAGE_ROTATE_BYTES = 10 * 1024 * 1024;

function privacySafeUsageEvent(
  event: Record<string, unknown>
): Record<string, unknown> {
  const { query, ...safe } = event;
  return typeof query === "string"
    ? { ...safe, queryLength: query.length }
    : safe;
}

/** Append a usage event (tool_search/tool_call/…) for later analysis.
 *  Async (never blocks the tool-call hot path) and rotated at 10MB (one
 *  generation kept as usage.jsonl.1) so the file can't grow forever. */
export function logUsage(cfg: OpenMoatConfig, event: Record<string, unknown>): void {
  const file = path.join(cfg.stateDir, "usage.jsonl");
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      ...privacySafeUsageEvent(event),
    }) + "\n";
  void (async () => {
    try {
      await fs.promises.mkdir(cfg.stateDir, {
        recursive: true,
        mode: 0o700,
      });
      await fs.promises.chmod(cfg.stateDir, 0o700);
      const size = await fs.promises.stat(file).then((s) => s.size, () => 0);
      if (size >= USAGE_ROTATE_BYTES) {
        await fs.promises.rename(file, `${file}.1`);
        await fs.promises.chmod(`${file}.1`, 0o600);
      }
      await fs.promises.appendFile(file, line, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.promises.chmod(file, 0o600);
    } catch (e) {
      // telemetry must never break a tool call — but don't fail silently either
      console.error(`openmoat: usage log write failed: ${e}`);
    }
  })();
}
