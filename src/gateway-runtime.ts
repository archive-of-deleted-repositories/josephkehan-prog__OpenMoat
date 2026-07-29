import type { OpenMoatConfig } from "./config.js";
import {
  gatewayCall,
  gatewayDescribe,
  gatewayHealth,
  prewarm,
  reapAll,
  type GatewayHealth,
  type GatewayResult,
} from "./gateway.js";

/**
 * Stable control-plane boundary for the gateway data plane.
 *
 * The TypeScript implementation is local today. A future Rust process can
 * implement this contract without coupling reconciliation, adapters, or the
 * public agent MCP server to its process-management details.
 */
export interface GatewayRuntime {
  describe(
    server: string,
    tool?: string,
    caller?: string
  ): Promise<string>;
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    cwd?: string,
    caller?: string
  ): Promise<GatewayResult>;
  prewarm(servers: string[]): void;
  health(): GatewayHealth;
  close(): { server: string; pids: number[] }[];
}

export function createGatewayRuntime(cfg: OpenMoatConfig): GatewayRuntime {
  return {
    describe: (server, tool, caller) =>
      gatewayDescribe(cfg, server, tool, caller),
    call: (server, tool, args, cwd, caller) =>
      gatewayCall(cfg, server, tool, args, cwd, caller),
    prewarm: (servers) => prewarm(cfg, servers),
    health: () => gatewayHealth(cfg),
    close: () => reapAll(),
  };
}
