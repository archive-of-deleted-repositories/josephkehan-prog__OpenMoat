import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Archive } from "../dist/archive.js";

function config(stateDir, overrides = {}) {
  return {
    stateDir,
    archiveLimits: {
      maxBlobBytes: 1024,
      maxCallerBytes: 2048,
      maxCallerEntries: 2,
      ttlMs: 60_000,
      ...overrides,
    },
  };
}

test("archives use opaque caller-bound handles and private storage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-archive-"));
  const stateDir = path.join(root, "state");
  const archive = new Archive(config(stateDir));
  try {
    const handle = archive.store("caller-a", "shared sensitive result");
    assert.match(handle, /^[a-f0-9]{48}$/);
    assert.equal(archive.fetch("caller-b", handle), null);
    assert.equal(archive.find("caller-b", handle, "sensitive"), null);
    assert.equal(
      archive.fetch("caller-a", handle)?.slice,
      "shared sensitive result"
    );
    assert.deepEqual(
      archive.find("caller-a", handle, "sensitive"),
      [{ offset: 0, line: "shared sensitive result" }]
    );
    assert.equal(archive.fetch("caller-a", "../escape"), null);
    assert.equal(fs.statSync(stateDir).mode & 0o077, 0);
    assert.equal(
      fs.statSync(path.join(stateDir, "archive.db")).mode & 0o077,
      0
    );
  } finally {
    archive.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive enforces byte, entry, paging, and TTL bounds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-quota-"));
  const archive = new Archive(
    config(path.join(root, "state"), {
      maxBlobBytes: 100,
      maxCallerBytes: 150,
      maxCallerEntries: 2,
      ttlMs: 5,
    })
  );
  try {
    assert.throws(
      () => archive.store("caller", "x".repeat(101)),
      /RESULT_TOO_LARGE/
    );
    const first = archive.store("caller", "a".repeat(80));
    const second = archive.store("caller", "b".repeat(80));
    assert.equal(
      archive.fetch("caller", first),
      null,
      "quota evicts the oldest caller-owned entry"
    );
    assert.equal(archive.fetch("caller", second, -10, 1)?.slice.length, 80);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    assert.equal(archive.fetch("caller", second), null);
  } finally {
    archive.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
