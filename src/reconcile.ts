import { createHash } from "node:crypto";

export type ReconcileOperation =
  | {
      kind: "create" | "update";
      path: string;
      beforeHash: string | null;
      afterHash: string;
      content: string;
    }
  | {
      kind: "remove";
      path: string;
      beforeHash: string;
      afterHash: null;
    };

export interface ReconcilePlan {
  version: 1;
  source: "openmoat";
  operations: ReconcileOperation[];
}

export interface ApplyInterface {
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function planFiles(
  current: Readonly<Record<string, string>>,
  desired: Readonly<Record<string, string>>
): ReconcilePlan {
  const paths = [...new Set([...Object.keys(current), ...Object.keys(desired)])].sort();
  const operations: ReconcileOperation[] = [];
  for (const filePath of paths) {
    const before = current[filePath];
    const after = desired[filePath];
    if (after === undefined && before !== undefined) {
      operations.push({
        kind: "remove",
        path: filePath,
        beforeHash: digest(before),
        afterHash: null,
      });
    } else if (after !== undefined && before === undefined) {
      operations.push({
        kind: "create",
        path: filePath,
        beforeHash: null,
        afterHash: digest(after),
        content: after,
      });
    } else if (after !== undefined && before !== undefined && after !== before) {
      operations.push({
        kind: "update",
        path: filePath,
        beforeHash: digest(before),
        afterHash: digest(after),
        content: after,
      });
    }
  }
  return { version: 1, source: "openmoat", operations };
}

export async function applyPlan(
  plan: ReconcilePlan,
  adapter: ApplyInterface
): Promise<void> {
  for (const operation of plan.operations) {
    if (operation.kind === "remove") {
      await adapter.remove(operation.path);
    } else {
      await adapter.write(operation.path, operation.content);
    }
  }
}

