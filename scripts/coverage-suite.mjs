#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(command, args) {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
}

const tests = fs
  .readdirSync("test")
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => `test/${file}`);

run(process.execPath, ["--test", ...tests]);
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
