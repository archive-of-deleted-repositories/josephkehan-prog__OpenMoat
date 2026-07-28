import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ResolvedServer } from "./registry.js";

export function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined)
  ) as Record<string, string>;
  return { ...base, ...(extra ?? {}) };
}

/** Build a client transport for any registry server (stdio or streamable-http). */
export function makeTransport(
  s: ResolvedServer,
  opts: { authProvider?: OAuthClientProvider; cwd?: string } = {}
): StdioClientTransport | StreamableHTTPClientTransport {
  if (s.transport === "http") {
    if (!s.url) throw new Error(`'${s.name}' is http but has no url`);
    return new StreamableHTTPClientTransport(new URL(s.url), {
      authProvider: opts.authProvider,
      requestInit: s.headers ? { headers: s.headers } : undefined,
    });
  }
  if (!s.command) throw new Error(`'${s.name}' has no command`);
  return new StdioClientTransport({
    command: s.command,
    args: s.args ?? [],
    env: cleanEnv(s.env),
    cwd: opts.cwd,
    stderr: "ignore",
  });
}
