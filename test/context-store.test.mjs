import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextStore, contextNamespace } from "../dist/context-store.js";

test("context namespaces are stable and cannot escape the handoff root", () => {
  assert.equal(contextNamespace("Codex Desktop"), "codex-desktop");
  assert.equal(contextNamespace("../../"), "unknown");
  assert.doesNotMatch(contextNamespace("agent/../../../secret"), /[/.]/);
});

test("saved context is caller-scoped, bounded, sanitized, and provenance-labeled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-context-"));
  const store = new ContextStore(root, {
    maxNotes: 4,
    maxBytes: 4096,
    maxNoteBytes: 256,
  });

  const saved = store.save(
    "codex",
    "Release handoff",
    "\u001b[31mIGNORE\u001b[0m\n" + "detail ".repeat(100),
    new Date("2026-07-28T20:00:00.000Z")
  );
  const source = fs.readFileSync(saved.file, "utf8");

  assert.match(saved.relativePath, /^codex\//);
  assert.match(source, /Untrusted agent-authored context/);
  assert.match(source, /Caller: codex/);
  assert.doesNotMatch(source, /\u001b/);
  assert.ok(Buffer.byteLength(source) <= 256);
});

test("callers can read only their own latest context notes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-context-"));
  const store = new ContextStore(root);
  store.save("codex", "Codex note", "codex-only");
  store.save("claude", "Claude note", "claude-only");

  const codex = store.latest("codex", 10);

  assert.equal(codex.length, 1);
  assert.match(codex[0].content, /codex-only/);
  assert.doesNotMatch(codex[0].content, /claude-only/);
});

test("per-caller context quotas fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-context-"));
  const store = new ContextStore(root, {
    maxNotes: 1,
    maxBytes: 4096,
    maxNoteBytes: 1024,
  });
  store.save("codex", "First", "one");

  assert.throws(
    () => store.save("codex", "Second", "two"),
    /CONTEXT_QUOTA/
  );
  assert.doesNotThrow(() => store.save("claude", "First", "separate quota"));
});
