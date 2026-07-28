/**
 * Hub-side OAuth for remote MCP servers (mcp-hub / Docker-gateway pattern):
 * authorization-code + PKCE, tokens persisted per server under state/oauth/.
 * First gateway call to an OAuth server opens the browser once; afterwards
 * tokens refresh silently. Non-interactive contexts (catalog indexing) throw
 * a clear "run `hub auth <name>`" error instead of opening a browser.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/client";

// One callback port per machine is a real constraint (DCR registrations pin
// the redirect_uri), but it must at least be configurable so two hub setups
// can coexist: HUB_OAUTH_PORT overrides.
const PORT = Number(process.env.HUB_OAUTH_PORT) || 8090;

/** Open a URL in the default browser, cross-platform, without ever throwing —
 *  auth must still be completable by pasting the printed URL. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
  child.on("error", (e) => {
    console.error(`openmoat: could not open a browser (${e.message}) — open this URL manually:\n  ${url}`);
  });
  child.unref();
}

interface Stored {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export class FileOAuthProvider implements OAuthClientProvider {
  private file: string;
  private server?: http.Server;
  private codeResolve?: (code: string) => void;
  private codeReject?: (err: Error) => void;
  // The redirect can land BEFORE waitForCode() installs the resolvers (the SDK
  // only surfaces UnauthorizedError after the browser is already open) — buffer
  // an early result instead of dropping it.
  private pendingCode?: string;
  private pendingError?: Error;
  // CSRF: the `state` the SDK put on the authorization URL. The callback must
  // echo it back, otherwise a different flow's (or an attacker's) code could
  // be fed into this waiting server. Undefined = SDK sent no state; then we
  // can't bind it, but PKCE + loopback binding still protect the flow.
  private expectedState?: string;

  constructor(stateDir: string, private serverName: string, private interactive: boolean) {
    const dir = path.join(stateDir, "oauth");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${serverName}.json`);
  }

  private load(): Stored {
    if (!fs.existsSync(this.file)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      // save() merges over load(), so returning {} for an unreadable file
      // would silently wipe stored tokens — preserve it first.
      try {
        fs.copyFileSync(this.file, `${this.file}.corrupt`);
      } catch {
        /* best-effort */
      }
      console.error(`openmoat: OAuth state ${this.file} unreadable (kept as .corrupt) — re-auth will be required: ${e}`);
      return {};
    }
  }

  private save(patch: Partial<Stored>): void {
    fs.writeFileSync(this.file, JSON.stringify({ ...this.load(), ...patch }, null, 2), { mode: 0o600 });
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "openmoat",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.load().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.save({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.load().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.save({ tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.save({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.load().codeVerifier;
    if (!v) throw new Error("no PKCE verifier saved — restart the auth flow");
    return v;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) {
      throw new Error(
        `'${this.serverName}' requires OAuth authorization — run \`node dist/cli.js auth ${this.serverName}\` once (opens browser), then it's usable from every agent.`
      );
    }
    // Remember the SDK-issued `state` so the callback can be bound to it.
    this.expectedState = url.searchParams.get("state") ?? undefined;
    await this.startCallbackServer();
    openBrowser(url.toString());
    console.error(`openmoat: browser opened to authorize '${this.serverName}' — waiting for approval…\n  (if no browser appeared, open: ${url})`);
  }

  /** Resolves with the authorization code once the browser redirect lands
   *  (immediately, if it already landed before this was called). */
  waitForCode(timeoutMs = 180_000): Promise<string> {
    if (this.pendingCode) {
      const code = this.pendingCode;
      this.pendingCode = undefined;
      return Promise.resolve(code);
    }
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = undefined;
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this.codeResolve = resolve;
      this.codeReject = reject;
      setTimeout(() => reject(new Error(`authorization timed out after ${timeoutMs / 1000}s`)), timeoutMs).unref();
    });
  }

  private startCallbackServer(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
        if (u.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        // CSRF check: reject a callback whose `state` doesn't match the one
        // the SDK issued for this flow. Only enforced when a state was set.
        if (this.expectedState !== undefined && u.searchParams.get("state") !== this.expectedState) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end("<body>authorization failed: state mismatch</body>");
          const e = new Error("authorization failed: OAuth state mismatch (possible CSRF)");
          if (this.codeReject) this.codeReject(e);
          else this.pendingError = e;
          return;
        }
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          code
            ? "<body style='font-family:serif;text-align:center;padding-top:4rem'><h2>openmoat authorized</h2>You can close this tab.</body>"
            : `<body>authorization failed: ${err ?? "no code"}</body>`
        );
        if (code) {
          if (this.codeResolve) this.codeResolve(code);
          else this.pendingCode = code; // landed before waitForCode — buffer it
        } else {
          const e = new Error(`authorization failed: ${err ?? "no code returned"}`);
          if (this.codeReject) this.codeReject(e);
          else this.pendingError = e;
        }
      });
      this.server.on("error", (e) => reject(new Error(`OAuth callback port ${PORT} unavailable: ${e.message}`)));
      this.server.listen(PORT, "127.0.0.1", () => resolve());
      this.server.unref();
    });
  }

  closeCallbackServer(): void {
    this.server?.close();
    this.server = undefined;
  }
}
