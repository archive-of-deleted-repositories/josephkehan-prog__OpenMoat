# Security Policy

Report vulnerabilities privately to the maintainers. Do not include live
credentials or configuration.

OpenMoat treats configuration, tool metadata, MCP output, and caller identity
as untrusted input. Policy is deny-by-default, deny rules take precedence,
quarantined or disabled servers cannot spawn, child commands are passed
without shell interpolation, child environments contain only a portable
baseline plus explicitly configured values, caller working directories must
realpath-resolve beneath declared roots, and shutdown reaps pooled children
and descendants.

Tool metadata is control-character sanitized, bounded, and labeled as
untrusted with its source and trust state. Resolved secrets are redacted from
tool results, errors, health, and catalog diagnostics. Agent MCP calls cannot
perform trust, enablement, synchronization, configuration application, or
shared-index administration.

Agent-authored context writes are isolated by the resolved caller policy label,
bounded by per-caller count and byte quotas, stored mode 0600, and labeled as
untrusted data on read. Modern request `clientInfo`, legacy connection
`clientInfo`, and the trusted local-launcher `OPENMOAT_CALLER` override are
labels for local policy selection, not authenticated principals. Missing or
malformed labels resolve to `unknown`, which is denied by default. A caller
cannot retrieve another caller label's notes through `context_latest` or
context-backed RAG results, but same-user processes are not cryptographically
isolated by these labels.

Complete downstream tool-result envelopes are recursively redacted before
proxying. OpenMoat removes downstream client/server identity and protocol
version metadata at the connection hop; those fields cannot establish caller
authority on the outward connection.

Never place secrets directly in `Moatfile`. Use `${NAME}` and provide the value
through the environment or a mode-0600 ignored `secrets.env`.

OpenMoat is not an operating-system sandbox. Trusting a local MCP server allows
that executable to act with the current user's privileges. Use a separate
account, container, or sandbox wrapper when the child itself is not trusted.
