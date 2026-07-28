import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";

const STARTER_FILES = [
  "Moatfile",
  "registry/mcp-servers.json",
  "profile/AGENTS.md",
] as const;

export interface InitResult {
  dir: string;
  config: string;
  created: string[];
}

export function initWorkspace(destination: string, force = false, root = repoRoot()): InitResult {
  const dir = path.resolve(destination);
  const examples = path.join(root, "examples");
  if (!fs.existsSync(examples)) {
    throw new Error(`starter templates missing: ${examples}`);
  }

  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 && !force) {
    throw new Error(`${dir} is not empty; pass --force to overwrite starter-managed files`);
  }

  const created: string[] = [];
  for (const relative of STARTER_FILES) {
    const source = path.join(examples, relative);
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    created.push(target);
  }

  for (const relative of ["state", "skills", "plugins", "context"]) {
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
  }

  const secrets = path.join(dir, "secrets.env");
  fs.writeFileSync(secrets, "# Add NAME=value entries referenced by ${NAME} placeholders.\n", {
    mode: 0o600,
  });
  fs.chmodSync(secrets, 0o600);
  created.push(secrets);

  return {
    dir,
    config: path.join(dir, "Moatfile"),
    created,
  };
}
