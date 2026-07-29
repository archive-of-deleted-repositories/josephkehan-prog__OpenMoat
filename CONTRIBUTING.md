# Contributing

Use test-driven development:

1. Add a user-visible failing test and record RED.
2. Implement the minimum behavior and record GREEN.
3. Run `npm run verify`.
4. Keep commits signed and use Conventional Commits.

Do not contribute live configuration, secrets, personal paths, runtime state,
logs, generated catalogs, or machine-specific policy. OpenMoat v1 accepts
changes only within the local TypeScript MCP security-gateway mission. Harness
configuration adapters, profiles, handoffs, RAG, skills, plugins, federation,
and other agent-platform features are out of scope.
