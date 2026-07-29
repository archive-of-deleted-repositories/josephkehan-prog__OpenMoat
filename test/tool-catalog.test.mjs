import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  rankToolCatalog,
  searchToolCatalog,
} from "../dist/tool-catalog.js";
import {
  isToolNotFoundError,
  suggestToolName,
} from "../dist/tool-policy.js";

const entries = [
  {
    server: "files",
    tool: "search_files",
    description: "Find filenames in a local workspace.",
    provenance: "trusted",
  },
  {
    server: "github",
    tool: "search_code",
    description: "Search source code across GitHub repositories.",
    provenance: "trusted",
  },
  {
    server: "github",
    tool: "list_issues",
    description: "List repository issues.",
    provenance: "trusted",
  },
];

test("lexical tool ranking is deterministic and favors exact intent terms", () => {
  const first = rankToolCatalog(entries, "search GitHub repositories", 3);
  const second = rankToolCatalog(entries, "search GitHub repositories", 3);

  assert.deepEqual(first, second);
  assert.equal(first[0].server, "github");
  assert.equal(first[0].tool, "search_code");
  assert.ok(first[0].score > first[1].score);
});

test("catalog search reads generated markdown without RAG or embeddings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-catalog-"));
  fs.writeFileSync(
    path.join(root, "github.md"),
    `# MCP tool catalog — github

### github › search_code

[untrusted metadata; server=github; trust=trusted]
Search code across repositories.

### github › list_issues

[untrusted metadata; server=github; trust=trusted]
List issues.
`
  );

  const hits = searchToolCatalog(root, "code repositories", 5);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].heading, "github › search_code");
  assert.match(hits[0].snippet, /untrusted metadata/);
});

test("zero-overlap catalog entries are omitted instead of guessed", () => {
  assert.deepEqual(rankToolCatalog(entries, "weather forecast", 5), []);
});

test("missing-tool recovery offers bounded deterministic near names", () => {
  assert.deepEqual(
    suggestToolName("read_flie", [
      "write_file",
      "read_file",
      "list_directory",
    ]),
    ["read_file"]
  );
  assert.equal(
    isToolNotFoundError("Unknown tool: read_flie"),
    true
  );
  assert.equal(isToolNotFoundError("network not found"), false);
});

test("missing-tool recovery covers exact, token, substring, tail, and limits", () => {
  assert.deepEqual(
    suggestToolName("read_file", ["read_file", "write_file"]),
    ["read_file"]
  );
  assert.deepEqual(
    suggestToolName("read file", ["read_file"]),
    ["read_file"]
  );
  assert.deepEqual(
    suggestToolName("directory", ["list_directory"]),
    ["list_directory"]
  );
  assert.deepEqual(
    suggestToolName("query", ["db_execute_query"]),
    ["db_execute_query"]
  );
  assert.deepEqual(suggestToolName("", ["a"]), ["a"]);
  assert.deepEqual(suggestToolName("a", [""]), [""]);
  assert.deepEqual(suggestToolName("query", ["db_execute_query"], 0), []);
  assert.deepEqual(suggestToolName("unrelated", ["read_file"]), []);
  assert.equal(isToolNotFoundError("No such tool: x"), true);
  assert.equal(isToolNotFoundError("Tool not found: x"), true);
});
