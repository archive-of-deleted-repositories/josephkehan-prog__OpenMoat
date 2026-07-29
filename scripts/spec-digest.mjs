#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "vendor/spec");

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      return [];
    }
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? files(absolute) : [absolute];
  });
}

const digest = crypto.createHash("sha256");
for (const file of files(root).sort()) {
  digest.update(path.relative(root, file));
  digest.update("\0");
  digest.update(fs.readFileSync(file));
  digest.update("\0");
}
console.log(digest.digest("hex"));
