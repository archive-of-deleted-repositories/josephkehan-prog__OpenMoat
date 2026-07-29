export const AGENT_TOOL_NAMES = [
  "moat_bootstrap",
  "rag_search",
  "tool_search",
  "tool_describe",
  "tool_call",
  "tool_result_fetch",
  "moat_health",
  "moat_usage",
  "instinct_report",
  "mcp_discover",
  "context_save",
  "context_latest",
  "federation_status",
  "skills_list",
  "skill_read",
  "plugins_list",
  "profile_read",
  "registry_list",
] as const;

export const HUMAN_ADMIN_COMMANDS = [
  "rag reindex",
  "mcp refresh",
  "trust",
  "sync",
  "configure --apply",
] as const;

