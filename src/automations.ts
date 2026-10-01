import { Events, PermissionFlagsBits, type Client, type GuildMember, type Message, type TextChannel } from "discord.js";
import { MessageGuard } from "./guards.js";
import { logger } from "./logger.js";
import { EconomyService, type MessageLeaderboardEntry } from "./services/economy.js";

export const ACTIVITY_ROLE_ID = "1554082572739551262";
export const MESSAGE_LEADERBOARD_OWNER_ID = "1527744055029665834";
export const DAILY_REWARD_ROLE_ID = "1529626820801200248";
export const PURGE_CHANNEL_ID = "1533467066529747144";
const DISBOARD_ID = "302050872383242240";
const REWARD = 5_000;
const PURGE_MINIMUM_AGE_MS = 30 * 60_000;

export interface PurgeQueueEntry {
  messageId: string;
  deleteAt: number;
  retryAt?: number;
  message?: Message;
}

export function selectDuePurgeEntries(
  entries: Iterable<PurgeQueueEntry>,
  now: number,
): PurgeQueueEntry[] {
  return [...entries]
    .filter((entry) => (entry.retryAt ?? entry.deleteAt) <= now)
    .sort((a, b) => a.deleteAt - b.deleteAt || a.messageId.localeCompare(b.messageId));
}

export function weekStartUtc(offsetWeeks = 0): string {
  const now = new Date();
  const day = now.getUTCDay() || 7;
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - day + 1 + offsetWeeks * 7);
  return date.toISOString().slice(0, 10);
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export class AutomationManager {
  readonly #pendingMessages = new Map<string, number>();
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #purgeQueue = new Map<string, PurgeQueueEntry>();
  readonly #livePurgeTimers = new Map<string, NodeJS.Timeout>();
  #purgeTimer: NodeJS.Timeout | null = null;
  #purgeDraining = false;
  #stopped = false;
  #flushing = false;

  public constructor(
    readonly client: Client,
    readonly economy: EconomyService,
    readonly guard: MessageGuard,
  ) {
    client.on(Events.MessageCreate, (message) => {
      if (message.channelId === PURGE_CHANNEL_ID && !message.pinned) {
        this.#scheduleLivePurge(message);
      }
      if (!message.author.bot && message.guildId && this.guard.inspect(message).allowActivity) {
        this.#track(message.guildId, message.author.id);
      }
      void this.#handleBump(message).catch((error) => logger.error("DISBOARD reward failed", { message: String(error) }));
    });
    client.on(Events.MessageDelete, (message) => {
      if (message.channelId !== PURGE_CHANNEL_ID) return;
      this.#purgeQueue.delete(message.id);
      const timer = this.#livePurgeTimers.get(message.id);
      if (timer) clearTimeout(timer);
      this.#livePurgeTimers.delete(message.id);
    });
    client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
      if (newMessage.channelId !== PURGE_CHANNEL_ID) return;
      if (newMessage.pinned) {
        this.#purgeQueue.delete(newMessage.id);
        const timer = this.#livePurgeTimers.get(newMessage.id);
        if (timer) clearTimeout(timer);
        this.#livePurgeTimers.delete(newMessage.id);
      } else {
        void newMessage.fetch()
          .then((message) => this.#scheduleLivePurge(message))
          .catch((error) => logger.warn("Could not refresh updated purge message", {
            channelId: PURGE_CHANNEL_ID,
            messageId: newMessage.id,
            message: String(error),
          }));
      }
    });
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      if (!oldMember.premiumSinceTimestamp && newMember.premiumSinceTimestamp) {
        void this.#awardBoost(newMember).catch((error) => logger.error("Boost reward failed", { message: String(error) }));
      }
    });
  }

  public start(): void {
    this.#stopped = false;
    void Promise.allSettled([
      this.#scanBoostersAndDailyRoles(),
      this.#updateWeeklyActivityRoles(),
    ]);
    void this.#rebuildPurgeQueue().catch((error) => logger.error("Purge queue rebuild failed", { message: String(error) }));
    this.#repeat(() => this.flushMessages(), 30_000);
    this.#repeat(() => this.#scanBoostersAndDailyRoles(), 24 * 60 * 60_000);
    this.#repeat(() => this.#updateWeeklyActivityRoles(), 60 * 60_000);
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.length = 0;
    if (this.#purgeTimer) clearTimeout(this.#purgeTimer);
    this.#purgeTimer = null;
    for (const timer of this.#livePurgeTimers.values()) clearTimeout(timer);
    this.#livePurgeTimers.clear();
    this.#purgeQueue.clear();
    await this.flushMessages();
  }

  public async getMessageLeaderboard(guildId: string, userId: string): Promise<{ entries: MessageLeaderboardEntry[]; weekStart: string }> {
    await this.flushMessages();
    const weekStart = weekStartUtc();
    return { entries: await this.economy.messageLeaderboard(guildId, weekStart, userId), weekStart };
  }

  public async flushMessages(): Promise<void> {
    if (this.#flushing || this.#pendingMessages.size === 0) return;
    this.#flushing = true;
    const snapshot = [...this.#pendingMessages.entries()];
    this.#pendingMessages.clear();
    try {
      await this.economy.recordMessageBatch(snapshot.map(([key, count]) => {
        const [guild_id, user_id] = key.split(":") as [string, string];
        return { guild_id, user_id, count };
      }));
    } catch (error) {
      for (const [key, count] of snapshot) this.#pendingMessages.set(key, (this.#pendingMessages.get(key) ?? 0) + count);
      logger.error("Message activity flush failed", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#flushing = false;
    }
  }

  #track(guildId: string, userId: string): void {
    const key = `${guildId}:${userId}`;
    this.#pendingMessages.set(key, (this.#pendingMessages.get(key) ?? 0) + 1);
  }

  async #handleBump(message: Message): Promise<void> {
    if (message.author.id !== DISBOARD_ID || !message.guildId) return;
    const text = [message.content, ...message.embeds.flatMap((embed) => [embed.title ?? "", embed.description ?? ""])]
      .join(" ").toLowerCase();
    if (!text.includes("bump done") && !text.includes("successfully bumped")) return;
    const userId = message.interactionMetadata?.user.id;
    if (!userId) return;
    await this.economy.awardEvent({
      eventId: `disboard:${message.id}`, guildId: message.guildId, userId, source: "disboard_bump", amount: REWARD,
    });
  }

  async #awardBoost(member: GuildMember): Promise<void> {
    if (!member.premiumSince) return;
    await this.economy.awardEvent({
      eventId: `boost:${member.guild.id}:${member.id}:${member.premiumSince.toISOString()}`,
      guildId: member.guild.id, userId: member.id, source: "server_boost", amount: REWARD,
    });
  }

  async #scanBoostersAndDailyRoles(): Promise<void> {
    for (const guild of this.client.guilds.cache.values()) {
      try {
        const members = await guild.members.fetch();
        const work: Promise<unknown>[] = [];
        for (const member of members.values()) {
          if (member.user.bot) continue;
          if (member.premiumSince) work.push(this.#awardBoost(member));
          if (member.roles.cache.has(DAILY_REWARD_ROLE_ID)) {
            work.push(this.economy.awardEvent({
              eventId: `daily-role:${guild.id}:${member.id}:${utcDate()}`,
              guildId: guild.id, userId: member.id, source: "daily_role", amount: REWARD,
            }));
          }
        }
        await Promise.all(work);
      } catch (error) {
        logger.error("Role reward scan failed", { guildId: guild.id, message: String(error) });
      }
    }
  }

  async #updateWeeklyActivityRoles(): Promise<void> {
    await this.flushMessages();
    const previousWeek = weekStartUtc(-1);
    for (const guild of this.client.guilds.cache.values()) {
      const role = guild.roles.cache.get(ACTIVITY_ROLE_ID);
      if (!role) continue;
      try {
        const leaders = await this.economy.messageLeaderboard(guild.id, previousWeek, MESSAGE_LEADERBOARD_OWNER_ID);
        const winner = leaders.find((entry) => entry.rank === 1);
        if (!winner) continue;
        const members = await guild.members.fetch();
        for (const member of members.values()) {
          if (member.roles.cache.has(role.id) && member.id !== winner.userId) await member.roles.remove(role);
        }
        const winnerMember = members.get(winner.userId) ?? await guild.members.fetch(winner.userId);
        if (!winnerMember.roles.cache.has(role.id)) await winnerMember.roles.add(role);
      } catch (error) {
        logger.error("Weekly activity role update failed", { guildId: guild.id, message: String(error) });
      }
    }
  }

  #enqueuePurge(message: Message, schedule = true): void {
    if (this.#stopped
      || message.channelId !== PURGE_CHANNEL_ID
      || this.#livePurgeTimers.has(message.id)
      || this.#purgeQueue.has(message.id)) return;
    const entry: PurgeQueueEntry = {
      messageId: message.id,
      deleteAt: message.createdTimestamp + PURGE_MINIMUM_AGE_MS,
      message,
    };
    this.#purgeQueue.set(message.id, entry);
    logger.debug("Purge message queued", {
      channelId: PURGE_CHANNEL_ID,
      messageId: message.id,
      deleteAt: new Date(entry.deleteAt).toISOString(),
    });
    if (schedule) this.#schedulePurge();
  }

  #scheduleLivePurge(message: Message, minimumDelay = 0): void {
    if (this.#stopped || message.channelId !== PURGE_CHANNEL_ID || message.pinned) return;
    const existing = this.#livePurgeTimers.get(message.id);
    if (existing) clearTimeout(existing);
    const deleteAt = message.createdTimestamp + PURGE_MINIMUM_AGE_MS;
    const delay = Math.max(minimumDelay, deleteAt - Date.now(), 0);
    const timer = setTimeout(() => {
      this.#livePurgeTimers.delete(message.id);
      void this.#deleteLiveMessage(message).catch((error) => {
        logger.error("Live purge deletion failed", {
          channelId: PURGE_CHANNEL_ID,
          messageId: message.id,
          message: String(error),
        });
      });
    }, delay);
    timer.unref();
    this.#livePurgeTimers.set(message.id, timer);
    logger.info("Live purge message scheduled", {
      channelId: PURGE_CHANNEL_ID,
      messageId: message.id,
      deleteAt: new Date(deleteAt).toISOString(),
    });
  }

  async #deleteLiveMessage(message: Message): Promise<void> {
    if (this.#stopped || message.pinned) return;
    try {
      await message.delete();
      logger.info("Live purge message deleted", {
        channelId: PURGE_CHANNEL_ID,
        messageId: message.id,
      });
    } catch (error) {
      if (discordErrorCode(error) === 10_008) return;
      logger.warn("Live purge message will retry", {
        channelId: PURGE_CHANNEL_ID,
        messageId: message.id,
        code: discordErrorCode(error),
        message: String(error),
      });
      this.#scheduleLivePurge(message, 60_000);
    }
  }

  #schedulePurge(minimumDelay = 0): void {
    if (this.#stopped || this.#purgeDraining || this.#purgeQueue.size === 0) return;
    if (this.#purgeTimer) clearTimeout(this.#purgeTimer);
    const nextAttemptAt = [...this.#purgeQueue.values()].reduce((earliest, entry) => (
      Math.min(earliest, entry.retryAt ?? entry.deleteAt)
    ), Number.POSITIVE_INFINITY);
    const delay = Math.max(minimumDelay, nextAttemptAt - Date.now(), 0);
    this.#purgeTimer = setTimeout(() => {
      this.#purgeTimer = null;
      void this.#drainPurgeQueue().catch((error) => {
        logger.error("Purge queue failed", { message: String(error) });
      });
    }, delay);
    this.#purgeTimer.unref();
  }

  async #rebuildPurgeQueue(): Promise<void> {
    const channel = await this.client.channels.fetch(PURGE_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    const textChannel = channel as TextChannel;
    const permissions = this.client.user ? textChannel.permissionsFor(this.client.user) : null;
    const missingPermissions = [
      [PermissionFlagsBits.ViewChannel, "ViewChannel"],
      [PermissionFlagsBits.ReadMessageHistory, "ReadMessageHistory"],
      [PermissionFlagsBits.ManageMessages, "ManageMessages"],
    ].filter(([permission]) => !permissions?.has(permission as bigint)).map(([, name]) => name);
    if (missingPermissions.length > 0) {
      logger.error("Purge channel permissions are incomplete", {
        channelId: PURGE_CHANNEL_ID,
        missingPermissions,
      });
    }

    let after = textChannel.id;
    let scannedPages = 0;
    let queued = 0;
    while (true) {
      const page = await textChannel.messages.fetch({ limit: 100, after });
      scannedPages += 1;
      if (page.size === 0) break;
      const ordered = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const message of ordered) {
        if (!message.pinned) {
          this.#enqueuePurge(message, false);
          queued += 1;
        }
      }
      if (selectDuePurgeEntries(this.#purgeQueue.values(), Date.now()).length > 0) {
        await this.#drainPurgeQueue();
      }
      const newest = ordered.at(-1);
      if (!newest || newest.id === after || page.size < 100) break;
      after = newest.id;
    }
    const dueOnStartup = selectDuePurgeEntries(this.#purgeQueue.values(), Date.now()).length;
    logger.info("Purge queue rebuilt", {
      channelId: PURGE_CHANNEL_ID,
      queued,
      dueOnStartup,
      scannedPages,
    });
    if (dueOnStartup > 0) await this.#drainPurgeQueue();
    else this.#schedulePurge();
  }

  async #drainPurgeQueue(): Promise<void> {
    if (this.#stopped || this.#purgeDraining) return;
    this.#purgeDraining = true;
    let deleted = 0;
    let processed = 0;
    try {
      const due = selectDuePurgeEntries(this.#purgeQueue.values(), Date.now());
      if (due.length === 0) return;
      for (const entry of due) {
        this.#purgeQueue.delete(entry.messageId);
        processed += 1;
        try {
          if (!entry.message) throw new Error("Queued purge message is unavailable");
          const message = entry.message;
          if (message.pinned) continue;
          await message.delete();
          deleted += 1;
        } catch (error) {
          if (discordErrorCode(error) !== 10_008) {
            this.#purgeQueue.set(entry.messageId, { ...entry, retryAt: Date.now() + 60_000 });
          }
          logger.warn("Could not delete queued message", {
            channelId: PURGE_CHANNEL_ID,
            messageId: entry.messageId,
            code: discordErrorCode(error),
            message: String(error),
          });
        }
      }
    } finally {
      this.#purgeDraining = false;
      this.#schedulePurge();
    }
    logger.info("Silent purge completed", {
      channelId: PURGE_CHANNEL_ID,
      deleted,
      processed,
    });
  }

  #repeat(task: () => Promise<void>, interval: number): void {
    const timer = setInterval(() => void task().catch((error) => logger.error("Scheduled task failed", { message: String(error) })), interval);
    timer.unref();
    this.#timers.push(timer);
  }
}

function discordErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}
