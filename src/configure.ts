import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { writeFileSafe } from "./backup.js";

interface RawTarget {
  enabled?: unknown;
  [key: string]: unknown;
}

interface RawHubConfig {
  targets?: Record<string, RawTarget>;
  [key: string]: unknown;
}

export interface TargetConfigurationChange {
  id: string;
  before: boolean;
  after: boolean;
}

export interface TargetConfigurationResult {
  configFile: string;
  operation: "enable" | "disable";
  requestedTargets: string[];
  changes: TargetConfigurationChange[];
  changed: boolean;
  applied: boolean;
  backup: string | null;
  harnessFilesWritten: false;
}

function readRawConfig(file: string): {
  raw: RawHubConfig;
  serialize: (changes: TargetConfigurationChange[]) => string;
} {
  const source = fs.readFileSync(file, "utf8");
  const json = path.extname(file).toLowerCase() === ".json";
  const document = json ? undefined : parseDocument(source);
  const raw = (json ? JSON.parse(source) : document!.toJS()) as RawHubConfig;
  if (!raw.targets || typeof raw.targets !== "object" || Array.isArray(raw.targets)) {
    throw new Error(`${file} has no targets object`);
  }
  return {
    raw,
    serialize: (changes) => {
      if (json) return `${JSON.stringify(raw, null, 2)}\n`;
      for (const change of changes) {
        document!.setIn(["targets", change.id, "enabled"], change.after);
      }
      return document!.toString();
    },
  };
}

/**
 * Preview or apply explicit target enablement in the Hub config only. This
 * function never invokes an adapter, so it cannot create or modify a harness
 * configuration file. Applying uses the same backup + atomic rename path as
 * normal Hub synchronization.
 */
export function configureTargets(
  file: string,
  stateDir: string,
  ids: string[],
  enabled: boolean,
  apply = false
): TargetConfigurationResult {
  file = path.resolve(file);
  const parsed = readRawConfig(file);
  const raw = parsed.raw;
  const targets = raw.targets!;
  const requestedTargets = [...new Set(ids)];
  if (requestedTargets.length === 0) throw new Error("name at least one target");

  const unknown = requestedTargets.filter((id) => !Object.hasOwn(targets, id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown target${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")} (known: ${Object.keys(targets).join(", ")})`
    );
  }

  const changes = requestedTargets
    .map((id) => ({ id, before: targets[id].enabled === true, after: enabled }))
    .filter((change) => change.before !== change.after);

  let backup: string | null = null;
  if (apply && changes.length > 0) {
    for (const change of changes) targets[change.id].enabled = change.after;
    backup = writeFileSafe(file, parsed.serialize(changes), stateDir, false);
  }

  return {
    configFile: file,
    operation: enabled ? "enable" : "disable",
    requestedTargets,
    changes,
    changed: changes.length > 0,
    applied: apply && changes.length > 0,
    backup,
    harnessFilesWritten: false,
  };
}

export function renderTargetConfiguration(result: TargetConfigurationResult): string {
  const heading = result.applied
    ? "APPLIED Hub target configuration."
    : result.changed
      ? "PREVIEW Hub target configuration — no files changed."
      : "NO CHANGES required in Hub target configuration.";
  const lines = [heading];

  for (const change of result.changes) {
    lines.push(`  ${change.id}: ${change.before ? "enabled" : "disabled"} -> ${change.after ? "enabled" : "disabled"}`);
  }
  if (result.changes.length === 0) {
    lines.push(`  ${result.requestedTargets.join(", ")} already ${result.operation === "enable" ? "enabled" : "disabled"}`);
  }

  lines.push(`Hub config: ${result.configFile}`);
  if (result.backup) lines.push(`Backup: ${result.backup}`);
  lines.push("Harness files written: none.");
  if (result.changed && !result.applied) {
    lines.push("Review the target list, then re-run this command with --apply.");
  } else {
    lines.push("Next: hub doctor && hub sync --dry-run");
  }
  return lines.join("\n");
}
