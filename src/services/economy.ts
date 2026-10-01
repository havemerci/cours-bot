import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { config } from "../config.js";
import type {
  MafiaGame,
  MafiaDetectiveClue,
  MafiaHistoryEntry,
  MafiaLeaderboardEntry,
  MafiaMutation,
  MafiaPlayer,
  MafiaRole,
  MafiaRolePreset,
  MafiaSnapshot,
  MafiaSpeakPermissionState,
  MafiaStats,
  MafiaRecapEvent,
} from "../games/mafia/types.js";
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

const mafiaMutationSchema = z.object({
  accepted: z.boolean(),
  reason: z.string(),
  version: z.coerce.number().int().nonnegative(),
});

const mafiaGameRowSchema = z.object({
  id: z.uuid(), guild_id: z.string(), channel_id: z.string(), message_id: z.string().nullable(),
  host_id: z.string(), status: z.enum(["lobby", "active", "completed", "cancelled"]),
  phase: z.enum(["lobby", "night", "discussion", "voting", "completed"]),
  day: z.coerce.number().int().nonnegative(), version: z.coerce.number().int().nonnegative(),
  winner: z.enum(["town", "mafia"]).nullable(),
  last_event: z.record(z.string(), z.unknown()), phase_ends_at: z.string().nullable(),
  night_seconds: z.coerce.number().int().default(60),
  discussion_seconds: z.coerce.number().int().default(120),
  voting_seconds: z.coerce.number().int().default(60),
  reveal_roles: z.boolean().default(true),
  doctor_self_protect: z.boolean().default(true),
  revives_enabled: z.boolean().default(true),
  anonymous_voting: z.boolean().default(true),
  role_preset: z.enum(["balanced", "classic", "vanilla"]).default("balanced"),
  started_at: z.string().nullable().optional().default(null),
  completed_at: z.string().nullable().optional().default(null),
});

const mafiaSpeakPermissionSchema = z.preprocess((value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return ["allow", "deny", "inherit"].includes(normalized) ? normalized : null;
}, z.enum(["allow", "deny", "inherit"]).nullable());

const mafiaPlayerRowSchema = z.object({
  game_id: z.uuid(), user_id: z.string(), role: z.enum(["mafia", "detective", "doctor", "villager"]).nullable(),
  alive: z.boolean(), night_target_id: z.string().nullable(), vote_target_id: z.string().nullable(),
  last_investigated_id: z.string().nullable(),
  speak_permission_state: mafiaSpeakPermissionSchema.optional().default(null),
  ready: z.boolean().default(false),
  missed_turns: z.coerce.number().int().nonnegative().default(0),
  acted_this_phase: z.boolean().default(false),
  voted_this_phase: z.boolean().default(false),
  joined_at: z.string(),
});

const mafiaLeaderboardRowSchema = z.object({
  user_id: z.string(),
  wins: z.coerce.number().int().nonnegative().safe(),
  rank: z.coerce.number().int().positive().safe(),
  is_target: z.boolean(),
});

const mafiaStatsRowSchema = z.object({
  user_id: z.string(), wins: z.coerce.number().int().nonnegative(), games_played: z.coerce.number().int().nonnegative(),
  town_wins: z.coerce.number().int().nonnegative(), mafia_wins: z.coerce.number().int().nonnegative(),
  investigations: z.coerce.number().int().nonnegative(), successful_investigations: z.coerce.number().int().nonnegative(),
  successful_protections: z.coerce.number().int().nonnegative(), revives: z.coerce.number().int().nonnegative(),
  survivals: z.coerce.number().int().nonnegative(), current_win_streak: z.coerce.number().int().nonnegative(),
  longest_win_streak: z.coerce.number().int().nonnegative(),
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

  public async createMafiaLobby(guildId: string, channelId: string, hostId: string): Promise<string> {
    const { data, error } = await this.#supabase.rpc("create_mafia_lobby", {
      p_guild_id: guildId, p_channel_id: channelId, p_host_id: hostId,
    });
    if (error) throw this.#databaseError("create Mafia lobby", error);
    return z.uuid().parse(data);
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

  public async setMafiaMessage(gameId: string, messageId: string): Promise<void> {
    const { error } = await this.#supabase.rpc("set_mafia_message", {
      p_game_id: gameId, p_message_id: messageId,
    });
    if (error) throw this.#databaseError("set Mafia message", error);
  }

  public async mafiaSnapshot(gameId: string): Promise<MafiaSnapshot | null> {
    const { data: gameData, error: gameError } = await this.#supabase.from("mafia_games")
      .select("*").eq("id", gameId).maybeSingle();
    if (gameError) throw this.#databaseError("get Mafia game", gameError);
    if (!gameData) return null;
    const { data: playerData, error: playerError } = await this.#supabase.from("mafia_players")
      .select("*").eq("game_id", gameId).order("joined_at", { ascending: true });
    if (playerError) throw this.#databaseError("get Mafia players", playerError);
    return {
      game: this.#parseMafiaGame(gameData),
      players: z.array(mafiaPlayerRowSchema).parse(playerData ?? []).map((row) => this.#parseMafiaPlayer(row)),
    };
  }

  public async openMafiaGames(): Promise<MafiaGame[]> {
    const { data, error } = await this.#supabase.from("mafia_games").select("*")
      .in("status", ["lobby", "active"]);
    if (error) throw this.#databaseError("get open Mafia games", error);
    return z.array(mafiaGameRowSchema).parse(data ?? []).map((row) => this.#parseMafiaGame(row));
  }

  public async mafiaPermissionRecoveryGameIds(): Promise<string[]> {
    const { data, error } = await this.#supabase.from("mafia_players")
      .select("game_id").not("speak_permission_state", "is", null);
    if (error) {
      const migrationMissing = error.message.includes("speak_permission_state")
        && ["42703", "PGRST204"].includes(error.code ?? "");
      if (migrationMissing) return [];
      throw this.#databaseError("get Mafia permission recovery games", error);
    }
    return [...new Set(z.array(z.object({ game_id: z.uuid() })).parse(data ?? []).map((row) => row.game_id))];
  }

  public async mafiaLeaderboard(guildId: string, userId: string): Promise<MafiaLeaderboardEntry[]> {
    const { data, error } = await this.#supabase.rpc("get_mafia_leaderboard", {
      p_guild_id: guildId, p_user_id: userId, p_limit: 10,
    });
    if (error) throw this.#databaseError("get Mafia leaderboard", error);
    return z.array(mafiaLeaderboardRowSchema).parse(data ?? []).map((row) => ({
      userId: row.user_id,
      wins: row.wins,
      rank: row.rank,
      isTarget: row.is_target,
    }));
  }

  public async mafiaStats(guildId: string, userId: string): Promise<MafiaStats> {
    const [{ data, error }, achievements] = await Promise.all([
      this.#supabase.rpc("get_mafia_stats", { p_guild_id: guildId, p_user_id: userId }),
      this.#supabase.from("mafia_achievements").select("achievement")
        .eq("guild_id", guildId).eq("user_id", userId).order("earned_at", { ascending: true }),
    ]);
    if (error) throw this.#databaseError("get Mafia stats", error);
    if (achievements.error) throw this.#databaseError("get Mafia achievements", achievements.error);
    const row = z.array(mafiaStatsRowSchema).parse(data ?? [])[0];
    const earned = z.array(z.object({ achievement: z.string() })).parse(achievements.data ?? []).map((item) => item.achievement);
    return row ? {
      userId: row.user_id, wins: row.wins, gamesPlayed: row.games_played,
      townWins: row.town_wins, mafiaWins: row.mafia_wins, investigations: row.investigations,
      successfulInvestigations: row.successful_investigations, successfulProtections: row.successful_protections,
      revives: row.revives, survivals: row.survivals, currentWinStreak: row.current_win_streak,
      longestWinStreak: row.longest_win_streak, achievements: earned,
    } : {
      userId, wins: 0, gamesPlayed: 0, townWins: 0, mafiaWins: 0, investigations: 0,
      successfulInvestigations: 0, successfulProtections: 0, revives: 0, survivals: 0,
      currentWinStreak: 0, longestWinStreak: 0, achievements: earned,
    };
  }

  public async mafiaHistory(guildId: string): Promise<MafiaHistoryEntry[]> {
    const { data, error } = await this.#supabase.from("mafia_games")
      .select("id,winner,started_at,completed_at,mafia_players(count)")
      .eq("guild_id", guildId).eq("status", "completed").not("winner", "is", null)
      .order("completed_at", { ascending: false }).limit(5);
    if (error) throw this.#databaseError("get Mafia history", error);
    const schema = z.array(z.object({
      id: z.uuid(), winner: z.enum(["town", "mafia"]), started_at: z.string().nullable(),
      completed_at: z.string().nullable(), mafia_players: z.array(z.object({ count: z.coerce.number().int() })),
    }));
    return schema.parse(data ?? []).map((row) => ({
      id: row.id, winner: row.winner, players: row.mafia_players[0]?.count ?? 0,
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    }));
  }

  public async mafiaRecap(gameId: string): Promise<MafiaRecapEvent[]> {
    const [events, actions, players] = await Promise.all([
      this.#supabase.from("mafia_events").select("day,phase,event")
        .eq("game_id", gameId).order("version", { ascending: true }),
      this.#supabase.from("mafia_action_log").select("day,phase,actor_id,action,target_id,updated_at")
        .eq("game_id", gameId).order("updated_at", { ascending: true }),
      this.#supabase.from("mafia_players").select("user_id,role").eq("game_id", gameId),
    ]);
    if (events.error) throw this.#databaseError("get Mafia recap", events.error);
    if (actions.error) throw this.#databaseError("get Mafia actions", actions.error);
    if (players.error) throw this.#databaseError("get Mafia recap roles", players.error);
    const outcomes = z.array(z.object({
      day: z.coerce.number().int(), phase: z.string(), event: z.record(z.string(), z.unknown()),
    })).parse(events.data ?? []);
    const choices = z.array(z.object({
      day: z.coerce.number().int(), phase: z.string(), actor_id: z.string(), action: z.string(), target_id: z.string(),
      updated_at: z.string(),
    })).parse(actions.data ?? []).map((row) => ({
      day: row.day, phase: row.phase,
      event: { type: "action", actor_id: row.actor_id, action: row.action, target_id: row.target_id, at: row.updated_at },
    }));
    const roles = z.array(z.object({ user_id: z.string(), role: z.string().nullable() })).parse(players.data ?? [])
      .map((row) => ({ day: 0, phase: "roles", event: { type: "role", user_id: row.user_id, role: row.role } }));
    return [...roles, ...choices, ...outcomes].sort((a, b) => a.day - b.day
      || (a.phase === "night" ? 0 : 1) - (b.phase === "night" ? 0 : 1)
      || (a.event.type === "action" ? 0 : 1) - (b.event.type === "action" ? 0 : 1));
  }

  public async mafiaDetectiveClues(gameId: string, detectiveId: string): Promise<MafiaDetectiveClue[]> {
    const { data, error } = await this.#supabase.from("mafia_detective_clues")
      .select("day,clue").eq("game_id", gameId).eq("detective_id", detectiveId)
      .order("day", { ascending: true });
    if (error) throw this.#databaseError("get Detective clue notebook", error);
    return z.array(z.object({ day: z.coerce.number().int().positive(), clue: z.string() })).parse(data ?? []);
  }

  public async joinMafia(gameId: string, userId: string): Promise<MafiaMutation> {
    return this.#mafiaMutation("join Mafia game", "join_mafia_game", { p_game_id: gameId, p_user_id: userId });
  }

  public async toggleMafiaReady(gameId: string, userId: string): Promise<MafiaMutation> {
    return this.#mafiaMutation("toggle Mafia ready state", "toggle_mafia_ready", {
      p_game_id: gameId, p_user_id: userId,
    });
  }

  public async updateMafiaSetting(
    gameId: string,
    hostId: string,
    key: string,
    value: string | number | boolean | MafiaRolePreset,
  ): Promise<MafiaMutation> {
    return this.#mafiaMutation("update Mafia setting", "update_mafia_setting", {
      p_game_id: gameId, p_host_id: hostId, p_key: key, p_value: String(value),
    });
  }

  public async leaveMafia(gameId: string, userId: string): Promise<MafiaMutation> {
    return this.#mafiaMutation("leave Mafia game", "leave_mafia_game", { p_game_id: gameId, p_user_id: userId });
  }

  public async cancelMafia(gameId: string, userId: string): Promise<MafiaMutation> {
    return this.#mafiaMutation("cancel Mafia game", "cancel_mafia_game", { p_game_id: gameId, p_user_id: userId });
  }

  public async startMafia(
    gameId: string,
    hostId: string,
    assignments: Array<{ userId: string; role: MafiaRole }>,
  ): Promise<MafiaMutation> {
    return this.#mafiaMutation("start Mafia game", "start_mafia_game", {
      p_game_id: gameId,
      p_host_id: hostId,
      p_assignments: assignments.map((entry) => ({ user_id: entry.userId, role: entry.role })),
    });
  }

  public async submitMafiaNightAction(
    gameId: string, userId: string, targetId: string, version: number,
  ): Promise<MafiaMutation> {
    return this.#mafiaMutation("submit Mafia night action", "submit_mafia_night_action", {
      p_game_id: gameId, p_user_id: userId, p_target_id: targetId, p_expected_version: version,
    });
  }

  public async submitMafiaVote(
    gameId: string, userId: string, targetId: string, version: number,
  ): Promise<MafiaMutation> {
    return this.#mafiaMutation("submit Mafia vote", "submit_mafia_vote", {
      p_game_id: gameId, p_user_id: userId, p_target_id: targetId, p_expected_version: version,
    });
  }

  public async advanceMafia(gameId: string, version: number): Promise<MafiaMutation> {
    return this.#mafiaMutation("advance Mafia game", "advance_mafia_game", {
      p_game_id: gameId, p_expected_version: version,
    });
  }

  public async setMafiaSpeakPermissionState(
    gameId: string,
    userId: string,
    state: MafiaSpeakPermissionState | null,
  ): Promise<void> {
    const { error } = await this.#supabase.rpc("set_mafia_speak_permission_state", {
      p_game_id: gameId, p_user_id: userId, p_state: state,
    });
    if (error) throw this.#databaseError("set Mafia speaking permission state", error);
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

  async #mafiaMutation(
    operation: string,
    functionName: string,
    parameters: Record<string, unknown>,
  ): Promise<MafiaMutation> {
    const { data, error } = await this.#supabase.rpc(functionName, parameters);
    if (error) throw this.#databaseError(operation, error);
    return mafiaMutationSchema.parse(Array.isArray(data) ? data[0] : data);
  }

  #parseMafiaGame(input: unknown): MafiaGame {
    const row = mafiaGameRowSchema.parse(input);
    return {
      id: row.id, guildId: row.guild_id, channelId: row.channel_id, messageId: row.message_id,
      hostId: row.host_id, status: row.status, phase: row.phase, day: row.day, version: row.version,
      winner: row.winner, lastEvent: row.last_event,
      phaseEndsAt: row.phase_ends_at ? new Date(row.phase_ends_at) : null,
        nightSeconds: row.night_seconds, discussionSeconds: row.discussion_seconds,
        votingSeconds: row.voting_seconds, revealRoles: row.reveal_roles,
        doctorSelfProtect: row.doctor_self_protect, revivesEnabled: row.revives_enabled,
        anonymousVoting: row.anonymous_voting, rolePreset: row.role_preset,
        startedAt: row.started_at ? new Date(row.started_at) : null,
        completedAt: row.completed_at ? new Date(row.completed_at) : null,
    };
  }

  #parseMafiaPlayer(row: z.infer<typeof mafiaPlayerRowSchema>): MafiaPlayer {
    return {
      gameId: row.game_id, userId: row.user_id, role: row.role, alive: row.alive,
      nightTargetId: row.night_target_id, voteTargetId: row.vote_target_id,
      lastInvestigatedId: row.last_investigated_id,
        speakPermissionState: row.speak_permission_state,
        ready: row.ready, missedTurns: row.missed_turns,
        actedThisPhase: row.acted_this_phase, votedThisPhase: row.voted_this_phase,
      joinedAt: new Date(row.joined_at),
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
