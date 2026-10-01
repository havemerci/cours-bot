import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type MessageReplyOptions,
} from "discord.js";
import { activities } from "./activities.js";
import type { ActivityName, ClaimResult } from "./types.js";
import type { EconomyAdminResult, EconomyAuditEntry } from "./services/economy.js";

const currency = new Intl.NumberFormat("en-US");

function v2Message(container: ContainerBuilder): MessageReplyOptions {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { repliedUser: false },
  };
}

function divider(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

export function successMessage(command: ActivityName, result: ClaimResult): MessageReplyOptions {
  const activity = activities[command];
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ${activity.emoji} ${activity.title}\n${activity.success}`,
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**+${currency.format(result.reward)} Assurite**\n-# Balance · ${currency.format(result.balance)} Assurite`,
      ),
    );

  return v2Message(container);
}

export function cooldownMessage(nextClaimAt: Date): MessageReplyOptions {
  const timestamp = Math.ceil(nextClaimAt.getTime() / 1_000);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `You're moving too fast. Try again <t:${timestamp}:R>.`,
      ),
    );

  return v2Message(container);
}

export function errorMessage(): MessageReplyOptions {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "Something went wrong on my end. Try that command again in a moment.",
      ),
    );

  return v2Message(container);
}

export function balanceMessage(userId: string, balance: number): MessageReplyOptions {
  return v2Message(
    new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `◈ <@${userId}> has **${currency.format(balance)} Assurite**.`,
      ),
    ),
  );
}

export function leaderboardMessage(
  entries: ReadonlyArray<{ userId: string; balance: number; rank: number; isTarget: boolean }>,
): MessageReplyOptions {
  const top = entries.filter((entry) => entry.rank <= 10);
  const target = entries.find((entry) => entry.isTarget);
  const rows = top.length
    ? top.map((entry) => `\`${String(entry.rank).padStart(2, " ")}\` <@${entry.userId}>  ·  **${currency.format(entry.balance)}**`).join("\n")
    : "No one has a recorded balance yet.";
  const position = target
    ? `-# Your position · #${target.rank} with ${currency.format(target.balance)} Assurite`
    : "-# Use an economy command to join this server's leaderboard.";

  return v2Message(
    new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ◇ Richest in the server\n${rows}`))
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(position)),
  );
}

export function noticeMessage(title: string, text: string): MessageReplyOptions {
  return v2Message(
    new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${title}\n${text}`),
    ),
  );
}

export function transferMessage(recipientId: string, amount: number, balance: number, sentToday: number): MessageReplyOptions {
  return v2Message(
    new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `◈ Transfer complete, sent **${currency.format(amount)} Assurite** to <@${recipientId}>.`,
      ))
      .addSeparatorComponents(divider())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# Balance · ${currency.format(balance)} Assurite  ·  Sent today · ${currency.format(sentToday)} / 100,000`,
      )),
  );
}

export function messageLeaderboardMessage(
  entries: ReadonlyArray<{ userId: string; messageCount: number; rank: number; isTarget: boolean }>,
  weekLabel: string,
): MessageReplyOptions {
  const top = entries.filter((entry) => entry.rank <= 10);
  const target = entries.find((entry) => entry.isTarget);
  const rows = top.length
    ? top.map((entry) => `\`${String(entry.rank).padStart(2, " ")}\` <@${entry.userId}> · **${currency.format(entry.messageCount)}**`).join("\n")
    : "No messages recorded this week.";
  const footer = target ? `-# Your position · #${target.rank} with ${currency.format(target.messageCount)} messages` : "-# You have no recorded messages this week.";
  return v2Message(new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Weekly message activity\n-# Week of ${weekLabel}\n${rows}`))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(footer)));
}

export function economyAdminMessage(targetId: string, result: EconomyAdminResult): MessageReplyOptions {
  const labels = {
    add: "Balance increased", remove: "Balance decreased", set: "Balance set",
    freeze: "Account frozen", unfreeze: "Account unfrozen",
  } as const;
  const amount = result.amount === null ? "" : `\nAmount · **${currency.format(result.amount)} Assurite**`;
  return v2Message(new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**${labels[result.action]}**\nMember · <@${targetId}>${amount}\nBalance · **${currency.format(result.balanceAfter)} Assurite**\n-# Previous balance · ${currency.format(result.balanceBefore)} · ${result.frozen ? "Frozen" : "Active"}`,
    ),
  ));
}

export function economyAuditMessage(targetId: string, entries: readonly EconomyAuditEntry[]): MessageReplyOptions {
  const rows = entries.length ? entries.map((entry) => {
    const amount = entry.amount === null ? "" : ` · ${currency.format(entry.amount)}`;
    return `<t:${Math.floor(entry.createdAt.getTime() / 1_000)}:R> · ${entry.action}${amount} · ${currency.format(entry.balanceBefore)} → ${currency.format(entry.balanceAfter)} · <@${entry.actorId}>`;
  }).join("\n") : "No administrative changes recorded.";
  return v2Message(new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Economy audit · <@${targetId}>**\n${rows}`),
  ));
}
