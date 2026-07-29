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

/** Stable local boundary between the MCP server and downstream transports. */
export interface GatewayRuntime {
  describe(
    server: string,
    tool?: string,
    caller?: string
  ): Promise<string>;
  inspect(server: string): Promise<string>;
  authorize(server: string): Promise<string>;
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
    inspect: (server) =>
      gatewayDescribe(cfg, server, undefined, "moat-cli", {
        bypassPolicy: true,
      }),
    authorize: (server) =>
      gatewayDescribe(cfg, server, undefined, "moat-cli", {
        bypassPolicy: true,
        interactiveOAuth: true,
      }),
    call: (server, tool, args, cwd, caller) =>
      gatewayCall(cfg, server, tool, args, cwd, caller),
    prewarm: (servers) => prewarm(cfg, servers),
    health: () => gatewayHealth(cfg),
    close: () => reapAll(),
  };
}
