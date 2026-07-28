import { jsonMcpAdapter } from "./json-common.js";

/**
 * Claude Code user scope: ~/.claude.json, top-level `mcpServers`.
 * WARNING: this file holds lots of unrelated state — we only patch mcpServers.
 * stdio: { type, command, args, env }   http: { type, url, headers }
 */
export const claudeCode = jsonMcpAdapter("claude-code", (s) =>
  s.transport === "http"
    ? { type: "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
    : { type: "stdio", command: s.command, args: s.args ?? [], env: s.env ?? {} }
);
