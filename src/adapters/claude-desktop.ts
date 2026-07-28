import { jsonMcpAdapter } from "./json-common.js";

/**
 * Claude Desktop: claude_desktop_config.json `mcpServers`.
 * stdio only — remote servers are wrapped with `npx mcp-remote <url>`.
 */
export const claudeDesktop = jsonMcpAdapter("claude-desktop", (s) =>
  s.transport === "http"
    ? { command: "npx", args: ["-y", "mcp-remote", s.url] }
    : { command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) }
);
