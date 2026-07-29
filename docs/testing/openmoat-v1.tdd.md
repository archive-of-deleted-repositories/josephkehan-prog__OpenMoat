# OpenMoat v1 TDD record

## RED

`test/v1-product-contract.test.mjs` was added before production changes. All
four tests failed against 0.4:

- package version and mission were broad
- the CLI exposed 26 commands
- retired reconciliation and shared-agent modules remained in `src`
- `init` created profile, registry, skills, plugins, and context trees

Signed RED checkpoint: `1e3ab903be8a26bfdac54ed2e7e435042d8c8b20`.

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

## OAuth red-team follow-up

The release completion audit found that the provider validated an OAuth
`state` value but did not implement the SDK hook that generates one. A second
probe found that the interactive CLI exited after opening authorization because
its callback server was unreferenced.

Signed RED checkpoints:

- `2d9aaf2abd13a064e565a69a4c25de5b127d9a49`: missing `state()` fails with
  `TypeError: provider.state is not a function`
- `77e56bac489080c8fe00856fb77bcb5b9ed14e33`: the callback subprocess exits
  before receiving a terminal callback

GREEN guarantees:

- 256-bit base64url OAuth state is generated and bound before browser launch
- wrong-state callbacks fail and close the loopback listener
- successful state is accepted once and closes the listener
- the interactive process stays alive until a terminal callback
- a controlled local issuer completes dynamic registration, state, PKCE token
  exchange, authenticated MCP discovery, private issuer-bound persistence, and
  callback teardown
