const SUGGESTION_LIMIT = 4;

function tokens(value: string): string[] {
  return value.split(/[_\-\s]+/).filter(Boolean);
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index
  );
  let current = new Array<number>(right.length + 1);
  for (let row = 1; row <= left.length; row++) {
    current[0] = row;
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! +
          (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length]!;
}

export function suggestToolName(
  wanted: string,
  available: string[],
  limit = SUGGESTION_LIMIT
): string[] {
  const normalizedWanted = wanted.toLowerCase();
  const wantedTokens = tokens(normalizedWanted);
  const scored: { name: string; rank: number; distance: number }[] = [];
  for (const name of available) {
    const normalized = name.toLowerCase();
    if (normalized === normalizedWanted) return [name];
    const nameTokens = tokens(normalized);
    let rank = Number.POSITIVE_INFINITY;
    if (wantedTokens.length && nameTokens.length) {
      const left = new Set(wantedTokens);
      const right = new Set(nameTokens);
      const intersection = [...left].filter((value) =>
        right.has(value)
      ).length;
      if (
        intersection / (left.size + right.size - intersection) >=
        0.75
      ) {
        rank = 1;
      }
    }
    if (
      normalizedWanted.length >= 6 &&
      (normalized.includes(normalizedWanted) ||
        normalizedWanted.includes(normalized))
    ) {
      rank = Math.min(rank, 2);
    }
    const distance = editDistance(normalizedWanted, normalized);
    if (
      distance <=
      Math.max(
        2,
        Math.floor(
          Math.max(normalizedWanted.length, normalized.length) * 0.2
        )
      )
    ) {
      rank = Math.min(rank, 2);
    }
    const wantedTail = wantedTokens.at(-1);
    if (
      wantedTail &&
      wantedTail.length >= 3 &&
      nameTokens.at(-1) === wantedTail
    ) {
      rank = Math.min(rank, 3);
    }
    if (Number.isFinite(rank)) {
      scored.push({ name, rank, distance });
    }
  }
  return scored
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.distance - right.distance ||
        left.name.localeCompare(right.name)
    )
    .slice(0, Math.max(0, limit))
    .map((item) => item.name);
}

export function isToolNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("not found") ||
      normalized.includes("unknown tool") ||
      normalized.includes("no such tool")) &&
    normalized.includes("tool")
  );
}
