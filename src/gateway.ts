import { execFileSync } from "node:child_process";
import path from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/client";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { OpenMoatConfig } from "./config.js";
import {
  resolveFederatedServer,
  type FederatedAsset,
} from "./federation.js";
import { getHealth } from "./health.js";
import { makeTransport } from "./mcp-client.js";
import { FileOAuthProvider } from "./oauth.js";
import { requireGatewayAuthorization } from "./policy.js";
import {
  resolveWorkingDirectory,
  sanitizeMetadata,
  SecretRedactor,
  withDeadline,
} from "./runtime-security.js";
import { isToolNotFoundError, suggestToolName } from "./tool-policy.js";
import {
  loadSecretsCached,
  resolveServers,
  type ResolvedServer,
  type ServerDef,
} from "./registry.js";
import { OPENMOAT_VERSION } from "./version.js";

interface PoolEntry {
  client: Client;
  serverId: string;
  serverName: string;
  cwd?: string;
  pid?: number;
  lastUsed: number;
  redactor: SecretRedactor;
  callTimeoutMs: number;
  failureThreshold: number;
  resetAfterMs: number;
  maxConcurrentCalls: number;
}

interface RuntimeTarget {
  asset: FederatedAsset<ServerDef>;
  server: ResolvedServer;
  poolKey: string;
  cwd?: string;
  redactor: SecretRedactor;
}

const pool = new Map<string, PoolEntry>();
const inflight = new Map<string, Promise<PoolEntry>>();
const reservations = new Map<string, string>();
const activeCalls = new Map<string, number>();

/** All descendant pids of `pid` (children, grandchildren, …), breadth-first. */
function descendants(pid: number): number[] {
  const out: number[] = [];
  const stack = [pid];
  while (stack.length) {
    const parent = stack.pop()!;
    let children: number[] = [];
    try {
      children = execFileSync("pgrep", ["-P", String(parent)], { timeout: 1000 })
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    } catch {
      // No children.
    }
    for (const child of children) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

function killEntry(entry: PoolEntry): number[] {
  if (entry.pid === undefined) return [];
  return killProcessTree(entry.pid);
}

function killProcessTree(rootPid: number): number[] {
  const killed: number[] = [];
  for (const pid of [...descendants(rootPid).reverse(), rootPid]) {
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // Already gone.
    }
  }
  return killed;
}

function evict(poolKey: string, close = true): number[] {
  const entry = pool.get(poolKey);
  pool.delete(poolKey);
  reservations.delete(poolKey);
  activeCalls.delete(poolKey);
  if (!entry) return [];
  const killed = killEntry(entry);
  if (close) {
    void entry.client.close().catch(() => {
      // The process may already have exited.
    });
  }
  return killed;
}

/**
 * Synchronously kill every pooled child and all descendants. The CLI calls
 * this on EOF and termination signals, so no asynchronous cleanup is relied on.
 */
export function reapAll(): { server: string; pids: number[] }[] {
  const entries = [...pool.entries()];
  const reaped = entries.map(([key, entry]) => ({
    server: entry.serverId,
    pids: evict(key, false),
  }));
  pool.clear();
  inflight.clear();
  reservations.clear();
  activeCalls.clear();
  return reaped;
}

export interface GatewayHealth {
  version: 1;
  status: "ok" | "degraded" | "failed";
  pools: number;
  poolLimit: number;
  queuedCalls: number;
  servers: Record<
    string,
    {
      status: "cold" | "starting" | "ready" | "open" | "failed" | "stopped";
      latencyMs: number;
      failures: number;
      children: number;
      lastErrorCode?: string;
    }
  >;
}

export function gatewayHealth(cfg: OpenMoatConfig): GatewayHealth {
  reapIdle(cfg);
  const stats = getHealth(cfg).serverStats();
  const names = new Set([
    ...cfg.inlineServers.map((server) => server.name),
    ...Object.keys(stats),
    ...[...pool.values()].map((entry) => entry.serverName),
  ]);
  const servers: GatewayHealth["servers"] = {};
  for (const name of [...names].sort()) {
    const entries = [...pool.values()].filter(
      (entry) => entry.serverName === name && entryAlive(entry)
    );
    const metric = stats[name] ?? { latencyMs: 0, failures: 0 };
    const children = entries.reduce(
      (count, entry) =>
        count +
        (entry.pid === undefined ? 0 : 1 + descendants(entry.pid).length),
      0
    );
    servers[name] = {
      status:
        entries.length > 0
          ? "ready"
          : metric.failures > 0
            ? "failed"
            : inflight.size > 0
              ? "starting"
              : "cold",
      latencyMs: metric.latencyMs,
      failures: metric.failures,
      children,
      ...(metric.lastErrorCode
        ? { lastErrorCode: metric.lastErrorCode }
        : {}),
    };
  }
  const degraded = Object.values(servers).some(
    (server) => server.status === "failed" || server.status === "open"
  );
  return {
    version: 1,
    status: degraded ? "degraded" : "ok",
    pools: pool.size,
    poolLimit: cfg.gatewayLimits.maxPools,
    queuedCalls: inflight.size,
    servers,
  };
}

function reservePool(cfg: OpenMoatConfig, serverId: string, poolKey: string): void {
  if (reservations.has(poolKey)) return;
  const perServer = [...reservations.values()].filter(
    (value) => value === serverId
  ).length;
  if (perServer >= cfg.gatewayLimits.maxPoolsPerServer) {
    throw new Error(
      `POOL_LIMIT: '${serverId}' reached ${cfg.gatewayLimits.maxPoolsPerServer} pools`
    );
  }
  if (reservations.size >= cfg.gatewayLimits.maxPools) {
    throw new Error(
      `POOL_LIMIT: gateway reached ${cfg.gatewayLimits.maxPools} pools`
    );
  }
  reservations.set(poolKey, serverId);
}

function reapIdle(cfg: OpenMoatConfig): void {
  const now = Date.now();
  for (const [key, entry] of pool) {
    if (now - entry.lastUsed >= cfg.gatewayLimits.idleTimeoutMs) evict(key);
  }
}

function resolveTarget(
  cfg: OpenMoatConfig,
  serverName: string,
  requestedCwd?: string
): RuntimeTarget {
  const asset = resolveFederatedServer(cfg, serverName);
  if (!asset) {
    throw new Error(
      `'${serverName}' is not in the federated MCP catalog. Use registry_list.`
    );
  }
  if (asset.value.trusted === false) {
    throw new Error(
      `QUARANTINED: '${serverName}' requires approval from the human-only 'moat trust' command`
    );
  }
  if (asset.value.disabled) {
    throw new Error(`QUARANTINED: '${serverName}' is disabled`);
  }

  const secrets = loadSecretsCached(cfg.secretsEnv);
  const { servers, warnings } = resolveServers(
    [{ ...asset.value, name: asset.id, disabled: false }],
    secrets
  );
  if (warnings.length) {
    throw new Error(`UNRESOLVED_SECRET: ${warnings.join("; ")}`);
  }
  const server = servers[0];
  const redactor = new SecretRedactor([
    ...Object.values(secrets),
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
  ]);
  const cwd =
    server.transport === "http"
      ? undefined
      : resolveWorkingDirectory(
          requestedCwd,
          server.cwd,
          server.cwdRoots ?? [],
          path.dirname(cfg.configFile)
        );
  return {
    asset,
    server,
    cwd,
    poolKey: cwd ? `${asset.id}@${cwd}` : asset.id,
    redactor,
  };
}

function entryAlive(entry: PoolEntry): boolean {
  if (entry.pid === undefined) return true;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getEntry(
  cfg: OpenMoatConfig,
  serverName: string,
  requestedCwd?: string
): Promise<PoolEntry> {
  reapIdle(cfg);
  const target = resolveTarget(cfg, serverName, requestedCwd);
  const existing = pool.get(target.poolKey);
  if (existing && entryAlive(existing)) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing) evict(target.poolKey);
  const pending = inflight.get(target.poolKey);
  if (pending) return pending;

  reservePool(cfg, target.asset.id, target.poolKey);
  const spawning = spawnClient(cfg, target, serverName)
    .catch((error) => {
      reservations.delete(target.poolKey);
      throw error;
    })
    .finally(() => inflight.delete(target.poolKey));
  inflight.set(target.poolKey, spawning);
  return spawning;
}

/** Prewarm is best-effort and never exposes secret-bearing errors. */
export function prewarm(cfg: OpenMoatConfig, servers: string[]): void {
  for (const name of servers) {
    getEntry(cfg, name).catch(() =>
      console.error(`openmoat: prewarm '${name}' failed`)
    );
  }
}

const binAvailable = new Map<string, boolean>();

async function connectHttp(
  cfg: OpenMoatConfig,
  target: RuntimeTarget,
  client: Client,
  serverName: string
): Promise<Client> {
  const server = target.server;
  if (server.headers) {
    const transport = makeTransport(server);
    await withDeadline(
      client.connect(transport),
      server.startupTimeoutMs ?? 10_000,
      () => transport.close()
    );
    return client;
  }

  const provider = new FileOAuthProvider(cfg.stateDir, server.name, true);
  let transport = makeTransport(server, {
    authProvider: provider,
  }) as StreamableHTTPClientTransport;
  try {
    await withDeadline(
      client.connect(transport),
      server.startupTimeoutMs ?? 10_000,
      () => transport.close()
    );
    return client;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      const code = await provider.waitForCode();
      await transport.finishAuth(code);
      provider.closeCallbackServer();
      client = new Client({
        name: "openmoat-gateway",
        version: OPENMOAT_VERSION,
      });
      transport = makeTransport(server, {
        authProvider: provider,
      }) as StreamableHTTPClientTransport;
      await withDeadline(
        client.connect(transport),
        server.startupTimeoutMs ?? 10_000,
        () => transport.close()
      );
      return client;
    }
    if (String(error).includes("dynamic client registration")) {
      throw new Error(
        `PROCESS_FAILED: '${serverName}' requires an explicitly configured token header`
      );
    }
    throw error;
  }
}

async function spawnClient(
  cfg: OpenMoatConfig,
  target: RuntimeTarget,
  serverName: string
): Promise<PoolEntry> {
  const { server, poolKey, redactor } = target;

  for (const requirement of server.requires ?? []) {
    let available = binAvailable.get(requirement.bin);
    if (available === undefined) {
      try {
        execFileSync(
          "/bin/sh",
          ["-c", 'command -v "$1"', "sh", requirement.bin],
          { stdio: "ignore" }
        );
        available = true;
      } catch {
        available = false;
      }
      binAvailable.set(requirement.bin, available);
    }
    if (!available) {
      throw new Error(
        `PROCESS_FAILED: '${serverName}' needs '${requirement.bin}' installed first`
      );
    }
  }

  const health = getHealth(cfg);
  const breaker = health.check("server", poolKey, {
    failureThreshold: server.limits?.failureThreshold,
    resetAfterMs: server.limits?.resetAfterMs,
  });
  if (breaker.open) {
    throw new Error(
      `CIRCUIT_OPEN: '${serverName}' is cooling down; last error: ${redactor.text(breaker.reason)}`
    );
  }

  let client = new Client({
    name: "openmoat-gateway",
    version: OPENMOAT_VERSION,
  });
  let pid: number | undefined;
  try {
    if (server.transport === "http") {
      client = await connectHttp(cfg, target, client, serverName);
    } else {
      const transport = makeTransport(server, { cwd: target.cwd });
      await withDeadline(
        client.connect(transport),
        server.startupTimeoutMs ?? 10_000,
        async () => {
          if (
            "pid" in transport &&
            typeof transport.pid === "number"
          ) {
            killProcessTree(transport.pid);
          }
          await transport.close();
        }
      );
      pid =
        "pid" in transport && typeof transport.pid === "number"
          ? transport.pid
          : undefined;
    }
  } catch (error) {
    const message = redactor.text(String(error));
    health.failure("server", poolKey, message);
    try {
      await client.close();
    } catch {
      // The client may never have connected.
    }
    if (message.includes("TIMEOUT")) throw new Error(message);
    throw new Error(`PROCESS_FAILED: ${message}`);
  }

  health.success("server", poolKey);
  const entry: PoolEntry = {
    client,
    serverId: target.asset.id,
    serverName,
    cwd: target.cwd,
    pid,
    lastUsed: Date.now(),
    redactor,
    callTimeoutMs: server.callTimeoutMs ?? 30_000,
    failureThreshold: server.limits?.failureThreshold ?? 4,
    resetAfterMs: server.limits?.resetAfterMs ?? 5 * 60_000,
    maxConcurrentCalls: server.limits?.maxConcurrentCalls ?? 4,
  };
  pool.set(poolKey, entry);
  return entry;
}

function authorize(
  cfg: OpenMoatConfig,
  serverName: string,
  toolName: string,
  agent?: string
): FederatedAsset<ServerDef> {
  const asset = resolveFederatedServer(cfg, serverName);
  if (!asset) {
    throw new Error(
      `'${serverName}' is not in the federated MCP catalog. Use registry_list.`
    );
  }
  requireGatewayAuthorization(
    cfg,
    agent,
    serverName,
    toolName,
    asset.value.zone ?? "default"
  );
  return asset;
}

export async function gatewayDescribe(
  cfg: OpenMoatConfig,
  serverName: string,
  toolName?: string,
  agent?: string
): Promise<string> {
  const asset = authorize(cfg, serverName, toolName ?? "*", agent);
  const entry = await getEntry(cfg, serverName);
  const result = await withDeadline(
    entry.client.listTools(),
    entry.callTimeoutMs,
    async () => {
      evict(entry.cwd ? `${asset.id}@${entry.cwd}` : asset.id);
    }
  );
  const picked = toolName
    ? result.tools.filter((tool) => tool.name === toolName)
    : result.tools;
  if (!picked.length) {
    return `No tool '${toolName}' on '${serverName}'. Available: ${result.tools
      .map((tool) => tool.name)
      .join(", ")}`;
  }
  return picked
    .map((tool) =>
      sanitizeMetadata(
        `Tool: ${tool.name}\n${tool.description ?? ""}\nInput schema: ${JSON.stringify(tool.inputSchema)}`,
        {
          server: serverName,
          trust: asset.value.trusted === false ? "quarantined" : "trusted",
        }
      )
    )
    .join("\n\n");
}

export interface GatewayResult {
  content: unknown[];
  isError?: boolean;
}

export async function gatewayCall(
  cfg: OpenMoatConfig,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  cwd?: string,
  agent?: string
): Promise<GatewayResult> {
  const health = getHealth(cfg);
  let asset: FederatedAsset<ServerDef>;
  try {
    asset = authorize(cfg, serverName, toolName, agent);
  } catch (error) {
    try {
      health.recordAgentCall(
        agent ?? "unknown",
        serverName,
        toolName,
        0,
        true
      );
    } catch {
      // Accounting cannot change the authorization result.
    }
    throw error;
  }

  const entry = await getEntry(cfg, serverName, cwd);
  const poolKey = entry.cwd ? `${asset.id}@${entry.cwd}` : asset.id;
  const toolKey = `${poolKey}›${toolName}`;
  const breaker = health.check("tool", toolKey, {
    failureThreshold: entry.failureThreshold,
    resetAfterMs: entry.resetAfterMs,
  });
  if (breaker.open) {
    throw new Error(
      `CIRCUIT_OPEN: '${serverName}›${toolName}' is locked out; last error: ${entry.redactor.text(breaker.reason)}`
    );
  }

  const concurrent = activeCalls.get(poolKey) ?? 0;
  if (concurrent >= entry.maxConcurrentCalls) {
    throw new Error(
      `POOL_LIMIT: '${serverName}' reached ${entry.maxConcurrentCalls} concurrent calls`
    );
  }
  activeCalls.set(poolKey, concurrent + 1);
  const started = Date.now();
  try {
    const result = await withDeadline(
      entry.client.callTool({ name: toolName, arguments: args }),
      entry.callTimeoutMs,
      async () => {
        evict(poolKey);
      }
    );
    const isError = result.isError === true;
    let content = entry.redactor.redact(
      (result.content as unknown[] | undefined) ?? []
    );
    if (isError) {
      content = content.map((block) => {
        if (
          block !== null &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text"
        ) {
          const value = block as { text?: unknown };
          return {
            ...block,
            text: `PROCESS_FAILED: ${String(value.text ?? "")}`,
          };
        }
        return block;
      });
    }
    const firstText =
      (content[0] as { text?: string } | undefined)?.text ?? "";
    health.recordCall(
      serverName,
      toolName,
      Date.now() - started,
      isError
    );
    health.recordAgentCall(
      agent ?? "unknown",
      serverName,
      toolName,
      Date.now() - started,
      isError
    );
    if (isError) health.failure("tool", toolKey, firstText);
    else health.success("tool", toolKey);
    entry.lastUsed = Date.now();
    return {
      content: content.length
        ? content
        : [{ type: "text", text: "(empty result)" }],
      isError,
    };
  } catch (error) {
    const message = entry.redactor.text(String(error));
    try {
      health.recordCall(
        serverName,
        toolName,
        Date.now() - started,
        true
      );
      health.recordAgentCall(
        agent ?? "unknown",
        serverName,
        toolName,
        Date.now() - started,
        true
      );
      health.failure("tool", toolKey, message);
    } catch {
      // Accounting cannot replace the gateway error.
    }
    evict(poolKey);
    if (isToolNotFoundError(message)) {
      throw new Error(
        await notFoundHelp(entry.client, serverName, toolName, message)
      );
    }
    throw new Error(message);
  } finally {
    const remaining = (activeCalls.get(poolKey) ?? 1) - 1;
    if (remaining > 0) activeCalls.set(poolKey, remaining);
    else activeCalls.delete(poolKey);
  }
}

async function notFoundHelp(
  client: Client,
  serverName: string,
  toolName: string,
  original: string
): Promise<string> {
  let names: string[] = [];
  try {
    names = ((await client.listTools()).tools ?? []).map((tool) => tool.name);
  } catch {
    return `${original}\n\n'${toolName}' is not a tool on '${serverName}', and the tool list could not be read. Run tool_search.`;
  }
  const near = suggestToolName(toolName, names);
  if (near.length) {
    return `No tool '${toolName}' on '${serverName}'. Did you mean: ${near
      .map((name) => `${serverName}›${name}`)
      .join(", ")}?`;
  }
  return `No tool '${toolName}' on '${serverName}'. Available: ${
    names.join(", ") || "(none)"
  }.`;
}
