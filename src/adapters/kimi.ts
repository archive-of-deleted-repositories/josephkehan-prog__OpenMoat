import { jsonMcpAdapter } from "./json-common.js";
import type { ResolvedServer } from "../registry.js";

/**
 * Kimi Code CLI: ~/.kimi-code/mcp.json `mcpServers`.
 * Claude-style JSON. stdio → {command, args, env}; http → {url}
 * (kimi-code accepts a bare `url` for remote servers, matching its own
 * browserclaw entries). Unmanaged user entries (wigolo, browserclaw,
 * ouroboros, …) are preserved by the generic merge.
 */
const mapKimi = (s: ResolvedServer) =>
  s.transport === "http"
    ? { url: s.url }
    : { command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) };

export const kimiCode = jsonMcpAdapter("kimi-code", mapKimi);

/**
 * Kimi desktop (Kimi Work): the embedded kimi-code runtime home at
 * ~/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/mcp.json.
 * Same mcpServers shape as the CLI. The desktop also injects plugin MCPs
 * out-of-band, so only hub-managed native servers are written here.
 */
export const kimiDesktop = jsonMcpAdapter("kimi", mapKimi);
