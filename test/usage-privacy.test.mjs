import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { logUsage } from "../dist/instincts.js";
import { recentUsageEvents } from "../dist/server.js";

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${file}`);
}

test("usage telemetry never persists raw search queries", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-usage-"));
  const file = path.join(stateDir, "usage.jsonl");
  logUsage(
    { stateDir },
    {
      tool: "tool_search",
      agent: "team/a",
      query: "private acquisition roadmap",
    }
  );

  await waitForFile(file);
  const persisted = fs.readFileSync(file, "utf8");
  const event = JSON.parse(persisted);
  assert.doesNotMatch(persisted, /private acquisition roadmap/);
  assert.equal(event.query, undefined);
  assert.equal(event.queryLength, 27);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test("recent usage events are caller-scoped", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-usage-"));
  fs.writeFileSync(
    path.join(stateDir, "usage.jsonl"),
    [
      {
        ts: "2026-07-29T00:00:00.000Z",
        agent: "team/a",
        tool: "tool_search",
        queryLength: 27,
      },
      {
        ts: "2026-07-29T00:01:00.000Z",
        agent: "team-b",
        tool: "tool_search",
        queryLength: 8,
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n"
  );

  const output = recentUsageEvents({ stateDir }, 10, "team-b");

  assert.doesNotMatch(output, /team\/a/);
  assert.match(output, /team-b/);
  assert.doesNotMatch(output, /private acquisition roadmap/);
});
