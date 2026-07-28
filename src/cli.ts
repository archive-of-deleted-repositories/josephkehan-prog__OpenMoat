#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSafe } from "./backup.js";
import { configFile, loadConfig } from "./config.js";
import {
  federatedPluginSurface,
  federatedPlugins,
  getFederationSnapshot,
  invalidateFederationCache,
  renderFederatedPlugins,
  renderFederation,
} from "./federation.js";
import { Rag } from "./rag.js";
import { serve } from "./server.js";
import { runDoctorReport, runSync } from "./sync.js";
import { HUB_VERSION } from "./version.js";

const program = new Command();
program
  .option("--file <path>", "Moatfile path (overrides OPENMOAT_FILE)")
  .hook("preAction", (command) => {
    const file = command.optsWithGlobals().file as string | undefined;
    if (file) process.env.OPENMOAT_FILE = file;
  });
program
  .command("federation")
  .description("Show federated skill, MCP, and plugin sources, winners, conflicts, and warnings")
  .option("--json", "machine-readable snapshot")
  .action((opts: { json?: boolean }) => {
    const snapshot = getFederationSnapshot(loadConfig(), true);
    if (opts.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    console.log(renderFederation(snapshot));
  });

program
  .name("moat")
  .version(HUB_VERSION)
  .description("OpenMoat: local-first MCP gateway, reconciliation, profile, handoffs, and optional shared-brain modules.");

program
  .command("demo [directory]")
  .description("Run the real federation/sync pipeline against isolated synthetic harness files")
  .option("--json", "machine-readable proof summary")
  .action(async (directory: string | undefined, opts: { json?: boolean }) => {
    const { runPortableDemo } = await import("./demo.js");
    const result = runPortableDemo(directory);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log("PASS isolated starter made no live harness writes");
    console.log(
      `PASS federated ${result.selected.skills} skill, ${result.selected.servers} MCP servers, and ${result.selected.plugins} plugin`
    );
    console.log(`PASS synchronized ${result.targets.join(", ")} through their real adapters`);
    console.log("PASS second sync was idempotent");
    console.log(
      result.preserved
        ? `demo workspace preserved at ${result.workspace}`
        : "temporary demo workspace removed"
    );
  });

program
  .command("detect")
  .description("Read-only scan for installed harnesses and safe enablement suggestions")
  .option("--all", "include targets with no installation evidence")
  .option("--json", "machine-readable detection report")
  .action(async (opts: { all?: boolean; json?: boolean }) => {
    const { detectTargets, renderDetection } = await import("./detect.js");
    const report = detectTargets(loadConfig(), { configFile: configFile() });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderDetection(report, opts.all ?? false));
  });

program
  .command("configure <targets...>")
  .description("Preview target enablement in the Moatfile; --apply writes only that file")
  .option("--disable", "disable the named targets instead of enabling them")
  .option("--apply", "apply after reviewing the default preview")
  .option("--json", "machine-readable configuration result")
  .action(async (targets: string[], opts: { disable?: boolean; apply?: boolean; json?: boolean }) => {
    const cfg = loadConfig();
    const { configureTargets, renderTargetConfiguration } = await import("./configure.js");
    const result = configureTargets(
      configFile(),
      cfg.stateDir,
      targets,
      !(opts.disable ?? false),
      opts.apply ?? false
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderTargetConfiguration(result));
  });

program
  .command("init [directory]")
  .description("Create an isolated portable starter workspace (all harness targets disabled)")
  .option("--force", "overwrite starter-managed files in a non-empty directory")
  .action(async (directory: string | undefined, opts: { force?: boolean }) => {
    const os = await import("node:os");
    const path = await import("node:path");
    const { initWorkspace } = await import("./init.js");
    const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    const destination = directory ?? path.join(configHome, "openmoat");
    const result = initWorkspace(destination, opts.force ?? false);
    console.log(`initialized ${result.dir}`);
    for (const file of result.created) console.log(`  ${file}`);
    console.log(`\nexport OPENMOAT_FILE=${result.config}`);
    console.log("run `moat detect`, then preview selection with: moat configure <targets...>");
    console.log("after explicit --apply, run: moat doctor && moat sync --dry-run");
  });

program
  .command("validate")
  .description("Validate the selected Moatfile")
  .option("--json", "machine-readable result")
  .action((opts: { json?: boolean }) => {
    try {
      loadConfig();
      const result = { ok: true };
      console.log(opts.json ? JSON.stringify(result) : "Moatfile is valid");
    } catch (error) {
      const result = {
        ok: false,
        error: {
          code: "INVALID_CONFIG",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      console.log(opts.json ? JSON.stringify(result) : result.error.message);
      process.exitCode = 1;
    }
  });

program
  .command("conformance")
  .description("Evaluate one OpenMoat conformance case")
  .requiredOption("--case <file>", "case JSON file")
  .option("--json", "machine-readable result")
  .action(async (opts: { case: string; json?: boolean }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { evaluateConformanceCase } = await import("./conformance.js");
    const caseFile = path.resolve(opts.case);
    const value = JSON.parse(fs.readFileSync(caseFile, "utf8")) as {
      operation: string;
      input: Record<string, unknown>;
    };
    const result = evaluateConformanceCase(value, caseFile);
    console.log(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  });

program
  .command("migrate-config <legacy-json> <Moatfile>")
  .description("Migrate configuration only; secrets and runtime state are never copied")
  .action(async (legacy: string, destination: string) => {
    const { migrateLegacyConfig } = await import("./integrations.js");
    console.log(`wrote ${migrateLegacyConfig(legacy, destination).destination}`);
  });

program
  .command("chezmoi-export <destination>")
  .description("Copy the selected Moatfile into a chezmoi source tree without invoking chezmoi")
  .action(async (destination: string) => {
    const { exportChezmoi } = await import("./integrations.js");
    console.log(`wrote ${exportChezmoi(configFile(), destination).destination}`);
  });

program
  .command("sync")
  .description("Write MCP servers, skills links, and profile blocks into every enabled harness config")
  .option("--dry-run", "show what would change without writing")
  .option("--only <target>", "sync a single target (any enabled target id, e.g. codex|claude-code|kimi-code|kimi)")
  .option("--json", "machine-readable sync or preview report")
  .action((opts: { dryRun?: boolean; only?: string; json?: boolean }) => {
    const report = runSync(loadConfig(), { dryRun: opts.dryRun, only: opts.only });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    for (const line of report.lines) console.log(line);
    if (!opts.dryRun) console.log("\nDone. Restart live sessions (hermes gateway restart / new Claude Code session / restart Claude Desktop).");
  });

program
  .command("serve")
  .description("Run the OpenMoat MCP server over stdio")
  .action(async () => {
    await serve(loadConfig());
  });

program
  .command("doctor")
  .description("Check registry, skills, profile files, and each harness config (incl. squish presence)")
  .option("--json", "machine-readable structured checks")
  .option("--strict", "exit nonzero when warnings or errors remain")
  .action((opts: { json?: boolean; strict?: boolean }) => {
    const report = runDoctorReport(loadConfig());
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const check of report.checks) console.log(check.message);
      console.log(
        `doctor: ${report.healthy ? "healthy" : "errors found"} — ${report.summary.ok} ok, ${report.summary.disabled} disabled, ${report.summary.warning} warning, ${report.summary.error} error (read-only)`
      );
    }
    if (opts.strict && !report.ready) process.exitCode = 1;
  });

program
  .command("index")
  .description("(Re)index the RAG corpus")
  .option("--force", "re-index everything, not just changed files")
  .action(async (opts: { force?: boolean }) => {
    const cfg = loadConfig();
    const rag = new Rag(cfg);
    const r = await rag.index(opts.force ?? false);
    const s = rag.stats();
    console.log(`indexed ${r.indexed}, unchanged ${r.skipped}, embeddings ${r.embedded ? "on" : "off (FTS-only — is Ollama running?)"}`);
    console.log(`corpus: ${s.files} files, ${s.chunks} chunks, ${s.withEmbeddings} embedded`);
    rag.close();
  });

program
  .command("search <query...>")
  .description("Search the RAG corpus from the terminal")
  .option("-k <n>", "results", "6")
  .action(async (queryParts: string[], opts: { k: string }) => {
    const cfg = loadConfig();
    const rag = new Rag(cfg);
    await rag.index();
    const hits = await rag.search(queryParts.join(" "), parseInt(opts.k, 10) || 6);
    for (const h of hits) console.log(`\n[${h.score}] ${h.file} › ${h.heading}\n${h.snippet.slice(0, 300)}`);
    if (!hits.length) console.log("No matches.");
    rag.close();
  });

program
  .command("mcp-index")
  .description("Catalog tools + ingest resources from every registry MCP server, then re-index the RAG")
  .action(async () => {
    const cfg = loadConfig();
    const { refreshMcpCatalog } = await import("./mcp-rag.js");
    for (const n of await refreshMcpCatalog(cfg)) console.log(n);
    const rag = new Rag(cfg);
    const r = await rag.index();
    console.log(`re-indexed ${r.indexed} file(s)`);
    rag.close();
  });

program
  .command("evaluate")
  .description("Self-evaluation: scan recent transcripts for gateway misses, reinforce/decay instincts")
  .option("--days <n>", "how many days of transcripts to scan", "3")
  .option("--no-tune", "report only, don't touch instincts")
  .action(async (opts: { days: string; tune: boolean }) => {
    const cfg = loadConfig();
    const { evaluate } = await import("./evaluate.js");
    const res = await evaluate(cfg, { days: parseInt(opts.days, 10) || 3, tune: opts.tune });
    console.log(res.report);
    if (res.reinforced.length) {
      const { runSync } = await import("./sync.js");
      console.log("\npublishing promoted instincts via sync…");
      for (const l of runSync(cfg, {}).lines.filter((x) => x.includes("gateway"))) console.log(l);
    }
  });

program
  .command("instincts")
  .description("List learned instincts; --export/--import share them as a pack (ECC-style)")
  .option("--export <file>", "write an instinct pack")
  .option("--import <file>", "merge an instinct pack")
  .action(async (opts: { export?: string; import?: string }) => {
    const cfg = loadConfig();
    const inst = await import("./instincts.js");
    if (opts.export) {
      const fs = await import("node:fs");
      fs.writeFileSync(opts.export, inst.exportPack(cfg));
      console.log(`instinct pack written to ${opts.export}`);
      return;
    }
    if (opts.import) {
      const fs = await import("node:fs");
      const r = inst.importPack(cfg, fs.readFileSync(opts.import, "utf8"));
      console.log(`imported: ${r.added} new, ${r.merged} merged — run \`hub sync\` to publish promoted instincts`);
      return;
    }
    for (const i of inst.loadInstincts(cfg).sort((a, b) => b.confidence - a.confidence))
      console.log(`[${i.confidence.toFixed(2)}] (${i.category}, ${i.evidence.length} evidence) ${i.rule}`);
  });

program
  .command("discover <query...>")
  .description("Search the awesome-mcp-servers aggregator for servers to adopt")
  .option("-k <n>", "results", "8")
  .option("--refresh", "re-fetch the aggregator (cached 24h)")
  .option("--runnable", "only entries with a run command")
  .option("--add <name>", "adopt a discovered server by name (quarantined)")
  .action(async (queryParts: string[], opts: { k: string; refresh?: boolean; runnable?: boolean; add?: string }) => {
    const cfg = loadConfig();
    const { discover, candidateToEntry } = await import("./discover.js");
    const hits = await discover(cfg, queryParts.join(" "), {
      k: opts.add ? 30 : parseInt(opts.k, 10) || 8,
      refresh: opts.refresh,
      runnableOnly: opts.runnable,
    });
    if (opts.add) {
      const c = hits.find((h) => h.name.toLowerCase() === opts.add!.toLowerCase());
      if (!c) return console.log(`'${opts.add}' not in the top matches for that query — refine the query so it appears.`);
      let entry: ReturnType<typeof candidateToEntry>;
      try {
        entry = candidateToEntry(c);
      } catch (e) {
        return console.log(String(e instanceof Error ? e.message : e));
      }
      const fs = await import("node:fs");
      const raw = JSON.parse(fs.readFileSync(cfg.registry, "utf8"));
      if (raw.servers.some((s: { name: string }) => s.name === entry.name)) return console.log(`'${entry.name}' already in registry.`);
      raw.servers.push(entry);
      writeFileSafe(cfg.registry, JSON.stringify(raw, null, 2) + "\n", cfg.stateDir, false);
      invalidateFederationCache(cfg);
      console.log(`adopted '${entry.name}' QUARANTINED (${entry.command} ${(entry.args as string[]).join(" ")}). Approve: hub trust ${entry.name}`);
      return;
    }
    for (const h of hits) {
      console.log(`\n[${h.score}] ${h.name}  ${h.repo}`);
      console.log(`  ${h.description}`);
      if (h.command) console.log(`  run: ${h.command}`);
    }
    if (hits.length) console.log(`\nadopt one:  hub discover ${queryParts.join(" ")} --add "<name>"`);
  });

program
  .command("adopt")
  .description("Pull drift back: servers found in harness configs but missing from the registry are adopted (gatewayOnly + quarantined)")
  .option("--dry-run", "report only")
  .action(async (opts: { dryRun?: boolean }) => {
    const { adopt } = await import("./adopt.js");
    for (const l of adopt(loadConfig(), opts.dryRun ?? false)) console.log(l);
  });

program
  .command("auth <name>")
  .description("Authorize an OAuth remote server once (opens browser; tokens cached for all agents)")
  .action(async (name: string) => {
    const cfg = loadConfig();
    const { gatewayDescribe, reapAll } = await import("./gateway.js");
    const out = await gatewayDescribe(cfg, name, undefined, "hub-cli");
    const tools = out.split("\n").filter((l) => l.startsWith("## ")).length;
    console.log(`authorized — '${name}' responds with ${tools} tool(s). Tokens cached in state/oauth/; every agent can now reach it via tool_call.`);
    reapAll();
    process.exit(0);
  });

program
  .command("backup")
  .description("Back up non-rebuildable state under the XDG state directory — keeps last 14")
  .option("--dest <dir>", "override destination directory")
  .action(async (opts: { dest?: string }) => {
    const { backupState } = await import("./backup.js");
    console.log(`state backed up to ${backupState(loadConfig().stateDir, opts.dest)}`);
  });

program
  .command("trust <name>")
  .description("Approve a quarantined server so the gateway will call it")
  .action(async (name: string) => {
    const { trust } = await import("./adopt.js");
    console.log(trust(loadConfig(), name));
  });

program
  .command("usage")
  .description("Per-agent tool-call tracker: which agent called which tool through the hub")
  .option("--agent <name>", "filter to one agent (harness clientInfo name)")
  .option("--server <name>", "filter to one upstream server")
  .option("--hours <n>", "window by last-call time", "24")
  .option("--recent <n>", "also show the last N raw usage events")
  .action(async (opts: { agent?: string; server?: string; hours: string; recent?: string }) => {
    const cfg = loadConfig();
    const { getHealth } = await import("./health.js");
    console.log(
      getHealth(cfg).usageReport({
        agent: opts.agent,
        server: opts.server,
        sinceMs: (parseInt(opts.hours, 10) || 24) * 3600_000,
      })
    );
    if (opts.recent) {
      const { recentUsageEvents } = await import("./server.js");
      console.log(`\nRECENT EVENTS (last ${opts.recent}):\n${recentUsageEvents(cfg, parseInt(opts.recent, 10) || 20)}`);
    }
  });

program
  .command("skills")
  .description("Show every skill on the hub, grouped by collection (the human-readable catalog)")
  .option("--json", "machine-readable dump")
  .option("--md <file>", "write a markdown catalog")
  .option("--html <file>", "write a self-contained searchable HTML catalog page")
  .action(async (opts: { json?: boolean; md?: string; html?: string }) => {
    const cfg = loadConfig();
    const snapshot = getFederationSnapshot(cfg, true);
    const roots = snapshot.sources.flatMap((source) => source.skillRoots);
    const { groupSkills, renderText, renderMarkdown, renderHtml, rootLabel } = await import("./skills-report.js");
    const groups = groupSkills(
      snapshot.skills.filter((asset) => asset.selected).map((asset) => asset.value),
      roots
    );
    if (opts.json) {
      const flat = snapshot.skills.map((asset) => ({
        id: asset.id,
        selected: asset.selected,
        source: asset.source,
        name: asset.name,
        dir: asset.value.dir,
        description: asset.value.description,
      }));
      console.log(JSON.stringify(flat, null, 2));
      return;
    }
    const fs = await import("node:fs");
    if (opts.md) {
      fs.writeFileSync(opts.md, renderMarkdown(groups));
      console.log(`markdown catalog written to ${opts.md}`);
    }
    if (opts.html) {
      fs.writeFileSync(opts.html, renderHtml(groups));
      console.log(`HTML catalog written to ${opts.html} — open it:  open ${opts.html}`);
    }
    if (!opts.md && !opts.html) {
      console.log(renderText(groups));
      console.log(`roots: ${roots.map((r) => rootLabel(r)).join(", ")}`);
      console.log(
        `publish a skill: add it to any configured federation skill root (picked up automatically)`
      );
    }
  });

program
  .command("plugins")
  .description("Show selected plugins across all federated stores and catalogs")
  .option("--json", "machine-readable dump")
  .option("--md <file>", "write a markdown catalog")
  .option("--html <file>", "write a self-contained searchable HTML catalog page")
  .action(async (opts: { json?: boolean; md?: string; html?: string }) => {
    const cfg = loadConfig();
    const plugins = federatedPlugins(cfg);
    if (opts.json) {
      console.log(JSON.stringify(plugins, null, 2));
      return;
    }
    const fs = await import("node:fs");
    const {
      renderPluginsMarkdown,
      renderPluginsHtml,
    } = await import("./plugins.js");
    const surface = federatedPluginSurface(plugins);
    if (opts.md) {
      fs.writeFileSync(opts.md, renderPluginsMarkdown(surface));
      console.log(`markdown catalog written to ${opts.md}`);
    }
    if (opts.html) {
      fs.writeFileSync(opts.html, renderPluginsHtml(surface));
      console.log(`HTML catalog written to ${opts.html} — open it:  open ${opts.html}`);
    }
    if (!opts.md && !opts.html) console.log(renderFederatedPlugins(plugins));
  });

program
  .command("list")
  .description("Show registry servers and skills")
  .action(() => {
    const cfg = loadConfig();
    const snapshot = getFederationSnapshot(cfg, true);
    console.log("servers:");
    for (const asset of snapshot.servers) {
      const server = asset.value;
      console.log(
        `  ${asset.selected ? "*" : "-"} ${server.disabled ? "[off] " : ""}${asset.id} (${server.transport ?? "stdio"})`
      );
    }
    console.log("skills:");
    for (const asset of snapshot.skills) {
      console.log(
        `  ${asset.selected ? "*" : "-"} ${asset.id} — ${asset.value.description.slice(0, 80)}`
      );
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
