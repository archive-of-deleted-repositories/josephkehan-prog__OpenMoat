import {
  sanitizeMetadata,
  type MetadataProvenance,
} from "./runtime-security.js";

export const MAX_DESCRIBED_TOOLS = 128;
export const TOOL_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface ToolMetadata {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export function safeToolNames(
  tools: readonly { name: string }[]
): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => TOOL_NAME_PATTERN.test(name));
}

export function boundedToolNames(names: readonly string[]): string {
  const shown = names.slice(0, 20);
  const suffix =
    names.length > shown.length
      ? `, … (${names.length - shown.length} more)`
      : "";
  return `${shown.join(", ") || "(none)"}${suffix}`;
}

function indentMetadata(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function formatToolMetadata(
  tools: readonly ToolMetadata[],
  serverName: string,
  provenance: MetadataProvenance,
  requested?: string
): string {
  const safe = tools.filter((tool) =>
    TOOL_NAME_PATTERN.test(tool.name)
  );
  const picked = requested
    ? safe.filter((tool) => tool.name === requested)
    : safe.slice(0, MAX_DESCRIBED_TOOLS);
  if (!picked.length) {
    return `No tool '${requested}' on '${serverName}'. Available: ${boundedToolNames(
      safe.map((tool) => tool.name)
    )}`;
  }
  const description = picked
    .map((tool) =>
      sanitizeMetadata(
        `Tool: ${tool.name}\nDescription:\n${indentMetadata(
          tool.description ?? ""
        )}\nInput schema:\n${indentMetadata(
          JSON.stringify(tool.inputSchema)
        )}`,
        provenance
      )
    )
    .join("\n\n");
  const omitted = safe.length - picked.length;
  return omitted > 0 && !requested
    ? `${description}\n\n[${omitted} additional tools omitted; request one by exact name]`
    : description;
}
