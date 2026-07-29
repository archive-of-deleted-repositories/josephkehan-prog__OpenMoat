# OpenMoat v1 TDD record

## RED

`test/v1-product-contract.test.mjs` was added before production changes. All
four tests failed against 0.4:

- package version and mission were broad
- the CLI exposed 26 commands
- retired reconciliation and shared-agent modules remained in `src`
- `init` created profile, registry, skills, plugins, and context trees

The signed RED commit was attempted but could not be created because the
configured encrypted SSH signing key was not available to the non-interactive
session. Commit signing was not bypassed.

## GREEN

The focused implementation makes the product-contract test pass and adds:

- schema and semantic validation for stdio and Streamable HTTP definitions
- deny-by-default per-request policy
- human-only trust and interactive OAuth
- issuer-bound private OAuth state
- deterministic caller-filtered catalog search
- path containment, environment minimization, redaction, deadlines, pools,
  breakers, and cleanup
- bounded caller-owned archives
- legacy/stateless outward and downstream protocol matrix

The release gate is `npm run verify`. Exact command output and commit state
belong in the external release-evidence report, not this durable test design.
