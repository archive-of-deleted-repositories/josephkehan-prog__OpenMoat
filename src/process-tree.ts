import { execFileSync } from "node:child_process";

/** All descendant pids of `pid` (children, grandchildren, ...), breadth-first. */
export function descendantPids(pid: number): number[] {
  const descendants: number[] = [];
  const stack = [pid];
  while (stack.length) {
    const parent = stack.pop()!;
    let children: number[] = [];
    try {
      children = execFileSync("pgrep", ["-P", String(parent)], {
        timeout: 1000,
      })
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    } catch {
      // No children.
    }
    for (const child of children) {
      descendants.push(child);
      stack.push(child);
    }
  }
  return descendants;
}

/** Kill descendants before their parent so no helper can be orphaned. */
export function killProcessTree(rootPid: number): number[] {
  const killed: number[] = [];
  for (const pid of [...descendantPids(rootPid).reverse(), rootPid]) {
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // Already gone.
    }
  }
  return killed;
}
