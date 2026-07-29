# Architecture

The public boundary is the versioned `Moatfile` and OpenMoat Spec snapshot.
Internally the reference product has four separable layers:

1. `reconcile.ts` is a pure deterministic planner.
2. `ApplyInterface` owns filesystem effects; adapters implement concrete
   harness writes.
3. `GatewayRuntime` is the data-plane boundary. The local TypeScript runtime
   owns MCP processes, pools, timeouts, policy enforcement, and cleanup
   independently of reconciliation adapters.
4. Optional shared-brain modules consume the normalized runtime configuration.

Core `tool_search` uses deterministic lexical ranking over a bounded,
provenance-labeled catalog. It never turns on RAG, calls an embedding model, or
contacts a reranker. Semantic document RAG remains a separate opt-in feature.

The intended evolutionary path is a TypeScript control plane with an optional
Rust data-plane gateway. `server.ts` depends on `GatewayRuntime`, not child
process details, so a future Rust process can replace the local runtime without
rewriting configuration, reconciliation, profiles, handoffs, or adapters. The
wire contract for that external runtime is deliberately not frozen in 0.2; it
must first be derived from cross-language conformance evidence.

The MCP TypeScript v2 client, server, and core packages are pinned at 2.0.0.
The reference stdio server uses the SDK's dual-era serving path for
MCP 2025-11-25 initialization and MCP 2026-07-28 discovery. Downstream clients
negotiate the protocol generation automatically. Process pools remain an
implementation optimization for startup cost, concurrency, working-directory
isolation, and cleanup; they do not supply protocol-session correctness.

Caller context is resolved at the tool-request boundary. Modern requests use
their per-request `clientInfo`; legacy requests use the initialized connection
label. A trusted launcher can pin the label with `OPENMOAT_CALLER`. These are
transport policy labels, not authenticated principals.

Gateway tool results retain the complete MCP envelope. Recursive redaction
applies before forwarding, and downstream protocol-hop metadata such as client
and server identity/version fields is removed so it cannot become upstream
authority.

`vendor/spec` is produced by `scripts/update-spec.sh /path/to/OpenMoat-Spec`,
verified against the signed tag and exact commit in `spec.lock`, and never
edited by hand. Calling the script without a source verifies the vendored
snapshot, so a standalone clone has no sibling-repository dependency. Its
black-box fixtures are intentionally usable by implementations in any
language.
