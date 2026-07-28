import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveServers } from "../dist/registry.js";

// A registry entry may pin the working directory its server is spawned in.
// Servers that derive per-project state from `process.cwd()` (squish resolves
// its project row that way) are wrong or broken without it: spawned from the
// hub's own directory they look up a project that does not exist.
//
// These tests cover the resolve half — that `cwd` survives resolution and gets
// the same `~` expansion `command` and `args` already get. The gateway half
// (falling back to this value when a tool_call supplies no cwd of its own)
// lives in spawnClient.

test("resolveServers preserves a server's pinned cwd", () => {
  const { servers } = resolveServers(
    [{ name: "pinned", command: "node", args: ["s.mjs"], cwd: "/tmp" }],
    {}
  );
  assert.equal(servers[0].cwd, "/tmp");
});

test("resolveServers expands ~ in cwd, as it does for command and args", () => {
  const { servers } = resolveServers(
    [{ name: "tilde", command: "node", args: ["s.mjs"], cwd: "~/projects/example" }],
    {}
  );
  assert.equal(servers[0].cwd, path.join(os.homedir(), "projects/example"));
});

test("resolveServers substitutes ${VAR} in cwd", () => {
  const { servers } = resolveServers(
    [{ name: "var", command: "node", args: ["s.mjs"], cwd: "${PROJECT_ROOT}/sub" }],
    { PROJECT_ROOT: "/opt/proj" }
  );
  assert.equal(servers[0].cwd, "/opt/proj/sub");
});

test("a server without cwd stays undefined rather than defaulting to a path", () => {
  const { servers } = resolveServers([{ name: "none", command: "node", args: ["s.mjs"] }], {});
  assert.equal(servers[0].cwd, undefined);
});
