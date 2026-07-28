/**
 * Deterministic tool-output compression (OmniRoute toolResultCompressor /
 * RTK / Caveman lineage, minimalist edition). Lossless-ish only: whitespace,
 * ANSI codes, duplicate-line runs, rule-character runs, pretty-printed JSON.
 * Anything still oversized after this goes to the archive (archive.ts) with
 * a retrieval hash — compression never silently destroys content.
 */

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MIN_SIZE = 2000; // below this, not worth touching

export function compressText(input: string): { text: string; saved: number } {
  if (input.length < MIN_SIZE) return { text: input, saved: 0 };
  let t = input.replace(ANSI, "");

  // compact pretty-printed JSON payloads
  const trimmed = t.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && /\n\s+["{[\]]/.test(trimmed)) {
    try {
      const compact = JSON.stringify(JSON.parse(trimmed));
      if (compact.length < t.length) t = compact;
    } catch {
      /* not JSON after all */
    }
  }

  // trailing whitespace + rule-character runs (=====, -----, #####)
  t = t
    .split("\n")
    .map((l) => l.trimEnd().replace(/([=\-_*#~.])\1{39,}/g, (_, c: string) => c.repeat(12)))
    .join("\n");

  // collapse runs of identical non-blank lines
  const lines = t.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === line && line.trim() !== "") j++;
    out.push(line);
    if (j - i > 2) out.push(`[line repeated ${j - i - 1} more times]`);
    else for (let k = i + 1; k < j; k++) out.push(line);
    i = j;
  }
  t = out.join("\n").replace(/\n{3,}/g, "\n\n");

  if (t.length >= input.length) return { text: input, saved: 0 };
  return { text: t, saved: input.length - t.length };
}
