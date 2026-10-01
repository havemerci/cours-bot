import { randomInt, randomUUID } from "node:crypto";
import {
  ContainerBuilder,
  Events,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type Client,
  type Message,
} from "discord.js";
import { logger } from "../logger.js";
import { MessageGuard } from "../guards.js";
import { EconomyService } from "../services/economy.js";
import { fetchAnimePool, type AnimeEntry } from "./anime-provider.js";
import { matchesAnimeAnswer, matchesFlagAnswer } from "./logic.js";

const MESSAGE_TRIGGER = 50;
const REWARD = 1_250;
const ROUND_DURATION_MS = 15_000;
const ACTIVITY_CHANNEL_ID = "1533467066529747144";

interface Prompt {
  type: "flag" | "anime";
  answer: string;
  aliases: string[];
  imageUrl: string;
}

interface Round extends Prompt {
  id: string;
  message: Message;
  claimed: boolean;
  timer: NodeJS.Timeout;
}

const countries: Array<{ code: string; name: string; aliases?: string[] }> = [
  { code: "ar", name: "Argentina" }, { code: "au", name: "Australia" },
  { code: "br", name: "Brazil" }, { code: "ca", name: "Canada" },
  { code: "cl", name: "Chile" }, { code: "cn", name: "China" },
  { code: "co", name: "Colombia" }, { code: "dk", name: "Denmark" },
  { code: "eg", name: "Egypt" }, { code: "et", name: "Ethiopia" },
  { code: "fi", name: "Finland" }, { code: "fr", name: "France" },
  { code: "de", name: "Germany" }, { code: "gh", name: "Ghana" },
  { code: "gr", name: "Greece" }, { code: "in", name: "India" },
  { code: "id", name: "Indonesia" }, { code: "ie", name: "Ireland" },
  { code: "it", name: "Italy" }, { code: "jp", name: "Japan" },
  { code: "ke", name: "Kenya" }, { code: "mx", name: "Mexico" },
  { code: "ma", name: "Morocco" }, { code: "nl", name: "Netherlands", aliases: ["The Netherlands", "Holland"] },
  { code: "nz", name: "New Zealand" }, { code: "ng", name: "Nigeria" },
  { code: "no", name: "Norway" }, { code: "pk", name: "Pakistan" },
  { code: "ph", name: "Philippines", aliases: ["The Philippines"] },
  { code: "pl", name: "Poland" }, { code: "pt", name: "Portugal" },
  { code: "sa", name: "Saudi Arabia" }, { code: "za", name: "South Africa" },
  { code: "kr", name: "South Korea", aliases: ["Korea", "Republic of Korea"] },
  { code: "es", name: "Spain" }, { code: "se", name: "Sweden" },
  { code: "ch", name: "Switzerland" }, { code: "tz", name: "Tanzania" },
  { code: "tr", name: "Turkey", aliases: ["Türkiye", "Turkiye"] },
  { code: "ug", name: "Uganda" }, { code: "ua", name: "Ukraine" },
  { code: "ae", name: "United Arab Emirates", aliases: ["UAE"] },
  { code: "gb", name: "United Kingdom", aliases: ["UK", "Great Britain", "Britain"] },
  { code: "us", name: "United States", aliases: ["USA", "US", "United States of America", "America"] },
];

export class ChatActivityManager {
  readonly #counts = new Map<string, number>();
  readonly #rounds = new Map<string, Round>();
  readonly #launching = new Set<string>();
  #animePool: AnimeEntry[] = [];
  #animePoolExpiresAt = 0;
  #animeRefresh: Promise<void> | null = null;
  #stopped = false;

  public constructor(
    readonly client: Client,
    readonly economy: EconomyService,
    readonly guard: MessageGuard,
  ) {
    client.on(Events.MessageCreate, (message) => {
      if (message.channelId === ACTIVITY_CHANNEL_ID
        && !message.author.bot
        && message.guildId
        && this.guard.inspect(message).allowActivity) {
        void this.#onMessage(message).catch((error) => logger.error("Chat activity failed", { message: String(error) }));
      }
    });
  }

  public stop(): void {
    this.#stopped = true;
    for (const round of this.#rounds.values()) clearTimeout(round.timer);
    this.#rounds.clear();
    this.#counts.clear();
    this.#launching.clear();
  }

  async #onMessage(message: Message): Promise<void> {
    if (this.#stopped) return;
    const active = this.#rounds.get(message.channelId);
    if (active && !active.claimed && this.#matches(message.content, active)) {
      active.claimed = true;
      clearTimeout(active.timer);
      try {
        await this.economy.awardEvent({
          eventId: `chat-activity:${active.id}`,
          guildId: message.guildId!,
          userId: message.author.id,
          source: `chat_activity_${active.type}`,
          amount: REWARD,
        });
        this.#rounds.delete(message.channelId);
        await active.message.edit(this.#finishedPayload(active, message.author.id));
      } catch (error) {
        this.#rounds.delete(message.channelId);
        await active.message.edit(this.#failedPayload()).catch(() => undefined);
        throw error;
      }
    }

    const count = (this.#counts.get(message.channelId) ?? 0) + 1;
    if (count < MESSAGE_TRIGGER) {
      this.#counts.set(message.channelId, count);
      return;
    }
    this.#counts.set(message.channelId, 0);
    if (this.#rounds.has(message.channelId) || this.#launching.has(message.channelId)) return;
    await this.#launch(message);
  }

  async #launch(source: Message): Promise<void> {
    this.#launching.add(source.channelId);
    try {
      if (!source.channel.isSendable()) return;
      const prompt = randomInt(2) === 0
        ? this.#flagPrompt()
        : await this.#animePrompt().catch((error) => {
          logger.warn("Anime round unavailable; starting a flag round", {
            message: error instanceof Error ? error.message : String(error),
          });
          return this.#flagPrompt();
        });
      if (this.#stopped) return;
      const expiresAt = Date.now() + ROUND_DURATION_MS;
      const sent = await source.channel.send(this.#activePayload(prompt, expiresAt));
      const id = randomUUID();
      const timer = setTimeout(
        () => void this.#expire(source.channelId, id),
        Math.max(0, expiresAt - Date.now()),
      );
      timer.unref();
      this.#rounds.set(source.channelId, { ...prompt, id, message: sent, claimed: false, timer });
    } finally {
      this.#launching.delete(source.channelId);
    }
  }

  #flagPrompt(): Prompt {
    const country = countries[randomInt(countries.length)]!;
    return {
      type: "flag",
      answer: country.name,
      aliases: [country.name, ...(country.aliases ?? [])],
      imageUrl: `https://flagcdn.com/w320/${country.code}.png`,
    };
  }

  async #animePrompt(): Promise<Prompt> {
    if (this.#animePool.length === 0 || Date.now() >= this.#animePoolExpiresAt) {
      try {
        await this.#refreshAnimePoolOnce();
      } catch (error) {
        if (this.#animePool.length === 0) throw error;
        this.#animePoolExpiresAt = Date.now() + 5 * 60_000;
        logger.warn("Anime providers unavailable; using stale cache", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const anime = this.#animePool[randomInt(this.#animePool.length)]!;
    const aliases = [anime.title, anime.englishTitle, anime.nativeTitle, ...anime.synonyms]
      .filter((title): title is string => Boolean(title?.trim()));
    return {
      type: "anime",
      answer: anime.englishTitle ?? anime.title,
      aliases,
      imageUrl: anime.imageUrl,
    };
  }

  #refreshAnimePoolOnce(): Promise<void> {
    if (!this.#animeRefresh) {
      const refresh = this.#refreshAnimePool().finally(() => {
        if (this.#animeRefresh === refresh) this.#animeRefresh = null;
      });
      this.#animeRefresh = refresh;
    }
    return this.#animeRefresh;
  }

  async #refreshAnimePool(): Promise<void> {
    this.#animePool = await fetchAnimePool();
    this.#animePoolExpiresAt = Date.now() + 6 * 60 * 60_000;
  }

  #matches(guess: string, round: Round): boolean {
    return round.type === "flag"
      ? matchesFlagAnswer(guess, round.aliases)
      : matchesAnimeAnswer(guess, round.aliases);
  }

  #activePayload(prompt: Prompt, expiresAt: number) {
    const title = prompt.type === "flag" ? "Guess the Country" : "Guess the Anime";
    const hint = prompt.type === "anime" ? "Guess the Anime" : "Type the country name.";
    const relativeDeadline = `<t:${Math.floor(expiresAt / 1_000)}:R>`;
    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### ${title}\nFirst correct answer wins **${REWARD.toLocaleString("en-US")} Assurite**.\n-# ${hint} · Ends ${relativeDeadline}`,
      ))
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(prompt.imageUrl).setDescription(title),
      ));
    return { flags: MessageFlags.IsComponentsV2 as const, components: [container], allowedMentions: { parse: [] as never[] } };
  }

  #finishedPayload(round: Round, winnerId?: string) {
    const text = winnerId
      ? `### Correct\n<@${winnerId}> guessed **${round.answer}** first.\n**+${REWARD.toLocaleString("en-US")} Assurite**`
      : `### Round over\nNobody guessed it in time. The answer was **${round.answer}**.`;
    return {
      flags: MessageFlags.IsComponentsV2 as const,
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text))],
      allowedMentions: { parse: [] as never[] },
    };
  }

  #failedPayload() {
    return {
      flags: MessageFlags.IsComponentsV2 as const,
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "### Round closed\nThe reward could not be issued, so this round was cancelled.",
      ))],
      allowedMentions: { parse: [] as never[] },
    };
  }

  async #expire(channelId: string, roundId: string): Promise<void> {
    const round = this.#rounds.get(channelId);
    if (!round || round.id !== roundId || round.claimed) return;
    round.claimed = true;
    this.#rounds.delete(channelId);
    await round.message.edit(this.#finishedPayload(round)).catch(() => undefined);
  }
}
