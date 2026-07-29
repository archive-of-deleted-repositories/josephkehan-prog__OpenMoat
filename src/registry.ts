import fs from "node:fs";
import { expandHome } from "./config.js";

export interface ServerDef {
  name: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: string[];
  url?: string;
  headers?: Record<string, string>;
  targets?: string[];
  disabled?: boolean;
  /** Reachable via the OpenMoat gateway (tool_call) but never synced into harness configs. */
  gatewayOnly?: boolean;
  /** Quarantine: false = not callable until a human runs `moat trust <name>`.
   *  Undefined/true = trusted. */
  trusted?: boolean;
  /** Local prerequisites checked before spawn; fail fast with the hint. */
  requires?: { bin: string; hint?: string }[];
  /** Working directory to spawn this server in, when a tool_call supplies none.
   *  Servers that derive per-project state from `process.cwd()` need this —
   *  without it they run in the OpenMoat's own directory and look up a project that
   *  does not exist. A caller-supplied cwd still wins. */
  cwd?: string;
  cwdRoots?: string[];
  capabilities?: (
    | "public-read"
    | "sensitive-read"
    | "filesystem-write"
    | "network-egress"
    | "process-control"
    | "secrets"
    | "memory-write"
  )[];
  zone?: string;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
  limits?: {
    failureThreshold?: number;
    resetAfterMs?: number;
    maxConcurrentCalls?: number;
  };
  notes?: string;
}

/** Same shape, but env/args fully resolved (secrets + ~). */
export type ResolvedServer = ServerDef;

export function loadRegistry(registryPath: string): ServerDef[] {
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { servers: ServerDef[] };
  return raw.servers ?? [];
}

// mtime-keyed caches for the gateway hot path: every cold spawn needs the
// registry and secrets, but the files rarely change under a running server.
const registryCache = new Map<string, { mtimeMs: number; servers: ServerDef[] }>();
const secretsCache = new Map<string, { mtimeMs: number; secrets: Record<string, string> }>();

export function loadRegistryCached(registryPath: string): ServerDef[] {
  const mtimeMs = fs.statSync(registryPath).mtimeMs;
  const hit = registryCache.get(registryPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.servers;
  const servers = loadRegistry(registryPath);
  registryCache.set(registryPath, { mtimeMs, servers });
  return servers;
}

export function loadSecretsCached(secretsEnvPath: string): Record<string, string> {
  const mtimeMs = fs.existsSync(secretsEnvPath) ? fs.statSync(secretsEnvPath).mtimeMs : -1;
  const hit = secretsCache.get(secretsEnvPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.secrets;
  const secrets = loadSecrets(secretsEnvPath);
  secretsCache.set(secretsEnvPath, { mtimeMs, secrets });
  return secrets;
}

export interface LoadSecretsOptions {
  /** Normal runtime reads harden the file. Read-only diagnostics disable this. */
  enforcePermissions?: boolean;
}

export function loadSecrets(
  secretsEnvPath: string,
  options: LoadSecretsOptions = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(secretsEnvPath)) return out;
  // Harden perms on read: secrets.env holds API keys + tokens; enforce 0600.
  if (options.enforcePermissions ?? true) {
    try {
      if ((fs.statSync(secretsEnvPath).mode & 0o077) !== 0) fs.chmodSync(secretsEnvPath, 0o600);
    } catch (e) {
      console.error(`openmoat: could not enforce 0600 on ${secretsEnvPath} — fix its permissions manually: ${e}`);
    }
  }
  for (const line of fs.readFileSync(secretsEnvPath, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function substitute(value: string, secrets: Record<string, string>, warnings: string[]): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = secrets[name] ?? process.env[name];
    if (v === undefined) {
      warnings.push(`unresolved secret \${${name}} — add it to secrets.env`);
      return `\${${name}}`;
    }
    return v;
  });
}

export function resolveServers(
  defs: ServerDef[],
  secrets: Record<string, string>
): { servers: ResolvedServer[]; warnings: string[] } {
  const warnings: string[] = [];
  const servers = defs
    .filter((d) => !d.disabled)
    .map((d) => {
      const r: ResolvedServer = { ...d };
      if (r.command) r.command = expandHome(substitute(r.command, secrets, warnings));
      if (r.args) r.args = r.args.map((a) => expandHome(substitute(a, secrets, warnings)));
      if (r.cwd) r.cwd = expandHome(substitute(r.cwd, secrets, warnings));
      if (r.env) {
        r.env = Object.fromEntries(
          Object.entries(r.env).map(([k, v]) => [k, substitute(v, secrets, warnings)])
        );
      }
      if (r.url) r.url = substitute(r.url, secrets, warnings);
      if (r.headers) {
        r.headers = Object.fromEntries(
          Object.entries(r.headers).map(([k, v]) => [k, substitute(v, secrets, warnings)])
        );
      }
      return r;
    });
  return { servers, warnings };
}

/** Servers applicable to a given target id (gateway-only servers are never synced). */
export function serversFor(servers: ResolvedServer[], targetId: string): ResolvedServer[] {
  return servers.filter((s) => !s.gatewayOnly && (!s.targets || s.targets.includes(targetId)));
}
