# OpenMoat v1 threat model

## Assets

- Secrets resolved from environment or `secrets.env`
- Files reachable by downstream MCP tools
- OAuth tokens and registrations
- Caller policy and trust decisions
- Tool results and derived catalog metadata
- Local process and resource availability

## Trust boundaries

The human-owned Moatfile and human CLI decisions are trusted inputs. Caller
labels, downstream executables, remote HTTP servers, metadata, errors, and tool
results are untrusted. Same-user local processes are inside the OS account
boundary and can impersonate policy labels.

## Abuse cases and controls

| Threat | Primary controls | Verification |
|---|---|---|
| Policy bypass | deny default, deny precedence, per-request caller resolution, pre-spawn authorization | policy unit tests; unauthorized black-box call |
| Discovery/call TOCTOU | search and describe filter current config; call re-authorizes current config before spawn | protocol tests and code review |
| Path or symlink escape | realpath both candidate and roots; reject undeclared caller cwd | runtime security tests |
| Command or argument injection | direct argv spawn; no shell; bounded schema fields | configuration tests and code review |
| Secret leakage | minimal child env, runtime placeholder resolution, recursive value/key redaction, coarse diagnostics | redaction and protocol-envelope tests |
| OAuth callback/state/issuer confusion | random one-time state, loopback callback, PKCE, hashed filenames, per-issuer credential maps, bounded port | state/liveness tests and controlled-issuer release probe |
| Oversized or adversarial result | depth, entry, byte, paging, owner quota, entry quota, TTL | archive and envelope tests |
| Pool, timeout, breaker exhaustion | global/per-server pool limits, per-server concurrency, deadlines, idle reap, persisted breakers | runtime and health tests |
| Malformed protocol or downgrade confusion | official SDK dual-era negotiation; hop metadata removed | legacy/modern outward/downstream matrix |
| Orphan process trees | descendant reaping on negotiation disposal, eviction, EOF, signal, and parent loss | protocol fixture and manual process check |
| Catalog prompt injection | catalog refresh only from trusted servers; metadata label/sanitize/bound; caller policy filter | catalog and sanitization tests |
| Cross-caller archive access | random opaque handle plus hashed owner binding | caller-isolation tests |

## Residual risk

- A trusted child can read or modify anything allowed to the OS user unless an
  external sandbox restricts it.
- A malicious same-user process can assert another caller label.
- Static bearer headers remain sensitive in process memory.
- Browser and authorization-server behavior is external to OpenMoat.
- Lexical search can rank a safe but less relevant tool first; authorization is
  still enforced at call time.
