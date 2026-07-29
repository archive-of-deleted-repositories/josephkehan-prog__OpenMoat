import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bootstrapPersonalSections } from "../dist/server.js";
import { AGENT_TOOL_NAMES } from "../dist/tool-surface.js";

test("public commands and optional integrations use OpenMoat-neutral names", () => {
  const publicSources = [
    "src/adopt.ts",
    "src/cli.ts",
    "src/configure.ts",
    "src/detect.ts",
    "src/evaluate.ts",
    "src/mcp-rag.ts",
    "src/oauth.ts",
    "src/server.ts",
    "src/sync.ts",
  ]
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");

  assert.doesNotMatch(
    publicSources,
    /\bhub (?:auth|configure|detect|discover|doctor|index|sync|trust)\b/
  );
  assert.doesNotMatch(
    fs.readFileSync("src/server.ts", "utf8") +
      fs.readFileSync("src/sync.ts", "utf8"),
    /\b(?:squish|exa|firecrawl|context7)\b/i
  );
  assert.doesNotMatch(publicSources, /HUB_OAUTH_PORT/);
  assert.equal(AGENT_TOOL_NAMES.includes("hub_bootstrap"), false);
  assert.equal(AGENT_TOOL_NAMES.includes("hub_usage"), false);
  assert.equal(AGENT_TOOL_NAMES.includes("moat_bootstrap"), true);
  assert.equal(AGENT_TOOL_NAMES.includes("moat_usage"), true);
});

test("disabled profile and handoff features expose no personal content", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "openmoat-neutrality-")
  );
  const profile = path.join(root, "profile.md");
  fs.writeFileSync(profile, "private-profile-marker");
  const latest = () => [
    {
      relativePath: "caller/latest.md",
      content: "private-handoff-marker",
    },
  ];
  const config = {
    features: { profile: false, handoffs: false },
    profileFiles: [profile],
  };
  try {
    assert.deepEqual(
      bootstrapPersonalSections(config, { latest }, "test-caller"),
      []
    );
    const enabled = bootstrapPersonalSections(
      {
        ...config,
        features: { profile: true, handoffs: true },
      },
      { latest },
      "test-caller"
    ).join("\n");
    assert.match(enabled, /private-profile-marker/);
    assert.match(enabled, /private-handoff-marker/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
