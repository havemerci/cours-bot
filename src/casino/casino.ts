import { randomInt, randomUUID } from "node:crypto";
import { ContainerBuilder, MessageFlags, TextDisplayBuilder, type Message } from "discord.js";
import { EconomyService } from "../services/economy.js";

const reds = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const format = new Intl.NumberFormat("en-US");

function box(content: string) {
  return { flags: MessageFlags.IsComponentsV2 as const, components: [new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))], allowedMentions: { parse: [] as never[] } };
}

export class CasinoManager {
  public constructor(readonly economy: EconomyService) {}

  public async handle(message: Message, prefix: string): Promise<boolean> {
    if (!message.guildId || message.author.bot || !message.content.startsWith(prefix)) return false;
    const args = message.content.slice(prefix.length).trim().toLowerCase().split(/\s+/);
    const aliases: Record<string, string> = { cf: "coinflip", flip: "coinflip", rl: "roulette", slot: "slots" };
    const game = aliases[args[0] ?? ""] ?? args[0] ?? "";
    if (game === "casino") {
      await message.reply(box(
        "### Casino\n" +
        `\`${prefix}coinflip <100-50,000> <heads|tails>\` · 2× return\n` +
        `\`${prefix}bet <100-50,000>\` · Hit/Miss · 50/50\n` +
        `\`${prefix}roulette <amount> <red|black|green|0-36>\` · 2× / 36× return\n` +
        `\`${prefix}slots <100-10,000>\` · up to 15×\n` +
        `\`${prefix}blackjack <100-25,000>\` · interactive · blackjack pays 3:2`,
      ));
      return true;
    }
    if (!["coinflip", "roulette", "slots", "bet"].includes(game)) return false;

    const bet = Number(args[1]?.replaceAll(",", ""));
    if (!Number.isSafeInteger(bet) || bet < 100) {
      await message.reply(box("### Invalid wager\nThe minimum casino wager is **100 Assurite**."));
      return true;
    }

    let payout = 0;
    let description = "";
    const audit: Record<string, unknown> = {};
    if (game === "bet") {
      if (bet > 50_000) {
        await message.reply(box("### Hit / Miss\nThe maximum bet is **50,000 Assurite**.")); return true;
      }
      const hit = randomInt(2) === 0;
      payout = hit ? bet * 2 : 0;
      description = hit
        ? `You bet **${format.format(bet)} Assurite** and you won: **${format.format(bet)} Assurite**.`
        : `You bet **${format.format(bet)} Assurite** and missed.`;
      Object.assign(audit, { outcome: hit ? "hit" : "miss" });
    } else if (game === "coinflip") {
      if (bet > 50_000 || !["heads", "tails"].includes(args[2] ?? "")) {
        await message.reply(box(`### Coinflip\nUse \`${prefix}coinflip <100-50,000> <heads|tails>\`.`)); return true;
      }
      const choice = args[2]!;
      const won = randomInt(10_000) < 4_800;
      const landed = won ? choice : choice === "heads" ? "tails" : "heads";
      payout = won ? bet * 2 : 0;
      description = `The coin landed **${landed}**.`;
      Object.assign(audit, { choice, landed });
    } else if (game === "roulette") {
      const choice = args[2] ?? "";
      const number = Number(choice);
      const exact = Number.isInteger(number) && number >= 0 && number <= 36;
      if (!exact && !["red", "black", "green"].includes(choice)) {
        await message.reply(box(`### Roulette\nChoose red, black, green, or a number from 0–36.`)); return true;
      }
      const max = exact || choice === "green" ? 2_500 : 25_000;
      if (bet > max) { await message.reply(box(`### Roulette\nThat wager has a **${format.format(max)}** maximum.`)); return true; }
      const landed = randomInt(37);
      const color = landed === 0 ? "green" : reds.has(landed) ? "red" : "black";
      const won = exact ? landed === number : color === choice;
      const multiplier = exact || choice === "green" ? 36 : 2;
      payout = won ? bet * multiplier : 0;
      description = `The wheel landed **${landed} ${color}**.`;
      Object.assign(audit, { choice, landed, color, multiplier });
    } else {
      if (bet > 10_000) { await message.reply(box("### Slots\nSlots have a **10,000 Assurite** maximum.")); return true; }
      const roll = randomInt(10_000);
      const result = roll < 6300 ? { multiplier: 0, symbols: "🍒 ◇ 🍋" }
        : roll < 8200 ? { multiplier: 1, symbols: "🍒 🍒 🍒" }
          : roll < 9350 ? { multiplier: 2, symbols: "🍋 🍋 🍋" }
            : roll < 9850 ? { multiplier: 5, symbols: "🔔 🔔 🔔" }
              : { multiplier: 15, symbols: "7️⃣ 7️⃣ 7️⃣" };
      payout = bet * result.multiplier;
      description = `${result.symbols}${result.multiplier ? ` · **${result.multiplier}× return**` : ""}`;
      Object.assign(audit, result);
    }

    const settled = await this.economy.settleCasinoRound({
      id: randomUUID(), guildId: message.guildId, userId: message.author.id, game, bet, payout, result: audit,
    });
    if (!settled.settled) {
      const text = settled.failureReason === "insufficient_balance" ? "You do not have enough Assurite." : "That wager could not be settled.";
      await message.reply(box(`### Casino\n${text}`)); return true;
    }
    const profit = payout - bet;
    const title = game === "bet" ? payout > 0 ? "Hit" : "Miss" : profit > 0 ? "You won" : profit === 0 ? "Stake returned" : "House wins";
    const wagerSummary = game === "bet"
      ? ""
      : `\n**Bet · ${format.format(bet)}**  ·  **Return · ${format.format(payout)} Assurite**`;
    await message.reply(box(
      `### ${title}\n${description}${wagerSummary}\n-# Balance · ${format.format(settled.balance)} Assurite`,
    ));
    return true;
  }
}
