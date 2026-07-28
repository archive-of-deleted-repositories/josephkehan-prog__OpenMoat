import { jsonMcpAdapter } from "./json-common.js";

/** Cursor: ~/.cursor/mcp.json `mcpServers`. stdio: {command,args,env}; http: {url}. */
export const cursor = jsonMcpAdapter("cursor", (s) =>
  s.transport === "http"
    ? { url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
    : { command: s.command, args: s.args ?? [], env: s.env ?? {} }
);
