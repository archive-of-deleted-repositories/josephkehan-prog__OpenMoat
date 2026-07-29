import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { trustServer } from "../dist/admin.js";
import {
  loadConfigFile,
  resolveConfigFile,
} from "../dist/config.js";
import { runDoctor } from "../dist/doctor.js";
import {
  loadSecrets,
  resolveServers,
} from "../dist/registry.js";

function write(root, gateway, paths = "") {
  const file = path.join(root, "Moatfile");
  fs.writeFileSync(
    file,
    `apiVersion: openmoat.dev/v1
kind: Moatfile
${paths}gateway:
${gateway}
`
  );
  return file;
}

test("config resolution is explicit and XDG-local", () => {
  assert.equal(
    resolveConfigFile(
      undefined,
      { XDG_CONFIG_HOME: "/tmp/config" },
      "/tmp/home"
    ),
    "/tmp/config/openmoat/Moatfile"
  );
  assert.equal(
    resolveConfigFile("./Moatfile", {}, "/tmp/home"),
    path.resolve("Moatfile")
  );
});

test("focused schema rejects retired surfaces and unsafe HTTP definitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-config-"));
  try {
    const retired = path.join(root, "retired");
    fs.writeFileSync(
      retired,
      `apiVersion: openmoat.dev/v1
kind: Moatfile
features: {}
gateway:
  callers: {}
  servers: {}
`
    );
    assert.throws(() => loadConfigFile(retired), /additional properties/);

    const insecure = write(
      root,
      `  callers: {}
  servers:
    remote:
      transport: http
      url: http://example.com/mcp
      trust: trusted
`
    );
    assert.throws(() => loadConfigFile(insecure), /must use https/);

    fs.writeFileSync(
      insecure,
      fs
        .readFileSync(insecure, "utf8")
        .replace("http://example.com", "https://example.com")
        .replace(
          "      trust: trusted",
          "      command: node\n      trust: trusted"
        )
    );
    assert.throws(
      () => loadConfigFile(insecure),
      /cannot set stdio process fields/
    );

    fs.writeFileSync(
      insecure,
      fs
        .readFileSync(insecure, "utf8")
        .replace("https://example.com", "https://user:password@example.com")
        .replace("      command: node\n", "")
    );
    assert.throws(
      () => loadConfigFile(insecure),
      /must not contain embedded credentials/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configuration and secret inputs have explicit size limits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-size-"));
  try {
    const config = path.join(root, "Moatfile");
    fs.writeFileSync(config, "x".repeat(1024 * 1024 + 1));
    assert.throws(
      () => loadConfigFile(config),
      /exceeds 1048576 bytes/
    );

    const secrets = path.join(root, "secrets.env");
    fs.writeFileSync(secrets, `TOKEN=${"x".repeat(1024 * 1024)}`, {
      mode: 0o600,
    });
    assert.throws(
      () => loadSecrets(secrets),
      /exceeds 1048576 bytes/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("config normalizes stdio and HTTP servers and rejects mixed-risk zones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-normalize-"));
  try {
    const file = write(
      root,
      `  callers:
    codex:
      allow: ["files:*"]
      zone: private
  zones:
    private:
      allowMixedRisk: false
  limits:
    maxPools: 4
  archives:
    ttlDays: 7
  servers:
    files:
      command: node
      args: ["server.mjs"]
      cwd: ./workspace
      cwdRoots: ["./workspace"]
      capabilities: ["sensitive-read"]
      zone: private
      trust: quarantined
    remote:
      transport: http
      url: https://example.com/mcp
      headers:
        Authorization: "Bearer \${TOKEN}"
      trust: trusted
`,
      `paths:
  state: ./state
  secrets: ./private.env
`
    );
    fs.mkdirSync(path.join(root, "workspace"));
    const cfg = loadConfigFile(file);
    assert.equal(cfg.gatewayPolicy.default, "deny");
    assert.equal(cfg.gatewayLimits.maxPools, 4);
    assert.equal(cfg.archiveLimits.ttlMs, 7 * 86_400_000);
    assert.equal(cfg.inlineServers[0].trusted, false);
    assert.equal(
      cfg.inlineServers[0].cwd,
      path.join(root, "workspace")
    );
    assert.equal(cfg.inlineServers[1].transport, "http");

    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(
          'capabilities: ["sensitive-read"]',
          'capabilities: ["sensitive-read", "network-egress"]'
        )
    );
    assert.throws(() => loadConfigFile(file), /mixed-risk zone/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("secret resolution is explicit, private, and reports missing values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-secrets-"));
  const file = path.join(root, "secrets.env");
  fs.writeFileSync(file, "TOKEN=secret\n", { mode: 0o644 });
  const secrets = loadSecrets(file);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  const resolved = resolveServers(
    [
      {
        name: "remote",
        transport: "http",
        url: "https://example.com/${PATH_PART}",
        headers: {
          Authorization: "Bearer ${TOKEN}",
          Missing: "${NOT_SET}",
        },
      },
    ],
    { ...secrets, PATH_PART: "mcp" }
  );
  assert.equal(
    resolved.servers[0].headers.Authorization,
    "Bearer secret"
  );
  assert.match(resolved.warnings[0], /NOT_SET/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("human trust mutates only the selected Moatfile field", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-trust-"));
  try {
    const file = write(
      root,
      `  callers: {}
  servers:
    alpha:
      # reviewed by a human
      command: node
      trust: quarantined
`
    );
    const before = loadConfigFile(file);
    assert.match(trustServer(before, "alpha"), /now trusted/);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /reviewed by a human/);
    assert.match(source, /trust: trusted/);
    assert.match(
      trustServer(loadConfigFile(file), "alpha"),
      /already trusted/
    );
    assert.throws(
      () => trustServer(loadConfigFile(file), "missing"),
      /not configured/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("human trust rejects disabled, symlinked, and malformed mutation targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-trust-reject-"));
  try {
    const real = write(
      root,
      `  callers: {}
  servers:
    alpha:
      command: node
      trust: quarantined
`
    );
    const cfg = loadConfigFile(real);
    assert.throws(
      () =>
        trustServer(
          {
            ...cfg,
            inlineServers: [{ ...cfg.inlineServers[0], disabled: true }],
          },
          "alpha"
        ),
      /disabled/
    );

    const link = path.join(root, "linked-Moatfile");
    fs.symlinkSync(real, link);
    assert.throws(
      () => trustServer({ ...cfg, configFile: link }, "alpha"),
      /symlinked/
    );

    const malformed = path.join(root, "malformed");
    fs.writeFileSync(malformed, "gateway: [");
    assert.throws(
      () => trustServer({ ...cfg, configFile: malformed }, "alpha"),
      /invalid Moatfile/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor is read-only and catches permissions and unresolved secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-doctor-"));
  try {
    const file = write(
      root,
      `  callers: {}
  servers:
    remote:
      transport: http
      url: https://example.com/mcp
      headers:
        Authorization: "Bearer \${MISSING_TOKEN}"
      trust: trusted
`,
      `paths:
  state: ./state
  secrets: ./secrets.env
`
    );
    const secrets = path.join(root, "secrets.env");
    fs.writeFileSync(secrets, "", { mode: 0o644 });
    const beforeMode = fs.statSync(secrets).mode & 0o777;
    const report = runDoctor(loadConfigFile(file));
    assert.equal(report.ready, false);
    assert.ok(
      report.checks.some(
        (check) => check.code === "SECRETS_PERMISSIONS"
      )
    );
    assert.ok(
      report.checks.some(
        (check) => check.code === "UNRESOLVED_SECRET"
      )
    );
    assert.equal(fs.statSync(secrets).mode & 0o777, beforeMode);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports private secrets and ready or stale catalogs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-doctor-ready-"));
  try {
    const file = write(
      root,
      `  callers: {}
  servers: {}
`,
      `paths:
  state: ./state
  secrets: ./secrets.env
`
    );
    fs.writeFileSync(path.join(root, "secrets.env"), "", { mode: 0o600 });
    fs.mkdirSync(path.join(root, "state"));
    const catalog = path.join(root, "state", "tool-catalog.json");
    fs.writeFileSync(
      catalog,
      '{"version":1,"generatedAt":"","entries":[]}'
    );
    let report = runDoctor(loadConfigFile(file));
    assert.equal(report.ready, true);
    assert.ok(report.checks.some((check) => check.code === "CATALOG_READY"));
    assert.ok(report.checks.some((check) => check.code === "SECRETS_PRIVATE"));

    const old = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(catalog, old, old);
    report = runDoctor(loadConfigFile(file));
    assert.ok(report.checks.some((check) => check.code === "CATALOG_STALE"));
    fs.rmSync(path.join(root, "secrets.env"));
    report = runDoctor(loadConfigFile(file));
    assert.ok(report.checks.some((check) => check.code === "SECRETS_MISSING"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
