import assert from "node:assert/strict";
import test from "node:test";
import { applyPlan, planFiles } from "../dist/reconcile.js";

test("pure reconciliation core returns deterministic operations without writing", () => {
  const plan = planFiles(
    { "/a": "old", "/remove": "stale" },
    { "/a": "new", "/create": "fresh" }
  );
  assert.deepEqual(
    plan.operations.map(({ kind, path }) => ({ kind, path })),
    [
      { kind: "update", path: "/a" },
      { kind: "create", path: "/create" },
      { kind: "remove", path: "/remove" },
    ]
  );
});

test("filesystem effects are isolated behind the apply interface", async () => {
  const calls = [];
  const adapter = {
    write: async (path, content) => calls.push(["write", path, content]),
    remove: async (path) => calls.push(["remove", path]),
  };
  const plan = planFiles({ "/old": "x" }, { "/new": "y" });
  await applyPlan(plan, adapter);
  assert.deepEqual(calls, [
    ["write", "/new", "y"],
    ["remove", "/old"],
  ]);
});

