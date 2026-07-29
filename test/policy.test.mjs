import assert from "node:assert/strict";
import test from "node:test";
import { authorizeGateway, requireGatewayAuthorization } from "../dist/policy.js";

const cfg = {
  gatewayPolicy: {
    default: "deny",
    agents: {
      codex: { allow: ["*"], deny: ["filesystem:write_file"] },
      research: { allow: ["exa:*", "firecrawl"] },
    },
  },
};

test("gateway policy defaults unknown callers to deny", () => {
  const decision = authorizeGateway(cfg, "unknown-client", "github", "create_issue");
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /gateway default/);
});

test("gateway policy supports server and tool scopes with deny precedence", () => {
  assert.equal(authorizeGateway(cfg, "research", "exa", "web_search_exa").allowed, true);
  assert.equal(authorizeGateway(cfg, "research", "firecrawl", "scrape").allowed, true);
  assert.equal(authorizeGateway(cfg, "research", "github", "create_issue").allowed, false);
  assert.equal(authorizeGateway(cfg, "codex", "filesystem", "read_file").allowed, true);
  assert.equal(authorizeGateway(cfg, "codex", "filesystem", "write_file").allowed, false);
});

test("gateway policy rejection names caller and target", () => {
  assert.throws(
    () => requireGatewayAuthorization(cfg, "research", "github", "create_issue"),
    /gateway policy denied 'research' access to 'github:create_issue'/
  );
});

test("gateway policy applies wildcard rules, zones, and missing-policy fail-closed", () => {
  const zoned = {
    gatewayPolicy: {
      default: "deny",
      agents: {
        "*": {
          allow: ["public:*"],
          deny: ["public:delete"],
          zone: "public",
        },
      },
    },
  };
  assert.equal(
    authorizeGateway(zoned, undefined, "public", "read", "public")
      .allowed,
    true
  );
  assert.equal(
    authorizeGateway(zoned, "new-client", "public", "delete", "public")
      .allowed,
    false
  );
  assert.match(
    authorizeGateway(zoned, "new-client", "private", "read", "private")
      .reason,
    /zone denied/
  );
  assert.equal(
    authorizeGateway({}, "client", "server", "tool").allowed,
    false
  );
  assert.equal(
    requireGatewayAuthorization(zoned, "client", "public", "read", "public")
      .allowed,
    true
  );
});
