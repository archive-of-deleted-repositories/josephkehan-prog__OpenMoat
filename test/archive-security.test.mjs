import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Archive } from "../dist/archive.js";

test("archived tool results are caller-bound, including identical content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-archive-"));
  const cfg = { stateDir: path.join(root, "state") };
  const archive = new Archive(cfg);
  try {
    const callerAHash = archive.store("caller-a", "shared sensitive result");
    const callerBHash = archive.store("caller-b", "shared sensitive result");

    assert.notEqual(callerAHash, callerBHash);
    assert.equal(archive.fetch("caller-b", callerAHash), null);
    assert.equal(archive.find("caller-b", callerAHash, "sensitive"), null);
    assert.equal(
      archive.fetch("caller-a", callerAHash)?.slice,
      "shared sensitive result"
    );
    assert.deepEqual(
      archive.find("caller-a", callerAHash, "sensitive"),
      [{ offset: 0, line: "shared sensitive result" }]
    );
  } finally {
    archive.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive state directories and databases are private", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-archive-mode-"));
  const stateDir = path.join(root, "state");
  const archive = new Archive({ stateDir });
  archive.close();
  try {
    assert.equal(fs.statSync(stateDir).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(stateDir, "archive.db")).mode & 0o077, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
