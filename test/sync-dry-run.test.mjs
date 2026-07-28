import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { initWorkspace } from "../dist/init.js";

function snapshot(root) {
  const entries = [];
  const visit = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else {
        const stat = fs.lstatSync(file);
        const content = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
        entries.push({
          path: path.relative(root, file),
          mode: stat.mode & 0o777,
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  };
  visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

test("sync dry-run is byte-for-byte read-only across configs, permissions, links, memory, and corrupt state", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-sync-dry-run-"));
  const workspace = path.join(tmp, "workspace");
  try {
    const initialized = initWorkspace(workspace, false, path.resolve("."));
    const config = parseDocument(fs.readFileSync(initialized.config, "utf8"));
    config.setIn(["targets", "claude-desktop", "enabled"], true);
    config.setIn(["targets", "claude-desktop", "config"], "./targets/claude.json");
    config.setIn(["targets", "claude-desktop", "skillsLink"], "./target-skills");
    config.setIn(["targets", "claude-desktop", "memoryFile"], "./target-memory.md");
    fs.writeFileSync(initialized.config, config.toString());

    fs.mkdirSync(path.join(workspace, "targets"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "targets", "claude.json"), '{"mcpServers":{"personal":{"command":"keep"}}}\n');
    fs.writeFileSync(path.join(workspace, "target-memory.md"), "# Existing memory\n");
    fs.mkdirSync(path.join(workspace, "skills", "synthetic"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "skills", "synthetic", "SKILL.md"), "# Synthetic\n");
    fs.writeFileSync(path.join(workspace, "state", "managed.json"), "not-json\n");
    fs.chmodSync(path.join(workspace, "secrets.env"), 0o644);

    const before = snapshot(workspace);
    const result = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "sync", "--dry-run", "--json"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, OPENMOAT_FILE: initialized.config },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.readOnly, true);
    assert.equal(report.hasChanges, true);
    assert.ok(report.warnings.some((warning) => warning.includes("dry-run left original unchanged")));
    assert.ok(report.lines.some((line) => line.includes("would update")));
    assert.equal(report.lines.some((line) => /\] updated|instructions updated|memory block updated/.test(line)), false);
    assert.equal(report.lines.some((line) => /· (?:updated|added|removed)\b/.test(line)), false);
    assert.deepEqual(snapshot(workspace), before);
    assert.equal(fs.existsSync(path.join(workspace, "target-skills")), false);
    assert.equal(
      fs.readdirSync(path.join(workspace, "state")).some((name) => name.includes(".corrupt-")),
      false
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sync updates gateway instructions through the canonical AGENTS symlink", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-sync-symlink-"));
  const workspace = path.join(tmp, "workspace");
  try {
    const initialized = initWorkspace(workspace, false, path.resolve("."));
    const config = parseDocument(fs.readFileSync(initialized.config, "utf8"));
    config.setIn(["paths", "profile"], "./AGENTS.md");
    fs.writeFileSync(initialized.config, config.toString());

    const memoryImport = path.join(workspace, "AGENTS.md");
    const target = path.join(workspace, "profile", "AGENTS.md");
    fs.symlinkSync(path.join("profile", "AGENTS.md"), memoryImport);

    const result = spawnSync(
      process.execPath,
      [path.resolve("dist/cli.js"), "sync", "--json"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, OPENMOAT_FILE: initialized.config },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.lstatSync(memoryImport).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(memoryImport), path.join("profile", "AGENTS.md"));
    assert.match(fs.readFileSync(target, "utf8"), /<!-- openmoat:begin -->/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
