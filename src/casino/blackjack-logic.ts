function rank(card: string): string { return card.slice(0, -1); }

export function handValue(cards: readonly string[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const value = rank(card);
    if (value === "A") { total += 11; aces += 1; }
    else total += ["J", "Q", "K"].includes(value) ? 10 : Number(value);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return { total, soft: aces > 0 };
}

export function isNatural(cards: readonly string[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

export function cardRank(card: string): string {
  return rank(card);
}
