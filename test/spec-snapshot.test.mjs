import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("vendors the complete signed OpenMoat Spec v0.2.4 snapshot", () => {
  const lock = JSON.parse(fs.readFileSync("spec.lock", "utf8"));
  const cases = fs
    .readdirSync("vendor/spec/cases")
    .filter((name) => name.endsWith(".json"));

  assert.equal(lock.tag, "v0.2.4");
  assert.equal(cases.length, 26);
  assert.equal(
    fs.existsSync(path.join("vendor", "spec", "conformance", "runner.py")),
    true
  );
});
