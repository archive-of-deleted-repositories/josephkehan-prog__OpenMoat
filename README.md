# OpenMoat

OpenMoat is the local security gateway for MCP: one TypeScript process lets
multiple local AI clients safely discover and call approved MCP servers through
deny-by-default policy, quarantine, secret redaction, bounded execution, and
deterministic cleanup.

It supports outward stdio clients and downstream stdio or Streamable HTTP
servers across MCP 2025-11-25 and stateless MCP 2026-07-28.

## Scope

OpenMoat v1 does one job: protect and multiplex local MCP access.

It includes:

- One extensionless YAML `Moatfile`.
- Deterministic `tool_search`, `tool_describe`, and `tool_call`.
- Explicit caller allow/deny policy and capability zones.
- Human-only quarantine approval and OAuth authorization.
- Secret placeholder resolution and recursive output redaction.
- Realpath-contained working directories, clean child environments, bounded
  pools, deadlines, circuit breakers, and process-tree cleanup.
- Caller-owned, quota- and TTL-bounded oversized-result archives.
- Privacy-bounded aggregate health and usage.

It does not include agent-configuration rewriting, harness adapters, profiles,
handoffs, RAG, embeddings, skills, plugins, instincts, federation, evaluation,
backups, or discovery marketplaces. Client configuration is deliberately
documentation-only and non-mutating.

## Requirements

- Node.js 22 or newer
- A local MCP client that can launch a stdio server

## Install

```sh
npm install --global openmoat
moat init ~/.config/openmoat
export OPENMOAT_FILE="$HOME/.config/openmoat/Moatfile"
moat validate
moat doctor
```

For a source checkout:

```sh
npm ci
npm run build
node dist/cli.js init /tmp/openmoat-config
```

Configuration precedence is `--file`, then `OPENMOAT_FILE`, then
`${XDG_CONFIG_HOME:-~/.config}/openmoat/Moatfile`.

## Minimal configuration

The starter denies every caller and has no servers. Add a server and a narrow
caller rule:

```yaml
apiVersion: openmoat.dev/v1
kind: Moatfile
paths:
  state: ./state
  secrets: ./secrets.env
gateway:
  callers:
    codex:
      allow: ["files:read_file"]
      deny: ["files:write_file"]
  servers:
    files:
      command: node
      args: ["/absolute/path/to/files-server.mjs"]
      cwdRoots: ["/absolute/path/to/approved/workspaces"]
      capabilities: ["sensitive-read"]
      trust: quarantined
```

Then review and approve it:

```sh
moat validate
moat trust files
moat catalog --refresh
moat doctor
```

`trust` is a human-only CLI mutation. No agent-facing MCP tool can approve a
server or initiate OAuth.

## Downstream HTTP and OAuth

Pre-provisioned headers use unresolved placeholders:

```yaml
    remote:
      transport: http
      url: https://mcp.example.com/mcp
      headers:
        Authorization: "Bearer ${REMOTE_MCP_TOKEN}"
      trust: trusted
```

Put `REMOTE_MCP_TOKEN=...` in the ignored, mode-0600 `secrets.env`. For
authorization-code OAuth with PKCE, omit `headers` and run:

```sh
moat auth remote
```

OAuth tokens, registrations, PKCE verifier, and discovery state are stored
privately per server and bound to the discovered issuer. Agent calls never open
a browser; they fail with a direction to run the human command.

## Client snippets

OpenMoat does not edit client configuration. Configure clients manually and set
a stable local policy label:

```json
{
  "mcpServers": {
    "openmoat": {
      "command": "moat",
      "args": ["serve"],
      "env": {
        "OPENMOAT_FILE": "/absolute/path/to/Moatfile",
        "OPENMOAT_CALLER": "codex"
      }
    }
  }
}
```

`OPENMOAT_CALLER` is a trusted local-launcher assertion. Without it, modern
requests use per-request `clientInfo` and legacy requests use initialized
`clientInfo`. These are policy labels, not cryptographic identities; processes
running as the same operating-system user are not isolated from one another.

## Commands and tools

Human CLI: `init`, `validate`, `serve`, `doctor`, `auth`, `trust`, `catalog`,
`usage`, and `list`.

Agent tools: `tool_search`, `tool_describe`, `tool_call`,
`tool_result_fetch`, `moat_health`, `moat_usage`, and `registry_list`.

## Security boundary

OpenMoat is a policy gateway, not an operating-system sandbox. Trusting a local
MCP executable allows it to act with the current user's privileges. Use a
separate account, container, or sandbox wrapper for untrusted code.

See [SECURITY.md](SECURITY.md) and
[docs/threat-model.md](docs/threat-model.md).

## Release status

The TypeScript repository is the sole supported implementation. The Go, Rust,
and Python experiments are historical comparison evidence and are not part of
the v1 product or package.

Run the complete local release gate with:

```sh
npm run verify
```

MIT licensed.
