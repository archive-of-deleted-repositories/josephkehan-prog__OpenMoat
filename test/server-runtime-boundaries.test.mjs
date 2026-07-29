import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";
import {
  bootstrapPersonalSections,
  boundToolResultEnvelope,
  recentUsageEvents,
  resolveCallerContext,
} from "../dist/server.js";

test("small tool-result envelopes pass through without archival", () => {
  const result = {
    content: [{ type: "text", text: "small" }],
    structuredContent: { answer: 42 },
    isError: false,
  };

  const bounded = boundToolResultEnvelope(
    { stateDir: "/unused" },
    "caller-a",
    result
  );

  assert.equal(bounded.archived, null);
  assert.equal(bounded.result, result);
});

test("oversized envelopes return a minimal caller-bound archive marker", () => {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openmoat-bound-result-")
  );
  const bounded = boundToolResultEnvelope(
    { stateDir },
    "caller-a",
    {
      content: [{ type: "text", text: "x".repeat(13_000) }],
    }
  );

  assert.match(bounded.archived, /^[a-f0-9]{16}$/);
  assert.equal(bounded.result.isError, undefined);
  assert.equal("resultType" in bounded.result, false);
  assert.match(bounded.result.content[0].text, /structured envelope archived/);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("recent usage formatting is caller-scoped and ignores malformed records", () => {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openmoat-recent-usage-")
  );
  try {
    assert.equal(
      recentUsageEvents({ stateDir }, 10, "caller-a"),
      "(no usage events yet)"
    );
    fs.writeFileSync(
      path.join(stateDir, "usage.jsonl"),
      [
        "not-json",
        JSON.stringify({
          ts: "2026-07-29T00:00:00.000Z",
          agent: "caller-a",
          tool: "tool_call",
          server: "fixture",
          target: "echo",
          ms: 12,
          isError: true,
        }),
        JSON.stringify({
          ts: "2026-07-29T00:01:00.000Z",
          agent: "caller-b",
          tool: "tool_search",
          queryLength: 8,
        }),
      ].join("\n")
    );

    const caller = recentUsageEvents({ stateDir }, 10, "caller-a");
    assert.match(caller, /fixture › echo \(12ms\) ERROR/);
    assert.doesNotMatch(caller, /caller-b/);

    const operator = recentUsageEvents({ stateDir }, 1);
    assert.match(operator, /caller-b/);
    assert.match(operator, /tool_search: search/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bootstrap sections honor disabled, missing, and enabled personal sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-bootstrap-"));
  const profile = path.join(root, "AGENTS.md");
  fs.writeFileSync(profile, "profile data");
  try {
    assert.deepEqual(
      bootstrapPersonalSections(
        {
          features: { profile: false, handoffs: false },
          profileFiles: [profile],
        },
        { latest: () => [] },
        "caller-a"
      ),
      []
    );

    const sections = bootstrapPersonalSections(
      {
        features: { profile: true, handoffs: true },
        profileFiles: [path.join(root, "missing.md"), profile],
      },
      {
        latest: () => [
          {
            relativePath: "caller-a/handoff.md",
            content: "handoff data",
          },
        ],
      },
      "caller-a"
    );
    assert.equal(sections.length, 2);
    assert.match(sections[0], /profile data/);
    assert.match(sections[1], /handoff data/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("caller resolution fails closed for malformed modern metadata", () => {
  const server = {
    server: {
      getClientVersion: () => ({ name: "legacy-client", version: "1.0.0" }),
    },
  };
  const malformed = {
    mcpReq: {
      envelope: {
        [CLIENT_INFO_META_KEY]: { name: "   " },
      },
    },
  };
  const modern = resolveCallerContext(
    server,
    { era: "modern" },
    malformed
  );
  assert.deepEqual(modern, {
    label: "unknown",
    source: "unknown",
    assurance: "none",
    protocolEra: "modern",
  });

  const legacy = resolveCallerContext(
    server,
    { era: "legacy" },
    { mcpReq: { envelope: undefined } }
  );
  assert.equal(legacy.label, "legacy-client");
  assert.equal(legacy.clientInfo.version, "1.0.0");

  const modernWithoutVersion = resolveCallerContext(
    server,
    { era: "modern" },
    {
      mcpReq: {
        envelope: {
          [CLIENT_INFO_META_KEY]: { name: "modern-client", version: 7 },
        },
      },
    }
  );
  assert.deepEqual(modernWithoutVersion.clientInfo, {
    name: "modern-client",
  });

  const noLegacyIdentity = resolveCallerContext(
    { server: { getClientVersion: () => undefined } },
    { era: "legacy" },
    { mcpReq: { envelope: null } }
  );
  assert.equal(noLegacyIdentity.label, "unknown");
});
