import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Health } from "../dist/health.js";

test("health tracks bounded breakers and aggregate caller usage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-health-"));
  const health = new Health({ stateDir: root });
  try {
    assert.equal(health.check("server", "alpha").open, false);
    health.failure("server", "alpha", "timeout with no secret payload");
    health.failure("server", "alpha", "timeout with no secret payload");
    health.failure("server", "alpha", "timeout with no secret payload");
    assert.equal(health.check("server", "alpha").open, true);
    assert.ok(health.openServers().has("alpha"));

    health.recordCall("alpha", "read", 10, false);
    health.recordCall("alpha", "read", 30, true);
    health.recordAgentCall("caller-a", "alpha", "read", 10, false);
    health.recordAgentCall("caller-a", "alpha", "read", 30, true);

    const stats = health.serverStats();
    assert.equal(stats.alpha.latencyMs, 20);
    assert.equal(stats.alpha.lastErrorCode, "TIMEOUT");
    const usage = health.usageReport({
      agent: "caller-a",
      server: "alpha",
    });
    assert.match(usage, /2 call\(s\), 1 error/);
    assert.match(usage, /50% errors/);
    assert.doesNotMatch(usage, /argument|prompt|result/);

    health.success("server", "alpha");
    assert.equal(health.check("server", "alpha").open, false);
    assert.match(
      health.usageReport({ agent: "missing" }),
      /No tracked calls/
    );
  } finally {
    health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("health supports half-open recovery and coarse error codes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-health-retry-"));
  const health = new Health({ stateDir: root });
  try {
    health.failure("tool", "alpha›read", "gateway policy denied");
    const open = health.check("tool", "alpha›read", {
      failureThreshold: 1,
      resetAfterMs: 1000,
    });
    assert.equal(open.open, true);
    const halfOpen = health.check("tool", "alpha›read", {
      failureThreshold: 1,
      resetAfterMs: 0,
    });
    assert.equal(halfOpen.open, false);
    health.recordCall("beta", "write", 0, true);
    health.failure("server", "beta", "quarantined");
    assert.equal(
      health.serverStats().beta.lastErrorCode,
      "QUARANTINED"
    );
  } finally {
    health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("health normalizes error classes, recency buckets, and empty reports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-health-codes-"));
  const health = new Health({ stateDir: root });
  try {
    health.failure("server", "source/circuit@cwd", "circuit open");
    health.failure("server", "source/denied@cwd", "unauthorized");
    health.failure("server", "source/failed@cwd", "unexpected exit");
    const stats = health.serverStats();
    assert.equal(stats.circuit.lastErrorCode, "CIRCUIT_OPEN");
    assert.equal(stats.denied.lastErrorCode, "UNAUTHORIZED");
    assert.equal(stats.failed.lastErrorCode, "PROCESS_FAILED");

    for (const [caller, age] of [
      ["minutes", 2 * 60_000],
      ["hours", 2 * 3_600_000],
      ["days", 3 * 86_400_000],
    ]) {
      health.recordAgentCall(caller, "alpha", "read", 1, false);
      health.db
        .prepare("UPDATE agent_calls SET last_at = ? WHERE agent = ?")
        .run(Date.now() - age, caller);
    }
    assert.match(health.usageReport({ agent: "minutes" }), /2m ago/);
    assert.match(health.usageReport({ agent: "hours" }), /2h ago/);
    assert.match(health.usageReport({ agent: "days" }), /3d ago/);
  } finally {
    health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
