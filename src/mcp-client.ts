import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ResolvedServer } from "./registry.js";
import { descendantPids } from "./process-tree.js";
import { buildChildEnv } from "./runtime-security.js";

interface DisposableStdioTransport {
  readonly pid: number | null;
  close(): Promise<void>;
}

const baseStdioDispose = Object.getOwnPropertyDescriptor(
  StdioClientTransport.prototype,
  "_dispose"
)?.value as
  | ((this: DisposableStdioTransport) => Promise<void>)
  | undefined;

/**
 * The SDK auto-negotiates stdio on a disposable sibling process. Reap that
 * sibling's descendants first: the SDK's base disposer owns the root process
 * and pipe lifecycle, but a helper process can otherwise outlive the probe.
 */
class ProcessTreeStdioClientTransport extends StdioClientTransport {}

Object.defineProperty(ProcessTreeStdioClientTransport.prototype, "_dispose", {
  configurable: true,
  async value(this: DisposableStdioTransport): Promise<void> {
    const rootPid = this.pid;
    if (rootPid !== null) {
      for (const pid of descendantPids(rootPid).reverse()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    if (baseStdioDispose) {
      await baseStdioDispose.call(this);
    } else {
      await this.close();
    }
  },
});

export function cleanEnv(
  extra?: Record<string, string>,
  inheritEnv?: string[],
  source: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  return buildChildEnv(extra, inheritEnv, source);
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
  return new ProcessTreeStdioClientTransport({
    command: s.command,
    args: s.args ?? [],
    env: cleanEnv(s.env, s.inheritEnv),
    cwd: opts.cwd,
    stderr: "ignore",
  });
}
