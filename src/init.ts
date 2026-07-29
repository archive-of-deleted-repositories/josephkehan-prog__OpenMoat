import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";

export interface InitResult {
  dir: string;
  config: string;
  created: string[];
}

export function initWorkspace(
  destination: string,
  force = false,
  root = repoRoot()
): InitResult {
  const dir = path.resolve(destination);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !force) {
    throw new Error(
      `${dir} is not empty; pass --force to overwrite OpenMoat starter files`
    );
  }
  fs.mkdirSync(dir, { recursive: true });

  const config = path.join(dir, "Moatfile");
  fs.copyFileSync(path.join(root, "examples", "Moatfile"), config);

  const state = path.join(dir, "state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.chmodSync(state, 0o700);

  const secrets = path.join(dir, "secrets.env");
  fs.writeFileSync(
    secrets,
    "# Values referenced by ${NAME} placeholders. Never commit this file.\n",
    { mode: 0o600 }
  );
  fs.chmodSync(secrets, 0o600);
  return { dir, config, created: [config, secrets, state] };
}
