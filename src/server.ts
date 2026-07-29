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
import { searchCatalog } from "./catalog.js";
import { compressText } from "./compress.js";
import type { OpenMoatConfig } from "./config.js";
import { createGatewayRuntime } from "./gateway-runtime.js";
import { getHealth } from "./health.js";
import { authorizeGateway } from "./policy.js";
import { sanitizeMetadata } from "./runtime-security.js";
import { OPENMOAT_VERSION } from "./version.js";

const MAX_INLINE_RESULT_CHARS = 12_000;
const MAX_RESULT_DEPTH = 32;
const MAX_RESULT_ENTRIES = 50_000;
const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

function validateResultStructure(value: unknown): void {
  const seen = new WeakSet<object>();
  const stack: { value: unknown; depth: number }[] = [
    { value, depth: 0 },
  ];
  let entries = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > MAX_RESULT_DEPTH) {
      throw new Error(
        `RESULT_TOO_DEEP: result nesting exceeds ${MAX_RESULT_DEPTH}`
      );
    }
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (seen.has(current.value)) {
      throw new Error("INVALID_RESULT: cyclic result");
    }
    seen.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    entries += children.length;
    if (entries > MAX_RESULT_ENTRIES) {
      throw new Error(
        `RESULT_TOO_COMPLEX: result exceeds ${MAX_RESULT_ENTRIES} entries`
      );
    }
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export function boundToolResultEnvelope(
  cfg: OpenMoatConfig,
  owner: string,
  result: CallToolResult
): { result: CallToolResult; archived: string | null } {
  validateResultStructure(result);
  const serialized = JSON.stringify(result);
  if (serialized.length <= MAX_INLINE_RESULT_CHARS) {
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
            `Tool result archived (${serialized.length.toLocaleString()} chars). ` +
            `Retrieve it with tool_result_fetch {"hash":"${hash}","offset":0}.`,
        },
      ],
      structuredContent: { openmoatArchivedResult: marker },
      _meta: { "openmoat.dev/archivedResult": marker },
      ...(result.isError === undefined
        ? {}
        : { isError: result.isError }),
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
  assurance:
    | "local-launcher-asserted"
    | "transport-self-asserted"
    | "none";
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
  if (
    typeof candidate.name !== "string" ||
    !candidate.name.trim() ||
    candidate.name.length > 128
  ) {
    return undefined;
  }
  return {
    name: candidate.name,
    ...(typeof candidate.version === "string" &&
    candidate.version.length <= 128
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
  if (launcherCaller?.trim() && launcherCaller.length <= 128) {
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
  if (clientInfo?.name && clientInfo.name.length <= 128) {
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

function buildServer(
  cfg: OpenMoatConfig,
  factoryContext: McpRequestContext,
  runtime: ReturnType<typeof createGatewayRuntime>,
  launcherCaller?: string
): McpServer {
  const server = new McpServer({
    name: "openmoat",
    version: OPENMOAT_VERSION,
  });
  const caller = (ctx: ServerContext) =>
    resolveCallerContext(
      server,
      factoryContext,
      ctx,
      launcherCaller
    ).label;

  server.registerTool(
    "tool_search",
    {
      description:
        "Search the local, human-refreshed catalog for tools this caller is authorized to use.",
      inputSchema: {
        query: z.string().min(1).max(500),
        k: z.number().int().min(1).max(15).optional(),
      },
    },
    async ({ query, k }, ctx) => {
      const who = caller(ctx);
      const hits = searchCatalog(cfg, query, 100)
        .filter((hit) => {
          const definition = cfg.inlineServers.find(
            (candidate) => candidate.name === hit.server
          );
          return (
            definition !== undefined &&
            !definition.disabled &&
            definition.trusted !== false &&
            authorizeGateway(
              cfg,
              who,
              hit.server,
              hit.tool,
              definition.zone ?? "default"
            ).allowed
          );
        })
        .slice(0, k ?? 5);
      if (!hits.length) {
        return text(
          "No authorized tool matches. A human can refresh derived metadata with `moat catalog --refresh`."
        );
      }
      return text(
        hits
          .map(
            (hit) =>
              `[${hit.score}] ${hit.heading}\n${hit.snippet}`
          )
          .join("\n\n")
      );
    }
  );

  server.registerTool(
    "tool_describe",
    {
      description:
        "Read current input schemas from one authorized downstream MCP server.",
      inputSchema: {
        server: z.string().min(1).max(128),
        tool: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
          .optional(),
      },
    },
    async ({ server: name, tool }, ctx) =>
      text(await runtime.describe(name, tool, caller(ctx)))
  );

  server.registerTool(
    "tool_call",
    {
      description:
        "Call one authorized downstream MCP tool. Optional cwd is constrained by the server's declared cwdRoots.",
      inputSchema: {
        server: z.string().min(1).max(128),
        tool: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
        arguments: z.record(z.string(), z.unknown()).optional(),
        cwd: z.string().max(4096).optional(),
      },
    },
    async (
      { server: name, tool, arguments: args, cwd },
      ctx
    ) => {
      const result = await runtime.call(
        name,
        tool,
        (args ?? {}) as Record<string, unknown>,
        cwd,
        caller(ctx)
      );
      const content = result.content.map((block) => {
        if (block.type !== "text") return block;
        return { ...block, text: compressText(block.text).text };
      });
      return boundToolResultEnvelope(cfg, caller(ctx), {
        ...result,
        content,
      }).result;
    }
  );

  server.registerTool(
    "tool_result_fetch",
    {
      description:
        "Read caller-owned slices from an opaque oversized-result archive handle.",
      inputSchema: {
        hash: z.string().regex(/^[a-f0-9]{48}$/),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(100).max(30_000).optional(),
        find: z.string().min(1).max(500).optional(),
      },
    },
    async ({ hash, offset, limit, find }, ctx) => {
      const archive = getArchive(cfg);
      const owner = caller(ctx);
      if (find) {
        const matches = archive.find(owner, hash, find);
        if (!matches) return text("Archived result not found or expired.");
        if (!matches.length) return text("No matching lines.");
        return text(
          matches
            .map((match) => `@${match.offset}: ${match.line}`)
            .join("\n")
        );
      }
      const hit = archive.fetch(
        owner,
        hash,
        offset ?? 0,
        limit ?? 8000
      );
      if (!hit) return text("Archived result not found or expired.");
      const next = (offset ?? 0) + hit.slice.length;
      return text(
        hit.slice +
          (hit.remaining
            ? `\n\n[${hit.remaining} chars remain; next offset ${next}]`
            : "\n\n[end]")
      );
    }
  );

  server.registerTool(
    "moat_health",
    {
      description:
        "Return bounded gateway pool, breaker, latency, and failure health.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(runtime.health()))
  );

  server.registerTool(
    "moat_usage",
    {
      description:
        "Return only caller-scoped aggregate counts, coarse errors, timings, and recency.",
      inputSchema: {
        server: z.string().max(128).optional(),
        hours: z.number().int().min(1).max(720).optional(),
      },
    },
    async ({ server: name, hours }, ctx) =>
      text(
        getHealth(cfg).usageReport({
          agent: caller(ctx),
          server: name,
          sinceMs: (hours ?? 24) * 3_600_000,
        })
      )
  );

  server.registerTool(
    "registry_list",
    {
      description:
        "List configured downstream servers without commands, arguments, environment values, headers, URLs, or paths.",
      inputSchema: {},
    },
    async () =>
      text(
        cfg.inlineServers
          .map((definition) => {
            const trust = definition.disabled
              ? "disabled"
              : definition.trusted === false
                ? "quarantined"
                : "trusted";
            const note = definition.notes
              ? ` — ${sanitizeMetadata(
                  definition.notes,
                  {
                    server: definition.name,
                    trust,
                  },
                  500
                )}`
              : "";
            return `${definition.name} (${definition.transport ?? "stdio"}, ${trust}, zone=${definition.zone ?? "default"})${note}`;
          })
          .join("\n") || "No servers configured."
      )
  );

  return server;
}

export async function serve(cfg: OpenMoatConfig): Promise<void> {
  const runtime = createGatewayRuntime(cfg);
  const launcherCaller = process.env.OPENMOAT_CALLER;
  serveStdio(
    (factoryContext) =>
      buildServer(cfg, factoryContext, runtime, launcherCaller),
    {
      legacy: "serve",
      onerror: (error) =>
        console.error(`openmoat: MCP stdio error: ${error.message}`),
    }
  );
  console.error("openmoat MCP server running (stdio, dual-era)");

  if (cfg.prewarm.length) runtime.prewarm(cfg.prewarm);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  setInterval(() => {
    if (process.ppid === 1) shutdown();
  }, 5000).unref();
}
