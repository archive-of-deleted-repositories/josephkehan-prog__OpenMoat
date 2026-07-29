# Stateless MCP v0.4 TDD Evidence

Source:
`~/mac/deliverable/OpenMoat/STATELESS-MCP-HANDOFF-2026-07-29.md`.

## User journeys

- MCP 2025-11-25 clients continue to use the outward stdio server.
- MCP 2026-07-28 clients use `server/discover` and carry caller metadata on
  each request.
- A trusted launcher can pin a caller policy label with `OPENMOAT_CALLER`.
- Legacy and modern outward clients can call legacy and modern downstream
  servers without a configured protocol-generation switch.
- Complete tool-result envelopes survive proxying after recursive secret
  redaction and connection-hop metadata filtering.
- Downstream process reuse, working-directory isolation, failure recovery, and
  cleanup remain independent of protocol negotiation.

## RED checkpoints

The canonical OpenMoat Spec tests were committed first as `e7379ec`. Four
contract tests failed until protocol-era schema, documentation, and driver
support were implemented.

The TypeScript end-to-end tests were committed first as `88b6888`. All five
new tests failed: modern outward requests returned `-32601 Method not found`,
and a legacy outward client could not call a modern-only downstream server.

After the first GREEN implementation, the canonical verifier found a second
RED checkpoint: `orphan-cleanup`, `partial-startup-cleanup`, `shutdown`, and
`signal-cleanup` each reported one remaining descendant. Automatic stdio
negotiation uses a disposable probe sibling; its helper descendant was outside
the normal session pool. The process-tree transport wrapper now reaps probe
descendants before the SDK disposes the sibling root and pipes.

## GREEN evidence

OpenMoat Spec:

- 32 tests passed.
- Coverage: 85.53%.
- Ruff, Pyright, package build, dependency audit, and leak scan passed.
- Signed commits: `e7379ec` (RED) and `b6fe08b` (GREEN).

TypeScript reference:

- 87 tests passed, including all five dual-era end-to-end cases.
- Configured coverage gate passed: 91.46% lines, 81.88% branches, and 94.23%
  functions.
- Official MCP conformance passed 3/3 applicable scenarios.
- Shared OpenMoat conformance passed 26/26 cases, including reuse, cwd
  isolation, failure recovery, orphan cleanup, shutdown, and signal cleanup.
- `npm audit` found zero vulnerabilities and Gitleaks found no leaks.
- `node scripts/verify.mjs` passed.
- Signed commits: `88b6888` (RED), `3df3ed7` (initial GREEN), and `8454982`
  (probe-descendant cleanup).

## Boundaries

`clientInfo` and `OPENMOAT_CALLER` select local policy labels; neither is an
authenticated principal. Missing or malformed caller metadata resolves to
`unknown`, which remains denied by default.

The TypeScript repository still vendors the signed OpenMoat Spec v0.2.6
snapshot. The v0.4 contract must be reviewed, signed, and tagged in the Spec
repository before `scripts/update-spec.sh` can vendor it. Rust, Go, and Python
compatibility is intentionally not claimed or changed until that finalized
contract is available.
