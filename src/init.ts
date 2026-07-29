import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";

export interface InitResult {
  dir: string;
  config: string;
  created: string[];
}

function rejectManagedSymlink(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(
        `refusing to overwrite OpenMoat managed path because it is a symbolic link: ${target}`
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export function initWorkspace(
  destination: string,
  force = false,
  root = repoRoot()
): InitResult {
  const dir = path.resolve(destination);
  rejectManagedSymlink(dir);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !force) {
    throw new Error(
      `${dir} is not empty; pass --force to overwrite OpenMoat starter files`
    );
  }
  fs.mkdirSync(dir, { recursive: true });

  const config = path.join(dir, "Moatfile");
  const state = path.join(dir, "state");
  const secrets = path.join(dir, "secrets.env");
  for (const managed of [config, state, secrets]) {
    rejectManagedSymlink(managed);
  }

  fs.copyFileSync(path.join(root, "examples", "Moatfile"), config);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.chmodSync(state, 0o700);
  fs.writeFileSync(
    secrets,
    "# Values referenced by ${NAME} placeholders. Never commit this file.\n",
    { mode: 0o600 }
  );
  fs.chmodSync(secrets, 0o600);
  return { dir, config, created: [config, secrets, state] };
}
