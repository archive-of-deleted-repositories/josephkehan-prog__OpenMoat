export const AGENT_TOOL_NAMES = [
  "tool_search",
  "tool_describe",
  "tool_call",
  "tool_result_fetch",
  "moat_health",
  "moat_usage",
  "registry_list",
] as const;

export const HUMAN_ADMIN_COMMANDS = [
  "catalog --refresh",
  "auth",
  "trust",
] as const;
