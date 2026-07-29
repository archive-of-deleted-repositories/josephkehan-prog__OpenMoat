import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  catalogFile,
  loadCatalog,
  refreshCatalog,
  searchCatalog,
} from "../dist/catalog.js";
import {
  browserLaunchCommand,
  FileOAuthProvider,
} from "../dist/oauth.js";

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function cfg(root) {
  return {
    stateDir: path.join(root, "state"),
    inlineServers: [
      { name: "alpha", command: "node", trusted: true },
      { name: "quarantine", command: "node", trusted: false },
      { name: "off", command: "node", disabled: true },
    ],
  };
}

test("catalog refresh is bounded, private, deterministic derived state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-catalog-"));
  const config = cfg(root);
  const runtime = {
    inspect: async (server) =>
      `[untrusted metadata; server=${server}; trust=trusted]
Tool: read_file
Read a local file
Input schema: {"type":"object"}`,
  };
  try {
    const notes = await refreshCatalog(config, runtime);
    assert.deepEqual(notes, [
      "alpha: cataloged 1 tool(s)",
      "quarantine: quarantined",
      "off: disabled",
    ]);
    assert.equal(fs.statSync(catalogFile(config)).mode & 0o077, 0);
    assert.equal(loadCatalog(config).entries.length, 1);
    assert.equal(searchCatalog(config, "read local", 5)[0].tool, "read_file");
    assert.deepEqual(searchCatalog(config, "", 5), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog rejects invalid and oversized files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-catalog-invalid-"));
  const config = cfg(root);
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(catalogFile(config), '{"version":2,"entries":[]}');
  assert.throws(() => loadCatalog(config), /INVALID_CATALOG/);
  fs.writeFileSync(
    catalogFile(config),
    '{"version":1,"generatedAt":"","entries":[{"server":7}]}'
  );
  assert.throws(() => loadCatalog(config), /INVALID_CATALOG/);
  fs.writeFileSync(
    catalogFile(config),
    "x".repeat(10 * 1024 * 1024 + 1)
  );
  assert.throws(() => loadCatalog(config), /CATALOG_TOO_LARGE/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("OAuth storage is private, path-safe, issuer-bound, and noninteractive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-oauth-"));
  const provider = new FileOAuthProvider(root, "../../escape", false);
  try {
    const oauthDir = path.join(root, "oauth");
    provider.saveClientInformation(
      { client_id: "client-a", issuer: "https://issuer-a.example" },
      { issuer: "https://issuer-a.example" }
    );
    provider.saveTokens(
      {
        access_token: "token-a",
        token_type: "bearer",
        issuer: "https://issuer-a.example",
      },
      { issuer: "https://issuer-a.example" }
    );
    provider.saveDiscoveryState({
      authorizationServerUrl: new URL("https://issuer-a.example"),
      issuer: "https://issuer-a.example",
    });
    const files = fs.readdirSync(oauthDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    assert.equal(fs.statSync(oauthDir).mode & 0o077, 0);
    assert.equal(
      fs.statSync(path.join(oauthDir, files[0])).mode & 0o077,
      0
    );
    assert.equal(
      provider.tokens({ issuer: "https://issuer-a.example" })
        .access_token,
      "token-a"
    );
    assert.equal(
      provider.tokens({ issuer: "https://issuer-b.example" }),
      undefined
    );
    assert.equal(
      provider.discoveryState().issuer,
      "https://issuer-a.example"
    );
    await assert.rejects(
      provider.redirectToAuthorization(
        new URL("https://issuer-a.example/authorize")
      ),
      /requires OAuth authorization/
    );
    provider.invalidateCredentials("tokens");
    assert.equal(provider.tokens(), undefined);
  } finally {
    provider.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("OAuth callback port validation rejects unsafe values", () => {
  const previous = process.env.OPENMOAT_OAUTH_PORT;
  process.env.OPENMOAT_OAUTH_PORT = "80";
  try {
    const provider = new FileOAuthProvider(
      fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-port-")),
      "server",
      false
    );
    assert.throws(() => provider.redirectUrl, /1024 through 65535/);
  } finally {
    if (previous === undefined) delete process.env.OPENMOAT_OAUTH_PORT;
    else process.env.OPENMOAT_OAUTH_PORT = previous;
  }
});

test("browser launch never passes an authorization URL through a command shell", () => {
  const url = "https://issuer.example/authorize?state=safe&x=1";
  const launch = browserLaunchCommand("win32", url);
  assert.equal(launch.command, "rundll32.exe");
  assert.deepEqual(launch.args, [
    "url.dll,FileProtocolHandler",
    url,
  ]);
  assert.notEqual(launch.command, "cmd");
});

test("OAuth state is random, enforced once, and closes the callback listener", async () => {
  const previous = process.env.OPENMOAT_OAUTH_PORT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-oauth-state-"));
  let provider;
  try {
    const firstPort = await unusedPort();
    process.env.OPENMOAT_OAUTH_PORT = String(firstPort);
    provider = new FileOAuthProvider(root, "remote", true, () => {});
    const firstState = provider.state();
    const activeState = provider.state();
    assert.match(activeState, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(activeState, firstState);
    await assert.rejects(
      provider.redirectToAuthorization(
        new URL(`http://issuer.invalid/authorize?state=wrong`)
      ),
      /state mismatch/
    );

    await provider.redirectToAuthorization(
      new URL(
        `http://issuer.invalid/authorize?state=${encodeURIComponent(activeState)}`
      )
    );
    const mismatch = assert.rejects(
      provider.waitForCode(1_000),
      /state mismatch/
    );
    const mismatchResponse = await fetch(
      `http://127.0.0.1:${firstPort}/callback?code=attacker&state=wrong`
    );
    assert.equal(mismatchResponse.status, 400);
    await mismatch;
    await assert.rejects(
      fetch(`http://127.0.0.1:${firstPort}/callback`),
      /fetch failed/
    );

    const secondPort = await unusedPort();
    process.env.OPENMOAT_OAUTH_PORT = String(secondPort);
    provider = new FileOAuthProvider(root, "remote", true, () => {});
    const state = provider.state();
    await provider.redirectToAuthorization(
      new URL(
        `http://issuer.invalid/authorize?state=${encodeURIComponent(state)}`
      )
    );
    const code = provider.waitForCode(1_000);
    const successResponse = await fetch(
      `http://127.0.0.1:${secondPort}/callback?code=approved&state=${encodeURIComponent(state)}`
    );
    assert.equal(successResponse.status, 200);
    assert.equal(await code, "approved");
    await assert.rejects(
      fetch(`http://127.0.0.1:${secondPort}/callback`),
      /fetch failed/
    );
  } finally {
    provider?.closeCallbackServer();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENMOAT_OAUTH_PORT;
    else process.env.OPENMOAT_OAUTH_PORT = previous;
  }
});

test("interactive OAuth keeps its process alive until a terminal callback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openmoat-oauth-liveness-"));
  const port = await unusedPort();
  const moduleUrl = pathToFileURL(
    path.resolve(import.meta.dirname, "../dist/oauth.js")
  ).href;
  const script = `
    import { FileOAuthProvider } from ${JSON.stringify(moduleUrl)};
    process.env.OPENMOAT_OAUTH_PORT = ${JSON.stringify(String(port))};
    const provider = new FileOAuthProvider(
      ${JSON.stringify(root)},
      "remote",
      true,
      () => {}
    );
    const state = provider.state();
    await provider.redirectToAuthorization(
      new URL("http://issuer.invalid/authorize?state=" + state)
    );
    console.log("READY " + state);
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const state = await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        const match = String(chunk).match(/READY ([A-Za-z0-9_-]+)/);
        if (match) resolve(match[1]);
      });
      child.on("exit", (code) => {
        reject(
          new Error(
            `OAuth child exited before callback (code ${code}): ${stderr}`
          )
        );
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      child.exitCode,
      null,
      "callback listener did not keep the OAuth process alive"
    );
    const response = await fetch(
      `http://127.0.0.1:${port}/callback?code=approved&state=${encodeURIComponent(state)}`
    );
    assert.equal(response.status, 200);
    const exitCode = await new Promise((resolve) =>
      child.on("close", resolve)
    );
    assert.equal(exitCode, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
