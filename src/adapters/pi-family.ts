import type { ResolvedServer } from "../registry.js";
import { jsonMcpAdapter } from "./json-common.js";

/**
 * pi (@earendil-works/pi-coding-agent) and omp (@oh-my-pi/pi-coding-agent)
 * discover MCP servers from user-level mcp.json (~/.pi/agent/mcp.json,
 * ~/.omp/agent/mcp.json) and project-root .mcp.json. Standard `mcpServers`
 * map: stdio {command,args,env}, remote {url}.
 */
const mapServer = (s: ResolvedServer) =>
  s.transport === "http"
    ? { url: s.url }
    : { command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) };

export const pi = jsonMcpAdapter("pi", mapServer);
export const omp = jsonMcpAdapter("omp", mapServer);
// senpi (@code-yeongyu/senpi, a pi fork): same discovery — ~/.senpi/agent/mcp.json, standard mcpServers.
export const senpi = jsonMcpAdapter("senpi", mapServer);
