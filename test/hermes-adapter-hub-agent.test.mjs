// The adapter owns its caller identity so reconciliation repairs config drift.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hermes } from "../dist/adapters/hermes.js";

const setup = (yaml) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-hermes-adapter-"));
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(configPath, yaml);
  return { configPath, stateDir: path.join(dir, "state") };
};

const SERVERS = [
  { name: "openmoat", transport: "stdio", command: "node", args: ["hub.js"], env: {} },
  { name: "phone-lookup", transport: "stdio", command: "npx", args: ["phone-lookup"], env: {} },
];

const BASE_YAML = `# user comment survives
model:
  provider: custom # inline comment
mcp_servers: {}
`;

test("sync overlays OPENMOAT_CALLER=hermes on openmoat and only openmoat", () => {
  const { configPath, stateDir } = setup(BASE_YAML);
  const res = hermes.sync(SERVERS, { configPath, stateDir, dryRun: false, prevManaged: [] });
  assert.equal(res.changed, true);
  const text = fs.readFileSync(configPath, "utf8");
  const found = Object.fromEntries(hermes.readServers(configPath).map((s) => [s.name, s.def]));
  assert.equal(found["openmoat"].env.OPENMOAT_CALLER, "hermes");
  assert.equal(found["phone-lookup"].env.OPENMOAT_CALLER, undefined);
  // Unrelated user content and comments survive the yaml Document edit.
  assert.match(text, /# user comment survives/);
  assert.match(text, /provider: custom # inline comment/);
});

test("sync repairs a drifted entry that lost OPENMOAT_CALLER", () => {
  const { configPath, stateDir } = setup(`mcp_servers:
  openmoat:
    command: node
    args:
      - hub.js
    env: {}
`);
  const res = hermes.sync(SERVERS, { configPath, stateDir, dryRun: false, prevManaged: ["openmoat"] });
  assert.equal(res.changed, true);
  const found = Object.fromEntries(hermes.readServers(configPath).map((s) => [s.name, s.def]));
  assert.equal(found["openmoat"].env.OPENMOAT_CALLER, "hermes");
});

test("second sync is a no-op once the overlay is applied", () => {
  const { configPath, stateDir } = setup(BASE_YAML);
  assert.equal(hermes.sync(SERVERS, { configPath, stateDir, dryRun: false, prevManaged: [] }).changed, true);
  const managed = SERVERS.map((s) => s.name);
  assert.equal(hermes.sync(SERVERS, { configPath, stateDir, dryRun: false, prevManaged: managed }).changed, false);
});

test("registry env values are preserved alongside the overlay", () => {
  const { configPath, stateDir } = setup(BASE_YAML);
  const servers = [{ name: "openmoat", transport: "stdio", command: "node", args: [], env: { HUB_LOG: "1" } }];
  hermes.sync(servers, { configPath, stateDir, dryRun: false, prevManaged: [] });
  const found = Object.fromEntries(hermes.readServers(configPath).map((s) => [s.name, s.def]));
  assert.deepEqual(found["openmoat"].env, { HUB_LOG: "1", OPENMOAT_CALLER: "hermes" });
});
