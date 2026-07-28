import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface ExportResult {
  source: string;
  destination: string;
}

export function exportChezmoi(source: string, destination: string): ExportResult {
  const input = path.resolve(source);
  const output = path.resolve(destination);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(input, output);
  return { source: input, destination: output };
}

interface LegacyConfig {
  targets?: Record<string, Record<string, unknown>>;
  gatewayPolicy?: {
    agents?: Record<string, { allow?: string[]; deny?: string[] }>;
  };
}

export function migrateLegacyConfig(source: string, destination: string): ExportResult {
  const input = path.resolve(source);
  const output = path.resolve(destination);
  const legacy = JSON.parse(fs.readFileSync(input, "utf8")) as LegacyConfig;
  const document = {
    apiVersion: "openmoat.dev/v1",
    kind: "Moatfile",
    features: {
      reconcile: true,
      gateway: true,
      profile: true,
      handoffs: true,
      rag: false,
      embeddings: false,
      skills: false,
      plugins: false,
      instincts: false,
    },
    targets: legacy.targets ?? {},
    gateway: {
      callers: legacy.gatewayPolicy?.agents ?? {},
      servers: {},
    },
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, stringify(document), "utf8");
  return { source: input, destination: output };
}

export function isCanonicalMoatfile(source: string): boolean {
  const document = parse(source) as { apiVersion?: unknown; kind?: unknown } | null;
  return document?.apiVersion === "openmoat.dev/v1" && document.kind === "Moatfile";
}

