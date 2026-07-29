import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";
import {
  boundToolResultEnvelope,
  resolveCallerContext,
} from "../dist/server.js";

function archiveConfig(stateDir) {
  return {
    stateDir,
    archiveLimits: {
      maxBlobBytes: 1_048_576,
      maxCallerBytes: 16_777_216,
      maxCallerEntries: 64,
      ttlMs: 86_400_000,
    },
  };
}

test("small results pass through and oversized results become caller-bound handles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-result-"));
  try {
    const small = {
      content: [{ type: "text", text: "small" }],
      structuredContent: { answer: 42 },
      isError: false,
    };
    assert.deepEqual(
      boundToolResultEnvelope(archiveConfig(root), "caller-a", small),
      { result: small, archived: null }
    );

    const bounded = boundToolResultEnvelope(
      archiveConfig(root),
      "caller-a",
      {
        content: [{ type: "text", text: "x".repeat(13_000) }],
        isError: true,
        resultType: "tool_error",
      }
    );
    assert.match(bounded.archived, /^[a-f0-9]{48}$/);
    assert.equal(bounded.result.isError, true);
    assert.equal(bounded.result.resultType, "tool_error");
    assert.match(bounded.result.content[0].text, /Tool result archived/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("result envelopes reject cycles, excessive depth, and excessive entries", () => {
  const cfg = archiveConfig(
    fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-shape-"))
  );
  const cyclic = { content: [] };
  cyclic.self = cyclic;
  assert.throws(
    () => boundToolResultEnvelope(cfg, "caller", cyclic),
    /cyclic/
  );

  let deep = "leaf";
  for (let index = 0; index < 40; index++) deep = [deep];
  assert.throws(
    () =>
      boundToolResultEnvelope(cfg, "caller", {
        content: deep,
      }),
    /RESULT_TOO_DEEP/
  );
  assert.throws(
    () =>
      boundToolResultEnvelope(cfg, "caller", {
        content: Array.from({ length: 50_001 }, () => null),
      }),
    /RESULT_TOO_COMPLEX/
  );
});

test("caller identity is per-request, bounded, and fails closed", () => {
  const server = {
    server: {
      getClientVersion: () => ({
        name: "legacy-client",
        version: "1.0.0",
      }),
    },
  };
  const modern = resolveCallerContext(
    server,
    { era: "modern" },
    {
      mcpReq: {
        envelope: {
          [CLIENT_INFO_META_KEY]: {
            name: "modern-client",
            version: "1.0.0",
          },
        },
      },
    }
  );
  assert.equal(modern.label, "modern-client");
  assert.equal(modern.assurance, "transport-self-asserted");

  const malformed = resolveCallerContext(
    server,
    { era: "modern" },
    {
      mcpReq: {
        envelope: {
          [CLIENT_INFO_META_KEY]: { name: "x".repeat(129) },
        },
      },
    }
  );
  assert.equal(malformed.label, "unknown");

  const launcher = resolveCallerContext(
    server,
    { era: "modern" },
    { mcpReq: { envelope: {} } },
    "trusted-launcher"
  );
  assert.equal(launcher.label, "trusted-launcher");
  assert.equal(launcher.assurance, "local-launcher-asserted");

  const legacy = resolveCallerContext(
    server,
    { era: "legacy" },
    { mcpReq: { envelope: undefined } }
  );
  assert.equal(legacy.label, "legacy-client");
});
