# OpenMoat

OpenMoat is a local-first MCP gateway and shared agent configuration
reconciler. TypeScript 0.1 is the supported complete implementation.

It extracts the reusable engineering from a private multi-agent setup without
shipping workstation identity, live configuration, secrets, registries,
runtime state, or logs.

## What it includes

- Lazy, pooled MCP gateway with lexical discovery, policy, quarantine, health,
  timeouts, OAuth support, and child cleanup.
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
supported in 0.1.

All harness targets begin disabled. Review `moat detect`, then explicitly
enable and apply only the targets you want.

## Safety

Caller policy is deny-by-default. New gateway servers are quarantined unless
their `trust` is explicitly `trusted`. `${ENV}` values remain placeholders in
configuration and are resolved only at runtime. Diagnostics must never print
resolved values.

`moat migrate-config old.json Moatfile` copies configuration only. It never
copies secrets, databases, OAuth tokens, archives, or other runtime state.

## Status

OpenMoat TypeScript 0.1 is supported. The sibling Rust, Go, and Python
repositories are experimental gateway-only comparisons and do not implement
the shared-brain modules.

MIT licensed; original attribution is preserved in [LICENSE](LICENSE).

