import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { contextNamespace } from "../dist/context-store.js";

const PROTOCOL_VERSION = "2026-07-28";

function modernMeta(caller) {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
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
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    );
  });
}

function startOpenMoat(moatfile, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-v04-"));
  const file = path.join(root, "Moatfile");
  fs.writeFileSync(file, moatfile(root));
  const child = spawn(
    process.execPath,
    ["dist/cli.js", "--file", file, "serve"],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const lines = readline.createInterface({ input: child.stdout });
  return { child, lines, root };
}

async function stopOpenMoat(instance) {
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

function baseMoatfile(root, extra = "") {
  return `apiVersion: openmoat.dev/v1
kind: Moatfile
features:
  handoffs: true
paths:
  state: ${JSON.stringify(path.join(root, "state"))}
  handoffs: ${JSON.stringify(path.join(root, "handoffs"))}
targets: {}
gateway:
  callers: {}
  servers: {}
${extra}`;
}

function gatewayMoatfile(root, mode) {
  const fixture = path.resolve("test/fixtures/protocol-server.mjs");
  return `apiVersion: openmoat.dev/v1
kind: Moatfile
features: {}
paths:
  state: ${JSON.stringify(path.join(root, "state"))}
  handoffs: ${JSON.stringify(path.join(root, "handoffs"))}
targets: {}
gateway:
  callers:
    outer-client:
      allow: ["fixture:*"]
      deny: []
  servers:
    fixture:
      command: ${JSON.stringify(process.execPath)}
      args:
        - ${JSON.stringify(fixture)}
        - ${JSON.stringify(mode)}
      env:
        FIXTURE_SECRET: top-secret-value
      trust: trusted
`;
}

async function initializeLegacy(instance, caller = "outer-client") {
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
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }) + "\n"
  );
}

async function discoverModern(instance, caller = "outer-client") {
  const response = await request(
    instance.child,
    instance.lines,
    1,
    "server/discover",
    { _meta: modernMeta(caller) }
  );
  assert.equal(response.error, undefined);
  assert.ok(response.result.supportedVersions.includes(PROTOCOL_VERSION));
}

async function callGateway(instance, id, caller, value) {
  return request(instance.child, instance.lines, id, "tools/call", {
    name: "tool_call",
    arguments: {
      server: "fixture",
      tool: "envelope_echo",
      arguments: { value },
    },
    _meta: modernMeta(caller),
  });
}

test("outward stdio serves modern requests and resolves caller labels per request", async () => {
  const instance = startOpenMoat((root) => baseMoatfile(root));
  try {
    await discoverModern(instance, "caller-a");
    for (const [id, caller] of [
      [2, "caller-a"],
      [3, "caller-b"],
    ]) {
      const saved = await request(
        instance.child,
        instance.lines,
        id,
        "tools/call",
        {
          name: "context_save",
          arguments: { title: caller, content: "request scoped" },
          _meta: modernMeta(caller),
        }
      );
      assert.equal(saved.error, undefined);
    }
    assert.equal(
      fs.existsSync(
        path.join(instance.root, "handoffs", contextNamespace("caller-a"))
      ),
      true
    );
    assert.equal(
      fs.existsSync(
        path.join(instance.root, "handoffs", contextNamespace("caller-b"))
      ),
      true
    );
  } finally {
    await stopOpenMoat(instance);
  }
});

test("trusted launcher caller overrides modern request labels", async () => {
  const instance = startOpenMoat(
    (root) => baseMoatfile(root),
    { OPENMOAT_CALLER: "launcher-caller" }
  );
  try {
    await discoverModern(instance, "request-caller");
    const saved = await request(
      instance.child,
      instance.lines,
      2,
      "tools/call",
      {
        name: "context_save",
        arguments: { title: "launcher", content: "trusted override" },
        _meta: modernMeta("request-caller"),
      }
    );
    assert.equal(saved.error, undefined);
    assert.equal(
      fs.existsSync(
        path.join(
          instance.root,
          "handoffs",
          contextNamespace("launcher-caller")
        )
      ),
      true
    );
    assert.equal(
      fs.existsSync(
        path.join(
          instance.root,
          "handoffs",
          contextNamespace("request-caller")
        )
      ),
      false
    );
  } finally {
    await stopOpenMoat(instance);
  }
});

for (const [outerEra, downstreamMode] of [
  ["legacy", "modern-only"],
  ["modern", "legacy-only"],
  ["modern", "modern-only"],
]) {
  test(`${outerEra} outward client proxies a complete envelope from ${downstreamMode} downstream`, async () => {
    const instance = startOpenMoat((root) =>
      gatewayMoatfile(root, downstreamMode)
    );
    try {
      if (outerEra === "legacy") await initializeLegacy(instance);
      else await discoverModern(instance);
      const response =
        outerEra === "legacy"
          ? await request(instance.child, instance.lines, 2, "tools/call", {
              name: "tool_call",
              arguments: {
                server: "fixture",
                tool: "envelope_echo",
                arguments: { value: `${outerEra}-${downstreamMode}` },
              },
            })
          : await callGateway(
              instance,
              2,
              "outer-client",
              `${outerEra}-${downstreamMode}`
            );
      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, false);
      assert.equal(
        response.result.structuredContent.nested.secret,
        "[REDACTED]"
      );
      assert.equal(
        response.result._meta["example.test/safe"].secret,
        "[REDACTED]"
      );
      assert.notEqual(
        response.result._meta["io.modelcontextprotocol/serverInfo"]?.name,
        "untrusted-downstream-identity"
      );
      assert.doesNotMatch(JSON.stringify(response.result), /top-secret-value/);
    } finally {
      await stopOpenMoat(instance);
    }
  });
}

test("modern structured envelopes are bounded and archived for retrieval", async () => {
  const instance = startOpenMoat((root) =>
    gatewayMoatfile(root, "modern-only")
  );
  try {
    await discoverModern(instance);
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
    assert.ok(JSON.stringify(response.result).length < 12_000);
    assert.match(
      response.result.content.map((block) => block.text ?? "").join("\n"),
      /structured envelope archived/i
    );
    assert.match(
      response.result.structuredContent.openmoatArchivedResult.hash,
      /^[a-f0-9]{16}$/
    );
    assert.equal(
      response.result._meta["openmoat.dev/archivedResult"].hash,
      response.result.structuredContent.openmoatArchivedResult.hash
    );
  } finally {
    await stopOpenMoat(instance);
  }
});

test("moat_usage cannot expose another caller's raw search telemetry", async () => {
  const instance = startOpenMoat((root) => baseMoatfile(root));
  try {
    await discoverModern(instance, "team-b");
    const state = path.join(instance.root, "state");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(
      path.join(state, "usage.jsonl"),
      JSON.stringify({
        ts: "2026-07-29T00:00:00.000Z",
        agent: "team/a",
        tool: "tool_search",
        query: "private acquisition roadmap",
      }) + "\n"
    );

    const response = await request(
      instance.child,
      instance.lines,
      2,
      "tools/call",
      {
        name: "moat_usage",
        arguments: { agent: "team/a", recent: 10 },
        _meta: modernMeta("team-b"),
      }
    );
    assert.equal(response.error, undefined);
    const output = response.result.content[0].text;
    assert.doesNotMatch(output, /team\/a/);
    assert.doesNotMatch(output, /private acquisition roadmap/);
  } finally {
    await stopOpenMoat(instance);
  }
});
