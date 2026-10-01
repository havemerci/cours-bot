const stopWords = new Set(["a", "an", "and", "no", "of", "on", "the", "to"]);

export function normalizeAnswer(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase("en-US")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function matchesFlagAnswer(guess: string, aliases: readonly string[]): boolean {
  const normalized = normalizeAnswer(guess);
  return normalized.length > 1 && aliases.some((alias) => normalizeAnswer(alias) === normalized);
}

export function matchesAnimeAnswer(guess: string, aliases: readonly string[]): boolean {
  const normalized = normalizeAnswer(guess);
  const compactLength = [...normalized.replaceAll(" ", "")].length;
  const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized);
  if (compactLength < (hasCjk ? 2 : 4)) return false;

  return aliases.some((rawAlias) => {
    const alias = normalizeAnswer(rawAlias);
    if (!alias) return false;
    if (alias === normalized || alias.includes(normalized)) return true;

    const guessTokens = normalized.split(" ").filter((token) => !stopWords.has(token));
    const aliasTokens = new Set(alias.split(" ").filter((token) => !stopWords.has(token)));
    return guessTokens.length > 0 && guessTokens.every((token) => aliasTokens.has(token));
  });
}
