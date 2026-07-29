# Security Policy

Report vulnerabilities privately to the maintainers. Do not include live
credentials, OAuth tokens, or personal configuration in a report.

Supported security fixes target the latest v1 release.

## Guarantees

- Caller access is deny-by-default; explicit deny wins.
- Policy, zone, trust, and disabled checks occur before downstream spawn.
- Agent tools cannot approve trust or initiate interactive OAuth.
- Stdio commands and arguments are passed without a shell.
- Child environments contain only explicitly configured values and allowlisted
  inherited names.
- Caller-supplied working directories must realpath-resolve beneath declared
  roots; symlink escapes fail.
- `moat init --force` refuses symbolic links at every managed destination.
- Non-loopback HTTP requires HTTPS; HTTP URLs cannot embed credentials.
- Moatfile and secrets inputs are each limited to 1 MiB.
- `${ENV}` placeholders resolve at runtime and unresolved values fail closed.
- Tool metadata uses the MCP 128-character identifier grammar, is capped at 128
  tools per description, structurally indented to prevent forged catalog
  headings, control-character sanitized, and labeled untrusted.
- Result values and keys are recursively redacted.
- Result archives are private, opaque, caller-bound, quota-bounded, and
  TTL-bounded.
- OAuth state is private, server-path-safe, issuer-bound, PKCE-protected, and
  loopback-callback state checked.
- Browser launch uses direct argument vectors without a command shell.
- Pools, concurrency, deadlines, circuit breakers, and shutdown cleanup are
  bounded.
- Usage exposes aggregate counts, coarse errors, timings, and recency—not
  prompts, queries, arguments, secrets, or results.

## Non-guarantees

OpenMoat is not an operating-system sandbox, malware detector, or authorization
boundary between mutually hostile processes running as the same OS user.
`clientInfo` and `OPENMOAT_CALLER` are local policy labels, not authenticated
principals.

Trusting an MCP server grants its executable the current user's privileges.
Sandbox the child separately when that is not acceptable.

See [docs/threat-model.md](docs/threat-model.md) for abuse cases and controls.
