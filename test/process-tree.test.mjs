import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  descendantPids,
  killProcessTree,
} from "../dist/process-tree.js";

test("process-tree cleanup kills a root and its descendant", async () => {
  const root = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require("child_process");
       spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
       setInterval(()=>{},1000);`,
    ],
    { stdio: "ignore" }
  );
  try {
    let descendants = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      descendants = descendantPids(root.pid);
      if (descendants.length) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(descendants.length >= 1);
    const killed = killProcessTree(root.pid);
    assert.ok(killed.includes(root.pid));
    assert.ok(descendants.some((pid) => killed.includes(pid)));
  } finally {
    try {
      process.kill(root.pid, "SIGKILL");
    } catch {
      // Expected after killProcessTree.
    }
  }
});

test("process-tree helpers tolerate an already-dead pid", () => {
  assert.deepEqual(descendantPids(999_999_999), []);
  assert.deepEqual(killProcessTree(999_999_999), []);
});
