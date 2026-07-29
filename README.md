# OpenMoat

OpenMoat is a local-first MCP gateway and shared agent configuration
reconciler. TypeScript 0.4 is the supported complete implementation.

It extracts the reusable engineering from a private multi-agent setup without
shipping workstation identity, live configuration, secrets, registries,
runtime state, or logs.

## What it includes

- Lazy, bounded MCP gateway with policy, quarantine, capability zones,
  realpath-contained working directories, secret redaction, timeouts, health,
  OAuth support, and complete child cleanup.
- Reconciliation adapters for common coding-agent harnesses.
- Shared profile and handoff support enabled by default.
- Opt-in RAG, embeddings, skills, plugins, and instincts.
- Federation, backups, health history, evaluation, and portable demos.
- Optional chezmoi export; chezmoi is never required or invoked.

## Install locally

```sh
npm ci
npm run build
node dist/cli.js init
node dist/cli.js --file ~/.config/openmoat/Moatfile validate
node dist/cli.js --file ~/.config/openmoat/Moatfile doctor
```

The npm package is `openmoat`; its only binary is `moat`. An unrelated npm
package named `moat` exists, so use the package name when installing. No
global installation is required.

Configuration precedence is `--file`, then `OPENMOAT_FILE`, then
`${XDG_CONFIG_HOME:-~/.config}/openmoat/Moatfile`. The canonical file is
extensionless YAML with `apiVersion: openmoat.dev/v1`. Project overlays are not
supported in 0.4.

All harness targets begin disabled. Review `moat detect`, then explicitly
enable and apply only the targets you want.

## Safety

Caller policy is deny-by-default. New gateway servers are quarantined unless
their `trust` is explicitly `trusted`. `${ENV}` values remain placeholders in
configuration and are resolved only at runtime. Diagnostics must never print
resolved values.

Agent-facing MCP tools cannot approve trust, enable servers, apply
configuration, synchronize harnesses, or rebuild shared indexes. Those
operations remain human-only CLI commands. MCP `clientInfo` is a launcher
or request policy label, not an authenticated principal. In modern MCP,
OpenMoat resolves the label from each request's `clientInfo`; the
`OPENMOAT_CALLER` environment variable remains a trusted local-launcher
override. Neither mechanism authenticates another process running as the same
operating-system user.

The outward stdio server accepts MCP 2025-11-25 and MCP 2026-07-28 clients.
Downstream connections negotiate either generation automatically. OpenMoat
forwards complete tool-result envelopes, including `structuredContent` and
safe `_meta` fields, after recursive secret redaction and removal of
connection-hop protocol metadata.

OpenMoat is useful when several local models or coding harnesses need the same
MCP capabilities without each one spawning its own copy of every server. The
gateway keeps tool metadata out of the model context until search/describe is
needed, lazily starts approved servers, reuses warm connections, and applies
one local policy boundary. It saves model context; it does not make an
untrusted local executable safe.

`context_save` provides small local handoffs without sending them to a hosted
memory service. Agent-authored notes are size/count bounded, control-character
sanitized, labeled as untrusted data, and isolated by the resolved caller
policy label.
They are continuity notes, not a substitute for a model context window or a
trusted knowledge base. Promote reviewed durable facts into human-owned
profile files.

Optional features are absent from the MCP tool list until enabled in
`Moatfile`; disabling RAG, skills, plugins, or instincts therefore removes
their model-callable surface rather than merely disabling a background job.

`moat migrate-config old.json Moatfile` copies configuration only. It never
copies secrets, databases, OAuth tokens, archives, or other runtime state.

## Status

OpenMoat TypeScript 0.4 is supported. The sibling Rust, Go, and Python
repositories are experimental gateway-only comparisons and do not implement
the shared-brain modules. Their MCP 2026-07-28 compatibility is not claimed
until they independently pass the finalized conformance contract.

MIT licensed; original attribution is preserved in [LICENSE](LICENSE).
