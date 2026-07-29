<p align="center">
  <img src="https://raw.githubusercontent.com/josephkehan-prog/OpenMoat/main/docs/assets/openmoat-gateway.svg" width="100%" alt="OpenMoat — one gate for your local AI tools">
</p>

<p align="center">
  <a href="https://github.com/josephkehan-prog/OpenMoat/actions/workflows/ci.yml"><img src="https://github.com/josephkehan-prog/OpenMoat/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&amp;logoColor=white" alt="Node.js 22 or newer"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-38bdf8.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/MCP-2025--11--25%20%7C%202026--07--28-f59e0b" alt="Supported MCP versions">
</p>

<p align="center">
  <strong>Connect your AI tools without giving every tool every permission.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#a-practical-example">Example</a> ·
  <a href="#how-openmoat-protects-a-call">How it works</a> ·
  <a href="#configuration-example">Configuration</a> ·
  <a href="docs/threat-model.md">Threat model</a>
</p>

OpenMoat sits between your local AI clients and MCP servers. You choose which
clients may use which tools. OpenMoat blocks everything else, keeps new servers
off by default, removes configured secrets from results, and cleans up child
processes when a call ends.

Clients connect over stdio. OpenMoat can then reach local stdio servers or
remote Streamable HTTP servers using MCP 2025-11-25 or stateless MCP
2026-07-28.

> [!IMPORTANT]
> **v1 release candidate.** The source release is verified on macOS and Linux.
> The npm package has not been published yet.

## How OpenMoat protects a call

Every request passes through the same checks before an MCP server runs:

| Check | What OpenMoat does |
|---|---|
| **Who is asking?** | Rejects unknown clients. |
| **What are they asking for?** | Checks the server, tool, and capability rules you wrote. |
| **Did you approve the server?** | Keeps new servers quarantined until a person trusts them. |
| **Is the call safe to run?** | Limits paths, runtime, concurrency, redirects, and child processes. |
| **Is the result safe to return?** | Redacts configured secrets and stores oversized results behind private handles. |

OpenMoat records health and totals, but not your prompts or tool results.

## A practical example

Suppose you use a coding assistant, a research assistant, and a desktop
assistant. All three need MCP tools, but they should not have the same access.

1. Add each MCP server to the `Moatfile`. New servers start in quarantine.
2. Give each assistant only the tools it needs. A coding assistant might read
   project files but never control the browser.
3. Review the server command, working folders, network address, and requested
   capabilities. Trust it only when those details look right.
4. Point each assistant at OpenMoat instead of connecting it directly to every
   server.
5. OpenMoat checks every call, runs only approved tools, and cleans the result
   before returning it.

| What happens | Result |
|---|---|
| An approved assistant calls an allowed tool | OpenMoat sends the call to the trusted server. |
| An assistant asks for a tool it cannot use | OpenMoat rejects the call before starting the server. |
| An unknown assistant connects | OpenMoat denies it. |
| A server is still quarantined | Assistants cannot use it. |
| A result contains one of your configured secrets | OpenMoat replaces the secret before returning the result. |
| A result is too large to return inline | OpenMoat stores it privately and returns a caller-specific handle. |

The same setup works for file tools, databases, internal APIs, browser
automation, and other MCP servers.

OpenMoat does not rewrite your AI client settings or manage prompts, profiles,
skills, plugins, handoffs, RAG, embeddings, backups, or marketplaces. You stay
in control of client configuration.

## Quick start

- Node.js 22 or newer
- Git
- A local MCP client that can launch a stdio server

```bash
git clone https://github.com/josephkehan-prog/OpenMoat.git
cd OpenMoat
npm ci
npm run build
node dist/cli.js init ~/.config/openmoat
export OPENMOAT_FILE="$HOME/.config/openmoat/Moatfile"
node dist/cli.js validate
node dist/cli.js doctor
```

Configuration precedence is `--file`, then `OPENMOAT_FILE`, then
`${XDG_CONFIG_HOME:-~/.config}/openmoat/Moatfile`.

## Configuration example

The starter configuration denies every client and contains no servers. This
example lets one coding assistant read project files but not change them:

```yaml
apiVersion: openmoat.dev/v1
kind: Moatfile
paths:
  state: ./state
  secrets: ./secrets.env
gateway:
  callers:
    coding-assistant:
      allow: ["project-files:read_file"]
      deny: ["project-files:write_file"]
  servers:
    project-files:
      command: node
      args: ["/absolute/path/to/filesystem-server.mjs"]
      cwdRoots: ["/absolute/path/to/your-projects"]
      capabilities: ["sensitive-read"]
      trust: quarantined
```

Then review and approve it:

```bash
node dist/cli.js validate
node dist/cli.js trust project-files
node dist/cli.js catalog --refresh
node dist/cli.js doctor
node dist/cli.js serve
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

```bash
node dist/cli.js auth remote
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
      "command": "node",
      "args": ["/absolute/path/to/OpenMoat/dist/cli.js", "serve"],
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

## Command surface

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

Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md). Do not open a public issue containing credentials,
tokens, or private configuration.

## Development

```bash
npm test
npm run test:coverage
npm run verify
```

Contributions use signed Conventional Commits and test-driven RED/GREEN
checkpoints. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Joseph Han.
