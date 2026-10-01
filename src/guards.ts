import type { Message } from "discord.js";
import { logger } from "./logger.js";

const FLOOD_WINDOW_MS = 6_000;
const FLOOD_MESSAGE_LIMIT = 8;
const FLOOD_BLOCK_MS = 20_000;
const DUPLICATE_WINDOW_MS = 15_000;
const DUPLICATE_LIMIT = 3;
const COMMAND_WINDOW_MS = 8_000;
const COMMAND_LIMIT = 5;
const COMMAND_BLOCK_MS = 30_000;
const MAX_COMMAND_LENGTH = 400;
const MAX_COMMAND_MENTIONS = 3;

export interface GuardDecision {
  allowActivity: boolean;
  allowCommand: boolean;
  notify: boolean;
  reason?: string;
  retryAt?: number;
}

interface UserState {
  messages: number[];
  commands: number[];
  recentContent: Array<{ value: string; at: number }>;
  blockedUntil: number;
  commandBlockedUntil: number;
  lastNoticeAt: number;
  lastSeenAt: number;
}

export class MessageGuard {
  readonly #states = new Map<string, UserState>();
  readonly #decisions = new Map<string, { at: number; value: GuardDecision }>();
  #observations = 0;

  public constructor(readonly prefix: string) {}

  public inspect(message: Message): GuardDecision {
    const cached = this.#decisions.get(message.id);
    if (cached) return cached.value;

    const now = Date.now();
    const isCommand = message.content.startsWith(this.prefix);
    const key = `${message.guildId ?? "dm"}:${message.author.id}`;
    const state = this.#states.get(key) ?? {
      messages: [], commands: [], recentContent: [], blockedUntil: 0,
      commandBlockedUntil: 0, lastNoticeAt: 0, lastSeenAt: now,
    };
    state.lastSeenAt = now;
    this.#states.set(key, state);
    this.#pruneState(state, now);

    let decision: GuardDecision = { allowActivity: true, allowCommand: true, notify: false };
    if (state.blockedUntil > now) {
      decision = this.#blockedDecision(state, "Message flooding detected.", state.blockedUntil, isCommand, now);
    } else {
      state.messages.push(now);
      const normalized = normalizeContent(message.content);
      if (normalized.length >= 2) state.recentContent.push({ value: normalized, at: now });

      if (state.messages.length > FLOOD_MESSAGE_LIMIT) {
        state.blockedUntil = now + FLOOD_BLOCK_MS;
        decision = this.#blockedDecision(state, "Message flooding detected.", state.blockedUntil, isCommand, now);
        this.#logBlock(message, "message_flood");
      } else if (normalized.length >= 2
        && state.recentContent.filter((entry) => entry.value === normalized).length >= DUPLICATE_LIMIT) {
        state.blockedUntil = now + FLOOD_BLOCK_MS;
        decision = this.#blockedDecision(state, "Repeated-message flooding detected.", state.blockedUntil, isCommand, now);
        this.#logBlock(message, "duplicate_flood");
      }
    }

    if (isCommand && decision.allowCommand) {
      if (state.commandBlockedUntil > now) {
        decision = this.#blockedDecision(state, "Command spam detected.", state.commandBlockedUntil, true, now);
      } else if (message.content.length > MAX_COMMAND_LENGTH
        || message.content.includes("\n")
        || /@(?:everyone|here)/i.test(message.content)
        || message.mentions.users.size > MAX_COMMAND_MENTIONS) {
        decision = {
          allowActivity: false,
          allowCommand: false,
          notify: this.#shouldNotify(state, now),
          reason: "That command is too large or contains too many mentions.",
        };
        this.#logBlock(message, "unsafe_command_shape");
      } else {
        state.commands.push(now);
        if (state.commands.length > COMMAND_LIMIT) {
          state.commandBlockedUntil = now + COMMAND_BLOCK_MS;
          decision = this.#blockedDecision(state, "Command spam detected.", state.commandBlockedUntil, true, now);
          this.#logBlock(message, "command_spam");
        }
      }
    }

    this.#decisions.set(message.id, { at: now, value: decision });
    this.#cleanup(now);
    return decision;
  }

  public stop(): void {
    this.#states.clear();
    this.#decisions.clear();
  }

  #blockedDecision(state: UserState, reason: string, retryAt: number, command: boolean, now: number): GuardDecision {
    return {
      allowActivity: false,
      allowCommand: !command,
      notify: command && this.#shouldNotify(state, now),
      reason,
      retryAt,
    };
  }

  #shouldNotify(state: UserState, now: number): boolean {
    if (now - state.lastNoticeAt < 5_000) return false;
    state.lastNoticeAt = now;
    return true;
  }

  #pruneState(state: UserState, now: number): void {
    state.messages = state.messages.filter((at) => now - at <= FLOOD_WINDOW_MS);
    state.commands = state.commands.filter((at) => now - at <= COMMAND_WINDOW_MS);
    state.recentContent = state.recentContent.filter((entry) => now - entry.at <= DUPLICATE_WINDOW_MS);
  }

  #cleanup(now: number): void {
    this.#observations += 1;
    if (this.#observations % 250 !== 0) return;
    for (const [id, cached] of this.#decisions) {
      if (now - cached.at > 60_000) this.#decisions.delete(id);
    }
    for (const [key, state] of this.#states) {
      if (now - state.lastSeenAt > 10 * 60_000) this.#states.delete(key);
    }
  }

  #logBlock(message: Message, reason: string): void {
    logger.warn("Message guard blocked activity", {
      reason,
      userId: message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
    });
  }
}

function normalizeContent(content: string): string {
  return content.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ").slice(0, 500);
}
