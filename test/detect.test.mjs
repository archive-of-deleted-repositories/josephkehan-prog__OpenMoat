import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectTargets, renderDetection } from "../dist/detect.js";

function target(config, enabled = false) {
  return { enabled, config };
}

test("target detection reports explicit evidence and recommends only disabled detected clients", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-detect-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, "#!/bin/sh\n");
  fs.chmodSync(codex, 0o755);

  const hermesConfig = path.join(home, ".hermes", "config.yaml");
  fs.mkdirSync(path.dirname(hermesConfig), { recursive: true });
  fs.writeFileSync(hermesConfig, "mcp_servers: {}\n");
  const opencodeConfig = path.join(home, ".config", "opencode", "opencode.jsonc");
  fs.mkdirSync(path.dirname(opencodeConfig), { recursive: true });

  try {
    const report = detectTargets(
      {
        targets: {
          codex: target(path.join(home, ".codex", "config.toml")),
          hermes: target(hermesConfig, true),
          opencode: target(opencodeConfig),
          cursor: target(path.join(home, ".cursor", "mcp.json")),
        },
      },
      {
        configFile: path.join(home, ".openmoat", "hub.config.json"),
        home,
        pathEnv: bin,
        platform: "linux",
      }
    );

    assert.equal(report.readOnly, true);
    assert.deepEqual(report.detectedTargets, ["codex", "hermes", "opencode"]);
    assert.deepEqual(report.recommendedTargets, ["codex", "opencode"]);
    assert.equal(report.targets.find((item) => item.id === "codex").evidence[0].kind, "command");
    assert.equal(report.targets.find((item) => item.id === "hermes").recommendation, "keep-enabled");
    assert.equal(report.targets.find((item) => item.id === "opencode").evidence[0].kind, "support-directory");
    assert.equal(report.targets.find((item) => item.id === "cursor").recommendation, "no-action");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("human detection output states the safety boundary and exact review step", () => {
  const report = {
    readOnly: true,
    configFile: "/tmp/hub.config.json",
    detectedTargets: ["codex"],
    recommendedTargets: ["codex"],
    targets: [
      {
        id: "codex",
        enabled: false,
        config: "/tmp/config.toml",
        configExists: false,
        detected: true,
        evidence: [{ kind: "command", value: "/tmp/bin/codex" }],
        recommendation: "enable-after-review",
      },
    ],
  };

  const output = renderDetection(report);
  assert.match(output, /no files changed/);
  assert.match(output, /Suggested after review: codex/);
  assert.match(output, /hub doctor && hub sync --dry-run/);
});
