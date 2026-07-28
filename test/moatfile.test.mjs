import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONFIG_ENV,
  loadConfigFile,
  resolveConfigFile,
} from "../dist/config.js";
import { exportChezmoi, migrateLegacyConfig } from "../dist/integrations.js";

const writeMoatfile = (dir, extra = "") => {
  const file = path.join(dir, "Moatfile");
  const gateway = extra.startsWith("gateway:")
    ? ""
    : `gateway:
  callers: {}
  servers: {}
`;
  fs.writeFileSync(
    file,
    `apiVersion: openmoat.dev/v1
kind: Moatfile
features:
  reconcile: true
  gateway: true
  profile: true
  handoffs: true
  rag: false
  embeddings: false
  skills: false
  plugins: false
  instincts: false
targets: {}
${gateway}
${extra}`
  );
  return file;
};

test("config precedence is --file, OPENMOAT_FILE, then XDG_CONFIG_HOME", () => {
  const env = { XDG_CONFIG_HOME: "/config", [CONFIG_ENV]: "/env/Moatfile" };
  assert.equal(resolveConfigFile("/cli/Moatfile", env, "/home"), "/cli/Moatfile");
  assert.equal(resolveConfigFile(undefined, env, "/home"), "/env/Moatfile");
  assert.equal(
    resolveConfigFile(undefined, { XDG_CONFIG_HOME: "/config" }, "/home"),
    "/config/openmoat/Moatfile"
  );
  assert.equal(resolveConfigFile(undefined, {}, "/home"), "/home/.config/openmoat/Moatfile");
});

test("Moatfile safe defaults enable core and disable optional shared-brain modules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-config-"));
  try {
    const cfg = loadConfigFile(writeMoatfile(dir));
    assert.deepEqual(cfg.features, {
      reconcile: true,
      gateway: true,
      profile: true,
      handoffs: true,
      rag: false,
      embeddings: false,
      skills: false,
      plugins: false,
      instincts: false,
    });
    assert.equal(cfg.gatewayPolicy.default, "deny");
    assert.deepEqual(cfg.targets, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gateway callers and servers normalize into the runtime without resolving secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-gateway-"));
  try {
    const file = writeMoatfile(
      dir,
      `gateway:
  callers:
    codex:
      allow: ["files:*"]
      deny: ["files:delete"]
  servers:
    files:
      command: node
      args: ["server.mjs"]
      env:
        TOKEN: "\${FILES_TOKEN}"
      trust: quarantined
`
    );
    const cfg = loadConfigFile(file);
    assert.deepEqual(cfg.gatewayPolicy.agents.codex.deny, ["files:delete"]);
    assert.equal(cfg.inlineServers[0].trusted, false);
    assert.equal(cfg.inlineServers[0].env.TOKEN, "${FILES_TOKEN}");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid or unsupported Moatfiles fail at the boundary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-invalid-"));
  try {
    const file = path.join(dir, "Moatfile");
    fs.writeFileSync(file, "apiVersion: openmoat.dev/v2\nkind: Moatfile\n");
    assert.throws(() => loadConfigFile(file), /invalid Moatfile/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy migration copies configuration only and emits canonical YAML", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-migrate-"));
  try {
    const legacy = path.join(dir, "legacy.json");
    const output = path.join(dir, "Moatfile");
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        targets: { codex: { enabled: true, config: "~/.codex/config.toml" } },
        gatewayPolicy: { default: "deny", agents: { codex: { allow: ["*"] } } },
        secretsEnv: "/private/secrets.env",
        stateDir: "/private/state",
      })
    );
    migrateLegacyConfig(legacy, output);
    const text = fs.readFileSync(output, "utf8");
    assert.match(text, /apiVersion: openmoat\.dev\/v1/);
    assert.doesNotMatch(text, /private|secretsEnv|stateDir/);
    assert.equal(loadConfigFile(output).targets.codex.enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chezmoi export is optional and never invokes chezmoi", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-chezmoi-"));
  try {
    const source = writeMoatfile(dir);
    const destination = path.join(dir, "dot_config", "openmoat", "Moatfile");
    const result = exportChezmoi(source, destination);
    assert.equal(result.destination, destination);
    assert.equal(fs.readFileSync(destination, "utf8"), fs.readFileSync(source, "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
