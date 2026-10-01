import { activityNames, type ActivityName } from "../types.js";

export type ParsedCommand =
  | { kind: "activity"; name: ActivityName }
  | { kind: "balance" }
  | { kind: "leaderboard" }
  | { kind: "message-leaderboard" }
  | { kind: "give"; recipientId: string; amount: number }
  | { kind: "invalid-give"; reason: string }
  | { kind: "economy-admin"; action: "add" | "remove" | "set"; targetId: string; amount: number }
  | { kind: "economy-freeze"; targetId: string }
  | { kind: "economy-audit"; targetId: string }
  | { kind: "invalid-economy-admin"; reason: string }
  | { kind: "game"; game: "c4" | "ttt"; opponentId: string; wager: number }
  | { kind: "invalid-game"; reason: string };

const activities = new Set<string>(activityNames);
const gamePattern = /^(c4|ttt)\s+<@!?(\d{15,25})>(?:\s+(\S+))?$/i;
const givePattern = /^give\s+<@!?(\d{15,25})>\s+(\S+)$/i;
const adminAmountPattern = /^(addmoney|removemoney|setbalance)\s+<@!?(\d{15,25})>\s+(\S+)$/i;
const adminTargetPattern = /^(freeze|economy\s+audit)\s+<@!?(\d{15,25})>$/i;
const wholeAmountPattern = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/;

function parseWholeAmount(input: string): number | null {
  if (!wholeAmountPattern.test(input)) return null;
  const amount = Number(input.replaceAll(",", ""));
  return Number.isSafeInteger(amount) ? amount : null;
}

export function parseCommand(content: string, prefix: string): ParsedCommand | null {
  if (!content.startsWith(prefix)) return null;
  const body = content.slice(prefix.length).trim();
  const lowered = body.toLowerCase();

  if (activities.has(lowered)) return { kind: "activity", name: lowered as ActivityName };
  if (lowered === "balance" || lowered === "bal") return { kind: "balance" };
  if (lowered === "lb" || lowered === "leaderboard") return { kind: "leaderboard" };
  if (lowered === "msglb" || lowered === "messagelb") return { kind: "message-leaderboard" };

  if (/^(?:addmoney|removemoney|setbalance|freeze|economy\s+audit)(?:\s|$)/i.test(body)) {
    const targetMatch = body.match(adminTargetPattern);
    if (targetMatch) {
      return targetMatch[1]!.toLowerCase() === "freeze"
        ? { kind: "economy-freeze", targetId: targetMatch[2]! }
        : { kind: "economy-audit", targetId: targetMatch[2]! };
    }
    const amountMatch = body.match(adminAmountPattern);
    if (!amountMatch) {
      return { kind: "invalid-economy-admin", reason: `Use \`${prefix}addmoney @user amount\`, \`${prefix}removemoney @user amount\`, \`${prefix}setbalance @user amount\`, \`${prefix}freeze @user\`, or \`${prefix}economy audit @user\`.` };
    }
    const amount = parseWholeAmount(amountMatch[3]!);
    if (amount === null || (amountMatch[1]!.toLowerCase() !== "setbalance" && amount < 1)) {
      return { kind: "invalid-economy-admin", reason: "Enter a valid whole Assurite amount." };
    }
    const actions = { addmoney: "add", removemoney: "remove", setbalance: "set" } as const;
    return {
      kind: "economy-admin", action: actions[amountMatch[1]!.toLowerCase() as keyof typeof actions],
      targetId: amountMatch[2]!, amount,
    };
  }

  if (lowered === "give" || lowered.startsWith("give ")) {
    const match = body.match(givePattern);
    if (!match) return { kind: "invalid-give", reason: `Use \`${prefix}give @user amount\`.` };
    const amount = parseWholeAmount(match[2]!);
    if (amount === null || amount < 1) {
      return { kind: "invalid-give", reason: "Enter a valid whole Assurite amount." };
    }
    return { kind: "give", recipientId: match[1]!, amount };
  }

  if (lowered === "c4" || lowered === "ttt" || /^(c4|ttt)\s/.test(lowered)) {
    const match = body.match(gamePattern);
    if (!match) {
      return { kind: "invalid-game", reason: `Use \`${prefix}c4 @user [amount]\` or \`${prefix}ttt @user [amount]\`.` };
    }

    const wager = match[3] ? parseWholeAmount(match[3]) : 0;
    if (wager === null || wager < 0) {
      return { kind: "invalid-game", reason: "That wager is not a valid amount." };
    }
    if (wager > 0 && wager < 2_500) {
      return { kind: "invalid-game", reason: "Wagered games have a 2,500 Assurite minimum." };
    }

    return {
      kind: "game",
      game: match[1]!.toLowerCase() as "c4" | "ttt",
      opponentId: match[2]!,
      wager,
    };
  }

  return null;
}
