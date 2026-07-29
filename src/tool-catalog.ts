import fs from "node:fs";
import path from "node:path";

export interface ToolCatalogEntry {
  server: string;
  tool: string;
  description: string;
  provenance: string;
  file?: string;
}

export interface ToolCatalogHit {
  file: string;
  heading: string;
  snippet: string;
  score: number;
  server: string;
  tool: string;
}

const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function normalizeToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function tokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(normalizeToken)
    ),
  ];
}

function scoreEntry(entry: ToolCatalogEntry, query: string[]): number {
  const server = new Set(tokens(entry.server));
  const tool = new Set(tokens(entry.tool));
  const description = new Set(tokens(entry.description));
  return query.reduce((score, token) => {
    if (tool.has(token)) return score + 8;
    if (server.has(token)) return score + 5;
    if (description.has(token)) return score + 2;
    return score;
  }, 0);
}

export function rankToolCatalog(
  entries: readonly ToolCatalogEntry[],
  query: string,
  limit: number
): ToolCatalogHit[] {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.server.localeCompare(right.entry.server) ||
        left.entry.tool.localeCompare(right.entry.tool)
    )
    .slice(0, Math.max(0, limit))
    .map(({ entry, score }) => ({
      file: entry.file ?? "",
      heading: `${entry.server} › ${entry.tool}`,
      snippet: entry.description
        .replace(CONTROL_CHARACTERS, "")
        .replace(/\r\n?/g, "\n")
        .trim()
        .slice(0, 500),
      score,
      server: entry.server,
      tool: entry.tool,
    }));
}

function markdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(candidate);
      }
    }
  };
  visit(root);
  return files.sort();
}

function parseCatalog(file: string): ToolCatalogEntry[] {
  const source = fs.readFileSync(file, "utf8");
  const matches = [...source.matchAll(/^###\s+(.+?)\s+›\s+(.+?)\s*$/gm)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    const description = source.slice(start, end).trim();
    const trust =
      description.match(/trust=([a-z-]+)/i)?.[1]?.toLowerCase() ?? "unknown";
    return {
      server: match[1].trim(),
      tool: match[2].trim(),
      description,
      provenance: trust,
      file,
    };
  });
}

export function searchToolCatalog(
  root: string,
  query: string,
  limit: number
): ToolCatalogHit[] {
  return rankToolCatalog(
    markdownFiles(root).flatMap((file) => parseCatalog(file)),
    query,
    limit
  );
}
