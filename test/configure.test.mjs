import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureTargets, renderTargetConfiguration } from "../dist/configure.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-configure-"));
  const file = path.join(dir, "hub.config.json");
  const stateDir = path.join(dir, "state");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        custom: { preserve: true },
        targets: {
          codex: { enabled: false, config: "~/.codex/config.toml" },
          hermes: { enabled: true, config: "~/.hermes/config.yaml", extra: "keep" },
        },
      },
      null,
      2
    ) + "\n"
  );
  return { dir, file, stateDir };
}

test("target configuration previews by default without touching the Hub config", () => {
  const { dir, file, stateDir } = fixture();
  const before = fs.readFileSync(file, "utf8");
  try {
    const result = configureTargets(file, stateDir, ["codex", "codex"], true);
    assert.equal(result.changed, true);
    assert.equal(result.applied, false);
    assert.equal(result.harnessFilesWritten, false);
    assert.deepEqual(result.requestedTargets, ["codex"]);
    assert.deepEqual(result.changes, [{ id: "codex", before: false, after: true }]);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.existsSync(path.join(stateDir, "backups")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit apply changes only named targets, preserves fields, and creates a backup", () => {
  const { dir, file, stateDir } = fixture();
  const before = fs.readFileSync(file, "utf8");
  try {
    const result = configureTargets(file, stateDir, ["codex"], true, true);
    assert.equal(result.applied, true);
    assert.ok(result.backup);
    assert.equal(fs.readFileSync(result.backup, "utf8"), before);

    const updated = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(updated.targets.codex.enabled, true);
    assert.equal(updated.targets.hermes.enabled, true);
    assert.equal(updated.targets.hermes.extra, "keep");
    assert.deepEqual(updated.custom, { preserve: true });

    const again = configureTargets(file, stateDir, ["codex"], true, true);
    assert.equal(again.changed, false);
    assert.equal(again.applied, false);
    assert.equal(again.backup, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown targets fail closed and human output states the write boundary", () => {
  const { dir, file, stateDir } = fixture();
  const before = fs.readFileSync(file, "utf8");
  try {
    assert.throws(
      () => configureTargets(file, stateDir, ["not-a-client"], true, true),
      /unknown target: not-a-client/
    );
    assert.equal(fs.readFileSync(file, "utf8"), before);

    const preview = configureTargets(file, stateDir, ["hermes"], false);
    const output = renderTargetConfiguration(preview);
    assert.match(output, /PREVIEW/);
    assert.match(output, /Harness files written: none/);
    assert.match(output, /--apply/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
