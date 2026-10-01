import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { config } from "../config.js";
import type { ActivityName, ClaimResult } from "../types.js";

const claimRowSchema = z.object({
  claimed: z.boolean(),
  reward: z.coerce.number().int().positive().safe(),
  balance: z.coerce.number().int().nonnegative().safe(),
  next_claim_at: z.iso.datetime({ offset: true }),
});

const leaderboardRowSchema = z.object({
  user_id: z.string(),
  balance: z.coerce.number().int().nonnegative().safe(),
  rank: z.coerce.number().int().positive().safe(),
  is_target: z.boolean(),
});

const activationSchema = z.object({
  accepted: z.boolean(),
  reason: z.string(),
  wager: z.coerce.number().int().nonnegative().safe(),
});


const economyAdminResultSchema = z.object({
  action: z.enum(["add", "remove", "set", "freeze", "unfreeze"]),
  amount: z.coerce.number().int().nonnegative().nullable(),
  balance_before: z.coerce.number().int().nonnegative().safe(),
  balance_after: z.coerce.number().int().nonnegative().safe(),
  frozen: z.boolean(),
});

export interface EconomyAdminResult {
  action: "add" | "remove" | "set" | "freeze" | "unfreeze";
  amount: number | null;
  balanceBefore: number;
  balanceAfter: number;
  frozen: boolean;
}

export interface EconomyAuditEntry {
  action: "add" | "remove" | "set" | "freeze" | "unfreeze";
  amount: number | null;
  balanceBefore: number;
  balanceAfter: number;
  actorId: string;
  targetId: string;
  createdAt: Date;
}

export interface LeaderboardEntry {
  userId: string;
  balance: number;
  rank: number;
  isTarget: boolean;
}

export interface GameActivation {
  accepted: boolean;
  reason: string;
  wager: number;
}

export interface TransferResult {
  transferred: boolean;
  senderBalance: number;
  recipientBalance: number;
  sentToday: number;
  failureReason: string | null;
}

export interface MessageLeaderboardEntry {
  userId: string;
  messageCount: number;
  rank: number;
  isTarget: boolean;
}

export interface BlackjackGame {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  userId: string;
  state: Record<string, unknown>;
  status: "active" | "settled";
  version: number;
  expiresAt: string;
}

export class EconomyService {
  readonly #supabase: SupabaseClient;

  public constructor() {
    this.#supabase = createClient(config.DB_URL, config.DB_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Client-Info": "assure/1.0" } },
    });
  }

  public async claim(userId: string, command: ActivityName, guildId: string | null): Promise<ClaimResult> {
    const { data, error } = await this.#supabase.rpc("claim_economy_reward", {
      p_user_id: userId,
      p_command: command,
      p_guild_id: guildId,
    });

    if (error) {
      throw new Error(`Supabase claim failed (${error.code}): ${error.message}`, {
        cause: error,
      });
    }

    const row = claimRowSchema.parse(Array.isArray(data) ? data[0] : data);
    return {
      claimed: row.claimed,
      reward: row.reward,
      balance: row.balance,
      nextClaimAt: new Date(row.next_claim_at),
    };
  }

  public async balance(userId: string, guildId: string | null): Promise<number> {
    const { data, error } = await this.#supabase.rpc("get_economy_balance", {
      p_user_id: userId,
      p_guild_id: guildId,
    });
    if (error) throw this.#databaseError("balance", error);
    return z.coerce.number().int().nonnegative().safe().parse(data);
  }

  public async leaderboard(guildId: string, userId: string): Promise<LeaderboardEntry[]> {
    const { data, error } = await this.#supabase.rpc("get_economy_leaderboard", {
      p_guild_id: guildId,
      p_target_user_id: userId,
      p_limit: 10,
    });
    if (error) throw this.#databaseError("leaderboard", error);
    return z.array(leaderboardRowSchema).parse(data).map((row) => ({
      userId: row.user_id,
      balance: row.balance,
      rank: row.rank,
      isTarget: row.is_target,
    }));
  }

  public async createGame(input: {
    guildId: string;
    channelId: string;
    type: "c4" | "ttt";
    challengerId: string;
    opponentId: string;
    wager: number;
  }): Promise<string> {
    const { data, error } = await this.#supabase.rpc("create_economy_game", {
      p_guild_id: input.guildId,
      p_channel_id: input.channelId,
      p_game_type: input.type,
      p_challenger_id: input.challengerId,
      p_opponent_id: input.opponentId,
      p_wager: input.wager,
    });
    if (error) throw this.#databaseError("create game", error);
    return z.uuid().parse(data);
  }

  public async setGameMessage(gameId: string, messageId: string): Promise<void> {
    const { error } = await this.#supabase.rpc("set_economy_game_message", {
      p_game_id: gameId,
      p_message_id: messageId,
    });
    if (error) throw this.#databaseError("set game message", error);
  }

  public async activateGame(gameId: string, opponentId: string): Promise<GameActivation> {
    const { data, error } = await this.#supabase.rpc("activate_economy_game", {
      p_game_id: gameId,
      p_opponent_id: opponentId,
    });
    if (error) throw this.#databaseError("activate game", error);
    const row = activationSchema.parse(Array.isArray(data) ? data[0] : data);
    return row;
  }

  public async settleGame(gameId: string, winnerId: string | null): Promise<boolean> {
    const { data, error } = await this.#supabase.rpc("settle_economy_game", {
      p_game_id: gameId,
      p_winner_id: winnerId,
    });
    if (error) throw this.#databaseError("settle game", error);
    return z.boolean().parse(data);
  }

  public async cancelGame(gameId: string, actorId: string): Promise<boolean> {
    const { data, error } = await this.#supabase.rpc("cancel_economy_game", {
      p_game_id: gameId,
      p_actor_id: actorId,
    });
    if (error) throw this.#databaseError("cancel game", error);
    return z.boolean().parse(data);
  }

  public async refundExpiredGames(): Promise<number> {
    const { data, error } = await this.#supabase.rpc("refund_expired_economy_games");
    if (error) throw this.#databaseError("refund expired games", error);
    return z.coerce.number().int().nonnegative().parse(data);
  }


  public async manageAccount(
    actorId: string,
    targetId: string,
    action: "add" | "remove" | "set" | "freeze",
    amount: number | null,
  ): Promise<EconomyAdminResult> {
    const { data, error } = await this.#supabase.rpc("manage_economy_account", {
      p_actor_id: actorId, p_target_id: targetId, p_action: action, p_amount: amount,
    });
    if (error) throw this.#databaseError("manage economy account", error);
    const row = economyAdminResultSchema.parse(Array.isArray(data) ? data[0] : data);
    return {
      action: row.action, amount: row.amount, balanceBefore: row.balance_before,
      balanceAfter: row.balance_after, frozen: row.frozen,
    };
  }

  public async economyAudit(targetId: string): Promise<EconomyAuditEntry[]> {
    const { data, error } = await this.#supabase.from("economy_admin_audit").select("*")
      .eq("target_id", targetId).order("created_at", { ascending: false }).limit(10);
    if (error) throw this.#databaseError("get economy audit", error);
    const schema = z.array(z.object({
      action: z.enum(["add", "remove", "set", "freeze", "unfreeze"]),
      amount: z.coerce.number().int().nonnegative().nullable(),
      balance_before: z.coerce.number().int().nonnegative().safe(),
      balance_after: z.coerce.number().int().nonnegative().safe(),
      actor_id: z.string(), target_id: z.string(), created_at: z.string(),
    }));
    return schema.parse(data ?? []).map((row) => ({
      action: row.action, amount: row.amount, balanceBefore: row.balance_before,
      balanceAfter: row.balance_after,
      actorId: row.actor_id, targetId: row.target_id, createdAt: new Date(row.created_at),
    }));
  }


  public async give(guildId: string, senderId: string, recipientId: string, amount: number): Promise<TransferResult> {
    const { data, error } = await this.#supabase.rpc("give_assurite", {
      p_guild_id: guildId, p_sender_id: senderId, p_recipient_id: recipientId, p_amount: amount,
    });
    if (error) throw this.#databaseError("transfer", error);
    const row = z.object({
      transferred: z.boolean(), sender_balance: z.coerce.number(), recipient_balance: z.coerce.number(),
      sent_today: z.coerce.number(), failure_reason: z.string().nullable(),
    }).parse(Array.isArray(data) ? data[0] : data);
    return { transferred: row.transferred, senderBalance: row.sender_balance,
      recipientBalance: row.recipient_balance, sentToday: row.sent_today, failureReason: row.failure_reason };
  }

  public async awardEvent(input: { eventId: string; guildId: string; userId: string; source: string; amount: number }): Promise<{ awarded: boolean; balance: number }> {
    const { data, error } = await this.#supabase.rpc("award_economy_event", {
      p_event_id: input.eventId, p_guild_id: input.guildId, p_user_id: input.userId,
      p_source: input.source, p_amount: input.amount,
    });
    if (error) throw this.#databaseError("reward event", error);
    const row = z.object({ awarded: z.boolean(), balance: z.coerce.number() })
      .parse(Array.isArray(data) ? data[0] : data);
    return row;
  }

  public async recordMessageBatch(entries: Array<{ guild_id: string; user_id: string; count: number }>): Promise<void> {
    if (entries.length === 0) return;
    const { error } = await this.#supabase.rpc("record_message_activity_batch", { p_entries: entries });
    if (error) throw this.#databaseError("message activity", error);
  }

  public async messageLeaderboard(guildId: string, weekStart: string, userId: string): Promise<MessageLeaderboardEntry[]> {
    const { data, error } = await this.#supabase.rpc("get_message_leaderboard", {
      p_guild_id: guildId, p_week_start: weekStart, p_target_user_id: userId, p_limit: 10,
    });
    if (error) throw this.#databaseError("message leaderboard", error);
    return z.array(z.object({ user_id: z.string(), message_count: z.coerce.number(), rank: z.coerce.number(), is_target: z.boolean() }))
      .parse(data).map((row) => ({ userId: row.user_id, messageCount: row.message_count, rank: row.rank, isTarget: row.is_target }));
  }

  public async settleCasinoRound(input: { id: string; guildId: string; userId: string; game: string; bet: number; payout: number; result: Record<string, unknown> }): Promise<{ settled: boolean; balance: number; failureReason: string | null }> {
    const { data, error } = await this.#supabase.rpc("settle_casino_round", {
      p_round_id: input.id, p_guild_id: input.guildId, p_user_id: input.userId, p_game: input.game,
      p_bet: input.bet, p_payout: input.payout, p_result: input.result,
    });
    if (error) throw this.#databaseError("casino round", error);
    const row = z.object({ settled: z.boolean(), balance: z.coerce.number(), failure_reason: z.string().nullable() })
      .parse(Array.isArray(data) ? data[0] : data);
    return { settled: row.settled, balance: row.balance, failureReason: row.failure_reason };
  }

  public async drawBlackjackCards(guildId: string, count: number): Promise<string[]> {
    const { data, error } = await this.#supabase.rpc("draw_blackjack_cards", { p_guild_id: guildId, p_count: count });
    if (error) throw this.#databaseError("draw blackjack cards", error);
    return z.array(z.string()).parse(data);
  }

  public async startBlackjack(input: { id: string; guildId: string; channelId: string; userId: string; bet: number; state: Record<string, unknown> }) {
    const { data, error } = await this.#supabase.rpc("start_blackjack_game", {
      p_game_id: input.id, p_guild_id: input.guildId, p_channel_id: input.channelId,
      p_user_id: input.userId, p_bet: input.bet, p_state: input.state,
    });
    if (error) throw this.#databaseError("start blackjack", error);
    return this.#blackjackMutation(data, "started");
  }

  public async updateBlackjack(input: { id: string; userId: string; version: number; state: Record<string, unknown>; additionalBet: number }) {
    const { data, error } = await this.#supabase.rpc("update_blackjack_game", {
      p_game_id: input.id, p_user_id: input.userId, p_expected_version: input.version,
      p_state: input.state, p_additional_bet: input.additionalBet,
    });
    if (error) throw this.#databaseError("update blackjack", error);
    return this.#blackjackMutation(data, "updated");
  }

  public async settleBlackjack(input: { id: string; userId: string; version: number; state: Record<string, unknown>; additionalBet: number; payout: number }) {
    const { data, error } = await this.#supabase.rpc("settle_blackjack_game", {
      p_game_id: input.id, p_user_id: input.userId, p_expected_version: input.version,
      p_state: input.state, p_additional_bet: input.additionalBet, p_payout: input.payout,
    });
    if (error) throw this.#databaseError("settle blackjack", error);
    return this.#blackjackMutation(data, "settled");
  }

  public async setBlackjackMessage(id: string, messageId: string): Promise<void> {
    const { error } = await this.#supabase.from("blackjack_games").update({ message_id: messageId }).eq("id", id);
    if (error) throw this.#databaseError("set blackjack message", error);
  }

  public async getBlackjack(id: string): Promise<BlackjackGame | null> {
    const { data, error } = await this.#supabase.from("blackjack_games").select("*").eq("id", id).maybeSingle();
    if (error) throw this.#databaseError("get blackjack", error);
    return data ? this.#parseBlackjack(data) : null;
  }

  public async expiredBlackjack(): Promise<BlackjackGame[]> {
    const { data, error } = await this.#supabase.from("blackjack_games").select("*")
      .eq("status", "active").lte("expires_at", new Date().toISOString()).limit(100);
    if (error) throw this.#databaseError("expired blackjack", error);
    return (data ?? []).map((row) => this.#parseBlackjack(row));
  }

  public async expireBlackjack(id: string): Promise<boolean> {
    const { data, error } = await this.#supabase.rpc("expire_blackjack_game", { p_game_id: id });
    if (error) throw this.#databaseError("expire blackjack", error);
    return z.boolean().parse(data);
  }

  #blackjackMutation(data: unknown, successKey: "started" | "updated" | "settled") {
    const row = z.record(z.string(), z.unknown()).parse(Array.isArray(data) ? data[0] : data);
    return {
      success: z.boolean().parse(row[successKey]),
      balance: z.coerce.number().parse(row.balance ?? 0),
      version: row.version == null ? 0 : z.coerce.number().parse(row.version),
      failureReason: row.failure_reason == null ? null : z.string().parse(row.failure_reason),
    };
  }


  #parseBlackjack(row: Record<string, unknown>): BlackjackGame {
    return {
      id: z.string().parse(row.id), guildId: z.string().parse(row.guild_id), channelId: z.string().parse(row.channel_id),
      messageId: row.message_id == null ? null : z.string().parse(row.message_id), userId: z.string().parse(row.user_id),
      state: z.record(z.string(), z.unknown()).parse(row.state), status: z.enum(["active", "settled"]).parse(row.status),
      version: z.coerce.number().parse(row.version), expiresAt: z.string().parse(row.expires_at),
    };
  }

  #databaseError(operation: string, error: { code: string; message: string }): Error {
    return new Error(`Supabase ${operation} failed (${error.code}): ${error.message}`, {
      cause: error,
    });
  }
}
