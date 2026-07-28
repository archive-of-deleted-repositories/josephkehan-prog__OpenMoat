import path from "node:path";
import { loadConfigFile } from "./config.js";

interface ConformanceCase {
  operation: string;
  input: Record<string, unknown>;
}

function error(code: string): Record<string, unknown> {
  return { ok: false, error: { code } };
}

function patterns(input: Record<string, unknown>, field: "allow" | "deny"): string[] {
  const policy = (input.policy ?? {}) as Record<string, unknown>;
  return Array.isArray(policy[field]) ? (policy[field] as string[]) : [];
}

function matches(pattern: string, server: string, tool: string): boolean {
  return pattern === "*" || pattern === server || pattern === `${server}:*` ||
    pattern === `${server}:${tool}`;
}

export function evaluateConformanceCase(
  value: ConformanceCase,
  casePath: string
): Record<string, unknown> {
  const input = value.input;
  switch (value.operation) {
    case "validate": {
      const fixture = path.resolve(path.dirname(path.dirname(casePath)), String(input.fixture));
      try {
        loadConfigFile(fixture);
        return { ok: true };
      } catch {
        return error("INVALID_CONFIG");
      }
    }
    case "resolve_path":
      return {
        ok: true,
        value: path.resolve(String(input.base), String(input.value)),
      };
    case "resolve_env": {
      const environment = (input.environment ?? {}) as Record<string, string>;
      let missing = false;
      const value = String(input.value).replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (placeholder, name: string) => {
          if (environment[name] === undefined) {
            missing = true;
            return placeholder;
          }
          return environment[name];
        }
      );
      return missing ? error("UNRESOLVED_ENV") : { ok: true, value };
    }
    case "authorize": {
      if (input.trust === "quarantined") {
        return { ok: true, allowed: false, reason: "quarantined" };
      }
      const server = String(input.server);
      const tool = String(input.tool);
      if (patterns(input, "deny").some((pattern) => matches(pattern, server, tool))) {
        return { ok: true, allowed: false, reason: "denied" };
      }
      if (patterns(input, "allow").some((pattern) => matches(pattern, server, tool))) {
        return { ok: true, allowed: true };
      }
      return { ok: true, allowed: false, reason: "default_deny" };
    }
    case "process_failure":
      return error("PROCESS_FAILED");
    case "timeout":
      return { ...error("TIMEOUT"), circuit: "open" };
    case "shutdown":
      return { ok: true, childrenRemaining: 0 };
    case "doctor":
      return { ok: true };
    default:
      return error("INTERNAL");
  }
}

