import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

const MODERN = "2026-07-28";

function modernMeta(caller) {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": {
      name: caller,
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function request(child, lines, id, method, params = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      lines.off("line", onLine);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    const onLine = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== id) return;
      clearTimeout(timer);
      lines.off("line", onLine);
      resolve(message);
    };
    lines.on("line", onLine);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
    );
  });
}

function moatfile(root, downstreamMode = "modern-only") {
  const fixture = path.resolve("test/fixtures/protocol-server.mjs");
  return `apiVersion: openmoat.dev/v1
kind: Moatfile
paths:
  state: ${JSON.stringify(path.join(root, "state"))}
  secrets: ${JSON.stringify(path.join(root, "secrets.env"))}
gateway:
  callers:
    outer-client:
      allow: ["fixture:*"]
    denied-client:
      deny: ["*"]
  servers:
    fixture:
      command: ${JSON.stringify(process.execPath)}
      args:
        - ${JSON.stringify(fixture)}
        - ${JSON.stringify(downstreamMode)}
      env:
        FIXTURE_SECRET: top-secret-value
      trust: trusted
`;
}

function start(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-v1-"));
  const file = path.join(root, "Moatfile");
  fs.writeFileSync(file, moatfile(root, mode));
  fs.writeFileSync(path.join(root, "secrets.env"), "", { mode: 0o600 });
  const child = spawn(
    process.execPath,
    ["dist/cli.js", "--file", file, "serve"],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  return {
    child,
    lines: readline.createInterface({ input: child.stdout }),
    root,
  };
}

async function stop(instance) {
  instance.lines.close();
  if (!instance.child.stdin.destroyed) instance.child.stdin.end();
  await Promise.race([
    new Promise((resolve) => instance.child.once("exit", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        instance.child.kill("SIGKILL");
        resolve();
      }, 3000)
    ),
  ]);
  fs.rmSync(instance.root, { recursive: true, force: true });
}

async function modernDiscover(instance, caller = "outer-client") {
  const response = await request(
    instance.child,
    instance.lines,
    1,
    "server/discover",
    { _meta: modernMeta(caller) }
  );
  assert.equal(response.error, undefined);
  assert.ok(response.result.supportedVersions.includes(MODERN));
}

async function legacyInitialize(instance, caller = "outer-client") {
  const response = await request(
    instance.child,
    instance.lines,
    1,
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: caller, version: "1.0.0" },
    }
  );
  assert.equal(response.error, undefined);
  instance.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })}\n`
  );
}

for (const [outerEra, downstreamMode] of [
  ["legacy", "modern-only"],
  ["modern", "legacy-only"],
  ["modern", "modern-only"],
]) {
  test(`${outerEra} outward stdio proxies to ${downstreamMode} downstream`, async () => {
    const instance = start(downstreamMode);
    try {
      if (outerEra === "legacy") await legacyInitialize(instance);
      else await modernDiscover(instance);
      const params = {
        name: "tool_call",
        arguments: {
          server: "fixture",
          tool: "envelope_echo",
          arguments: { value: `${outerEra}-${downstreamMode}` },
        },
        ...(outerEra === "modern"
          ? { _meta: modernMeta("outer-client") }
          : {}),
      };
      const response = await request(
        instance.child,
        instance.lines,
        2,
        "tools/call",
        params
      );
      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, false);
      assert.equal(
        response.result.structuredContent.nested.secret,
        "[REDACTED]"
      );
      assert.doesNotMatch(
        JSON.stringify(response.result),
        /top-secret-value/
      );
      assert.notEqual(
        response.result._meta[
          "io.modelcontextprotocol/serverInfo"
        ]?.name,
        "untrusted-downstream-identity"
      );
    } finally {
      await stop(instance);
    }
  });
}

test("stateless discovery exposes only the seven focused agent tools", async () => {
  const instance = start("modern-only");
  try {
    await modernDiscover(instance);
    const response = await request(
      instance.child,
      instance.lines,
      2,
      "tools/list",
      { _meta: modernMeta("outer-client") }
    );
    assert.equal(response.error, undefined);
    assert.deepEqual(
      response.result.tools.map((tool) => tool.name).sort(),
      [
        "moat_health",
        "moat_usage",
        "registry_list",
        "tool_call",
        "tool_describe",
        "tool_result_fetch",
        "tool_search",
      ]
    );
  } finally {
    await stop(instance);
  }
});

test("deny-by-default blocks unauthorized calls before downstream spawn", async () => {
  const instance = start("modern-only");
  try {
    await modernDiscover(instance, "unknown-client");
    const response = await request(
      instance.child,
      instance.lines,
      2,
      "tools/call",
      {
        name: "tool_call",
        arguments: {
          server: "fixture",
          tool: "envelope_echo",
          arguments: { value: "blocked" },
        },
        _meta: modernMeta("unknown-client"),
      }
    );
    assert.match(
      JSON.stringify(response),
      /gateway policy denied/
    );
  } finally {
    await stop(instance);
  }
});

test("oversized results use opaque caller-bound retrieval handles", async () => {
  const instance = start("modern-only");
  try {
    await modernDiscover(instance);
    const response = await request(
      instance.child,
      instance.lines,
      2,
      "tools/call",
      {
        name: "tool_call",
        arguments: {
          server: "fixture",
          tool: "oversized_envelope",
          arguments: {},
        },
        _meta: modernMeta("outer-client"),
      }
    );
    assert.equal(response.error, undefined);
    const handle =
      response.result.structuredContent.openmoatArchivedResult.hash;
    assert.match(handle, /^[a-f0-9]{48}$/);

    const denied = await request(
      instance.child,
      instance.lines,
      3,
      "tools/call",
      {
        name: "tool_result_fetch",
        arguments: { hash: handle },
        _meta: modernMeta("denied-client"),
      }
    );
    assert.match(
      denied.result.content[0].text,
      /not found or expired/
    );

    const owner = await request(
      instance.child,
      instance.lines,
      4,
      "tools/call",
      {
        name: "tool_result_fetch",
        arguments: { hash: handle, limit: 1000 },
        _meta: modernMeta("outer-client"),
      }
    );
    assert.doesNotMatch(owner.result.content[0].text, /not found/);
  } finally {
    await stop(instance);
  }
});
