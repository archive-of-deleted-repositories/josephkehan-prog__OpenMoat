# Architecture

The public boundary is the versioned `Moatfile` and OpenMoat Spec snapshot.
Internally the reference product has four separable layers:

1. `reconcile.ts` is a pure deterministic planner.
2. `ApplyInterface` owns filesystem effects; adapters implement concrete
   harness writes.
3. `gateway.ts`, `mcp-client.ts`, and `server.ts` own MCP processes and
   protocol behavior independently of reconciliation adapters.
4. Optional shared-brain modules consume the normalized runtime configuration.

The MCP TypeScript v2 client, server, and core packages are pinned at 2.0.0.
Protocol package differences are not exposed in OpenMoat JSON contracts.

`vendor/spec` is produced by `scripts/update-spec.sh`, verified against
`spec.lock`, and never edited by hand. Its black-box fixtures are intentionally
usable by future implementations in any language.

