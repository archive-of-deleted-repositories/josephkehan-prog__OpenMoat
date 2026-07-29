import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfigFile } from "../dist/config.js";
import {
  PoolBudget,
  SecretRedactor,
  buildChildEnv,
  resolveWorkingDirectory,
  sanitizeMetadata,
  withDeadline,
} from "../dist/runtime-security.js";
import { AGENT_TOOL_NAMES } from "../dist/tool-surface.js";

test("child environments contain only explicit values and allowlisted inheritance", () => {
  const source = {
    PATH: "/bin",
    HOME: "/home/test",
    OPENMOAT_AMBIENT_SECRET: "must-not-leak",
    EXPLICIT_PARENT: "allowed",
  };

  const environment = buildChildEnv(
    { TOKEN: "configured" },
    ["EXPLICIT_PARENT"],
    source
  );

  assert.deepEqual(environment, {
    EXPLICIT_PARENT: "allowed",
    TOKEN: "configured",
  });
  assert.equal(environment.OPENMOAT_AMBIENT_SECRET, undefined);
});

test("working directories are realpath-contained beneath declared roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-root-"));
  const allowed = path.join(root, "allowed");
  const project = path.join(allowed, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside);
  const escape = path.join(allowed, "escape");
  fs.symlinkSync(outside, escape);

  assert.equal(
    resolveWorkingDirectory(project, undefined, [allowed], root),
    fs.realpathSync(project)
  );
  assert.throws(
    () => resolveWorkingDirectory(outside, undefined, [allowed], root),
    /PATH_OUTSIDE_ROOT/
  );
  assert.throws(
    () => resolveWorkingDirectory(escape, undefined, [allowed], root),
    /PATH_OUTSIDE_ROOT/
  );
  assert.throws(
    () => resolveWorkingDirectory(project, undefined, [], root),
    /caller-supplied cwd is disabled/
  );
});

test("configured working directory remains available when caller cwd is disabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-configured-cwd-"));
  const configured = path.join(root, "configured");
  fs.mkdirSync(configured);

  assert.equal(
    resolveWorkingDirectory(undefined, configured, [], root),
    fs.realpathSync(configured)
  );
});

test("untrusted tool metadata is sanitized, bounded, and labeled with provenance", () => {
  const value = sanitizeMetadata(
    "\u001b[31mIGNORE\u001b[0m\n" + "metadata ".repeat(1000),
    { server: "fixture", trust: "trusted" },
    512
  );

  assert.doesNotMatch(value, /\u001b/);
  assert.match(value, /^\[untrusted metadata; server=fixture; trust=trusted\]/);
  assert.ok(value.length <= 512);
});

test("secret redaction traverses nested MCP output without mutating the input", () => {
  const original = {
    content: [{ type: "text", text: "token=secret-value" }],
    structuredContent: {
      "secret-value": {
        "prefix-secret-value-suffix": "secret-value",
      },
    },
    _meta: {
      "example.test/secret-value": {
        error: "secret-value",
      },
    },
  };
  const redactor = new SecretRedactor(["secret-value"]);

  const redacted = redactor.redact(original);

  assert.deepEqual(redacted, {
    content: [{ type: "text", text: "token=[REDACTED]" }],
    structuredContent: {
      "[REDACTED]": {
        "prefix-[REDACTED]-suffix": "[REDACTED]",
      },
    },
    _meta: {
      "example.test/[REDACTED]": {
        error: "[REDACTED]",
      },
    },
  });
  assert.equal(original.content[0].text, "token=secret-value");
  assert.doesNotMatch(JSON.stringify(redacted), /secret-value/);
});

test("secret-bearing key redaction preserves colliding fields without disclosure", () => {
  const redactor = new SecretRedactor(["secret-value"]);

  const redacted = redactor.redact({
    "secret-value": "first",
    "[REDACTED]": "second",
  });

  assert.deepEqual(redacted, {
    "[REDACTED]": "first",
    "[REDACTED]#2": "second",
  });
  assert.doesNotMatch(JSON.stringify(redacted), /secret-value/);
});

test("deadlines reject with a stable timeout code and run cleanup", async () => {
  let cleaned = false;
  await assert.rejects(
    withDeadline(
      new Promise((resolve) => setTimeout(resolve, 100)),
      5,
      async () => {
        cleaned = true;
      }
    ),
    /TIMEOUT/
  );
  assert.equal(cleaned, true);
});

test("pool budgets enforce global and per-server limits", () => {
  const budget = new PoolBudget({ maxPools: 2, maxPoolsPerServer: 1 });
  budget.reserve("files", "files@a");
  assert.throws(() => budget.reserve("files", "files@b"), /POOL_LIMIT/);
  budget.reserve("git", "git@a");
  assert.throws(() => budget.reserve("search", "search@a"), /POOL_LIMIT/);
  budget.release("files@a");
  budget.reserve("search", "search@a");
  assert.equal(budget.size, 2);
});

test("agent MCP surface contains no trust, enablement, or reindex administration", () => {
  assert.ok(AGENT_TOOL_NAMES.includes("tool_search"));
  assert.ok(AGENT_TOOL_NAMES.includes("tool_call"));
  for (const forbidden of [
    "registry_trust",
    "registry_enable",
    "rag_reindex",
    "mcp_reindex",
  ]) {
    assert.equal(AGENT_TOOL_NAMES.includes(forbidden), false);
  }
});

test("Moatfile v1 accepts v0.2 runtime security fields and rejects mixed-risk zones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-security-config-"));
  const valid = path.join(root, "valid");
  fs.writeFileSync(
    valid,
    `apiVersion: openmoat.dev/v1
kind: Moatfile
features: {}
targets: {}
gateway:
  callers:
    codex:
      allow: ["files:*"]
      zone: private
  zones:
    private:
      allowMixedRisk: false
  limits:
    maxPools: 8
    maxPoolsPerServer: 2
    idleTimeoutMs: 1000
  servers:
    files:
      command: files-mcp
      cwdRoots: ["./workspace"]
      capabilities: ["sensitive-read"]
      zone: private
      trust: trusted
`
  );
  assert.equal(loadConfigFile(valid).gatewayLimits.maxPools, 8);

  const invalid = path.join(root, "invalid");
  fs.writeFileSync(
    invalid,
    fs
      .readFileSync(valid, "utf8")
      .replace('capabilities: ["sensitive-read"]', 'capabilities: ["sensitive-read", "network-egress"]')
  );
  assert.throws(() => loadConfigFile(invalid), /mixed-risk zone/);
});
