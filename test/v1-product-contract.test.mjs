import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../dist/init.js";

const root = path.resolve(import.meta.dirname, "..");

test("v1 package states the focused TypeScript MCP gateway mission", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  assert.equal(pkg.version, "1.0.0");
  assert.equal(
    pkg.description,
    "Local security gateway for MCP with deny-by-default policy and stateless protocol support."
  );
  assert.deepEqual(pkg.files, [
    "dist/",
    "examples/Moatfile",
    "schemas/",
    "LICENSE",
    "README.md",
    "ARCHITECTURE.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "docs/threat-model.md",
    "docs/release-checklist.md",
  ]);
  assert.equal(pkg.dependencies["jsonc-parser"], undefined);
});

test("v1 CLI exposes only the local gateway contract", () => {
  const help = execFileSync(
    process.execPath,
    [path.join(root, "dist", "cli.js"), "--help"],
    { encoding: "utf8" }
  );
  const commands = [...help.matchAll(/^  ([a-z][a-z-]*)[ <[]/gm)].map(
    (match) => match[1]
  );
  assert.deepEqual(commands, [
    "init",
    "validate",
    "serve",
    "doctor",
    "auth",
    "trust",
    "catalog",
    "usage",
    "list",
    "help",
  ]);
  assert.match(help, /local security gateway for MCP/i);
  assert.doesNotMatch(
    help,
    /federation|shared.brain|profile|handoff|RAG|skills|plugins|sync|adapter/i
  );
});

test("v1 production tree contains no retired product surfaces", () => {
  const retired = [
    "adapters",
    "backup.ts",
    "configure.ts",
    "context-store.ts",
    "demo.ts",
    "detect.ts",
    "discover.ts",
    "evaluate.ts",
    "federation.ts",
    "instincts.ts",
    "integrations.ts",
    "mcp-rag.ts",
    "plugins.ts",
    "rag.ts",
    "reconcile.ts",
    "skills-report.ts",
    "skills.ts",
    "sync.ts",
  ];
  for (const entry of retired) {
    assert.equal(
      fs.existsSync(path.join(root, "src", entry)),
      false,
      `retired production surface remains: src/${entry}`
    );
  }
});

test("starter initializes one Moatfile plus private local state", () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "openmoat-v1-"));
  try {
    execFileSync(
      process.execPath,
      [path.join(root, "dist", "cli.js"), "init", temp],
      { cwd: root, encoding: "utf8" }
    );
    const relative = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        relative.push(path.relative(temp, absolute));
        if (entry.isDirectory()) walk(absolute);
      }
    };
    walk(temp);
    assert.deepEqual(relative.sort(), [
      "Moatfile",
      "secrets.env",
      "state",
    ]);
    assert.equal(fs.statSync(path.join(temp, "state")).mode & 0o777, 0o700);
    assert.equal(
      fs.statSync(path.join(temp, "secrets.env")).mode & 0o777,
      0o600
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("starter refuses non-empty destinations unless force is explicit", () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "openmoat-init-"));
  try {
    fs.writeFileSync(path.join(temp, "owned.txt"), "preserve");
    assert.throws(() => initWorkspace(temp), /not empty/);
    const result = initWorkspace(temp, true);
    assert.equal(fs.readFileSync(path.join(temp, "owned.txt"), "utf8"), "preserve");
    assert.equal(result.created.length, 3);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("starter force mode refuses managed-path symlinks", () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "openmoat-link-"));
  const target = path.join(temp, "outside-owned.txt");
  try {
    fs.writeFileSync(target, "preserve");
    fs.symlinkSync(target, path.join(temp, "Moatfile"));
    assert.throws(
      () => initWorkspace(temp, true),
      /symbolic link/
    );
    assert.equal(fs.readFileSync(target, "utf8"), "preserve");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
