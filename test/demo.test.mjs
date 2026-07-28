import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPortableDemo } from "../dist/demo.js";

test("portable demo uses real adapters, is idempotent, and cleans up by default", () => {
  const result = runPortableDemo(undefined, path.resolve("."));

  assert.equal(result.passed, true);
  assert.equal(result.preserved, false);
  assert.deepEqual(result.targets, ["claude-desktop", "hermes", "opencode"]);
  assert.equal(result.dryRunChanges, 3);
  assert.equal(result.synchronizedTargets, 3);
  assert.deepEqual(result.selected, { servers: 2, skills: 1, plugins: 1 });
  assert.equal(result.idempotent, true);
  assert.equal(fs.existsSync(result.workspace), false);
});

test("portable demo preserves an explicitly requested workspace", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-demo-test-"));
  const destination = path.join(tmp, "inspectable");
  try {
    const result = runPortableDemo(destination, path.resolve("."));

    assert.equal(result.preserved, true);
    assert.equal(result.workspace, destination);
    assert.ok(fs.existsSync(path.join(destination, "claude-desktop.json")));
    assert.ok(fs.existsSync(path.join(destination, "hermes.yaml")));
    assert.ok(fs.existsSync(path.join(destination, "opencode.jsonc")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
