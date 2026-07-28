import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initWorkspace } from "../dist/init.js";

function snapshot(root) {
  const entries = [];
  const visit = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else {
        const content = fs.readFileSync(file);
        entries.push({
          path: path.relative(root, file),
          mode: fs.statSync(file).mode & 0o777,
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  };
  visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function doctor(config, ...args) {
  return spawnSync(process.execPath, [path.resolve("dist/cli.js"), "doctor", "--json", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, OPENMOAT_FILE: config },
  });
}

test("doctor is byte-for-byte read-only on a fresh starter, including secret permissions", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-doctor-"));
  const workspace = path.join(tmp, "workspace");
  try {
    const initialized = initWorkspace(workspace, false, path.resolve("."));
    fs.chmodSync(path.join(workspace, "secrets.env"), 0o644);
    const before = snapshot(workspace);

    const result = doctor(initialized.config);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.readOnly, true);
    assert.equal(report.healthy, true);
    assert.equal(report.ready, false);
    assert.ok(report.checks.some((check) => check.id === "rag" && check.status === "warning"));
    assert.ok(report.checks.some((check) => check.id === "secrets" && check.status === "warning"));
    assert.deepEqual(snapshot(workspace), before);
    assert.equal(fs.existsSync(path.join(workspace, "state", "rag.db")), false);

    const strict = doctor(initialized.config, "--strict");
    assert.equal(strict.status, 1);
    assert.deepEqual(snapshot(workspace), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor reports a corrupt RAG header without opening or changing the database", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-doctor-rag-"));
  const workspace = path.join(tmp, "workspace");
  try {
    const initialized = initWorkspace(workspace, false, path.resolve("."));
    const db = path.join(workspace, "state", "rag.db");
    fs.writeFileSync(db, "not a sqlite database");
    const before = fs.readFileSync(db);

    const result = doctor(initialized.config);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.healthy, false);
    assert.ok(report.checks.some((check) => check.id === "rag" && check.status === "error"));
    assert.deepEqual(fs.readFileSync(db), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
