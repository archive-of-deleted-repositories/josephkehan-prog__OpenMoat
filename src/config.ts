import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import type { ServerDef } from "./registry.js";

export const CONFIG_ENV = "OPENMOAT_FILE";

export interface GatewayPolicyRule {
  allow?: string[];
  deny?: string[];
  zone?: string;
}

export interface GatewayPolicy {
  default: "deny";
  agents: Record<string, GatewayPolicyRule>;
}

export interface GatewayZone {
  allowMixedRisk: boolean;
}

export interface GatewayRuntimeLimits {
  maxPools: number;
  maxPoolsPerServer: number;
  idleTimeoutMs: number;
}

export interface ArchiveLimits {
  maxBlobBytes: number;
  maxCallerBytes: number;
  maxCallerEntries: number;
  ttlMs: number;
}

export interface OpenMoatConfig {
  configFile: string;
  inlineServers: ServerDef[];
  secretsEnv: string;
  stateDir: string;
  gatewayPolicy: GatewayPolicy;
  gatewayZones: Record<string, GatewayZone>;
  gatewayLimits: GatewayRuntimeLimits;
  archiveLimits: ArchiveLimits;
  prewarm: string[];
}

interface GatewayServerDocument {
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: string[];
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  cwdRoots?: string[];
  requires?: { bin: string; hint?: string }[];
  capabilities?: ServerDef["capabilities"];
  zone?: string;
  trust?: "trusted" | "quarantined" | "disabled";
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
  limits?: ServerDef["limits"];
  notes?: string;
}

interface MoatfileDocument {
  apiVersion: "openmoat.dev/v1";
  kind: "Moatfile";
  paths?: { state?: string; secrets?: string };
  gateway: {
    callers: Record<string, GatewayPolicyRule>;
    zones?: Record<string, { allowMixedRisk?: boolean }>;
    limits?: Partial<GatewayRuntimeLimits>;
    archives?: Partial<{
      maxBlobBytes: number;
      maxCallerBytes: number;
      maxCallerEntries: number;
      ttlDays: number;
    }>;
    servers: Record<string, GatewayServerDocument>;
  };
  prewarm?: string[];
}

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveConfigFile(
  cliFile?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = os.homedir()
): string {
  const selected =
    cliFile ??
    env[CONFIG_ENV] ??
    path.join(
      env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
      "openmoat",
      "Moatfile"
    );
  return path.resolve(expandHome(selected));
}

export function configFile(root?: string): string {
  if (process.env[CONFIG_ENV]) return resolveConfigFile();
  if (root && path.resolve(root) !== repoRoot()) {
    return path.join(path.resolve(root), "Moatfile");
  }
  return resolveConfigFile();
}

function absoluteFrom(base: string, value: string): string {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
}

let validateMoatfile: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (validateMoatfile) return validateMoatfile;
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot(), "schemas", "moatfile-v1.schema.json"),
      "utf8"
    )
  ) as object;
  validateMoatfile = new Ajv2020({
    allErrors: true,
    strict: false,
  }).compile(schema);
  return validateMoatfile;
}

function normalizeServers(
  servers: Record<string, GatewayServerDocument>,
  base: string
): ServerDef[] {
  return Object.entries(servers).map(([name, server]) => {
    const transport = server.transport ?? "stdio";
    return {
      name,
      transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.inheritEnv ? { inheritEnv: server.inheritEnv } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(server.headers ? { headers: server.headers } : {}),
      ...(server.cwd ? { cwd: absoluteFrom(base, server.cwd) } : {}),
      ...(server.cwdRoots
        ? {
            cwdRoots: server.cwdRoots.map((root) =>
              absoluteFrom(base, root)
            ),
          }
        : {}),
      ...(server.requires ? { requires: server.requires } : {}),
      capabilities: server.capabilities ?? [],
      zone: server.zone ?? "default",
      trusted: server.trust === "trusted",
      disabled: server.trust === "disabled",
      ...(server.startupTimeoutMs
        ? { startupTimeoutMs: server.startupTimeoutMs }
        : {}),
      ...(server.callTimeoutMs
        ? { callTimeoutMs: server.callTimeoutMs }
        : {}),
      ...(server.limits ? { limits: server.limits } : {}),
      ...(server.notes ? { notes: server.notes } : {}),
    };
  });
}

function validateSemantics(document: MoatfileDocument): void {
  const zones = document.gateway.zones ?? {};
  const capabilities = new Map<string, Set<string>>();
  for (const [name, server] of Object.entries(document.gateway.servers)) {
    const transport = server.transport ?? "stdio";
    if (transport === "stdio") {
      if (!server.command) {
        throw new Error(
          `invalid Moatfile: stdio server '${name}' requires command`
        );
      }
      if (server.url || server.headers) {
        throw new Error(
          `invalid Moatfile: stdio server '${name}' cannot set url or headers`
        );
      }
    } else {
      if (!server.url) {
        throw new Error(
          `invalid Moatfile: http server '${name}' requires url`
        );
      }
      if (
        server.command ||
        server.args ||
        server.env ||
        server.inheritEnv ||
        server.cwd ||
        server.cwdRoots ||
        server.requires
      ) {
        throw new Error(
          `invalid Moatfile: http server '${name}' cannot set stdio process fields`
        );
      }
      let url: URL;
      try {
        url = new URL(server.url);
      } catch {
        throw new Error(
          `invalid Moatfile: http server '${name}' has an invalid url`
        );
      }
      if (
        url.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
      ) {
        throw new Error(
          `invalid Moatfile: http server '${name}' must use https outside loopback`
        );
      }
    }

    if (server.trust === "disabled") continue;
    const zone = server.zone ?? "default";
    if (zone !== "default" && zones[zone] === undefined) {
      throw new Error(
        `invalid Moatfile: server '${name}' references unknown zone '${zone}'`
      );
    }
    const values = capabilities.get(zone) ?? new Set<string>();
    for (const capability of server.capabilities ?? []) {
      values.add(capability);
    }
    capabilities.set(zone, values);
  }
  for (const [caller, rule] of Object.entries(document.gateway.callers)) {
    const zone = rule.zone ?? "default";
    if (zone !== "default" && zones[zone] === undefined) {
      throw new Error(
        `invalid Moatfile: caller '${caller}' references unknown zone '${zone}'`
      );
    }
  }
  for (const [zone, values] of capabilities) {
    if (
      values.has("sensitive-read") &&
      values.has("network-egress") &&
      zones[zone]?.allowMixedRisk !== true
    ) {
      throw new Error(
        `invalid Moatfile: mixed-risk zone '${zone}' combines sensitive-read and network-egress`
      );
    }
  }
}

function normalize(document: MoatfileDocument, file: string): OpenMoatConfig {
  const base = path.dirname(file);
  const stateHome =
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const archive = document.gateway.archives ?? {};
  return {
    configFile: file,
    inlineServers: normalizeServers(document.gateway.servers, base),
    secretsEnv: absoluteFrom(
      base,
      document.paths?.secrets ?? "./secrets.env"
    ),
    stateDir: absoluteFrom(
      base,
      document.paths?.state ?? path.join(stateHome, "openmoat")
    ),
    gatewayPolicy: {
      default: "deny",
      agents: document.gateway.callers,
    },
    gatewayZones: Object.fromEntries(
      Object.entries(document.gateway.zones ?? {}).map(([name, zone]) => [
        name,
        { allowMixedRisk: zone.allowMixedRisk === true },
      ])
    ),
    gatewayLimits: {
      maxPools: document.gateway.limits?.maxPools ?? 32,
      maxPoolsPerServer:
        document.gateway.limits?.maxPoolsPerServer ?? 8,
      idleTimeoutMs:
        document.gateway.limits?.idleTimeoutMs ?? 300_000,
    },
    archiveLimits: {
      maxBlobBytes: archive.maxBlobBytes ?? 1_048_576,
      maxCallerBytes: archive.maxCallerBytes ?? 16_777_216,
      maxCallerEntries: archive.maxCallerEntries ?? 64,
      ttlMs: (archive.ttlDays ?? 14) * 86_400_000,
    },
    prewarm: document.prewarm ?? [],
  };
}

export function loadConfig(root?: string): OpenMoatConfig {
  return loadConfigFile(configFile(root));
}

export function loadConfigFile(input: string): OpenMoatConfig {
  const file = path.resolve(expandHome(input));
  let document: unknown;
  try {
    document = parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `invalid Moatfile: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const validate = validator();
  if (!validate(document)) {
    const details = (validate.errors ?? [])
      .map(
        (error) =>
          `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
      )
      .join("; ");
    throw new Error(`invalid Moatfile: ${details}`);
  }
  validateSemantics(document as MoatfileDocument);
  return normalize(document as MoatfileDocument, file);
}
