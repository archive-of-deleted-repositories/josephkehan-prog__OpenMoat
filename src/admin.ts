import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type { OpenMoatConfig } from "./config.js";

export function trustServer(cfg: OpenMoatConfig, name: string): string {
  const server = cfg.inlineServers.find((candidate) => candidate.name === name);
  if (!server) throw new Error(`'${name}' is not configured`);
  if (server.disabled) throw new Error(`'${name}' is disabled`);
  if (server.trusted !== false) return `'${name}' is already trusted`;

  const stat = fs.lstatSync(cfg.configFile);
  if (stat.isSymbolicLink()) {
    throw new Error("refusing to mutate a symlinked Moatfile");
  }
  const source = fs.readFileSync(cfg.configFile, "utf8");
  const document = parseDocument(source);
  if (document.errors.length) {
    throw new Error(`invalid Moatfile: ${document.errors[0]?.message}`);
  }
  document.setIn(["gateway", "servers", name, "trust"], "trusted");
  const destination = path.resolve(cfg.configFile);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp-${process.pid}`
  );
  fs.writeFileSync(temporary, document.toString(), {
    mode: stat.mode & 0o777,
  });
  fs.renameSync(temporary, destination);
  return `'${name}' is now trusted; restart running OpenMoat processes`;
}
