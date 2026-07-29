#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { trustServer } from "./admin.js";
import { loadCatalog, refreshCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { createGatewayRuntime } from "./gateway-runtime.js";
import { getHealth } from "./health.js";
import { initWorkspace } from "./init.js";
import { serve } from "./server.js";
import { OPENMOAT_VERSION } from "./version.js";

const program = new Command();
program
  .name("moat")
  .version(OPENMOAT_VERSION)
  .description(
    "OpenMoat: local security gateway for MCP with deny-by-default policy and stateless protocol support."
  )
  .option(
    "--file <path>",
    "Moatfile path (overrides OPENMOAT_FILE)"
  )
  .hook("preAction", (command) => {
    const file = command.optsWithGlobals().file as string | undefined;
    if (file) process.env.OPENMOAT_FILE = path.resolve(file);
  });

program
  .command("init [directory]")
  .description("Create one Moatfile plus private local state")
  .option("--force", "overwrite starter-managed files")
  .action(
    (directory: string | undefined, options: { force?: boolean }) => {
      const destination =
        directory ??
        path.join(
          process.env.XDG_CONFIG_HOME ??
            path.join(os.homedir(), ".config"),
          "openmoat"
        );
      const result = initWorkspace(
        destination,
        options.force ?? false
      );
      console.log(`initialized ${result.dir}`);
      console.log(`export OPENMOAT_FILE=${result.config}`);
      console.log("next: edit the Moatfile, then run `moat validate`");
    }
  );

program
  .command("validate")
  .description("Validate the selected Moatfile")
  .option("--json", "machine-readable result")
  .action((options: { json?: boolean }) => {
    try {
      loadConfig();
      console.log(options.json ? '{"ok":true}' : "Moatfile is valid");
    } catch (error) {
      const result = {
        ok: false,
        error: {
          code: "INVALID_CONFIG",
          message:
            error instanceof Error ? error.message : String(error),
        },
      };
      console.log(
        options.json
          ? JSON.stringify(result)
          : result.error.message
      );
      process.exitCode = 1;
    }
  });

program
  .command("serve")
  .description(
    "Serve MCP over stdio (2025-11-25 and stateless 2026-07-28)"
  )
  .action(async () => {
    await serve(loadConfig());
  });

program
  .command("doctor")
  .description("Run read-only local security and readiness checks")
  .option("--json", "machine-readable report")
  .option("--strict", "exit nonzero for warnings as well as errors")
  .action((options: { json?: boolean; strict?: boolean }) => {
    const report = runDoctor(loadConfig());
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const check of report.checks) {
        console.log(`[${check.status}] ${check.code}: ${check.message}`);
      }
    }
    if (
      !report.ready ||
      (options.strict &&
        report.checks.some((check) => check.status === "warning"))
    ) {
      process.exitCode = 1;
    }
  });

program
  .command("auth <server>")
  .description(
    "Human-only OAuth authorization for one downstream HTTP server"
  )
  .action(async (server: string) => {
    const runtime = createGatewayRuntime(loadConfig());
    try {
      const description = await runtime.authorize(server);
      const count = [...description.matchAll(/^Tool: /gm)].length;
      console.log(`authorized '${server}' (${count} tool(s))`);
    } finally {
      runtime.close();
    }
  });

program
  .command("trust <server>")
  .description("Human-only approval of one quarantined server")
  .action((server: string) => {
    console.log(trustServer(loadConfig(), server));
  });

program
  .command("catalog")
  .description("Inspect or human-refresh derived tool metadata")
  .option("--refresh", "connect to trusted servers and rebuild")
  .option("--json", "machine-readable catalog")
  .action(
    async (options: { refresh?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      let refreshNotes: string[] = [];
      if (options.refresh) {
        const runtime = createGatewayRuntime(cfg);
        try {
          refreshNotes = await refreshCatalog(cfg, runtime);
        } finally {
          runtime.close();
        }
      }
      const catalog = loadCatalog(cfg);
      if (options.json) {
        console.log(
          JSON.stringify({ ...catalog, refreshNotes }, null, 2)
        );
      } else {
        for (const note of refreshNotes) console.log(note);
        console.log(
          `${catalog.entries.length} tool(s); generated ${
            catalog.generatedAt || "never"
          }`
        );
      }
    }
  );

program
  .command("usage")
  .description("Show privacy-bounded aggregate gateway usage")
  .option("--caller <name>", "filter to one caller")
  .option("--server <name>", "filter to one downstream server")
  .action((options: { caller?: string; server?: string }) => {
    const cfg = loadConfig();
    console.log(
      getHealth(cfg).usageReport({
        agent: options.caller,
        server: options.server,
      })
    );
  });

program
  .command("list")
  .description("List configured servers without secret-bearing fields")
  .action(() => {
    for (const server of loadConfig().inlineServers) {
      const trust = server.disabled
        ? "disabled"
        : server.trusted === false
          ? "quarantined"
          : "trusted";
      console.log(
        `${server.name}\t${server.transport ?? "stdio"}\t${trust}\tzone=${server.zone ?? "default"}`
      );
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
