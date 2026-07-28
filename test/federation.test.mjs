import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFederationSnapshot,
  requireFederationReady,
  resolveFederatedServer,
  resolveFederatedSkill,
} from "../dist/federation.js";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeSkill(root, name, description) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
  );
}

function fixture(policy = "prefer-priority") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-federation-"));
  const low = path.join(tmp, "low");
  const high = path.join(tmp, "high");
  writeSkill(path.join(low, "skills"), "shared", "low priority");
  writeSkill(path.join(high, "skills"), "shared", "high priority");
  writeSkill(path.join(low, "skills"), "only-low", "unique low");
  writeJson(path.join(low, "registry.json"), {
    servers: [
      { name: "shared-server", command: "low" },
      { name: "only-low-server", command: "only-low" },
    ],
  });
  writeJson(path.join(high, "registry.json"), {
    servers: [{ name: "shared-server", command: "high" }],
  });
  writeJson(path.join(low, "plugins.json"), {
    plugins: [
      {
        name: "shared-plugin",
        ecosystem: "generic",
        collection: "tests",
        version: "1.0.0",
      },
    ],
  });
  writeJson(path.join(high, "plugins.json"), {
    plugins: [
      {
        name: "shared-plugin",
        ecosystem: "generic",
        collection: "tests",
        version: "2.0.0",
      },
    ],
  });
  const cfg = {
    registry: path.join(tmp, "unused.json"),
    secretsEnv: path.join(tmp, "secrets.env"),
    stateDir: path.join(tmp, "state"),
    skillsDir: path.join(tmp, "unused-skills"),
    extraSkillsDirs: [],
    pluginsDir: path.join(tmp, "unused-plugins"),
    profileFiles: [],
    memoryImport: path.join(tmp, "AGENTS.md"),
    contextDir: path.join(tmp, "context"),
    rag: { db: path.join(tmp, "rag.db"), include: [], embeddings: { provider: "none", model: "none" } },
    targets: {},
    federation: {
      includeLocal: false,
      conflictPolicy: policy,
      sources: [
        {
          id: "low",
          priority: 10,
          skillRoots: [path.join(low, "skills")],
          mcpRegistries: [path.join(low, "registry.json")],
          pluginCatalogs: [path.join(low, "plugins.json")],
        },
        {
          id: "high",
          priority: 20,
          skillRoots: [path.join(high, "skills")],
          mcpRegistries: [path.join(high, "registry.json")],
          pluginCatalogs: [path.join(high, "plugins.json")],
        },
      ],
    },
  };
  return { tmp, cfg };
}

test("federation selects by priority and preserves qualified shadowed assets", () => {
  const { tmp, cfg } = fixture();
  try {
    const snapshot = buildFederationSnapshot(cfg);
    assert.deepEqual(
      snapshot.conflicts.map((conflict) => conflict.kind).sort(),
      ["mcp", "plugin", "skill"]
    );
    assert.equal(
      snapshot.skills.find((asset) => asset.name === "shared" && asset.selected)?.id,
      "high/shared"
    );
    assert.equal(
      snapshot.servers.find((asset) => asset.name === "shared-server" && asset.selected)?.value.command,
      "high"
    );
    assert.equal(
      snapshot.servers.find((asset) => asset.id === "high/shared-server")?.value.trusted,
      false
    );
    assert.equal(
      snapshot.servers.find((asset) => asset.id === "high/shared-server")?.value.gatewayOnly,
      true
    );
    assert.equal(
      snapshot.plugins.find((asset) => asset.selected)?.value.version,
      "2.0.0"
    );
    assert.equal(resolveFederatedSkill(cfg, "shared")?.id, "high/shared");
    assert.equal(resolveFederatedSkill(cfg, "low/shared")?.value.description, "low priority");
    assert.equal(resolveFederatedServer(cfg, "shared-server")?.id, "high/shared-server");
    assert.equal(resolveFederatedServer(cfg, "low/shared-server")?.value.command, "low");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("strict federation rejects collisions before runtime resolution", () => {
  const { tmp, cfg } = fixture("error");
  try {
    const snapshot = buildFederationSnapshot(cfg);
    assert.throws(
      () => requireFederationReady(cfg, snapshot),
      /federation conflicts block resolution/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
