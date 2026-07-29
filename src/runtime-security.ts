import fs from "node:fs";
import path from "node:path";

export interface RuntimePoolLimits {
  maxPools: number;
  maxPoolsPerServer: number;
}

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export function buildChildEnv(
  configured: Readonly<Record<string, string>> = {},
  inheritEnv: readonly string[] = [],
  source: EnvironmentSource = process.env
): Record<string, string> {
  const inherited = Object.fromEntries(
    inheritEnv.flatMap((name) => {
      const value = source[name];
      return value === undefined || value.startsWith("()") ? [] : [[name, value]];
    })
  );
  return { ...inherited, ...configured };
}

function requireDirectory(value: string, label: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(value);
  } catch {
    throw new Error(`PATH_OUTSIDE_ROOT: ${label} does not exist`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`PATH_OUTSIDE_ROOT: ${label} is not a directory`);
  }
  return resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function resolveWorkingDirectory(
  requested: string | undefined,
  configured: string | undefined,
  roots: readonly string[],
  baseDir: string
): string {
  if (requested !== undefined && roots.length === 0) {
    throw new Error(
      "PATH_OUTSIDE_ROOT: caller-supplied cwd is disabled for this server"
    );
  }
  const selected = requested ?? configured ?? baseDir;
  const absolute = path.isAbsolute(selected)
    ? selected
    : path.resolve(baseDir, selected);
  const resolved = requireDirectory(absolute, `cwd '${selected}'`);
  if (roots.length === 0) return resolved;
  const allowed = roots.map((root) =>
    requireDirectory(
      path.isAbsolute(root) ? root : path.resolve(baseDir, root),
      `cwd root '${root}'`
    )
  );
  if (!allowed.some((root) => isWithin(root, resolved))) {
    throw new Error(
      `PATH_OUTSIDE_ROOT: cwd '${selected}' resolves outside declared roots`
    );
  }
  return resolved;
}

export interface MetadataProvenance {
  server: string;
  trust: "trusted" | "quarantined" | "disabled";
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeMetadata(
  value: string,
  provenance: MetadataProvenance,
  maxLength = 4096
): string {
  const prefix =
    `[untrusted metadata; server=${provenance.server}; ` +
    `trust=${provenance.trust}]\n`;
  const sanitized = value
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\r\n?/g, "\n");
  return `${prefix}${sanitized}`.slice(0, Math.max(0, maxLength));
}

export class SecretRedactor {
  readonly #secrets: readonly string[];

  constructor(values: readonly string[]) {
    this.#secrets = [...new Set(values.filter(Boolean))].sort(
      (left, right) => right.length - left.length
    );
  }

  text(value: string): string {
    return this.#secrets.reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      value
    );
  }

  redact<T>(value: T): T {
    return this.#redactUnknown(value) as T;
  }

  #redactUnknown(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.#redactUnknown(item));
    }
    if (value !== null && typeof value === "object") {
      const entries: [string, unknown][] = [];
      const used = new Set<string>();
      for (const [key, item] of Object.entries(value)) {
        const base = this.text(key);
        let safeKey = base;
        for (let suffix = 2; used.has(safeKey); suffix++) {
          safeKey = `${base}#${suffix}`;
        }
        used.add(safeKey);
        entries.push([safeKey, this.#redactUnknown(item)]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  }
}
export async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> | void = () => {}
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(async () => {
      try {
        await onTimeout();
      } finally {
        reject(new Error(`TIMEOUT: operation exceeded ${timeoutMs}ms`));
      }
    }, Math.max(1, timeoutMs));
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PoolBudget {
  readonly #limits: RuntimePoolLimits;
  readonly #keys = new Map<string, string>();

  constructor(limits: RuntimePoolLimits) {
    this.#limits = { ...limits };
  }

  get size(): number {
    return this.#keys.size;
  }

  reserve(server: string, key: string): void {
    if (this.#keys.has(key)) return;
    const perServer = [...this.#keys.values()].filter(
      (value) => value === server
    ).length;
    if (perServer >= this.#limits.maxPoolsPerServer) {
      throw new Error(
        `POOL_LIMIT: '${server}' reached ${this.#limits.maxPoolsPerServer} pools`
      );
    }
    if (this.#keys.size >= this.#limits.maxPools) {
      throw new Error(
        `POOL_LIMIT: gateway reached ${this.#limits.maxPools} pools`
      );
    }
    this.#keys.set(key, server);
  }

  release(key: string): void {
    this.#keys.delete(key);
  }
}
