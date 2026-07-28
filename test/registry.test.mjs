import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadRegistry,
  loadRegistryCached,
  loadSecrets,
  loadSecretsCached,
  resolveServers,
  serversFor,
} from "../dist/registry.js";

const tmpFile = (content) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hub-registry-")), "secrets.env");
  fs.writeFileSync(f, content);
  return f;
};

test("loadSecrets parses assignments, export prefix, quoted values; enforces 0600", () => {
  const f = tmpFile('A=1\nexport B = "two"\nC=\'three\'\n# comment\nnot a line\n');
  fs.chmodSync(f, 0o644);
  const s = loadSecrets(f);
  assert.deepEqual(s, { A: "1", B: "two", C: "three" });
  assert.equal(fs.statSync(f).mode & 0o077, 0);
});

test("resolveServers substitutes ${VAR} in args/env/url/headers, expands ~", () => {
  const defs = [
    {
      name: "x",
      command: "npx",
      args: ["-y", "pkg@1.0.0", "~/data"],
      env: { KEY: "${MY_SECRET}" },
      url: "https://h/${MY_SECRET}",
      headers: { Authorization: "Bearer ${MY_SECRET}" },
    },
  ];
  const { servers, warnings } = resolveServers(defs, { MY_SECRET: "s3cr3t" });
  assert.equal(warnings.length, 0);
  assert.equal(servers[0].env.KEY, "s3cr3t");
  assert.equal(servers[0].url, "https://h/s3cr3t");
  assert.equal(servers[0].headers.Authorization, "Bearer s3cr3t");
  assert.equal(servers[0].args[2], path.join(os.homedir(), "data"));
});

test("resolveServers warns and leaves literal on unresolved secret; filters disabled", () => {
  const defs = [
    { name: "a", command: "x", env: { K: "${DEFINITELY_NOT_SET_ANYWHERE_42}" } },
    { name: "b", command: "x", disabled: true },
  ];
  const { servers, warnings } = resolveServers(defs, {});
  assert.equal(servers.length, 1);
  assert.equal(servers[0].env.K, "${DEFINITELY_NOT_SET_ANYWHERE_42}");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unresolved secret/);
});

test("serversFor excludes gatewayOnly servers from harness configs", () => {
  const servers = [
    { name: "native", command: "x" },
    { name: "hidden", command: "x", gatewayOnly: true },
  ];
  assert.deepEqual(serversFor(servers, "claude-code").map((s) => s.name), ["native"]);
});

test("registry and secret caches return stable parsed values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-registry-cache-"));
  try {
    const registry = path.join(dir, "registry.json");
    fs.writeFileSync(registry, '{"servers":[{"name":"one","command":"node"}]}');
    assert.equal(loadRegistry(registry)[0].name, "one");
    assert.equal(loadRegistryCached(registry)[0].name, "one");
    assert.equal(loadRegistryCached(registry)[0].name, "one");

    const missingSecrets = path.join(dir, "missing.env");
    assert.deepEqual(loadSecretsCached(missingSecrets), {});
    assert.deepEqual(loadSecretsCached(missingSecrets), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
