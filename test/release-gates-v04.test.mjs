import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("CI delegates release review to the complete canonical verifier", () => {
  const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");

  assert.match(workflow, /npm run verify/);
});

test("canonical coverage measures the v0.4 gateway and server paths", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const coverage = [
    pkg.scripts["test:coverage"],
    pkg.scripts["test:coverage:core"],
    pkg.scripts["test:coverage:gateway"],
  ].join("\n");

  assert.match(coverage, /dist\/gateway\.js/);
  assert.match(coverage, /dist\/server\.js/);
  assert.match(coverage, /test-coverage-lines=50/);
  assert.match(coverage, /test-coverage-functions=50/);
  assert.match(coverage, /test-coverage-branches=25/);
  assert.match(
    fs.readFileSync("scripts/verify.mjs", "utf8"),
    /run\("npm", \["run", "test:coverage"\]\)/
  );
});
