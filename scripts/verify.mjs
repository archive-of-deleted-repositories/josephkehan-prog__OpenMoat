#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
}

run("npm", ["run", "build"]);
run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["run", "test:coverage"]);
run("npm", ["audit"]);
run("gitleaks", ["detect", "--no-banner", "--redact"]);
run("./scripts/update-spec.sh", []);
run("python3", [
  "vendor/spec/fixtures/official/run.py",
  "--binary",
  "node",
  "--binary",
  "dist/cli.js",
  "--file",
  "vendor/spec/fixtures/official/Moatfile",
]);
run("./scripts/run-shared-conformance.sh", []);

const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .stdout.split("\0")
  .filter(Boolean)
  .filter((file) => file !== "LICENSE" && file !== "scripts/verify.mjs");
const forbidden = /\/Users\/|boredinnyc|josephhan|~\/mac|the-agency|agent-hub|AGENT_HUB/;
for (const file of tracked) {
  if (forbidden.test(fs.readFileSync(file, "utf8"))) {
    throw new Error(`provenance scan failed: ${file}`);
  }
}

const source = fs.readFileSync("src/server.ts", "utf8");
for (const tool of [
  "tool_search",
  "tool_describe",
  "tool_call",
  "registry_list",
  "moat_health",
]) {
  if (!source.includes(`"${tool}"`)) throw new Error(`required tool missing: ${tool}`);
}

const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});
if (pack.status !== 0) throw new Error(pack.stderr);
const payload = JSON.parse(pack.stdout);
const packedFiles = payload[0].files.map((entry) => entry.path);
if (packedFiles.some((file) => /(?:^|\/)(?:state|secrets\.env|\.env)(?:\/|$)/.test(file))) {
  throw new Error("package contains runtime state or secrets");
}
if (packedFiles.some((file) => /(?:^|\/)__pycache__\/|\.pyc$/u.test(file))) {
  throw new Error("package contains generated Python bytecode");
}
console.log(`package inspection: ${packedFiles.length} files`);
