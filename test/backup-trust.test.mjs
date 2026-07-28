import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { backupState, pruneFileBackups } from "../dist/backup.js";
import { trust } from "../dist/adopt.js";

test("backupState tarballs non-rebuildable state, excludes rag.db", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-state-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "hub-backup-"));
  fs.writeFileSync(path.join(stateDir, "instincts.json"), "[]");
  fs.writeFileSync(path.join(stateDir, "managed.json"), "{}");
  fs.writeFileSync(path.join(stateDir, "rag.db"), "REBUILDABLE");
  fs.mkdirSync(path.join(stateDir, "evals"));
  fs.writeFileSync(path.join(stateDir, "evals", "x.md"), "report");
  const out = backupState(stateDir, dest);
  assert.ok(fs.existsSync(out));
  const listing = execFileSync("tar", ["-tzf", out]).toString();
  assert.match(listing, /instincts\.json/);
  assert.match(listing, /evals\/x\.md/);
  assert.doesNotMatch(listing, /rag\.db/);
});

test("backupState throws when nothing to back up", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-empty-"));
  assert.throws(() => backupState(stateDir, stateDir));
});

test("pruneFileBackups keeps newest generated backups and named milestones", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-state-"));
  const dir = path.join(stateDir, "backups");
  fs.mkdirSync(dir);
  for (let day = 1; day <= 5; day++) {
    fs.writeFileSync(path.join(dir, `.claude.json.bak-2026070${day}-120000000`), `${day}`);
  }
  fs.writeFileSync(path.join(dir, ".claude.json.bak-pre-abandon"), "milestone");

  assert.equal(pruneFileBackups(stateDir, 3), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    ".claude.json.bak-20260703-120000000",
    ".claude.json.bak-20260704-120000000",
    ".claude.json.bak-20260705-120000000",
    ".claude.json.bak-pre-abandon",
  ]);
  assert.equal(pruneFileBackups(stateDir, 0), 3);
  assert.deepEqual(fs.readdirSync(dir), [".claude.json.bak-pre-abandon"]);
});

test("trust flips trusted:false to true and refuses unknown/already-trusted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-trust-"));
  const registry = path.join(dir, "registry.json");
  fs.writeFileSync(registry, JSON.stringify({ servers: [{ name: "q", command: "x", trusted: false }, { name: "t", command: "x" }] }));
  const cfg = { registry, stateDir: path.join(dir, "state") };
  assert.match(trust(cfg, "nope"), /not in the registry/);
  assert.match(trust(cfg, "t"), /already trusted/);
  assert.match(trust(cfg, "q"), /now trusted/);
  const after = JSON.parse(fs.readFileSync(registry, "utf8"));
  assert.equal(after.servers.find((s) => s.name === "q").trusted, true);
});
