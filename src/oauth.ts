/**
 * OpenMoat-side OAuth for remote MCP servers:
 * authorization-code + PKCE, tokens persisted per server under state/oauth/.
 * First gateway call to an OAuth server opens the browser once; afterwards
 * tokens refresh silently. Non-interactive contexts (catalog indexing) throw
 * a clear "run `moat auth <name>`" error instead of opening a browser.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import type {
  OAuthClientInformation,
  OAuthClientInformationContext,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";

// One callback port per machine is a real constraint (DCR registrations pin
// the redirect_uri), but it must at least be configurable so two OpenMoat setups
// can coexist: OPENMOAT_OAUTH_PORT overrides.
function callbackPort(): number {
  const raw = process.env.OPENMOAT_OAUTH_PORT;
  if (!raw) return 8090;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(
      "OPENMOAT_OAUTH_PORT must be an integer from 1024 through 65535"
    );
  }
  return value;
}

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
  clientInformationByIssuer?: Record<string, OAuthClientInformationFull>;
  tokensByIssuer?: Record<string, OAuthTokens>;
  lastIssuer?: string;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
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
  private waitTimer?: NodeJS.Timeout;
  // CSRF: issue the SDK a random `state`, require the authorization URL to
  // carry that exact value, then require the callback to echo it once.
  private expectedState?: string;
  private issuedState?: string;

  constructor(
    stateDir: string,
    private serverName: string,
    private interactive: boolean,
    private openAuthorization: (url: string) => void = openBrowser
  ) {
    const dir = path.join(stateDir, "oauth");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const id = crypto
      .createHash("sha256")
      .update(serverName)
      .digest("hex");
    this.file = path.join(dir, `${id}.json`);
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
        fs.chmodSync(`${this.file}.corrupt`, 0o600);
      } catch {
        /* best-effort */
      }
      console.error(`openmoat: OAuth state ${this.file} unreadable (kept as .corrupt) — re-auth will be required: ${e}`);
      return {};
    }
  }

  private save(patch: Partial<Stored>): void {
    const temporary = `${this.file}.tmp-${process.pid}-${crypto
      .randomBytes(6)
      .toString("hex")}`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ ...this.load(), ...patch }, null, 2),
      { mode: 0o600 }
    );
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${callbackPort()}/callback`;
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

  private issuer(
    context?: OAuthClientInformationContext,
    value?: unknown
  ): string | undefined {
    return (
      context?.issuer ??
      (value as { issuer?: string } | undefined)?.issuer
    );
  }

  clientInformation(
    context?: OAuthClientInformationContext
  ): OAuthClientInformation | undefined {
    const stored = this.load();
    const issuer = this.issuer(context) ?? stored.lastIssuer;
    return issuer
      ? stored.clientInformationByIssuer?.[issuer]
      : undefined;
  }

  saveClientInformation(
    info: OAuthClientInformationFull,
    context?: OAuthClientInformationContext
  ): void {
    const issuer = this.issuer(context, info);
    if (!issuer) {
      throw new Error("OAuth issuer missing while saving client information");
    }
    const stored = this.load();
    this.save({
      clientInformationByIssuer: {
        ...stored.clientInformationByIssuer,
        [issuer]: info,
      },
      lastIssuer: issuer,
    });
  }

  tokens(
    context?: OAuthClientInformationContext
  ): OAuthTokens | undefined {
    const stored = this.load();
    const issuer = this.issuer(context) ?? stored.lastIssuer;
    return issuer ? stored.tokensByIssuer?.[issuer] : undefined;
  }

  saveTokens(
    tokens: OAuthTokens,
    context?: OAuthClientInformationContext
  ): void {
    const issuer = this.issuer(context, tokens);
    if (!issuer) {
      throw new Error("OAuth issuer missing while saving tokens");
    }
    const stored = this.load();
    this.save({
      tokensByIssuer: {
        ...stored.tokensByIssuer,
        [issuer]: tokens,
      },
      lastIssuer: issuer,
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.save({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.load().codeVerifier;
    if (!v) throw new Error("no PKCE verifier saved — restart the auth flow");
    return v;
  }

  state(): string {
    const state = crypto.randomBytes(32).toString("base64url");
    this.issuedState = state;
    return state;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) {
      throw new Error(
        `'${this.serverName}' requires OAuth authorization — run \`node dist/cli.js auth ${this.serverName}\` once (opens browser), then it's usable from every agent.`
      );
    }
    const state = url.searchParams.get("state") ?? "";
    const expected = this.issuedState ?? "";
    const stateBytes = Buffer.from(state);
    const expectedBytes = Buffer.from(expected);
    if (
      !state ||
      !expected ||
      stateBytes.length !== expectedBytes.length ||
      !crypto.timingSafeEqual(stateBytes, expectedBytes)
    ) {
      throw new Error("authorization failed: OAuth state mismatch");
    }
    this.expectedState = state;
    this.issuedState = undefined;
    await this.startCallbackServer();
    this.openAuthorization(url.toString());
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
      this.codeResolve = (code) => {
        if (this.waitTimer) clearTimeout(this.waitTimer);
        resolve(code);
      };
      this.codeReject = (error) => {
        if (this.waitTimer) clearTimeout(this.waitTimer);
        reject(error);
      };
      this.waitTimer = setTimeout(() => {
        this.closeCallbackServer();
        reject(
          new Error(
            `authorization timed out after ${timeoutMs / 1000}s`
          )
        );
      }, timeoutMs);
      this.waitTimer.unref();
    });
  }

  private startCallbackServer(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const port = callbackPort();
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
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
          const reject = this.codeReject;
          this.codeReject = undefined;
          this.codeResolve = undefined;
          this.expectedState = undefined;
          if (reject) reject(e);
          else this.pendingError = e;
          this.closeCallbackServer();
          return;
        }
        const code = u.searchParams.get("code");
        const err = u.searchParams
          .get("error")
          ?.replace(/[^A-Za-z0-9._-]/g, "")
          .slice(0, 80);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          code
            ? "<body style='font-family:serif;text-align:center;padding-top:4rem'><h2>openmoat authorized</h2>You can close this tab.</body>"
            : "<body>authorization failed</body>"
        );
        if (code) {
          const resolve = this.codeResolve;
          this.codeResolve = undefined;
          this.codeReject = undefined;
          this.expectedState = undefined;
          if (resolve) resolve(code);
          else this.pendingCode = code; // landed before waitForCode — buffer it
        } else {
          const e = new Error(`authorization failed: ${err ?? "no code returned"}`);
          const reject = this.codeReject;
          this.codeReject = undefined;
          this.codeResolve = undefined;
          this.expectedState = undefined;
          if (reject) reject(e);
          else this.pendingError = e;
        }
        this.closeCallbackServer();
      });
      const port = callbackPort();
      this.server.on("error", (e) => {
        this.server = undefined;
        reject(
          new Error(
            `OAuth callback port ${port} unavailable: ${e.message}`
          )
        );
      });
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  closeCallbackServer(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    this.server?.close();
    this.server = undefined;
    this.issuedState = undefined;
    this.expectedState = undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.save({ discoveryState: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.load().discoveryState;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): void {
    const stored = this.load();
    if (scope === "all") {
      this.save({
        clientInformationByIssuer: {},
        tokensByIssuer: {},
        codeVerifier: undefined,
        discoveryState: undefined,
        lastIssuer: undefined,
      });
      return;
    }
    if (scope === "client") this.save({ clientInformationByIssuer: {} });
    if (scope === "tokens") this.save({ tokensByIssuer: {} });
    if (scope === "verifier") this.save({ codeVerifier: undefined });
    if (scope === "discovery") this.save({ discoveryState: undefined });
  }
}
