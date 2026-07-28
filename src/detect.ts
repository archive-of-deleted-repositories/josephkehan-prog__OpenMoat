import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HubConfig } from "./config.js";

export type DetectionEvidenceKind = "config" | "command" | "application" | "support-directory";

export interface DetectionEvidence {
  kind: DetectionEvidenceKind;
  value: string;
}

export interface DetectedTarget {
  id: string;
  enabled: boolean;
  config: string;
  configExists: boolean;
  detected: boolean;
  evidence: DetectionEvidence[];
  recommendation: "keep-enabled" | "enable-after-review" | "review-enabled-target" | "no-action";
}

export interface DetectionReport {
  readOnly: true;
  configFile?: string;
  detectedTargets: string[];
  recommendedTargets: string[];
  targets: DetectedTarget[];
}

export interface DetectionOptions {
  configFile?: string;
  home?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  pathext?: string;
}

interface TargetSignals {
  commands?: string[];
  macApplications?: string[];
}

const SIGNALS: Record<string, TargetSignals> = {
  codex: { commands: ["codex"] },
  "claude-code": { commands: ["claude"] },
  "claude-desktop": { macApplications: ["Claude.app"] },
  hermes: { commands: ["hermes"] },
  opencode: { commands: ["opencode"] },
  cursor: { commands: ["cursor"], macApplications: ["Cursor.app"] },
  pi: { commands: ["pi"] },
  senpi: { commands: ["senpi"] },
  zed: { commands: ["zed"], macApplications: ["Zed.app"] },
  continue: { commands: ["continue"] },
  warp: { commands: ["warp"], macApplications: ["Warp.app"] },
  factory: { commands: ["droid", "factory"] },
  vscode: { commands: ["code"], macApplications: ["Visual Studio Code.app"] },
};

function commandCandidates(command: string, platform: NodeJS.Platform, pathext: string): string[] {
  if (platform !== "win32") return [command];
  if (path.extname(command)) return [command];
  const extensions = pathext
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function findCommand(command: string, options: Required<Pick<DetectionOptions, "pathEnv" | "platform" | "pathext">>): string | undefined {
  for (const directory of options.pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const candidate of commandCandidates(command, options.platform, options.pathext)) {
      const file = path.join(directory, candidate);
      try {
        fs.accessSync(file, options.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // A missing or non-executable PATH entry is simply not evidence.
      }
    }
  }
  return undefined;
}

function macApplicationPaths(name: string, home: string): string[] {
  return [path.join("/Applications", name), path.join(home, "Applications", name)];
}

function addEvidence(list: DetectionEvidence[], evidence: DetectionEvidence): void {
  if (!list.some((item) => item.kind === evidence.kind && item.value === evidence.value)) {
    list.push(evidence);
  }
}

/**
 * Inspect installation signals without parsing or writing any harness file.
 * Existing config files are treated only as presence evidence; adapter-level
 * correctness remains the responsibility of `hub doctor` and `hub sync --dry-run`.
 */
export function detectTargets(cfg: HubConfig, options: DetectionOptions = {}): DetectionReport {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const pathext = options.pathext ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const targets: DetectedTarget[] = [];

  for (const [id, target] of Object.entries(cfg.targets)) {
    const evidence: DetectionEvidence[] = [];
    const configExists = fs.existsSync(target.config);
    if (configExists) addEvidence(evidence, { kind: "config", value: target.config });

    const supportDir = path.dirname(target.config);
    if (!configExists && supportDir !== home && fs.existsSync(supportDir)) {
      addEvidence(evidence, { kind: "support-directory", value: supportDir });
    }

    const signals = SIGNALS[id] ?? {};
    for (const command of signals.commands ?? []) {
      const executable = findCommand(command, { pathEnv, platform, pathext });
      if (executable) addEvidence(evidence, { kind: "command", value: executable });
    }

    if (platform === "darwin") {
      for (const application of signals.macApplications ?? []) {
        const installed = macApplicationPaths(application, home).find((candidate) => fs.existsSync(candidate));
        if (installed) addEvidence(evidence, { kind: "application", value: installed });
      }
    }

    const detected = evidence.length > 0;
    const recommendation = target.enabled
      ? detected
        ? "keep-enabled"
        : "review-enabled-target"
      : detected
        ? "enable-after-review"
        : "no-action";

    targets.push({
      id,
      enabled: target.enabled,
      config: target.config,
      configExists,
      detected,
      evidence,
      recommendation,
    });
  }

  return {
    readOnly: true,
    configFile: options.configFile,
    detectedTargets: targets.filter((target) => target.detected).map((target) => target.id),
    recommendedTargets: targets
      .filter((target) => target.recommendation === "enable-after-review")
      .map((target) => target.id),
    targets,
  };
}

function tildify(value: string, home = os.homedir()): string {
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export function renderDetection(report: DetectionReport, includeAll = false): string {
  const visible = report.targets.filter((target) => includeAll || target.enabled || target.detected);
  const lines = ["Read-only harness detection — no files changed."];

  for (const target of visible) {
    const state = target.enabled
      ? target.detected
        ? "enabled"
        : "enabled; installation not verified"
      : "available; disabled";
    lines.push(`\n[${target.id}] ${state}`);
    lines.push(`  config: ${tildify(target.config)}${target.configExists ? " (exists)" : ""}`);
    for (const evidence of target.evidence) {
      lines.push(`  evidence: ${evidence.kind} ${tildify(evidence.value)}`);
    }
  }

  if (visible.length === 0) lines.push("\nNo installed harnesses were detected from configs, commands, or applications.");
  if (report.recommendedTargets.length > 0) {
    lines.push(`\nSuggested after review: ${report.recommendedTargets.join(", ")}`);
    if (report.configFile) lines.push(`Hub config: ${tildify(report.configFile)}`);
    lines.push(`Preview selection: hub configure ${report.recommendedTargets.join(" ")}`);
  }
  lines.push("Then run: hub doctor && hub sync --dry-run");
  lines.push("Run `hub detect --all` to include targets with no installation evidence.");
  return lines.join("\n");
}
