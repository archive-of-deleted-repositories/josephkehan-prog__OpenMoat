import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogFile,
  loadCatalog,
  refreshCatalog,
  searchCatalog,
} from "../dist/catalog.js";
import { FileOAuthProvider } from "../dist/oauth.js";

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
