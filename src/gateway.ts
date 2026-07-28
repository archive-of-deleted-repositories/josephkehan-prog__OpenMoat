import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/client";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { HubConfig } from "./config.js";
import {
  resolveFederatedServer,
  type FederatedAsset,
} from "./federation.js";
import { getHealth } from "./health.js";
import { makeTransport } from "./mcp-client.js";
import { FileOAuthProvider } from "./oauth.js";
import { requireGatewayAuthorization } from "./policy.js";
import { isToolNotFoundError, suggestToolName } from "./tool-policy.js";
import {
  loadSecretsCached,
  resolveServers,
  type ServerDef,
} from "./registry.js";
import { HUB_VERSION } from "./version.js";

/**
 * The reverse direction: agents connect to ONE server (the hub); the RAG
 * holds the whole MCP universe; the gateway lazily loads any registry server
 * on demand and proxies tool calls through. A server doesn't need to be
 * synced into any harness config — being in the registry is enough.
 *
 * Flow for an agent: tool_search("what I need") -> tool_describe(server, tool)
 * -> tool_call(server, tool, args). Connections are pooled per hub process.
 */

const pool = new Map<string, { client: Client; pid?: number }>();
/** Spawns in progress, keyed like the pool. Set synchronously before any await
 *  so two concurrent calls to the same cold server share one spawn instead of
 *  racing past the pool check and leaking an untracked child. */
const inflight = new Map<string, Promise<Client>>();

/** All descendant pids of `pid` (children, grandchildren, …), breadth-first. */
function descendants(pid: number): number[] {
  const out: number[] = [];
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    let kids: number[] = [];
    try {
      kids = execFileSync("pgrep", ["-P", String(p)], { timeout: 1000 })
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    } catch {
      /* no children */
    }
    for (const k of kids) {
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/**
 * Synchronously kill every pooled child (and its descendants). Used on
 * shutdown — no awaits, no timers, nothing that can hang. npx/npm-exec
 * wrappers don't forward SIGTERM to the real server, so the whole tree is
 * killed deepest-first. Returns what was reaped for logging.
 */
export function reapAll(): { server: string; pids: number[] }[] {
  const entries = [...pool.entries()];
  pool.clear();
  const reaped: { server: string; pids: number[] }[] = [];
  for (const [server, e] of entries) {
    const pids: number[] = [];
    if (e.pid) {
      // kill the whole tree, deepest first (npx wrappers nest: shell -> npm -> node)
      const tree = [...descendants(e.pid), e.pid].reverse();
      for (const p of tree) {
        try {
          process.kill(p, "SIGKILL");
          pids.push(p);
        } catch {
          /* already gone */
        }
      }
    }
    reaped.push({ server, pids });
  }
  return reaped;
}

async function getClient(cfg: HubConfig, serverName: string, cwd?: string): Promise<Client> {
  const asset = resolveFederatedServer(cfg, serverName);
  if (!asset) {
    throw new Error(`'${serverName}' is not in the federated MCP catalog. Use registry_list.`);
  }
  const poolKey = cwd ? `${asset.id}@${cwd}` : asset.id;
  const existing = pool.get(poolKey);
  if (existing) {
    // A pooled entry whose child has died must not be handed out — it fails
    // every call with "Not connected" until evicted. Signal 0 probes liveness.
    let alive = true;
    if (existing.pid !== undefined) {
      try {
        process.kill(existing.pid, 0);
      } catch {
        alive = false;
      }
    }
    if (alive) return existing.client;
    pool.delete(poolKey);
    try {
      void existing.client.close();
    } catch {
      /* already dead */
    }
  }
  const pending = inflight.get(poolKey);
  if (pending) return pending;
  const spawning = spawnClient(cfg, asset, serverName, cwd, poolKey).finally(() =>
    inflight.delete(poolKey)
  );
  inflight.set(poolKey, spawning);
  return spawning;
}

/**
 * Eagerly spawn a set of frequently-used servers so the first real tool_call
 * is warm (npx/uvx cold start + package resolution is otherwise paid on the
 * first call per server). Fire-and-forget: failures are logged, never thrown —
 * a bad prewarm target must not block hub boot. Already-pooled servers no-op.
 */
export function prewarm(cfg: HubConfig, servers: string[]): void {
  for (const name of servers) {
    getClient(cfg, name).catch((e) => console.error(`openmoat: prewarm '${name}' failed: ${e}`));
  }
}

// `command -v` results never change under a running process — check once.
const binAvailable = new Map<string, boolean>();

/** Absolute-resolve a spawn directory, rejecting files and missing paths with
 *  a message that names which setting supplied it. */
function requireDirectory(dir: string, label: string): string {
  const resolved = path.resolve(dir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`${label} does not exist`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}

async function spawnClient(
  cfg: HubConfig,
  asset: FederatedAsset<ServerDef>,
  serverName: string,
  cwd: string | undefined,
  poolKey: string
): Promise<Client> {
  const def = asset.value;
  if (def.trusted === false) {
    throw new Error(
      `'${serverName}' is QUARANTINED (newly adopted, not yet approved — tool-poisoning defense). A human must approve it: \`hub trust ${serverName}\` or the registry_trust tool.`
    );
  }

  // A caller-supplied `cwd` becomes the spawned server's working directory.
  // Require it to be an existing directory (absolute-resolved) so a tool call
  // can't point a server at a bogus or surprising path; reject files and
  // non-existent paths early with a clear error.
  if (cwd !== undefined) cwd = requireDirectory(cwd, `cwd '${cwd}'`);

  // Preflight: fail fast with the fix when a local prerequisite is missing.
  for (const r of def.requires ?? []) {
    let ok = binAvailable.get(r.bin);
    if (ok === undefined) {
      try {
        // No shell interpolation: `r.bin` is passed as a positional arg ($1)
        // to `command -v`, so a registry entry with shell metacharacters in
        // `requires[].bin` cannot inject a command (defense in depth — this
        // path already sits behind the trust gate above).
        execFileSync("/bin/sh", ["-c", 'command -v "$1"', "sh", r.bin], { stdio: "ignore" });
        ok = true;
      } catch {
        ok = false;
      }
      binAvailable.set(r.bin, ok);
    }
    if (!ok) throw new Error(`'${serverName}' needs '${r.bin}' installed first${r.hint ? ` — ${r.hint}` : ""}. Not spawned.`);
  }

  const health = getHealth(cfg);
  const breaker = health.check("server", serverName);
  if (breaker.open) {
    throw new Error(
      `'${serverName}' is cooling down after repeated failures (retry in ~${Math.ceil(breaker.retryInMs / 60_000)}m). Last error: ${breaker.reason}`
    );
  }

  const { servers } = resolveServers(
    [{ ...def, name: asset.id, disabled: false }],
    loadSecretsCached(cfg.secretsEnv)
  );
  const s = servers[0];

  // No cwd from the call? Use the one the registry entry pins. It is read from
  // the RESOLVED server so `~` and ${VAR} are already expanded — the raw def
  // still holds the literal string. Servers that derive per-project state from
  // `process.cwd()` otherwise spawn in the hub's own directory and look up a
  // project that does not exist.
  if (cwd === undefined && s.cwd !== undefined) {
    cwd = requireDirectory(s.cwd, `'${serverName}' registry cwd '${s.cwd}'`);
  }

  let client = new Client({ name: "openmoat-gateway", version: HUB_VERSION });
  try {
    if (s.transport === "http") {
      if (s.headers) {
        // Static bearer/header auth (for endpoints without dynamic client
        // registration, e.g. GitHub — token from secrets.env).
        await client.connect(makeTransport(s));
      } else {
        // Hub-side OAuth: browser opens once on first use, tokens cached in state/oauth/.
        const provider = new FileOAuthProvider(cfg.stateDir, s.name, true);
        let transport = makeTransport(s, { authProvider: provider }) as StreamableHTTPClientTransport;
        try {
          await client.connect(transport);
        } catch (e) {
          if (e instanceof UnauthorizedError) {
            const code = await provider.waitForCode();
            await transport.finishAuth(code);
            provider.closeCallbackServer();
            client = new Client({ name: "openmoat-gateway", version: HUB_VERSION });
            transport = makeTransport(s, { authProvider: provider }) as StreamableHTTPClientTransport;
            await client.connect(transport);
          } else if (String(e).includes("dynamic client registration")) {
            throw new Error(
              `'${serverName}' requires OAuth but doesn't support dynamic client registration. Add a token header in the registry instead, e.g. "headers": {"Authorization": "Bearer \${${serverName.toUpperCase()}_TOKEN}"} with the token in secrets.env.`
            );
          } else {
            throw e;
          }
        }
      }
      pool.set(poolKey, { client });
    } else {
      const transport = makeTransport(s, { cwd });
      await client.connect(transport);
      const pid = "pid" in transport && typeof transport.pid === "number" ? transport.pid : undefined;
      pool.set(poolKey, { client, pid });
    }
  } catch (e) {
    health.failure("server", serverName, String(e));
    throw e;
  }
  health.success("server", serverName);
  return client;
}

export async function gatewayDescribe(
  cfg: HubConfig,
  serverName: string,
  toolName?: string,
  agent?: string
): Promise<string> {
  requireGatewayAuthorization(cfg, agent, serverName, toolName ?? "*");
  const client = await getClient(cfg, serverName);
  const { tools } = await client.listTools();
  const picked = toolName ? tools.filter((t) => t.name === toolName) : tools;
  if (!picked.length) return `No tool '${toolName}' on '${serverName}'. Available: ${tools.map((t) => t.name).join(", ")}`;
  return picked
    .map((t) => `## ${serverName} › ${t.name}\n${t.description ?? ""}\nInput schema: ${JSON.stringify(t.inputSchema)}`)
    .join("\n\n");
}

export interface GatewayResult {
  content: unknown[];
  isError?: boolean;
}

export async function gatewayCall(
  cfg: HubConfig,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  cwd?: string,
  agent?: string
): Promise<GatewayResult> {
  const health = getHealth(cfg);
  const toolKey = `${serverName}›${toolName}`;
  try {
    requireGatewayAuthorization(cfg, agent, serverName, toolName);
  } catch (e) {
    try {
      health.recordAgentCall(agent ?? "unknown", serverName, toolName, 0, true);
    } catch (he) {
      console.error(`openmoat: health accounting failed for denied ${toolKey}: ${he}`);
    }
    throw e;
  }
  const lockout = health.check("tool", toolKey);
  if (lockout.open) {
    throw new Error(
      `'${toolKey}' is locked out after repeated errors (retry in ~${Math.ceil(lockout.retryInMs / 60_000)}m). Last error: ${lockout.reason}`
    );
  }

  const client = await getClient(cfg, serverName, cwd);
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name: toolName, arguments: args });
    const isError = res.isError === true;
    // Pass content through verbatim (text, images, embedded resources — all of it).
    const content = (res.content as unknown[] | undefined) ?? [];
    const firstText = (content[0] as { text?: string } | undefined)?.text ?? "";
    // Health accounting must never turn a successful upstream call into an
    // error for the agent (or evict a healthy connection).
    try {
      health.recordCall(serverName, toolName, Date.now() - t0, isError);
      health.recordAgentCall(agent ?? "unknown", serverName, toolName, Date.now() - t0, isError);
      if (isError) health.failure("tool", toolKey, firstText.slice(0, 150));
      else health.success("tool", toolKey);
    } catch (e) {
      console.error(`openmoat: health accounting failed for ${toolKey}: ${e}`);
    }
    return {
      content: content.length ? content : [{ type: "text", text: "(empty result)" }],
      isError,
    };
  } catch (e) {
    try {
      health.recordCall(serverName, toolName, Date.now() - t0, true);
      health.recordAgentCall(agent ?? "unknown", serverName, toolName, Date.now() - t0, true);
      health.failure("tool", toolKey, String(e));
    } catch (he) {
      console.error(`openmoat: health accounting failed for ${toolKey}: ${he}`);
    }
    // Drop the broken connection so the next call respawns the server. The
    // pool is keyed by the FEDERATED asset id (e.g. "local/lsp-go"), not the
    // caller's short server name — deleting by serverName was a silent no-op
    // that left dead clients pooled forever ("Not connected" on every call).
    const assetForEvict = resolveFederatedServer(cfg, serverName);
    const evictId = assetForEvict ? assetForEvict.id : serverName;
    pool.delete(cwd ? `${evictId}@${cwd}` : evictId);
    pool.delete(cwd ? `${serverName}@${cwd}` : serverName); // legacy key, belt-and-braces
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    // "Tool X not found" is unrecoverable as the downstream server phrases it —
    // the agent gets no way to correct, so it retries the same wrong name. On
    // 2026-07-21, 39% of all recorded gateway calls were exactly this loop
    // (dbx›query x20, squish›x x20). Name the near-miss instead.
    const msg = String(e);
    if (isToolNotFoundError(msg)) {
      throw new Error(await notFoundHelp(client, serverName, toolName, msg));
    }
    throw e;
  }
}

/** Rewrite a bare "tool not found" into something the agent can act on. */
async function notFoundHelp(
  client: Client,
  serverName: string,
  toolName: string,
  original: string
): Promise<string> {
  let names: string[] = [];
  try {
    names = ((await client.listTools()).tools ?? []).map((t) => t.name);
  } catch {
    return `${original}\n\n'${toolName}' is not a tool on '${serverName}', and the tool list could not be read. Run tool_search to find the right one.`;
  }
  const near = suggestToolName(toolName, names);
  const head = `No tool '${toolName}' on '${serverName}'.`;
  if (near.length) {
    return `${head} Did you mean: ${near.map((n) => `${serverName}›${n}`).join(", ")}? Do NOT retry '${toolName}' — it does not exist.`;
  }
  return `${head} Do NOT retry it. Available on '${serverName}': ${names.join(", ") || "(none)"}. Or run tool_search to find the right server.`;
}
