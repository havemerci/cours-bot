import { createClient } from "redis";
import type { Client, Message } from "discord.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const CACHE_KEY = "assure:restart:pending";
const LOADING_EMOJI_ID = "1554854241342849126";
const SUCCESS_EMOJI_ID = "1544388085003853824";

interface RestartRecord {
  channelId: string;
  messageId: string;
}

export class RestartCache {
  readonly #redis = config.REDIS_URL ? createClient({
    url: config.REDIS_URL,
    socket: { connectTimeout: 3_000, reconnectStrategy: false },
  }) : null;

  public async start(): Promise<void> {
    if (!this.#redis) {
      logger.warn("Redis restart disabled");
      return;
    }
    this.#redis.on("error", (error) => logger.warn("Redis restart cache error", { message: error.message }));
    await this.#redis.connect();
  }

  public async mark(message: Message): Promise<boolean> {
    if (!this.#redis?.isReady) return false;
    const record: RestartRecord = { channelId: message.channelId, messageId: message.id };
    await this.#redis.set(CACHE_KEY, JSON.stringify(record), { EX: 600 });
    return true;
  }

  public async complete(client: Client): Promise<void> {
    if (!this.#redis?.isReady || !client.user) return;
    const raw = await this.#redis.get(CACHE_KEY);
    if (!raw) return;
    const record = JSON.parse(raw) as RestartRecord;
    const channel = await client.channels.fetch(record.channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    const message = await channel.messages.fetch(record.messageId).catch(() => null);
    if (!message) {
      await this.#redis.del(CACHE_KEY);
      return;
    }
    const loading = message.reactions.resolve(LOADING_EMOJI_ID);
    if (loading) await loading.users.remove(client.user.id).catch(() => undefined);
    await message.react(SUCCESS_EMOJI_ID);
    await this.#redis.del(CACHE_KEY);
  }

  public async stop(): Promise<void> {
    if (this.#redis?.isOpen) await this.#redis.quit().catch(() => undefined);
  }
}

export const restartLoadingEmoji = LOADING_EMOJI_ID;
