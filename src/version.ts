import fs from "node:fs";

export const OPENMOAT_VERSION = (
  JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string }
).version;
