# Stateless MCP v0.4 TDD Evidence

Source: user-approved stateless MCP v0.4 handoff.

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

The release red-team review added a third RED checkpoint in signed commits
`f4f5485`, `4bf9c82`, `559b544`, and `319c248`. The focused suite reproduced
recursive secret-key disclosure, caller-label namespace collisions,
cross-caller usage disclosure, oversized structured envelopes, caller-neutral
archives, permissive state modes, incomplete CI verification, and missing
gateway/server coverage.

## GREEN evidence

OpenMoat Spec:

- 32 tests passed.
- Coverage: 85.53%.
- Ruff, Pyright, package build, dependency audit, and leak scan passed.
- Signed commits: `e7379ec` (RED) and `b6fe08b` (GREEN).

TypeScript reference:

- 97 tests passed, including the dual-era and release red-team cases.
- The established core coverage gate passed at 91.62% lines, 81.59% branches,
  and 94.17% functions.
- Gateway/server coverage is now collected separately and enforced at an
  initial 50% lines, 50% functions, and 25% branches. The verified run measured
  53.71% lines, 53.13% functions, and 37.04% branches.
- Official MCP conformance passed 3/3 applicable scenarios.
- Shared OpenMoat conformance passed 26/26 cases, including reuse, cwd
  isolation, failure recovery, orphan cleanup, shutdown, and signal cleanup.
- `npm audit` found zero vulnerabilities and Gitleaks found no leaks.
- `npm run verify` passed, including provenance and package-content scans.
- Signed commits: `88b6888` (RED), `3df3ed7` (initial GREEN), and `8454982`
  (probe-descendant cleanup), plus `d3405ab` (red-team GREEN) and `618398f`
  (coverage gate).

## Boundaries

`clientInfo` and `OPENMOAT_CALLER` select local policy labels; neither is an
authenticated principal. Missing or malformed caller metadata resolves to
`unknown`, which remains denied by default.

The TypeScript repository still vendors the signed OpenMoat Spec v0.2.6
snapshot. The v0.4 contract must be reviewed, signed, and tagged in the Spec
repository before `scripts/update-spec.sh` can vendor it. Rust, Go, and Python
compatibility is intentionally not claimed or changed until that finalized
contract is available.
