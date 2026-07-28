import fs from "node:fs";

export const HUB_VERSION = (
  JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string }
).version;
