import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFIG_ENV, loadConfig } from "../dist/config.js";
import { initWorkspace } from "../dist/init.js";

test("loadConfig honors OPENMOAT_FILE and resolves relative paths from it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-config-"));
  const file = path.join(tmp, "Moatfile");
  fs.writeFileSync(
    file,
    `apiVersion: openmoat.dev/v1
kind: Moatfile
features: {}
targets:
  codex:
    enabled: false
    config: ./codex.toml
gateway:
  callers: {}
  servers: {}
`
  );

  process.env[CONFIG_ENV] = file;
  try {
    const cfg = loadConfig("/ignored");
    assert.equal(cfg.registry, path.join(tmp, "registry/mcp-servers.json"));
    assert.equal(
      cfg.stateDir,
      path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "openmoat")
    );
    assert.equal(cfg.targets.codex.config, path.join(tmp, "codex.toml"));
  } finally {
    delete process.env[CONFIG_ENV];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("initWorkspace creates isolated starter and refuses accidental overwrite", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-init-"));
  const destination = path.join(tmp, "workspace");
  const root = path.resolve(".");
  try {
    const result = initWorkspace(destination, false, root);
    assert.equal(result.config, path.join(destination, "Moatfile"));
    assert.ok(fs.existsSync(path.join(destination, "registry/mcp-servers.json")));
    assert.ok(fs.existsSync(path.join(destination, "profile/AGENTS.md")));
    assert.ok(fs.existsSync(path.join(destination, "plugins")));
    assert.equal(fs.statSync(path.join(destination, "secrets.env")).mode & 0o077, 0);
    assert.match(fs.readFileSync(path.join(destination, "secrets.env"), "utf8"), /^#/);
    const cfg = loadConfig(result.dir);
    assert.equal(cfg.pluginsDir, path.join(destination, "plugins"));

    assert.throws(
      () => initWorkspace(destination, false, root),
      /is not empty/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
