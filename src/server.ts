import fs from "node:fs";
import path from "node:path";
import {
  CLIENT_INFO_META_KEY,
  McpServer,
  type CallToolResult,
  type McpRequestContext,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { getArchive } from "./archive.js";
import { compressText } from "./compress.js";
import type { OpenMoatConfig } from "./config.js";
import { ContextStore } from "./context-store.js";
import {
  federatedPlugins,
  federatedServers,
  federatedSkills,
  getFederationSnapshot,
  renderFederatedPlugins,
  renderFederation,
  resolveFederatedServer,
  resolveFederatedSkill,
} from "./federation.js";
import { createGatewayRuntime } from "./gateway-runtime.js";
import { getHealth } from "./health.js";
import { authorizeGateway } from "./policy.js";
import { applyToolPolicy, loadToolPolicy } from "./tool-policy.js";
import {
  hasRecentSelfReport,
  isAtFreeSelfReportCap,
  logUsage,
  reinforceInstinct,
  sanitizeObservation,
  truncateAtWord,
} from "./instincts.js";
import { catalogDirs } from "./mcp-rag.js";
import { Rag } from "./rag.js";
import { searchToolCatalog } from "./tool-catalog.js";
import { OPENMOAT_VERSION } from "./version.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const MAX_TOOL_RESULT_CHARS = 12_000;

export function boundToolResultEnvelope(
  cfg: OpenMoatConfig,
  owner: string,
  result: CallToolResult
): { result: CallToolResult; archived: string | null } {
  const serialized = JSON.stringify(result);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return { result, archived: null };
  }
  const hash = getArchive(cfg).store(owner, serialized);
  const marker = {
    hash,
    chars: serialized.length,
    fetchTool: "tool_result_fetch",
  };
  return {
    result: {
      content: [
        {
          type: "text",
          text:
            `Tool result structured envelope archived (${serialized.length.toLocaleString()} chars). ` +
            `Retrieve it with tool_result_fetch {"hash":"${hash}","offset":0}.`,
        },
      ],
      structuredContent: { openmoatArchivedResult: marker },
      _meta: { "openmoat.dev/archivedResult": marker },
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...("resultType" in result
        ? { resultType: result.resultType }
        : {}),
    },
    archived: hash,
  };
}

export interface CallerContext {
  label: string;
  source: "trusted-launcher" | "request-client-info" | "unknown";
  assurance: "local-launcher-asserted" | "transport-self-asserted" | "none";
  protocolEra: "legacy" | "modern";
  clientInfo?: { name: string; version?: string };
}

function requestClientInfo(
  ctx: ServerContext
): { name: string; version?: string } | undefined {
  const envelope = ctx.mcpReq.envelope as
    | Record<string, unknown>
    | undefined;
  const value = envelope?.[CLIENT_INFO_META_KEY];
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    return undefined;
  }
  return {
    name: candidate.name,
    ...(typeof candidate.version === "string"
      ? { version: candidate.version }
      : {}),
  };
}

export function resolveCallerContext(
  server: McpServer,
  factoryContext: McpRequestContext,
  ctx: ServerContext,
  launcherCaller?: string
): CallerContext {
  if (launcherCaller?.trim()) {
    return {
      label: launcherCaller,
      source: "trusted-launcher",
      assurance: "local-launcher-asserted",
      protocolEra: factoryContext.era,
    };
  }
  const clientInfo =
    factoryContext.era === "modern"
      ? requestClientInfo(ctx)
      : server.server.getClientVersion();
  if (clientInfo?.name) {
    return {
      label: clientInfo.name,
      source: "request-client-info",
      assurance: "transport-self-asserted",
      protocolEra: factoryContext.era,
      clientInfo,
    };
  }
  return {
    label: "unknown",
    source: "unknown",
    assurance: "none",
    protocolEra: factoryContext.era,
  };
}

/** Tail the raw usage log (falls back into the rotated generation if the live
 *  file is short). One line per event: ts, agent, tool, and the call target. */
export function recentUsageEvents(
  cfg: OpenMoatConfig,
  n: number,
  caller?: string
): string {
  const file = path.join(cfg.stateDir, "usage.jsonl");
  let lines: string[] = [];
  for (const f of [`${file}.1`, file]) {
    if (fs.existsSync(f)) lines.push(...fs.readFileSync(f, "utf8").split("\n").filter(Boolean));
  }
  const events = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const visible = events
    .filter((event) => caller === undefined || event.agent === caller)
    .slice(-n);
  if (!visible.length) return "(no usage events yet)";
  return visible
    .map((event) => {
      const what =
        event.tool === "tool_call" || event.tool === "tool_describe"
          ? `${event.server} › ${event.target ?? "*"}`
          : "search";
      const err = event.isError ? " ERROR" : "";
      return `${event.ts} [${event.agent ?? "?"}] ${event.tool}: ${what}${
        event.ms != null ? ` (${event.ms}ms)` : ""
      }${err}`;
    })
    .join("\n");
}

interface BootstrapContextReader {
  latest(
    caller: string,
    limit: number
  ): { relativePath: string; content: string }[];
}

export function bootstrapPersonalSections(
  cfg: Pick<OpenMoatConfig, "features" | "profileFiles">,
  contextStore: BootstrapContextReader,
  caller: string
): string[] {
  const parts: string[] = [];
  if (cfg.features.profile) {
    for (const file of cfg.profileFiles) {
      if (!fs.existsSync(file)) continue;
      parts.push(
        `## ${path.basename(file)}\n${fs.readFileSync(file, "utf8").slice(0, 4000)}`
      );
    }
  }
  if (cfg.features.handoffs) {
    const latest = contextStore.latest(caller, 1)[0];
    if (latest) {
      parts.push(
        `## Latest caller-scoped context (${latest.relativePath})\n${latest.content.slice(0, 4000)}`
      );
    }
  }
  return parts;
}

function buildServer(
  cfg: OpenMoatConfig,
  factoryContext: McpRequestContext,
  gatewayRuntime: ReturnType<typeof createGatewayRuntime>,
  contextStore: ContextStore,
  getRag: () => Rag,
  launcherCaller?: string
): McpServer {
  const server = new McpServer({ name: "openmoat", version: OPENMOAT_VERSION });
  const agentName = (ctx: ServerContext) =>
    resolveCallerContext(
      server,
      factoryContext,
      ctx,
      launcherCaller
    ).label;

  server.registerTool(
    "moat_bootstrap",
    {
      description:
        "Call at session start. Returns the enabled shared context modules and a summary of the configured MCP registry.",
      inputSchema: {},
    },
    async (_args, ctx) => {
      const servers = federatedServers(cfg)
        .map((asset) => asset.value)
        .filter((server) => !server.disabled);
      const optional = [
        cfg.features.rag ? "document search" : "",
        cfg.features.profile ? "shared profile" : "",
        cfg.features.handoffs ? "caller-scoped handoffs" : "",
        cfg.features.skills ? "skills" : "",
        cfg.features.plugins ? "plugins" : "",
        cfg.features.instincts ? "instincts" : "",
      ].filter(Boolean);
      const parts: string[] = [
        `## OpenMoat session
${servers.length} configured MCP server(s) are available through tool_search → tool_describe → tool_call. Servers start lazily and remain isolated by working directory. Use moat_health for failures or latency; quarantined servers require the human-only \`moat trust\` command. Optional modules enabled: ${optional.join(", ") || "none"}.`,
        ...bootstrapPersonalSections(cfg, contextStore, agentName(ctx)),
      ];
      if (cfg.features.skills) {
        const skills = federatedSkills(cfg);
        parts.push(
          `## Skills (${skills.length} selected, pull-only)\nNot preloaded. When a task matches one, call skills_list to see them, then skill_read to load it. Qualified source/name ids remain available when catalogs overlap.`
        );
      }
      parts.push(`## MCP registry\n${servers.map((s) => `- ${s.name}${s.notes ? ` — ${s.notes}` : ""}`).join("\n")}`);
      return text(parts.join("\n\n"));
    }
  );

  if (cfg.features.rag) {
    server.registerTool(
      "rag_search",
      {
        description:
          "Semantic + full-text search over configured workspace documents, caller-scoped handoffs, profiles, skills, and guides.",
        inputSchema: {
          query: z.string(),
          k: z.number().int().min(1).max(20).optional(),
        },
      },
      async ({ query, k }, ctx) => {
        const activeRag = getRag();
        await activeRag.index();
        const hits = (await activeRag.search(query, (k ?? 6) * 3))
          .filter(
            (hit) =>
              !path
                .resolve(hit.file)
                .startsWith(`${path.resolve(cfg.contextDir)}${path.sep}`) ||
              contextStore.owns(agentName(ctx), hit.file)
          )
          .slice(0, k ?? 6);
        logUsage(cfg, {
          tool: "rag_search",
          agent: agentName(ctx),
          query,
          topScore: hits[0]?.score ?? 0,
        });
        if (!hits.length) return text("No matches.");
        return text(
          hits
            .map(
              (hit) =>
                `[${hit.score}] ${hit.file} › ${hit.heading}\n${hit.snippet}`
            )
            .join("\n\n---\n\n")
        );
      }
    );
  }

  server.registerTool(
    "tool_search",
    {
      description:
        "Find the right MCP tool across all authorized servers by describing what you need. Searches the human-refreshed tool catalog; use the human-only `moat mcp refresh` command if it is stale.",
      inputSchema: { query: z.string(), k: z.number().int().min(1).max(15).optional() },
    },
    async ({ query, k }, ctx) => {
      const { toolsDir } = catalogDirs(cfg);
      // Core discovery is deterministic lexical ranking over a human-refreshed
      // catalog. It never loads embeddings, contacts a model, or turns on RAG.
      const want = k ?? 5;
      let hits = searchToolCatalog(toolsDir, query, 50);
      // Search is discovery, but discovery still observes the same caller,
      // trust, and zone boundaries as describe/call. Otherwise a denied server
      // can poison or disclose its catalog metadata before a call is refused.
      hits = hits.filter((hit) => {
        const [serverName = "", toolName = "*"] = hit.heading
          .split("›", 2)
          .map((value) => value.trim());
        const asset = resolveFederatedServer(cfg, serverName);
        if (!asset || asset.value.disabled || asset.value.trusted === false) {
          return false;
        }
        return authorizeGateway(
          cfg,
          agentName(ctx),
          serverName,
          toolName,
          asset.value.zone ?? "default"
        ).allowed;
      });
      hits = hits.slice(0, want);
      // demote results from servers whose breaker is open
      const flaky = getHealth(cfg).openServers();
      if (flaky.size) {
        const isFlaky = (h: { heading: string }) => flaky.has(h.heading.split("›")[0]?.trim() ?? "");
        hits = [...hits.filter((h) => !isFlaky(h)), ...hits.filter(isFlaky)];
      }
      logUsage(cfg, { tool: "tool_search", agent: agentName(ctx), query, topScore: hits[0]?.score ?? 0 });
      if (!hits.length) return text("No tool matches. Ask a human to run `moat mcp refresh` if the catalog is stale.");
      // Collision handling: duplicate tool names (fetch, search, click, query,
      // list_issues…) score near-identically under FTS, so without this the
      // agent picks arbitrarily. Demotes registry-dispreferred duplicates and
      // annotates same-name-different-domain pairs. Never drops a hit.
      const annotated = applyToolPolicy(hits, loadToolPolicy(cfg.registry));
      return text(
        annotated
          .map(({ hit: h, note }) => {
            const warn = flaky.has(h.heading.split("›")[0]?.trim() ?? "") ? " [server cooling down — see moat_health]" : "";
            return `[${h.score}]${warn}${note} ${h.heading}\n${h.snippet.slice(0, 300)}`;
          })
          .join("\n\n")
      );
    }
  );

  server.registerTool(
    "tool_describe",
    {
      description:
        "Get full input schemas for a registry server's tools (all, or one by name). Use after tool_search, before tool_call.",
      inputSchema: { server: z.string(), tool: z.string().optional() },
    },
    async ({ server: srv, tool }, ctx) => {
      const agent = agentName(ctx);
      try {
        const result = await gatewayRuntime.describe(srv, tool, agent);
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
        "Call any authorized tool in the configured registry. The server starts on demand and does not need a duplicate client-side configuration. Pass `cwd` when server behavior depends on the working directory.",
      inputSchema: {
        server: z.string(),
        tool: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        cwd: z.string().optional(),
      },
    },
    async ({ server: srv, tool, arguments: args, cwd }, ctx) => {
      const t0 = Date.now();
      const agent = agentName(ctx);
      let r;
      try {
        r = await gatewayRuntime.call(
          srv,
          tool,
          (args ?? {}) as Record<string, unknown>,
          cwd,
          agent
        );
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
      const content: CallToolResult["content"] = r.content.map((block) => {
        if (block.type !== "text") return block;
        const { text: compressed, saved } = compressText(block.text);
        savedChars += saved;
        let text = compressed;
        if (text.length > 12000) {
          const hash = getArchive(cfg).store(agent, text);
          archived = hash;
          text =
            text.slice(0, 4000) +
            `\n\n[truncated: showing 4,000 of ${text.length.toLocaleString()} chars. Full result archived — call tool_result_fetch {"hash":"${hash}","offset":4000} to continue reading.]`;
        }
        return { ...block, text };
      });
      const bounded = boundToolResultEnvelope(cfg, agent, { ...r, content });
      if (bounded.archived) archived = bounded.archived;
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
      return bounded.result;
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
    async ({ hash, offset, limit, find }, ctx) => {
      const arch = getArchive(cfg);
      const owner = agentName(ctx);
      if (find) {
        const matches = arch.find(owner, hash, find);
        if (!matches) return text(`No archived result for hash '${hash}' (archives are pruned after 14 days).`);
        if (!matches.length) return text(`No lines matching "${find}" in archived result '${hash}'.`);
        return text(
          matches
            .map((m) => `@${m.offset}: ${m.line}`)
            .join("\n") + `\n\n[read around a match: tool_result_fetch {"hash":"${hash}","offset":<@offset>,"limit":2000}]`
        );
      }
      const hit = arch.fetch(owner, hash, offset ?? 0, limit ?? 8000);
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
    async () => text(JSON.stringify(gatewayRuntime.health()))
  );

  server.registerTool(
    "moat_usage",
    {
      description:
        "Caller-scoped tool-call tracker with volume, error rate, latency, and recency. `hours` bounds the window and `recent` appends privacy-safe events for the current caller.",
      inputSchema: {
        server: z.string().optional(),
        hours: z.number().int().min(1).max(24 * 30).optional(),
        recent: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ server: srv, hours, recent }, ctx) => {
      const caller = agentName(ctx);
      const report = getHealth(cfg).usageReport({
        agent: caller,
        server: srv,
        sinceMs: (hours ?? 24) * 3600_000,
      });
      const parts = [report];
      if (recent) {
        parts.push(
          `RECENT EVENTS (last ${recent}):\n${recentUsageEvents(
            cfg,
            recent,
            caller
          )}`
        );
      }
      return text(parts.join("\n\n"));
    }
  );

  if (cfg.features.instincts) {
    server.registerTool(
      "instinct_report",
    {
      description:
        "Self-evaluation: report a gateway miss you noticed — e.g. you did something the hard way and later realized a gateway tool existed, or a task category that should trigger tool_search but didn't. Creates/reinforces a learned instinct; instincts above 0.5 confidence are auto-published into every agent's instructions on next sync.",
      inputSchema: { observation: z.string(), server: z.string().optional() },
    },
    async ({ observation, server: srv }, ctx) => {
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
      const reporter = agentName(ctx);
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
  }

  server.registerTool(
    "mcp_discover",
    {
      description:
        "Search the configured public MCP catalog for a capability OpenMoat does not have yet. Adoption is human-only, begins quarantined, and requires `moat trust`.",
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
          .join("\n\n") + `\n\nTo adopt one, ask the human to run: moat discover --add "<name>"`
      );
    }
  );

  if (cfg.features.handoffs) {
    server.registerTool(
      "context_save",
    {
      description:
        "Preserve bounded context for the next session launched with the same caller identity. Notes are isolated by caller and labeled as untrusted agent-authored data.",
      inputSchema: { title: z.string(), content: z.string() },
    },
    async ({ title, content }, ctx) => {
      const saved = contextStore.save(agentName(ctx), title, content);
      if (cfg.features.rag) await getRag().index();
      return text(
        `saved caller-scoped context ${saved.relativePath} (indexed for rag_search)`
      );
    }
    );

    server.registerTool(
      "context_latest",
    {
      description:
        "Read the most recent context notes written by this same caller identity (default 3).",
      inputSchema: { n: z.number().int().min(1).max(10).optional() },
    },
    async ({ n }, ctx) => {
      const notes = contextStore.latest(agentName(ctx), n ?? 3);
      if (!notes.length) return text("No caller-scoped context notes yet.");
      return text(
        notes
          .map(
            (note) =>
              `## ${note.relativePath}\n${note.content.slice(0, 5000)}`
          )
          .join("\n\n")
      );
    }
    );
  }

  server.registerTool(
    "federation_status",
    {
      description:
        "Show capability federation sources, selected skill/MCP/plugin counts, conflicts, and missing-source warnings.",
      inputSchema: {},
    },
    async () => text(renderFederation(getFederationSnapshot(cfg, true)))
  );

  if (cfg.features.skills) {
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
  }

  if (cfg.features.plugins) {
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
  }

  if (cfg.features.profile) {
    server.registerTool(
      "profile_read",
    { description: "Read one of the shared profile files (IDENTITY, SOUL, USER, TOOLS, AGENTS).", inputSchema: { file: z.string() } },
    async ({ file }) => {
      const match = cfg.profileFiles.find((p) => path.basename(p).toLowerCase().startsWith(file.toLowerCase()));
      if (!match || !fs.existsSync(match)) return text(`Not found. Available: ${cfg.profileFiles.map((p) => path.basename(p)).join(", ")}`);
      return text(fs.readFileSync(match, "utf8"));
    }
    );
  }

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

  return server;
}

export async function serve(cfg: OpenMoatConfig): Promise<void> {
  let rag: Rag | undefined;
  const getRag = () => (rag ??= new Rag(cfg));
  const gatewayRuntime = createGatewayRuntime(cfg);
  const contextStore = new ContextStore(cfg.contextDir);
  const launcherCaller = process.env.OPENMOAT_CALLER;

  serveStdio(
    (factoryContext) =>
      buildServer(
        cfg,
        factoryContext,
        gatewayRuntime,
        contextStore,
        getRag,
        launcherCaller
      ),
    {
      legacy: "serve",
      onerror: (error) =>
        console.error(`openmoat: MCP stdio error: ${error.message}`),
    }
  );
  console.error("openmoat MCP server running (stdio, dual-era)");

  // Pre-warm hot servers so the first real tool_call is warm (not paying
  // npx/uvx cold-start). Fire-and-forget; opt-in via cfg.prewarm.
  if (cfg.prewarm?.length) gatewayRuntime.prewarm(cfg.prewarm);

  // Shutdown must reap pooled gateway children (npx wrappers orphan their
  // real server processes) and then exit. Triggered by: MCP transport close,
  // stdin EOF, signals, or the orphan watchdog (parent died -> ppid becomes 1).
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reaped = gatewayRuntime.close();
    console.error(`openmoat: shutdown, reaped ${reaped.map((r) => `${r.server}:[${r.pids.join(",")}]`).join(" ") || "nothing"}`);
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  setInterval(() => {
    if (process.ppid === 1) shutdown(); // reparented to launchd = harness is gone
  }, 5000).unref();
}
