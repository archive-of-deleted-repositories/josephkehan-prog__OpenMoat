#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const output = path.resolve("dist");
if (path.basename(output) !== "dist") {
  throw new Error(`refusing to clean unexpected output path: ${output}`);
}
fs.rmSync(output, { recursive: true, force: true });

const result = spawnSync(
  path.join(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc"
  ),
  [],
  { stdio: "inherit" }
);
process.exit(result.status ?? 1);
