import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { syncJsonMcpServers } from "../dist/adapters/json-common.js";
import { codex, parseCodexList } from "../dist/adapters/codex.js";

const setup = (initial) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-adapter-"));
  const configPath = path.join(dir, "config.json");
  if (initial !== undefined) fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));
  return { configPath, stateDir: path.join(dir, "state") };
};
const readCfg = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

test("adds managed entries, preserves everything else in the file", () => {
  const { configPath, stateDir } = setup({ theme: "dark", mcpServers: { userOwn: { command: "keepme" } } });
  const res = syncJsonMcpServers(
    "mcpServers",
    { hub: { command: "node", args: ["hub.js"] } },
    { configPath, stateDir, dryRun: false, prevManaged: [] }
  );
  assert.equal(res.changed, true);
  assert.deepEqual(res.managed, ["hub"]);
  const cfg = readCfg(configPath);
  assert.equal(cfg.theme, "dark"); // untouched
  assert.deepEqual(cfg.mcpServers.userOwn, { command: "keepme" }); // unmanaged preserved
  assert.deepEqual(cfg.mcpServers.hub, { command: "node", args: ["hub.js"] });
});

test("removes only previously-managed entries no longer in the registry", () => {
  const { configPath, stateDir } = setup({ mcpServers: { stale: { command: "old" }, userOwn: { command: "keep" } } });
  syncJsonMcpServers("mcpServers", { fresh: { command: "new" } }, { configPath, stateDir, dryRun: false, prevManaged: ["stale"] });
  const cfg = readCfg(configPath);
  assert.equal(cfg.mcpServers.stale, undefined);
  assert.deepEqual(cfg.mcpServers.userOwn, { command: "keep" });
  assert.deepEqual(cfg.mcpServers.fresh, { command: "new" });
});

test("round-trip is idempotent: second sync reports no changes", () => {
  const { configPath, stateDir } = setup({ mcpServers: {} });
  const entries = { hub: { command: "node" } };
  const ctx = { configPath, stateDir, dryRun: false, prevManaged: [] };
  assert.equal(syncJsonMcpServers("mcpServers", entries, ctx).changed, true);
  assert.equal(syncJsonMcpServers("mcpServers", entries, { ...ctx, prevManaged: ["hub"] }).changed, false);
});

test("never manufactures a config for an uninstalled tool", () => {
  const { configPath, stateDir } = setup(undefined);
  const res = syncJsonMcpServers("mcpServers", { hub: { command: "node" } }, { configPath, stateDir, dryRun: false, prevManaged: [] });
  assert.equal(res.changed, false);
  assert.equal(fs.existsSync(configPath), false);
  assert.match(res.notes[0], /SKIP/);
});

test("writes a timestamped backup before modifying", () => {
  const { configPath, stateDir } = setup({ mcpServers: {} });
  syncJsonMcpServers("mcpServers", { hub: { command: "node" } }, { configPath, stateDir, dryRun: false, prevManaged: [] });
  const backups = fs.readdirSync(path.join(stateDir, "backups"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /\.bak-\d+/);
});

test("parses Codex stdio and HTTP MCP list output", () => {
  const found = parseCodexList(JSON.stringify([
    {
      name: "hub",
      transport: { type: "stdio", command: "/bin/node", args: ["hub.js"], env: { MODE: "shared" } },
    },
    {
      name: "remote",
      transport: { type: "streamable_http", url: "https://example.com/mcp" },
    },
    {
      name: "authenticated-remote",
      transport: {
        type: "streamable_http",
        url: "https://example.com/private",
        bearer_token_env_var: "TOKEN",
      },
    },
    {
      name: "disabled",
      enabled: false,
      transport: { type: "stdio", command: "/bin/false", args: [] },
    },
    {
      name: "plugin-local",
      startup_timeout_sec: 120,
      transport: { type: "stdio", command: "node", args: ["./mcp/server.mjs"], cwd: "/plugin" },
    },
  ]));

  assert.deepEqual(found, [
    {
      name: "hub",
      active: true,
      adoptable: true,
      adoptReason: undefined,
      def: { transport: "stdio", command: "/bin/node", args: ["hub.js"], env: { MODE: "shared" } },
    },
    {
      name: "remote",
      active: true,
      adoptable: true,
      adoptReason: undefined,
      def: { transport: "http", url: "https://example.com/mcp" },
    },
    {
      name: "authenticated-remote",
      active: true,
      adoptable: false,
      adoptReason: "Codex-only fields: bearer_token_env_var",
      def: { transport: "http", url: "https://example.com/private" },
    },
    {
      name: "disabled",
      active: false,
      adoptable: false,
      adoptReason: "Codex-only fields: disabled",
      def: { transport: "stdio", command: "/bin/false", args: [], env: {} },
    },
    {
      name: "plugin-local",
      active: true,
      adoptable: false,
      adoptReason: "Codex-only fields: cwd, startup_timeout_sec",
      def: { transport: "stdio", command: "node", args: ["./mcp/server.mjs"], env: {} },
    },
  ]);
});

test("Codex sync restores the exact backup after a partial CLI mutation fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-codex-rollback-"));
  const configPath = path.join(dir, "config.toml");
  const stateDir = path.join(dir, "state");
  const fakeCodex = path.join(dir, "codex");
  fs.writeFileSync(configPath, "ORIGINAL\n");
  fs.writeFileSync(
    fakeCodex,
    `#!/bin/sh
set -eu
config="$CODEX_HOME/config.toml"
test "$1" = "mcp"
case "$2" in
  list)
    if grep -q ORIGINAL "$config"; then
      printf '%s\\n' '[{"name":"stale","transport":{"type":"stdio","command":"/bin/true","args":[]}}]'
    else
      printf '%s\\n' '[]'
    fi
    ;;
  remove)
    printf '%s\\n' MUTATED > "$config"
    ;;
  add)
    echo "injected add failure" >&2
    exit 7
    ;;
  *)
    exit 9
    ;;
esac
`
  );
  fs.chmodSync(fakeCodex, 0o755);

  const previous = process.env.OPENMOAT_CODEX_BIN;
  process.env.OPENMOAT_CODEX_BIN = fakeCodex;
  try {
    const result = codex.sync(
      [{ name: "fresh", transport: "stdio", command: "/bin/echo", args: ["ok"] }],
      { configPath, stateDir, dryRun: false, prevManaged: ["stale"] }
    );
    assert.equal(result.changed, false);
    assert.deepEqual(result.managed, ["stale"]);
    assert.match(result.notes.join("\n"), /rolled back/);
    assert.equal(fs.readFileSync(configPath, "utf8"), "ORIGINAL\n");
    assert.equal(fs.readdirSync(path.join(stateDir, "backups")).length, 1);
  } finally {
    if (previous === undefined) delete process.env.OPENMOAT_CODEX_BIN;
    else process.env.OPENMOAT_CODEX_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
