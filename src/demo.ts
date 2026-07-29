import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { loadConfigFile, repoRoot } from "./config.js";
import {
  getFederationSnapshot,
  invalidateFederationCache,
} from "./federation.js";
import { initWorkspace } from "./init.js";
import { runSync } from "./sync.js";

const TARGETS = ["claude-desktop", "hermes", "opencode"] as const;

export interface PortableDemoResult {
  passed: true;
  workspace: string;
  preserved: boolean;
  sources: number;
  selected: {
    servers: number;
    skills: number;
    plugins: number;
  };
  targets: string[];
  dryRunChanges: number;
  synchronizedTargets: number;
  idempotent: boolean;
}

function requireDemo(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`portable demo failed: ${message}`);
}

/**
 * Exercise the installed OpenMoat's real federation and adapter pipeline without
 * reading or writing any live harness configuration. When destination is
 * omitted, the complete workspace is removed before this function returns.
 */
export function runPortableDemo(
  destination?: string,
  root = repoRoot()
): PortableDemoResult {
  const ephemeralRoot = destination
    ? undefined
    : fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-demo-"));
  const workspace = path.resolve(destination ?? path.join(ephemeralRoot!, "workspace"));
  const preserved = destination !== undefined;
  let cfg: ReturnType<typeof loadConfigFile> | undefined;

  try {
    const initialized = initWorkspace(workspace, false, root);
    const team = path.join(workspace, "team");
    const skillDir = path.join(team, "skills", "team-release");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: team-release\ndescription: Federated release review skill.\n---\n\n# Team release\n`
    );
    fs.writeFileSync(
      path.join(team, "registry.json"),
      JSON.stringify(
        {
          servers: [
            {
              name: "team-observer",
              transport: "stdio",
              command: "node",
              args: ["observer.js"],
              gatewayOnly: true,
              trusted: true,
            },
          ],
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(team, "plugins.json"),
      JSON.stringify(
        {
          plugins: [
            {
              name: "team-pack",
              ecosystem: "generic",
              collection: "portable-demo",
              version: "1.0.0",
              skills: ["team-release"],
            },
          ],
        },
        null,
        2
      ) + "\n"
    );

    const document = parseDocument(fs.readFileSync(initialized.config, "utf8"));
    const targetFiles: Record<(typeof TARGETS)[number], string> = {
      "claude-desktop": path.join(workspace, "claude-desktop.json"),
      hermes: path.join(workspace, "hermes.yaml"),
      opencode: path.join(workspace, "opencode.jsonc"),
    };
    for (const id of TARGETS) {
      document.setIn(["targets", id, "enabled"], true);
      document.setIn(["targets", id, "config"], targetFiles[id]);
    }
    document.setIn(
      ["targets", "opencode", "memoryFile"],
      path.join(workspace, "opencode-AGENTS.md")
    );
    fs.writeFileSync(initialized.config, document.toString());
    for (const file of Object.values(targetFiles)) fs.writeFileSync(file, "{}\n");

    cfg = loadConfigFile(initialized.config);
    cfg.federation = {
      includeLocal: true,
      conflictPolicy: "error",
      sources: [{
      id: "team",
      priority: 50,
      skillRoots: [path.join(team, "skills")],
      mcpRegistries: [path.join(team, "registry.json")],
      pluginCatalogs: [path.join(team, "plugins.json")],
      }],
    };
    const snapshot = getFederationSnapshot(cfg, true);
    const selected = {
      servers: snapshot.servers.filter((asset) => asset.selected).length,
      skills: snapshot.skills.filter((asset) => asset.selected).length,
      plugins: snapshot.plugins.filter((asset) => asset.selected).length,
    };
    requireDemo(snapshot.sources.some((source) => source.id === "team"), "team source missing");
    requireDemo(
      snapshot.skills.some((asset) => asset.id === "team/team-release" && asset.selected),
      "federated skill missing"
    );
    requireDemo(
      snapshot.servers.some((asset) => asset.id === "team/team-observer" && asset.selected),
      "federated MCP server missing"
    );
    requireDemo(
      snapshot.plugins.some(
        (asset) =>
          asset.id === "team/generic:portable-demo:team-pack" && asset.selected
      ),
      "federated plugin missing"
    );

    const dryRun = runSync(cfg, { dryRun: true });
    const dryRunChanges = TARGETS.filter((id) =>
      dryRun.lines.some((line) => line.startsWith(`[${id}] would update`))
    ).length;
    requireDemo(dryRun.lines.some((line) => line.includes("[DRY RUN]")), "dry-run marker missing");
    requireDemo(dryRun.readOnly && dryRun.hasChanges, "dry-run contract missing");
    requireDemo(dryRunChanges === TARGETS.length, "dry run did not cover every target");

    const synchronized = runSync(cfg);
    const synchronizedTargets = TARGETS.filter((id) =>
      synchronized.lines.some((line) => line.startsWith(`[${id}] updated`))
    ).length;
    requireDemo(
      synchronizedTargets === TARGETS.length,
      "sync did not update every target"
    );
    for (const file of Object.values(targetFiles)) {
      requireDemo(fs.readFileSync(file, "utf8").includes("openmoat"), `${file} lacks gateway`);
    }

    const second = runSync(cfg, { dryRun: true });
    const idempotent =
      !second.hasChanges &&
      TARGETS.every((id) =>
        second.lines.some((line) => line.startsWith(`[${id}] no changes`))
      );
    requireDemo(idempotent, "second sync was not idempotent");

    return {
      passed: true,
      workspace,
      preserved,
      sources: snapshot.sources.length,
      selected,
      targets: [...TARGETS],
      dryRunChanges,
      synchronizedTargets,
      idempotent,
    };
  } finally {
    if (cfg) invalidateFederationCache(cfg);
    if (ephemeralRoot) fs.rmSync(ephemeralRoot, { recursive: true, force: true });
  }
}
