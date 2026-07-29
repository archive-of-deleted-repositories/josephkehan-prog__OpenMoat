import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

function request(process, lines, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${method}`)),
      3000
    );
    const onLine = (line) => {
      const message = JSON.parse(line);
      if (message.id !== id) return;
      clearTimeout(timer);
      lines.off("line", onLine);
      resolve(message);
    };
    lines.on("line", onLine);
    process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    );
  });
}

test("default MCP surface excludes every opt-in and human-admin capability", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-surface-"));
  const file = path.join(root, "Moatfile");
  fs.writeFileSync(
    file,
    `apiVersion: openmoat.dev/v1
kind: Moatfile
features: {}
paths:
  state: ./state
  profile: ./profile.md
  handoffs: ./handoffs
targets: {}
gateway:
  callers: {}
  servers: {}
`
  );
  const child = spawn(
    process.execPath,
    ["dist/cli.js", "--file", file, "serve"],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
  );
  const lines = readline.createInterface({ input: child.stdout });
  try {
    await request(child, lines, 1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "surface-test", version: "1" },
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n"
    );
    const listed = await request(child, lines, 2, "tools/list");
    const names = listed.result.tools.map((tool) => tool.name);

    for (const required of [
      "tool_search",
      "tool_describe",
      "tool_call",
      "registry_list",
      "moat_health",
      "context_save",
    ]) {
      assert.ok(names.includes(required), `${required} should be available`);
    }
    for (const excluded of [
      "rag_search",
      "instinct_report",
      "skills_list",
      "skill_read",
      "plugins_list",
      "registry_trust",
      "registry_enable",
      "rag_reindex",
      "mcp_reindex",
    ]) {
      assert.equal(names.includes(excluded), false, excluded);
    }
  } finally {
    lines.close();
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
