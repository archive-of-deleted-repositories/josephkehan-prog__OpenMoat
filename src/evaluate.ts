import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Archive } from "./archive.js";
import type { OpenMoatConfig } from "./config.js";
import { decayAndPrune, reinforceInstinct, sanitizeObservation, truncateAtWord } from "./instincts.js";
import { catalogDirs } from "./mcp-rag.js";
import { Rag } from "./rag.js";

/**
 * Self-evaluation: scan recent harness transcripts for gateway MISSES —
 * moments where an agent said "I don't have that tool" or fell back to
 * generic web/bash while the catalog had a specialist. Confirmed misses
 * reinforce instincts (ECC-style); stale instincts decay; promoted instincts
 * are rendered into AGENTS.md by `moat sync`.
 *
 * v1 scans Claude Code transcripts (~/.claude/projects/**.jsonl).
 */

const MISS_PHRASE =
  /(don'?t|do not|doesn'?t) have (access to |a |the )?[^.\n]{0,50}(tool|mcp|server)|not (wired|configured|available|set ?up)[^.\n]{0,30}(session|here)|no (dedicated|native) [^.\n]{0,40}(tool|integration)/i;

interface Miss {
  session: string;
  when: string;
  kind: "said-unavailable" | "generic-fallback";
  request: string;
  evidence: string;
  suggestion?: { server: string; heading: string; score: number };
}

interface TranscriptEvent {
  role: "user" | "assistant";
  text?: string;
  toolName?: string;
  toolInput?: string;
  ts?: string;
}

function* transcriptFiles(days: number): Generator<string> {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) return;
  const cutoff = Date.now() - days * 86400_000;
  for (const proj of fs.readdirSync(root)) {
    const dir = path.join(root, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs >= cutoff) yield p;
    }
  }
}

function parseSession(file: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let obj: { type?: string; timestamp?: string; message?: { content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const content = obj.message?.content;
    if (typeof content === "string") {
      events.push({ role: obj.type, text: content, ts: obj.timestamp });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const c of content as { type: string; text?: string; name?: string; input?: unknown }[]) {
      if (c.type === "text" && c.text) events.push({ role: obj.type, text: c.text, ts: obj.timestamp });
      if (c.type === "tool_use" && obj.type === "assistant")
        events.push({ role: "assistant", toolName: c.name, toolInput: JSON.stringify(c.input ?? {}).slice(0, 300), ts: obj.timestamp });
    }
  }
  return events;
}

export async function evaluate(
  cfg: OpenMoatConfig,
  opts: { days?: number; tune?: boolean } = {}
): Promise<{ report: string; misses: Miss[]; reinforced: string[]; pruned: string[] }> {
  const days = opts.days ?? 3;
  const tune = opts.tune ?? true;
  const rag = new Rag(cfg);
  await rag.index();
  const { toolsDir } = catalogDirs(cfg);
  const misses: Miss[] = [];
  let sessions = 0;
  let sessionsUsingHub = 0;

  for (const file of transcriptFiles(days)) {
    const events = parseSession(file);
    if (!events.length) continue;
    sessions++;
    const hubUsed = events.some((e) => e.toolName?.startsWith("mcp__openmoat"));
    if (hubUsed) sessionsUsingHub++;
    let lastUser = "";
    for (const e of events) {
      if (e.role === "user" && e.text) {
        lastUser = e.text.slice(0, 200);
        continue;
      }
      let miss: Miss | null = null;
      if (e.role === "assistant" && e.text && MISS_PHRASE.test(e.text)) {
        miss = {
          session: path.basename(file, ".jsonl"),
          when: e.ts ?? "",
          kind: "said-unavailable",
          request: lastUser,
          evidence: (e.text.match(MISS_PHRASE)?.[0] ?? "").slice(0, 160),
        };
      } else if (
        !hubUsed &&
        e.toolName &&
        (e.toolName === "WebSearch" ||
          e.toolName === "WebFetch" ||
          (e.toolName === "Bash" &&
            /(curl|wget) [^\n]*https?:\/\//.test(e.toolInput ?? "") &&
            !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(e.toolInput ?? "")))
      ) {
        miss = {
          session: path.basename(file, ".jsonl"),
          when: e.ts ?? "",
          kind: "generic-fallback",
          request: lastUser,
          evidence: `${e.toolName}: ${e.toolInput?.slice(0, 100) ?? ""}`,
        };
      }
      if (!miss || !miss.request) continue;
      // Skip system-injected skill scaffolding "requests" — not user intent.
      if (/^Base directory for this skill|^<system|^Caveat:/.test(miss.request)) continue;
      // Cross-check: did the catalog actually have a specialist for this?
      const hits = (await rag.search(`${miss.request} ${miss.evidence}`, 30, { pathPrefix: toolsDir })).filter(
        (h) => h.heading.includes("›") // specific tools only, not file headers
      );
      const top = hits[0];
      const threshold = miss.kind === "said-unavailable" || miss.evidence.startsWith("WebSearch") || miss.evidence.startsWith("WebFetch") ? 0.7 : 0.78;
      if (top && top.score >= threshold) {
        const [server] = top.heading.split(" › ");
        miss.suggestion = { server: server?.trim() ?? "?", heading: top.heading, score: top.score };
        misses.push(miss);
      }
    }
  }
  rag.close();

  // Deduplicate per session+server (one reinforcement per pattern per session)
  const seen = new Set<string>();
  const confirmed = misses.filter((m) => {
    const k = `${m.session}:${m.suggestion?.server}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const reinforcedIds = new Set<string>();
  const reinforced: string[] = [];
  let pruned: string[] = [];
  if (tune) {
    for (const m of confirmed) {
      const s = m.suggestion!;
      const taskHint = truncateAtWord(sanitizeObservation(m.request), 70);
      const id = `gateway-miss:${s.server}`;
      reinforceInstinct(cfg, {
        id,
        category: s.server,
        rule: `Tasks like "${taskHint}" → use ${s.heading} through tool_call (was missed before)`,
        evidence: { ts: m.when || new Date().toISOString(), source: "evaluate", snippet: truncateAtWord(m.evidence, 120) },
      });
      reinforcedIds.add(id);
      reinforced.push(`${s.heading} (${m.kind})`);
    }
    pruned = decayAndPrune(cfg, reinforcedIds);
  }

  const lines = [
    `# Gateway self-evaluation — ${new Date().toISOString().slice(0, 16)}`,
    ``,
    `Scanned ${sessions} session(s) from the last ${days} day(s); ${sessionsUsingHub} used the OpenMoat.`,
    `Confirmed misses (catalog had a specialist, score >= 0.7): ${confirmed.length}`,
    ``,
    ...confirmed.map(
      (m) =>
        `- [${m.kind}] "${m.request.slice(0, 80)}" → should have used **${m.suggestion!.heading}** (${m.suggestion!.score})\n  evidence: ${m.evidence}`
    ),
    ``,
    reinforced.length ? `Reinforced instincts: ${reinforced.join("; ")}` : `No instincts reinforced.`,
    pruned.length ? `Pruned stale instincts: ${pruned.join("; ")}` : ``,
    ``,
    `Run \`moat sync\` to publish promoted instincts (confidence >= 0.5) into AGENTS.md.`,
  ];
  // housekeeping: expire old archived tool results
  try {
    const arch = new Archive(cfg);
    arch.prune(14);
    arch.close();
  } catch {
    /* archive not created yet */
  }

  // housekeeping: nightly tarball of the non-rebuildable state/ files
  try {
    const { backupState } = await import("./backup.js");
    lines.push("", `State backed up: ${backupState(cfg.stateDir)}`);
  } catch (e) {
    lines.push("", `WARN: state backup failed: ${e instanceof Error ? e.message : e}`);
  }

  // housekeeping: pull config drift back into the registry (quarantined)
  try {
    const { adopt } = await import("./adopt.js");
    const adopted = adopt(cfg, false).filter((l) => l.startsWith("adopted"));
    if (adopted.length) lines.push("", "Registry drift adopted (quarantined until `moat trust`):", ...adopted.map((l) => `- ${l}`));
  } catch {
    /* non-fatal */
  }

  const report = lines.filter((l) => l !== undefined).join("\n");
  const evalDir = path.join(cfg.stateDir, "evals");
  fs.mkdirSync(evalDir, { recursive: true });
  fs.writeFileSync(path.join(evalDir, `${new Date().toISOString().slice(0, 10)}.md`), report, "utf8");
  return { report, misses: confirmed, reinforced, pruned };
}
