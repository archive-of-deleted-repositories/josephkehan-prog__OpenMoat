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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SAME_ORIGIN_REDIRECTS = 5;

/**
 * Follow only bounded same-origin redirects. Native fetch follows redirects
 * automatically, which would let a configured remote endpoint pivot a request
 * toward a different host or a loopback/internal service.
 */
export function sameOriginFetch(
  _endpoint?: URL,
  baseFetch: typeof fetch = fetch
): typeof fetch {
  return (async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    let current = new URL(
      input instanceof Request ? input.url : String(input)
    );
    const origin = current.origin;
    let method = (
      init.method ??
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    let body =
      init.body ??
      (input instanceof Request &&
      method !== "GET" &&
      method !== "HEAD"
        ? input.body
        : undefined);
    const headers = new Headers(
      init.headers ??
        (input instanceof Request ? input.headers : undefined)
    );

    for (
      let redirects = 0;
      redirects <= MAX_SAME_ORIGIN_REDIRECTS;
      redirects++
    ) {
      const response = await baseFetch(current, {
        ...init,
        method,
        headers,
        body,
        redirect: "manual",
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, current);
      if (
        next.origin !== origin ||
        next.username ||
        next.password
      ) {
        throw new Error(
          `HTTP_REDIRECT_BLOCKED: refused redirect from '${origin}' to '${next.origin}'`
        );
      }
      if (redirects === MAX_SAME_ORIGIN_REDIRECTS) {
        throw new Error(
          `HTTP_REDIRECT_BLOCKED: exceeded ${MAX_SAME_ORIGIN_REDIRECTS} same-origin redirects`
        );
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      current = next;
    }
    throw new Error("HTTP_REDIRECT_BLOCKED: unreachable redirect state");
  }) as typeof fetch;
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
      fetch: sameOriginFetch(new URL(s.url)),
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
