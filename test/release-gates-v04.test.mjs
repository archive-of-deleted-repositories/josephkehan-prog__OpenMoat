import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("CI delegates release review to the complete canonical verifier", () => {
  const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");

  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
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
  assert.match(coverage, /--lines=80/);
  assert.match(coverage, /--functions=80/);
  assert.match(coverage, /--branches=80/);
  assert.doesNotMatch(coverage, /test-coverage-(?:lines|functions|branches)=(?:25|50)/);
  assert.match(
    fs.readFileSync("scripts/verify.mjs", "utf8"),
    /run\("npm", \["run", "test:coverage"\]\)/
  );
});
