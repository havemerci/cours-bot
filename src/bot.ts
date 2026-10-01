import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Options,
  Partials,
  type Message,
} from "discord.js";
import { AutomationManager, MESSAGE_LEADERBOARD_OWNER_ID } from "./automations.js";
import { BlackjackManager } from "./casino/blackjack.js";
import { CasinoManager } from "./casino/casino.js";
import { ChatActivityManager } from "./chat-activities/manager.js";
import { parseCommand } from "./commands/input.js";
import { config } from "./config.js";
import { GameManager } from "./games/manager.js";
import { MessageGuard, type GuardDecision } from "./guards.js";
import { HelpManager } from "./help.js";
import { logger } from "./logger.js";
import { RestartCache, restartLoadingEmoji } from "./restart-cache.js";
import { EconomyService } from "./services/economy.js";
import {
  balanceMessage,
  cooldownMessage,
  economyAdminMessage,
  economyAuditMessage,
  errorMessage,
  leaderboardMessage,
  messageLeaderboardMessage,
  noticeMessage,
  successMessage,
  transferMessage,
} from "./ui.js";

export interface BotRuntime {
  client: Client;
  stop(): Promise<void>;
}

const BOT_OWNER_ID = "1506332513004683274";
const ECONOMY_ADMIN_IDS = new Set([BOT_OWNER_ID, "1527744055029665834"]);
let restartScheduled = false;

export async function startBot(): Promise<BotRuntime> {
  const economy = new EconomyService();
  const restartCache = new RestartCache();
  await restartCache.start().catch((error) => {
    logger.warn("Could not connect to Redis restart cache", { message: String(error) });
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.GuildMember],
    allowedMentions: { parse: [], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      MessageManager: 20,
      GuildMemberManager: 200,
      PresenceManager: 0,
      ReactionManager: 0,
    }),
    sweepers: {
      messages: { interval: 300, lifetime: 600 },
    },
    presence: {
      status: "online",
      activities: [{ name: "status", state: "made by @ilybabemwah", type: ActivityType.Custom }],
    },
  });
  const guard = new MessageGuard(config.PREFIX);
  const games = new GameManager(client, economy);
  const casino = new CasinoManager(economy);
  const blackjack = new BlackjackManager(client, economy);
  const automations = new AutomationManager(client, economy, guard);
  const help = new HelpManager(client, config.PREFIX);
  const chatActivities = new ChatActivityManager(client, economy, guard);

  client.once(Events.ClientReady, (readyClient) => {
    logger.info("ready", {
      user: readyClient.user.tag,
      guilds: readyClient.guilds.cache.size,
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message, economy, games, casino, blackjack, automations, help, guard, restartCache);
  });

  client.on(Events.Error, (error) => {
    logger.error("Discord client error", { message: error.message });
  });

  await client.login(config.TOKEN);
  await games.refundExpired();
  blackjack.start();
  automations.start();
  await restartCache.complete(client).catch((error) => {
    logger.warn("Could not finalize restart reaction", { message: String(error) });
  });
  const cleanupTimer = setInterval(() => void games.refundExpired(), 60_000);
  cleanupTimer.unref();
  return {
    client,
    async stop() {
      clearInterval(cleanupTimer);
      guard.stop();
      chatActivities.stop();
      blackjack.stop();
      await automations.stop();
      await restartCache.stop();
    },
  };
}

async function handleMessage(
  message: Message,
  economy: EconomyService,
  games: GameManager,
  casino: CasinoManager,
  blackjack: BlackjackManager,
  automations: AutomationManager,
  help: HelpManager,
  guard: MessageGuard,
  restartCache: RestartCache,
): Promise<void> {
  if (message.author.bot) return;

  try {
    const guardDecision = guard.inspect(message);
    if (message.content.startsWith(config.PREFIX) && !guardDecision.allowCommand) {
      if (guardDecision.notify) await message.reply(guardNotice(guardDecision));
      return;
    }

    const ownerCommand = message.content.startsWith(config.PREFIX)
      ? message.content.slice(config.PREFIX.length).trim().toLowerCase()
      : "";
    if (ownerCommand === "ping" || ownerCommand === "restart") {
      if (message.author.id !== BOT_OWNER_ID) {
        await message.reply(noticeMessage("Restricted command", "Only the bot owner can use this command."));
        return;
      }

      if (ownerCommand === "ping") {
        const startedAt = performance.now();
        const response = await message.reply(noticeMessage("Ping", "Measuring connection latency…"));
        const roundTrip = Math.max(0, Math.round(performance.now() - startedAt));
        const gateway = Math.max(0, Math.round(message.client.ws.ping));
        const pong = noticeMessage(
          "Pong",
          `Discord gateway · **${gateway} ms**\nMessage round trip · **${roundTrip} ms**`,
        );
        await response.edit({
          components: pong.components ?? [],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
        });
        return;
      }

      if (restartScheduled) {
        return;
      }
      await message.react(restartLoadingEmoji);
      if (!await restartCache.mark(message)) {
        await message.reactions.resolve(restartLoadingEmoji)?.users.remove(message.client.user.id).catch(() => undefined);
        await message.react("<:close:1544388036761096205>");
        logger.error("Restart cancelled because Redis is unavailable");
        return;
      }
      restartScheduled = true;
      logger.warn("forced process restart", { userId: message.author.id });
      const restartTimer = setTimeout(() => process.exit(1), 750);
      restartTimer.unref();
      return;
    }

    if (await help.handle(message)) return;
    if (await blackjack.handle(message, config.PREFIX)) return;
    if (await casino.handle(message, config.PREFIX)) return;
    const command = parseCommand(message.content, config.PREFIX);
    if (!command) return;

    if (command.kind === "invalid-game") {
      await message.reply(noticeMessage("Game challenge", command.reason));
      return;
    }
    if (command.kind === "invalid-give") {
      await message.reply(noticeMessage("Transfer", command.reason));
      return;
    }
    const economyOwnerCommand = command.kind === "economy-admin" || command.kind === "economy-freeze"
      || command.kind === "economy-audit" || command.kind === "invalid-economy-admin";
    if (economyOwnerCommand && !ECONOMY_ADMIN_IDS.has(message.author.id)) {
      await message.reply(noticeMessage("Restricted command", "Only an economy owner can use this command."));
      return;
    }
    if (command.kind === "invalid-economy-admin") {
      await message.reply(noticeMessage("Economy administration", command.reason));
      return;
    }
    if (command.kind === "economy-audit") {
      await message.reply(economyAuditMessage(command.targetId, await economy.economyAudit(command.targetId)));
      return;
    }
    if (command.kind === "economy-admin" || command.kind === "economy-freeze") {
      const targetId = command.targetId;
      const target = message.mentions.users.get(targetId);
      if (!target || target.bot) {
        await message.reply(noticeMessage("Economy administration", "Choose a human member of this server."));
        return;
      }
      const result = command.kind === "economy-freeze"
        ? await economy.manageAccount(message.author.id, targetId, "freeze", null)
        : await economy.manageAccount(message.author.id, targetId, command.action, command.amount);
      await message.reply(economyAdminMessage(targetId, result));
      return;
    }

    if (command.kind === "activity") {
      const result = await economy.claim(message.author.id, command.name, message.guildId);
      await message.reply(
        result.claimed
          ? successMessage(command.name, result)
          : cooldownMessage(result.nextClaimAt),
      );
      return;
    }

    if (command.kind === "balance") {
      const balance = await economy.balance(message.author.id, message.guildId);
      await message.reply(balanceMessage(message.author.id, balance));
      return;
    }

    if (command.kind === "leaderboard") {
      if (!message.guildId) {
        await message.reply(noticeMessage("Leaderboard", "Use this command inside a server."));
        return;
      }
      const entries = await economy.leaderboard(message.guildId, message.author.id);
      await message.reply(leaderboardMessage(entries));
      return;
    }

    if (command.kind === "message-leaderboard") {
      if (!message.guildId || message.author.id !== MESSAGE_LEADERBOARD_OWNER_ID) {
        await message.reply(noticeMessage("Message activity", "You are not allowed to view this leaderboard."));
        return;
      }
      const result = await automations.getMessageLeaderboard(message.guildId, message.author.id);
      await message.reply(messageLeaderboardMessage(result.entries, result.weekStart));
      return;
    }

    if (command.kind === "give") {
      const recipient = message.mentions.users.get(command.recipientId);
      if (!message.guildId || !recipient || recipient.bot || recipient.id === message.author.id) {
        await message.reply(noticeMessage("Transfer", "Choose another human member of this server."));
        return;
      }
      const result = await economy.give(message.guildId, message.author.id, recipient.id, command.amount);
      if (!result.transferred) {
        const reasons: Record<string, string> = {
          transaction_cap: "A single transfer cannot exceed 25,000 Assurite.",
          daily_cap: `You have reached the 100,000 Assurite daily transfer cap. Sent today: ${result.sentToday.toLocaleString("en-US")}.`,
          insufficient_balance: "You do not have enough Assurite.",
          self_transfer: "You cannot transfer Assurite to yourself.",
        };
        await message.reply(noticeMessage("Transfer declined", reasons[result.failureReason ?? ""] ?? "That transfer could not be completed."));
        return;
      }
      await message.reply(transferMessage(recipient.id, command.amount, result.senderBalance, result.sentToday));
      return;
    }

    const opponent = message.mentions.users.get(command.opponentId);
    if (!message.guildId || !opponent) {
      await message.reply(noticeMessage("Game challenge", "Games can only be started by mentioning someone in a server."));
      return;
    }
    if (opponent.bot || opponent.id === message.author.id) {
      await message.reply(noticeMessage("Game challenge", "Choose another human player."));
      return;
    }
    await games.challenge({
      source: message,
      type: command.game,
      opponentId: opponent.id,
      wager: command.wager,
    });
  } catch (error) {
    logger.error("Economy command failed", {
      command: message.content.slice(0, 50),
      userId: message.author.id,
      message: error instanceof Error ? error.message : String(error),
    });

    try {
      const text = error instanceof Error && error.message.includes("enough Assurite")
        ? noticeMessage("Not enough Assurite", "Both players need the full wager in their balance.")
        : error instanceof Error && error.message.includes("account is frozen")
          ? noticeMessage("Account frozen", "This account cannot send, receive, earn, spend, or wager Assurite.")
          : errorMessage();
      await message.reply(text);
    } catch (replyError) {
      logger.warn("Could not send command error response", {
        message: replyError instanceof Error ? replyError.message : String(replyError),
      });
    }
  }
}

function guardNotice(decision: GuardDecision) {
  const retry = decision.retryAt
    ? ` Try again <t:${Math.ceil(decision.retryAt / 1_000)}:R>.`
    : "";
  return noticeMessage("Slow down", `${decision.reason ?? "That command was blocked."}${retry}`);
}
