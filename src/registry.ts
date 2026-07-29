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
  disabled?: boolean;
  trusted?: boolean;
  requires?: { bin: string; hint?: string }[];
  cwd?: string;
  cwdRoots?: string[];
  capabilities?: (
    | "public-read"
    | "sensitive-read"
    | "filesystem-write"
    | "network-egress"
    | "process-control"
    | "secrets"
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

export type ResolvedServer = ServerDef;

const secretsCache = new Map<
  string,
  { mtimeMs: number; secrets: Record<string, string> }
>();
const MAX_SECRETS_BYTES = 1024 * 1024;

export interface LoadSecretsOptions {
  enforcePermissions?: boolean;
}

export function loadSecrets(
  secretsEnvPath: string,
  options: LoadSecretsOptions = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(secretsEnvPath)) return out;
  const stat = fs.statSync(secretsEnvPath);
  if (stat.size > MAX_SECRETS_BYTES) {
    throw new Error(
      `secrets file exceeds ${MAX_SECRETS_BYTES} bytes`
    );
  }
  if (options.enforcePermissions ?? true) {
    if ((stat.mode & 0o077) !== 0) {
      fs.chmodSync(secretsEnvPath, 0o600);
    }
  }
  for (const line of fs
    .readFileSync(secretsEnvPath, "utf8")
    .split("\n")) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/
    );
    if (!match) continue;
    out[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function loadSecretsCached(
  secretsEnvPath: string
): Record<string, string> {
  const mtimeMs = fs.existsSync(secretsEnvPath)
    ? fs.statSync(secretsEnvPath).mtimeMs
    : -1;
  const hit = secretsCache.get(secretsEnvPath);
  if (hit?.mtimeMs === mtimeMs) return hit.secrets;
  const secrets = loadSecrets(secretsEnvPath);
  secretsCache.set(secretsEnvPath, { mtimeMs, secrets });
  return secrets;
}

function substitute(
  value: string,
  secrets: Record<string, string>,
  warnings: string[]
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => {
      const replacement = secrets[name] ?? process.env[name];
      if (replacement === undefined) {
        warnings.push(
          `unresolved secret \${${name}} — add it to secrets.env`
        );
        return `\${${name}}`;
      }
      return replacement;
    }
  );
}

export function resolveServers(
  definitions: ServerDef[],
  secrets: Record<string, string>
): { servers: ResolvedServer[]; warnings: string[] } {
  const warnings: string[] = [];
  const servers = definitions
    .filter((definition) => !definition.disabled)
    .map((definition) => {
      const resolved: ResolvedServer = { ...definition };
      if (resolved.command) {
        resolved.command = expandHome(
          substitute(resolved.command, secrets, warnings)
        );
      }
      if (resolved.args) {
        resolved.args = resolved.args.map((argument) =>
          expandHome(substitute(argument, secrets, warnings))
        );
      }
      if (resolved.cwd) {
        resolved.cwd = expandHome(
          substitute(resolved.cwd, secrets, warnings)
        );
      }
      if (resolved.env) {
        resolved.env = Object.fromEntries(
          Object.entries(resolved.env).map(([key, value]) => [
            key,
            substitute(value, secrets, warnings),
          ])
        );
      }
      if (resolved.url) {
        resolved.url = substitute(resolved.url, secrets, warnings);
      }
      if (resolved.headers) {
        resolved.headers = Object.fromEntries(
          Object.entries(resolved.headers).map(([key, value]) => [
            key,
            substitute(value, secrets, warnings),
          ])
        );
      }
      return resolved;
    });
  return { servers, warnings };
}
