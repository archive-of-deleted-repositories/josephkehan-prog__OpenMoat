#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(command, args, options = {}) {
  const { echo = true, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...spawnOptions,
  });
  if (echo) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`
    );
  }
  return result.stdout;
}

run("npm", ["run", "build"]);
run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["run", "test:coverage"]);
run("npm", ["audit"]);
run("gitleaks", ["detect", "--no-banner", "--redact"]);
run("git", ["diff", "--check"]);

const tracked = run("git", [
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
], { echo: false })
  .split("\0")
  .filter(Boolean)
  .filter(
    (file) =>
      file !== "LICENSE" &&
      file !== "scripts/verify.mjs" &&
      !file.startsWith("docs/testing/")
  );
const privateEvidence =
  /\/Users\/|boredinnyc|josephhan|~\/mac|the-agency|agent-hub|AGENT_HUB/;
for (const file of tracked) {
  if (!fs.existsSync(file)) continue;
  const stat = fs.statSync(file);
  if (!stat.isFile()) continue;
  if (privateEvidence.test(fs.readFileSync(file, "utf8"))) {
    throw new Error(`provenance scan failed: ${file}`);
  }
}

const source = fs.readFileSync("src/server.ts", "utf8");
for (const tool of [
  "tool_search",
  "tool_describe",
  "tool_call",
  "tool_result_fetch",
  "moat_health",
  "moat_usage",
  "registry_list",
]) {
  if (!source.includes(`"${tool}"`)) {
    throw new Error(`required tool missing: ${tool}`);
  }
}

const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "openmoat-release-")
);
try {
  const packOutput = run(
    "npm",
    ["pack", "--pack-destination", temporary, "--json"],
    { echo: false }
  );
  const payload = JSON.parse(packOutput);
  const packedFiles = payload[0].files.map((entry) => entry.path);
  const forbiddenPackagePath =
    /(?:^|\/)(?:state|secrets\.env|\.env|src|test|vendor|\.ouroboros)(?:\/|$)|\.(?:py|pyc|rs|go)$/u;
  const forbiddenSurface =
    /(?:^|\/)(?:adapters?|rag|skills?|plugins?|federation|handoffs?|profiles?)(?:[./-]|$)/iu;
  for (const file of packedFiles) {
    if (forbiddenPackagePath.test(file)) {
      throw new Error(`package contains forbidden path: ${file}`);
    }
    if (forbiddenSurface.test(file)) {
      throw new Error(`package contains retired surface: ${file}`);
    }
  }

  const archive = path.join(temporary, payload[0].filename);
  const cleanRoom = path.join(temporary, "clean-room");
  fs.mkdirSync(cleanRoom);
  fs.writeFileSync(
    path.join(cleanRoom, "package.json"),
    '{"private":true}\n'
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", archive],
    { cwd: cleanRoom }
  );
  const binary = path.join(cleanRoom, "node_modules", ".bin", "moat");
  const help = run(binary, ["--help"], { cwd: cleanRoom });
  if (
    /federation|shared.brain|profile|handoff|RAG|skills|plugins|sync|adapter/i.test(
      help
    )
  ) {
    throw new Error("clean-room CLI exposes a retired surface");
  }
  const starter = path.join(cleanRoom, "starter");
  run(binary, ["init", starter], { cwd: cleanRoom });
  run(
    binary,
    ["--file", path.join(starter, "Moatfile"), "validate"],
    { cwd: cleanRoom }
  );
  console.log(
    `package inspection: ${packedFiles.length} files; clean-room smoke passed`
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
