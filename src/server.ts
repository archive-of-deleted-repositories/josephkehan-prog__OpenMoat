import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { getArchive } from "./archive.js";
import { writeFileSafe } from "./backup.js";
import { compressText } from "./compress.js";
import type { HubConfig } from "./config.js";
import {
  federatedPlugins,
  federatedServers,
  federatedSkills,
  getFederationSnapshot,
  invalidateFederationCache,
  renderFederatedPlugins,
  renderFederation,
  resolveFederatedServer,
  resolveFederatedSkill,
} from "./federation.js";
import { gatewayCall, gatewayDescribe, prewarm, reapAll } from "./gateway.js";
import { getHealth } from "./health.js";
import { applyToolPolicy, loadToolPolicy } from "./tool-policy.js";
import {
  hasRecentSelfReport,
  isAtFreeSelfReportCap,
  logUsage,
  reinforceInstinct,
  sanitizeObservation,
  truncateAtWord,
} from "./instincts.js";
import { catalogDirs, refreshMcpCatalog } from "./mcp-rag.js";
import { Rag } from "./rag.js";
import { runSync } from "./sync.js";
import { HUB_VERSION } from "./version.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Tail the raw usage log (falls back into the rotated generation if the live
 *  file is short). One line per event: ts, agent, tool, and the call target. */
export function recentUsageEvents(cfg: HubConfig, n: number): string {
  const file = path.join(cfg.stateDir, "usage.jsonl");
  let lines: string[] = [];
  for (const f of [`${file}.1`, file]) {
    if (fs.existsSync(f)) lines.push(...fs.readFileSync(f, "utf8").split("\n").filter(Boolean));
  }
  lines = lines.slice(-n);
  if (!lines.length) return "(no usage events yet)";
  return lines
    .map((l) => {
      try {
        const e = JSON.parse(l) as Record<string, unknown>;
        const what = e.tool === "tool_call" || e.tool === "tool_describe" ? `${e.server} › ${e.target ?? "*"}` : `"${e.query ?? ""}"`;
        const err = e.isError ? " ERROR" : "";
        return `${e.ts} [${e.agent ?? "?"}] ${e.tool}: ${what}${e.ms != null ? ` (${e.ms}ms)` : ""}${err}`;
      } catch {
        return l.slice(0, 160);
      }
    })
    .join("\n");
}

function latestContextFiles(contextDir: string, n: number): string[] {
  if (!fs.existsSync(contextDir)) return [];
  return fs
    .readdirSync(contextDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = path.join(contextDir, f);
      return { file, mtime: fs.statSync(file).mtimeMs }; // stat once, not per comparison
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n)
    .map((e) => e.file);
}

export async function serve(cfg: HubConfig): Promise<void> {
  const server = new McpServer({ name: "openmoat", version: HUB_VERSION });
  const rag = new Rag(cfg);

  // Who is calling: OPENMOAT_CALLER override, else the MCP clientInfo sent by the
  // harness during initialize. Lazy — clientInfo only exists after the
  // handshake, and tool handlers always run after it.
  const agentName = () => process.env.OPENMOAT_CALLER ?? server.server.getClientVersion()?.name ?? "unknown";

  server.registerTool(
    "hub_bootstrap",
    {
      description:
        "Call at session start. Returns the shared profile/identity, the latest context handoff, the skills index, and the MCP registry summary. For long-term memory use the squish tools (squish_recall / squish_remember); for searching workspace documents use rag_search.",
      inputSchema: {},
    },
    async () => {
      const servers = federatedServers(cfg)
        .map((asset) => asset.value)
        .filter((server) => !server.disabled);
      const parts: string[] = [
        `## You are on a hub-managed machine
Every agent here shares one brain: openmoat (${path.dirname(cfg.registry).replace(/\/registry$/, "")}). ${servers.length} MCP servers sit behind this hub — reach ANY capability via tool_search → tool_describe → tool_call (never assume a tool is missing). STANDING ORDER: before reaching for generic WebSearch/WebFetch/curl, run tool_search first — the catalog usually has a specialist (exa for web research, firecrawl for scraping, context7 for library docs, github for repos). Memory: squish = project facts, rag_search = all workspace documents (full guide: rag_search "operator guide for agents"), context_save/latest = handoffs between agents. Oversized results page via tool_result_fetch; failures explain themselves via hub_health; quarantined servers need the human's \`hub trust\`.`,
      ];
      for (const f of cfg.profileFiles) {
        if (!fs.existsSync(f)) continue;
        parts.push(`## ${path.basename(f)}\n${fs.readFileSync(f, "utf8").slice(0, 4000)}`);
      }
      const latest = latestContextFiles(cfg.contextDir, 1)[0];
      if (latest) parts.push(`## Latest context handoff (${path.basename(latest)})\n${fs.readFileSync(latest, "utf8").slice(0, 4000)}`);
      const skills = federatedSkills(cfg);
      parts.push(
        `## Skills (${skills.length} selected, pull-only)\nNot preloaded. When a task matches one, call skills_list to see them, then skill_read to load it. Qualified source/name ids remain available when catalogs overlap.`
      );
      parts.push(`## MCP registry\n${servers.map((s) => `- ${s.name}${s.notes ? ` — ${s.notes}` : ""}`).join("\n")}`);
      return text(parts.join("\n\n"));
    }
  );

  server.registerTool(
    "rag_search",
    {
      description:
        "Semantic + full-text search over configured workspace documents, handoffs, profiles, skills, and guides.",
      inputSchema: { query: z.string(), k: z.number().int().min(1).max(20).optional() },
    },
    async ({ query, k }) => {
      await rag.index(); // incremental — cheap when nothing changed
      const hits = await rag.search(query, k ?? 6);
      logUsage(cfg, { tool: "rag_search", agent: agentName(), query, topScore: hits[0]?.score ?? 0 });
      if (!hits.length) return text("No matches.");
      return text(hits.map((h) => `[${h.score}] ${h.file} › ${h.heading}\n${h.snippet}`).join("\n\n---\n\n"));
    }
  );

  server.registerTool(
    "rag_reindex",
    { description: "Force a full re-index of the RAG corpus. Returns stats.", inputSchema: {} },
    async () => {
      const r = await rag.index(true);
      const s = rag.stats();
      return text(
        `reindexed ${r.indexed} files (embeddings: ${r.embedded ? "on" : "off — FTS only"}). corpus: ${s.files} files, ${s.chunks} chunks, ${s.withEmbeddings} embedded.`
      );
    }
  );

  // Cross-encoder re-rank for tool_search candidates. Qwen3-Reranker is a
  // co-resident lane on the local llama-swap (:1235), so a call never evicts
  // the warm base model. 1.5s budget — ranking must never hang tool_search.
  // Any failure returns the input order unchanged (hybrid bm25+embedding).
  async function rerankWithCrossEncoder(
    query: string,
    hits: { file: string; heading: string; snippet: string; score: number }[],
    k: number
  ): Promise<typeof hits> {
    if (!hits.length) return hits;
    const url = process.env.HUB_RERANK_URL ?? "http://127.0.0.1:1235/v1/rerank";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.HUB_RERANK_MODEL ?? "reranker",
          query,
          documents: hits.map((h) => `${h.heading} — ${h.snippet.slice(0, 300)}`),
        }),
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return hits.slice(0, k);
      const json = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
      if (!Array.isArray(json.results)) return hits.slice(0, k);
      return json.results
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, k)
        .map((r) => ({ ...hits[r.index], score: Math.round(r.relevance_score * 1000) / 1000 }));
    } catch {
      return hits.slice(0, k);
    }
  }

  server.registerTool(
    "tool_search",
    {
      description:
        "Find the right MCP tool across ALL servers in the shared registry by describing what you need (e.g. 'store a long-term memory', 'search case law'). Searches the indexed tool catalogs semantically. Run mcp_reindex first if catalogs are stale.",
      inputSchema: { query: z.string(), k: z.number().int().min(1).max(15).optional() },
    },
    async ({ query, k }) => {
      await rag.index();
      const { toolsDir } = catalogDirs(cfg);
      // Retrieve top-20 hybrid (bm25 + embedding cosine), then re-rank with the
      // local cross-encoder (Qwen3-Reranker via llama-swap /v1/rerank). Benchmark
      // 2026-07-24 on 1,456-query non-circular corpus: mrr 0.2564 -> 0.5689,
      // top1 0.1607 -> 0.4429 vs the old ftsOnly path. Falls back to hybrid
      // order on any reranker failure, and to FTS-only if embeddings are down.
      const want = k ?? 5;
      let hits = await rag.search(query, 20, { pathPrefix: toolsDir });
      hits = await rerankWithCrossEncoder(query, hits, want);
      // demote results from servers whose breaker is open
      const flaky = getHealth(cfg).openServers();
      if (flaky.size) {
        const isFlaky = (h: { heading: string }) => flaky.has(h.heading.split("›")[0]?.trim() ?? "");
        hits = [...hits.filter((h) => !isFlaky(h)), ...hits.filter(isFlaky)];
      }
      logUsage(cfg, { tool: "tool_search", agent: agentName(), query, topScore: hits[0]?.score ?? 0 });
      if (!hits.length) return text("No tool matches. Run mcp_reindex to refresh the catalogs.");
      // Collision handling: duplicate tool names (fetch, search, click, query,
      // list_issues…) score near-identically under FTS, so without this the
      // agent picks arbitrarily. Demotes registry-dispreferred duplicates and
      // annotates same-name-different-domain pairs. Never drops a hit.
      const annotated = applyToolPolicy(hits, loadToolPolicy(cfg.registry));
      return text(
        annotated
          .map(({ hit: h, note }) => {
            const warn = flaky.has(h.heading.split("›")[0]?.trim() ?? "") ? " [server cooling down — see hub_health]" : "";
            return `[${h.score}]${warn}${note} ${h.heading}\n${h.snippet.slice(0, 300)}`;
          })
          .join("\n\n")
      );
    }
  );

  server.registerTool(
    "mcp_reindex",
    {
      description:
        "Refresh the MCP-derived RAG corpus: connects to every registry server (read-only), re-catalogs their tools, ingests their resources, and re-indexes. Use when servers were added or their toolsets changed.",
      inputSchema: {},
    },
    async () => {
      const notes = await refreshMcpCatalog(cfg);
      const r = await rag.index();
      return text([...notes, `re-indexed ${r.indexed} file(s)`].join("\n"));
    }
  );

  server.registerTool(
    "tool_describe",
    {
      description:
        "Get full input schemas for a registry server's tools (all, or one by name). Use after tool_search, before tool_call.",
      inputSchema: { server: z.string(), tool: z.string().optional() },
    },
    async ({ server: srv, tool }) => {
      const agent = agentName();
      try {
        const result = await gatewayDescribe(cfg, srv, tool, agent);
        logUsage(cfg, { tool: "tool_describe", agent, server: srv, target: tool });
        return text(result);
      } catch (e) {
        logUsage(cfg, { tool: "tool_describe", agent, server: srv, target: tool, isError: true });
        throw e;
      }
    }
  );

  server.registerTool(
    "tool_call",
    {
      description:
        "Call any tool on any MCP server in the shared registry through the hub gateway — the server is spawned on demand; it does NOT need to be configured in your harness. Flow: tool_search -> tool_describe -> tool_call. Pass `cwd` for servers whose behavior depends on the working directory (e.g. per-project memory like squish). Remote OAuth servers open a browser once on first use, then work for every agent.",
      inputSchema: {
        server: z.string(),
        tool: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        cwd: z.string().optional(),
      },
    },
    async ({ server: srv, tool, arguments: args, cwd }) => {
      const t0 = Date.now();
      const agent = agentName();
      let r;
      try {
        r = await gatewayCall(cfg, srv, tool, (args ?? {}) as Record<string, unknown>, cwd, agent);
      } catch (e) {
        logUsage(cfg, {
          tool: "tool_call",
          agent,
          server: srv,
          target: tool,
          ms: Date.now() - t0,
          isError: true,
        });
        throw e;
      }
      // Compress text blocks (whitespace/dedup, lossless-ish); archive anything
      // still oversized and hand back a retrieval hash instead of destroying it.
      let savedChars = 0;
      let archived: string | null = null;
      const content = r.content.map((c) => {
        const block = c as { type?: string; text?: string };
        if (block?.type !== "text" || typeof block.text !== "string") return c;
        const { text: compressed, saved } = compressText(block.text);
        savedChars += saved;
        let text = compressed;
        if (text.length > 12000) {
          const hash = getArchive(cfg).store(text);
          archived = hash;
          text =
            text.slice(0, 4000) +
            `\n\n[truncated: showing 4,000 of ${text.length.toLocaleString()} chars. Full result archived — call tool_result_fetch {"hash":"${hash}","offset":4000} to continue reading.]`;
        }
        return { ...block, text };
      });
      logUsage(cfg, {
        tool: "tool_call",
        agent,
        server: srv,
        target: tool,
        ms: Date.now() - t0,
        isError: r.isError === true,
        savedChars,
        archived,
      });
      return { content, isError: r.isError } as { content: { type: "text"; text: string }[]; isError?: boolean };
    }
  );

  server.registerTool(
    "tool_result_fetch",
    {
      description:
        "Page through an archived oversized tool result. tool_call returns a hash when a result was too large for context; fetch the rest here in slices.",
      inputSchema: {
        hash: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(100).max(30000).optional(),
        find: z.string().optional(),
      },
    },
    async ({ hash, offset, limit, find }) => {
      const arch = getArchive(cfg);
      if (find) {
        const matches = arch.find(hash, find);
        if (!matches) return text(`No archived result for hash '${hash}' (archives are pruned after 14 days).`);
        if (!matches.length) return text(`No lines matching "${find}" in archived result '${hash}'.`);
        return text(
          matches
            .map((m) => `@${m.offset}: ${m.line}`)
            .join("\n") + `\n\n[read around a match: tool_result_fetch {"hash":"${hash}","offset":<@offset>,"limit":2000}]`
        );
      }
      const hit = arch.fetch(hash, offset ?? 0, limit ?? 8000);
      if (!hit) return text(`No archived result for hash '${hash}' (archives are pruned after 14 days).`);
      const next = (offset ?? 0) + hit.slice.length;
      return text(
        hit.slice +
          (hit.remaining > 0
            ? `\n\n[${hit.remaining.toLocaleString()} chars remain — next: tool_result_fetch {"hash":"${hash}","offset":${next}}]`
            : "\n\n[end of archived result]")
      );
    }
  );

  server.registerTool(
    "moat_health",
    {
      description:
        "Gateway health: open circuit breakers (servers cooling down, tools locked out) and per-tool call stats (volume, error rate, latency). Check when a tool_call fails or feels slow.",
      inputSchema: {},
    },
    async () => text(getHealth(cfg).report())
  );

  server.registerTool(
    "hub_usage",
    {
      description:
        "Per-agent tool-call tracker: which agent (harness) called which tool through the hub, with volume, error rate, latency, and recency. Filter by agent or server; `hours` bounds the window (default 24, by last-call time); `recent` appends the last N raw usage events.",
      inputSchema: {
        agent: z.string().optional(),
        server: z.string().optional(),
        hours: z.number().int().min(1).max(24 * 30).optional(),
        recent: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ agent, server: srv, hours, recent }) => {
      const report = getHealth(cfg).usageReport({
        agent,
        server: srv,
        sinceMs: (hours ?? 24) * 3600_000,
      });
      const parts = [report];
      if (recent) parts.push(`RECENT EVENTS (last ${recent}):\n${recentUsageEvents(cfg, recent)}`);
      return text(parts.join("\n\n"));
    }
  );

  server.registerTool(
    "instinct_report",
    {
      description:
        "Self-evaluation: report a gateway miss you noticed — e.g. you did something the hard way and later realized a gateway tool existed, or a task category that should trigger tool_search but didn't. Creates/reinforces a learned instinct; instincts above 0.5 confidence are auto-published into every agent's instructions on next sync.",
      inputSchema: { observation: z.string(), server: z.string().optional() },
    },
    async ({ observation, server: srv }) => {
      // Same templated shape as evaluate.ts rules: agent prose becomes quoted
      // DATA inside a fixed template, never free-form text that publishes
      // verbatim into AGENTS.md.
      const hint = sanitizeObservation(observation);
      if (!hint) return text("instinct rejected: observation was empty after sanitization.");
      const resolvedServer = srv ? resolveFederatedServer(cfg, srv) : undefined;
      const canonicalServer =
        resolvedServer && !resolvedServer.value.disabled ? srv : undefined;
      if (srv && !canonicalServer) {
        return text(`instinct rejected: server '${srv}' is not an enabled canonical registry server.`);
      }
      const id = canonicalServer
        ? `gateway-miss:${canonicalServer}`
        : `self-report:${hint.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
      if (isAtFreeSelfReportCap(cfg, id)) {
        return text("instinct rejected: too many unattributed self-reports already recorded — pass `server` to attribute the miss to a registry server (one instinct per server).");
      }
      const reporter = agentName();
      if (hasRecentSelfReport(cfg, id, reporter)) {
        return text(`instinct rejected: '${reporter}' already supplied recent evidence for '${id}'; independent evidence is required.`);
      }
      const rule = canonicalServer
        ? `Tasks like "${truncateAtWord(hint, 110)}" → use the ${canonicalServer} server via tool_search/tool_call (agent self-report)`
        : `Tasks like "${truncateAtWord(hint, 110)}" → run tool_search before generic tools (agent self-report)`;
      const inst = reinforceInstinct(cfg, {
        id,
        category: canonicalServer ?? "general",
        rule,
        evidence: {
          ts: new Date().toISOString(),
          source: "self-report",
          snippet: truncateAtWord(hint, 120),
          agent: reporter,
        },
      });
      return text(`instinct recorded: "${inst.rule}" — confidence ${inst.confidence.toFixed(2)}${inst.confidence >= 0.5 ? " (will publish on next sync)" : ""}`);
    }
  );

  server.registerTool(
    "mcp_discover",
    {
      description:
        "Search the awesome-mcp-servers aggregator (~2,800 MCP servers) for a capability the hub doesn't have yet. Returns candidates with repo + run command. To actually use one, tell the human — adoption adds it QUARANTINED and requires `hub trust`.",
      inputSchema: { query: z.string(), k: z.number().int().min(1).max(15).optional(), runnableOnly: z.boolean().optional() },
    },
    async ({ query, k, runnableOnly }) => {
      const { discover } = await import("./discover.js");
      const hits = await discover(cfg, query, { k: k ?? 8, runnableOnly });
      if (!hits.length) return text(`No aggregator matches for "${query}".`);
      return text(
        hits
          .map(
            (h) =>
              `[${h.score}] ${h.name} — ${h.repo}\n  ${h.description}${h.command ? `\n  run: ${h.command}` : "\n  (no run command listed — see repo)"}`
          )
          .join("\n\n") + `\n\nTo adopt one, ask the human to run: hub discover --add "<name>"`
      );
    }
  );

  server.registerTool(
    "registry_trust",
    {
      description:
        "Approve a QUARANTINED registry server (newly adopted servers can't be called through the gateway until a human approves them — tool-poisoning defense). Gated: unless the hub is configured with autoApproveTrust, this tool refuses and the human must run `hub trust <name>` themselves.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      if (!cfg.autoApproveTrust) {
        return text(
          `refused: agents cannot approve quarantined servers (autoApproveTrust is off). Ask the human to run \`hub trust ${name}\` in a terminal — approval must come from outside the agent loop.`
        );
      }
      const { trust } = await import("./adopt.js");
      return text(trust(cfg, name));
    }
  );

  server.registerTool(
    "registry_enable",
    {
      description:
        "Permanently enable a disabled registry server and sync it into every harness config (use when a tool should be natively available rather than gateway-proxied). Requires harness restart to take effect.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const federated = resolveFederatedServer(cfg, name);
      if (federated && federated.source !== "local") {
        return text(
          `'${name}' comes from read-only federation source '${federated.source}'. Enable or trust it in that source, or copy it into the local registry first.`
        );
      }
      const localName = federated?.name ?? name;
      const raw = JSON.parse(fs.readFileSync(cfg.registry, "utf8")) as {
        servers: { name: string; disabled?: boolean; gatewayOnly?: boolean; trusted?: boolean }[];
      };
      const entry = raw.servers.find((s) => s.name === localName);
      if (!entry) return text(`'${name}' not in local registry.`);
      if (entry.trusted === false) {
        return text(`'${name}' is QUARANTINED — a human must approve it first (\`hub trust ${name}\`).`);
      }
      entry.disabled = false;
      writeFileSafe(cfg.registry, JSON.stringify(raw, null, 2) + "\n", cfg.stateDir, false);
      invalidateFederationCache(cfg);
      if (entry.gatewayOnly) {
        // serversFor() never syncs gatewayOnly servers into harness configs —
        // don't claim otherwise.
        return text(
          `enabled '${name}' for gateway routing (tool_search → tool_call). It is marked gatewayOnly, so it was NOT written into any harness config; set "gatewayOnly": false in the registry and run hub sync to make it native.`
        );
      }
      const report = runSync(cfg, {});
      return text([`enabled '${name}' and synced:`, ...report.lines].join("\n"));
    }
  );

  server.registerTool(
    "context_save",
    {
      description:
        "Preserve context for the next agent/session: write a dated handoff note to the shared memory folder. Use at the end of significant work (what was done, decisions, open items).",
      inputSchema: { title: z.string(), content: z.string() },
    },
    async ({ title, content }) => {
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      fs.mkdirSync(cfg.contextDir, { recursive: true });
      let file = path.join(cfg.contextDir, `${stamp}-${slug}.md`);
      // Never overwrite an existing handoff (same title, same second).
      for (let i = 2; fs.existsSync(file); i++) file = path.join(cfg.contextDir, `${stamp}-${slug}-${i}.md`);
      fs.writeFileSync(file, `# ${title}\n\n_Saved by openmoat · ${d.toISOString()}_\n\n${content}\n`, "utf8");
      await rag.index(); // make it searchable immediately
      return text(`saved ${file} (indexed for rag_search)`);
    }
  );

  server.registerTool(
    "context_latest",
    {
      description: "Read the most recent context handoff notes (default 3).",
      inputSchema: { n: z.number().int().min(1).max(10).optional() },
    },
    async ({ n }) => {
      const files = latestContextFiles(cfg.contextDir, n ?? 3);
      if (!files.length) return text("No context notes yet.");
      return text(files.map((f) => `## ${path.basename(f)}\n${fs.readFileSync(f, "utf8").slice(0, 5000)}`).join("\n\n"));
    }
  );

  server.registerTool(
    "federation_status",
    {
      description:
        "Show capability federation sources, selected skill/MCP/plugin counts, conflicts, and missing-source warnings.",
      inputSchema: {},
    },
    async () => text(renderFederation(getFederationSnapshot(cfg, true)))
  );

  server.registerTool(
    "skills_list",
    {
      description:
        "List selected shared skills with federated source ids. Use source/name to address a shadowed skill explicitly.",
      inputSchema: {},
    },
    async () => {
      const snapshot = getFederationSnapshot(cfg);
      return text(
        snapshot.skills
          .map(
            (asset) =>
              `${asset.selected ? "*" : "-"} ${asset.id}: ${asset.value.description}${asset.selected ? "" : " (shadowed)"}`
          )
          .join("\n") || "No skills found."
      );
    }
  );

  server.registerTool(
    "skill_read",
    {
      description:
        "Read a skill's full SKILL.md by selected name or qualified source/name id.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const skill = resolveFederatedSkill(cfg, name);
      if (!skill) return text(`Skill '${name}' not found. Use skills_list.`);
      return text(fs.readFileSync(skill.value.skillMd, "utf8"));
    }
  );

  server.registerTool(
    "plugins_list",
    {
      description:
        "List selected plugins across federated stores/catalogs, including source, ecosystem, version, scope, and components.",
      inputSchema: {},
    },
    async () => {
      return text(renderFederatedPlugins(federatedPlugins(cfg)));
    }
  );

  server.registerTool(
    "profile_read",
    { description: "Read one of the shared profile files (IDENTITY, SOUL, USER, TOOLS, AGENTS).", inputSchema: { file: z.string() } },
    async ({ file }) => {
      const match = cfg.profileFiles.find((p) => path.basename(p).toLowerCase().startsWith(file.toLowerCase()));
      if (!match || !fs.existsSync(match)) return text(`Not found. Available: ${cfg.profileFiles.map((p) => path.basename(p)).join(", ")}`);
      return text(fs.readFileSync(match, "utf8"));
    }
  );

  server.registerTool(
    "registry_list",
    {
      description:
        "List MCP servers across the federated catalogs. '*' marks the unqualified winner; source/name addresses a shadowed server.",
      inputSchema: {},
    },
    async () => {
      const servers = getFederationSnapshot(cfg).servers;
      return text(
        servers
          .map(
            (asset) =>
              `${asset.selected ? "*" : "-"} ${asset.value.disabled ? "[off] " : ""}${asset.id} (${asset.value.transport ?? "stdio"})${asset.value.notes ? ` — ${asset.value.notes}` : ""}`
          )
          .join("\n")
      );
    }
  );

  await server.connect(new StdioServerTransport());
  console.error("openmoat MCP server running (stdio)");

  // Pre-warm hot servers so the first real tool_call is warm (not paying
  // npx/uvx cold-start). Fire-and-forget; opt-in via cfg.prewarm.
  if (cfg.prewarm?.length) prewarm(cfg, cfg.prewarm);

  // Shutdown must reap pooled gateway children (npx wrappers orphan their
  // real server processes) and then exit. Triggered by: MCP transport close,
  // stdin EOF, signals, or the orphan watchdog (parent died -> ppid becomes 1).
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reaped = reapAll();
    console.error(`openmoat: shutdown, reaped ${reaped.map((r) => `${r.server}:[${r.pids.join(",")}]`).join(" ") || "nothing"}`);
    process.exit(0);
  };
  server.server.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  setInterval(() => {
    if (process.ppid === 1) shutdown(); // reparented to launchd = harness is gone
  }, 5000).unref();
}
