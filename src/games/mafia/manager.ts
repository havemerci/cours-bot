import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type Message,
  type StringSelectMenuInteraction,
} from "discord.js";
import { logger } from "../../logger.js";
import { EconomyService } from "../../services/economy.js";
import { assignRoles } from "./logic.js";
import type { MafiaSnapshot } from "./types.js";
import {
  mafiaHistoryPayload,
  mafiaLeaderboardPayload,
  mafiaNoticePayload,
  mafiaPublicNoticePayload,
  mafiaPublicPayload,
  mafiaRecapPayload,
  mafiaRolePayload,
  mafiaSettingsPayload,
  mafiaTargetPayload,
  mafiaStatsPayload,
} from "./ui.js";

const MAX_RECOVERY_ADVANCES = 8;

export class MafiaManager {
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #busy = new Set<string>();
  readonly #messageToGame = new Map<string, string>();
  #stopped = false;

  public constructor(readonly client: Client, readonly economy: EconomyService) {
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton() && interaction.customId.startsWith("mafia:")) {
        void this.#button(interaction).catch((error) => this.#interactionError(interaction, error));
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("mafia:")) {
        void this.#select(interaction).catch((error) => this.#interactionError(interaction, error));
      }
    });
    client.on(Events.MessageDelete, (message) => {
      const gameId = this.#messageToGame.get(message.id);
      if (!gameId) return;
      this.#messageToGame.delete(message.id);
      void this.#restorePublicMessage(gameId, message.channelId).catch((error) => {
        logger.error("Could not restore Mafia message", { gameId, message: String(error) });
      });
    });
  }

  public async start(): Promise<void> {
    this.#stopped = false;
    const games = await this.economy.openMafiaGames();
    const openIds = new Set(games.map((game) => game.id));
    for (const game of games) {
      if (game.messageId) this.#messageToGame.set(game.messageId, game.id);
      await this.#advanceUntilFuture(game.id);
    }
    const recoveryIds = await this.economy.mafiaPermissionRecoveryGameIds();
    for (const gameId of recoveryIds) {
      if (openIds.has(gameId)) continue;
      const snapshot = await this.economy.mafiaSnapshot(gameId);
      if (snapshot) await this.#syncSpeakingPermissions(snapshot);
    }
  }

  public stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#busy.clear();
    this.#messageToGame.clear();
  }

  public async handle(message: Message, prefix: string): Promise<boolean> {
    if (!message.content.startsWith(prefix)) return false;
    const body = message.content.slice(prefix.length).trim().toLowerCase();
    const leaderboard = body === "mafialb" || body === "mafia lb" || body === "mafia leaderboard";
    const history = body === "mafia history" || body === "mafiahistory";
    const stats = /^(?:mafiastats|mafia stats)(?:\s|$)/.test(body);
    if (body !== "mafia" && !leaderboard && !history && !stats) return false;
    if (!message.guildId) {
      await message.reply(mafiaPublicNoticePayload("Mafia", body === "mafia"
        ? "Start Mafia inside a channel."
        : "Mafia records are only available inside a server."));
      return true;
    }
    if (leaderboard) {
      const entries = await this.economy.mafiaLeaderboard(message.guildId, message.author.id);
      await message.reply(mafiaLeaderboardPayload(entries));
      return true;
    }
    if (history) {
      await message.reply(mafiaHistoryPayload(await this.economy.mafiaHistory(message.guildId)));
      return true;
    }
    if (stats) {
      const target = message.mentions.users.first();
      if (target?.bot) {
        await message.reply(mafiaPublicNoticePayload("Mafia stats", "Choose a human member."));
        return true;
      }
      await message.reply(mafiaStatsPayload(
        await this.economy.mafiaStats(message.guildId, target?.id ?? message.author.id),
      ));
      return true;
    }
    try {
      const gameId = await this.economy.createMafiaLobby(message.guildId, message.channelId, message.author.id);
      const snapshot = await this.#requiredSnapshot(gameId);
      const publicMessage = await message.reply(mafiaPublicPayload(snapshot));
      await this.economy.setMafiaMessage(gameId, publicMessage.id);
      this.#messageToGame.set(publicMessage.id, gameId);
      this.#schedule(snapshot);
    } catch (error) {
      const text = error instanceof Error && error.message.includes("already open")
        ? "A Mafia lobby or game is already active in this channel."
        : error instanceof Error && error.message.includes("already participating")
          ? "You are already in another open Mafia game in this server."
          : "The Mafia lobby could not be created. Try again in a moment.";
      await message.reply(mafiaPublicNoticePayload("Mafia", text));
      logger.error("Could not create Mafia lobby", { channelId: message.channelId, message: String(error) });
    }
    return true;
  }

  async #button(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const [, action, gameId] = parts;
    if (!action || !gameId) return;
    if (action === "setting") {
      await this.#settingButton(interaction, parts);
      return;
    }
    if (action === "settings") {
      const snapshot = await this.#requiredSnapshot(gameId);
      if (snapshot.game.hostId !== interaction.user.id) {
        await interaction.reply(mafiaNoticePayload("Host only", "Only the host can change lobby settings."));
        return;
      }
      await interaction.reply(mafiaSettingsPayload(snapshot));
      return;
    }
    if (action === "rematch") {
      await this.#rematch(interaction, gameId);
      return;
    }
    if (action === "recap") {
      const snapshot = await this.#requiredSnapshot(gameId);
      if (snapshot.game.status !== "completed") {
        await interaction.reply(mafiaNoticePayload("Recap", "The full recap is available after the game ends."));
        return;
      }
      await interaction.reply(mafiaRecapPayload(await this.economy.mafiaRecap(gameId)));
      return;
    }
    if (["join", "leave", "ready", "start", "cancel"].includes(action)) {
      await this.#lobbyButton(interaction, gameId, action);
      return;
    }
    const snapshot = await this.#requiredSnapshot(gameId);
    const player = snapshot.players.find((entry) => entry.userId === interaction.user.id);
    if (!player) {
      await interaction.reply(mafiaNoticePayload("Not in this game", "Only players in this Mafia game can use these controls."));
      return;
    }
    if (action === "role") {
      const clues = player.role === "detective"
        ? await this.economy.mafiaDetectiveClues(gameId, player.userId)
        : [];
      await interaction.reply(mafiaRolePayload(snapshot, player, clues));
      return;
    }
    if (!player.alive) {
      await interaction.reply(mafiaNoticePayload("Eliminated", "Eliminated players cannot act or vote."));
      return;
    }
    if (action === "act") {
      if (snapshot.game.phase !== "night" || !player.role || player.role === "villager") {
        await interaction.reply(mafiaNoticePayload("No night action", "Your role has no action in the current phase."));
        return;
      }
      await interaction.reply(mafiaTargetPayload({
        snapshot, player, mode: "night", labels: await this.#playerLabels(snapshot),
      }));
      return;
    }
    if (action === "vote") {
      if (snapshot.game.phase !== "voting") {
        await interaction.reply(mafiaNoticePayload("Voting closed", "Voting is not active right now."));
        return;
      }
      await interaction.reply(mafiaTargetPayload({
        snapshot, player, mode: "vote", labels: await this.#playerLabels(snapshot),
      }));
    }
  }

  async #lobbyButton(
    interaction: ButtonInteraction,
    gameId: string,
    action: string,
  ): Promise<void> {
    if (this.#busy.has(gameId)) {
      await interaction.reply(mafiaNoticePayload("One moment", "Another lobby action is being processed."));
      return;
    }
    this.#busy.add(gameId);
    await interaction.deferUpdate();
    try {
      let changed = false;
      if (action === "join") {
        const member = interaction.guild?.members.cache.get(interaction.user.id)
          ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
        if (member?.user.bot) return;
        const result = await this.economy.joinMafia(gameId, interaction.user.id);
        changed = result.accepted && result.reason !== "already_joined";
        if (!result.accepted) await interaction.followUp(mafiaNoticePayload("Could not join", this.#mutationReason(result.reason)));
      } else if (action === "leave") {
        const result = await this.economy.leaveMafia(gameId, interaction.user.id);
        changed = result.accepted;
        if (!result.accepted) await interaction.followUp(mafiaNoticePayload("Could not leave", this.#mutationReason(result.reason)));
      } else if (action === "ready") {
        const result = await this.economy.toggleMafiaReady(gameId, interaction.user.id);
        changed = result.accepted;
        if (!result.accepted) await interaction.followUp(mafiaNoticePayload("Ready check", this.#mutationReason(result.reason)));
      } else if (action === "cancel") {
        const result = await this.economy.cancelMafia(gameId, interaction.user.id);
        changed = result.accepted;
        if (!result.accepted) await interaction.followUp(mafiaNoticePayload("Could not cancel", this.#mutationReason(result.reason)));
      } else if (action === "start") {
        const snapshot = await this.#requiredSnapshot(gameId);
        const result = await this.economy.startMafia(
          gameId,
          interaction.user.id,
          assignRoles(snapshot.players.map((player) => player.userId), snapshot.game.rolePreset),
        );
        changed = result.accepted;
        if (!result.accepted) await interaction.followUp(mafiaNoticePayload("Could not start", this.#mutationReason(result.reason)));
      }
      if (!changed) return;
      const snapshot = await this.#requiredSnapshot(gameId);
      await this.#publishSnapshot(snapshot);
      this.#schedule(snapshot);
    } finally {
      this.#busy.delete(gameId);
    }
  }

  async #select(interaction: StringSelectMenuInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const [, mode, gameId, versionText] = parts;
    if (mode === "setting") {
      await this.#settingSelect(interaction, parts);
      return;
    }
    const targetId = interaction.values[0];
    const version = Number(versionText);
    if (!gameId || !targetId || !Number.isInteger(version) || (mode !== "night" && mode !== "vote")) return;
    const result = mode === "night"
      ? await this.economy.submitMafiaNightAction(gameId, interaction.user.id, targetId, version)
      : await this.economy.submitMafiaVote(gameId, interaction.user.id, targetId, version);
    const response = result.accepted
      ? mafiaNoticePayload(mode === "night" ? "" : "", `Selected <@${targetId}>. You may change this before the phase ends.`)
      : mafiaNoticePayload("Selection rejected", this.#mutationReason(result.reason));
    await interaction.update({
      components: response.components,
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  }

  async #settingButton(interaction: ButtonInteraction, parts: string[]): Promise<void> {
    const [, , key, gameId, value] = parts;
    if (!key || !gameId || !value) return;
    const result = await this.economy.updateMafiaSetting(gameId, interaction.user.id, key, value);
    if (!result.accepted) {
      await interaction.reply(mafiaNoticePayload("Settings", this.#mutationReason(result.reason)));
      return;
    }
    const snapshot = await this.#requiredSnapshot(gameId);
    const payload = mafiaSettingsPayload(snapshot);
    await interaction.update({ components: payload.components, allowedMentions: { parse: [] } });
    await this.#publishSnapshot(snapshot);
  }

  async #settingSelect(interaction: StringSelectMenuInteraction, parts: string[]): Promise<void> {
    const [, , key, gameId] = parts;
    const value = interaction.values[0];
    if (!key || !gameId || !value) return;
    let accepted = true;
    if (key === "pace") {
      const timings: Record<string, [number, number, number]> = {
        quick: [30, 60, 30], standard: [60, 120, 60], relaxed: [90, 180, 90],
      };
      const selected = timings[value];
      if (!selected) return;
      for (const [setting, settingValue] of [
        ["night_seconds", selected[0]], ["discussion_seconds", selected[1]], ["voting_seconds", selected[2]],
      ] as const) {
        const result = await this.economy.updateMafiaSetting(gameId, interaction.user.id, setting, settingValue);
        accepted &&= result.accepted;
      }
    } else {
      const result = await this.economy.updateMafiaSetting(gameId, interaction.user.id, key, value);
      accepted = result.accepted;
    }
    if (!accepted) {
      await interaction.reply(mafiaNoticePayload("Settings", "That setting could not be changed."));
      return;
    }
    const snapshot = await this.#requiredSnapshot(gameId);
    const payload = mafiaSettingsPayload(snapshot);
    await interaction.update({ components: payload.components, allowedMentions: { parse: [] } });
    await this.#publishSnapshot(snapshot);
  }

  async #rematch(interaction: ButtonInteraction, gameId: string): Promise<void> {
    const previous = await this.#requiredSnapshot(gameId);
    if (previous.game.status !== "completed" || !previous.players.some((player) => player.userId === interaction.user.id)) {
      await interaction.reply(mafiaNoticePayload("Rematch", "Only players from a completed game can start its rematch."));
      return;
    }
    await interaction.deferReply();
    try {
      const nextId = await this.economy.createMafiaLobby(previous.game.guildId, previous.game.channelId, interaction.user.id);
      const next = await this.#requiredSnapshot(nextId);
      const message = await interaction.editReply(mafiaPublicPayload(next));
      await this.economy.setMafiaMessage(nextId, message.id);
      this.#messageToGame.set(message.id, nextId);
      this.#schedule(next);
      await interaction.message.delete().catch(() => undefined);
    } catch (error) {
      await interaction.editReply(mafiaPublicNoticePayload("Rematch", "A new lobby could not be created. Another game may already be open."));
      logger.warn("Could not create Mafia rematch", { gameId, message: String(error) });
    }
  }

  #schedule(snapshot: MafiaSnapshot): void {
    const { game } = snapshot;
    const existing = this.#timers.get(game.id);
    if (existing) clearTimeout(existing);
    this.#timers.delete(game.id);
    if (this.#stopped || !game.phaseEndsAt || !["lobby", "active"].includes(game.status)) return;
    const delay = Math.max(0, game.phaseEndsAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.#timers.delete(game.id);
      void this.#advanceUntilFuture(game.id).catch((error) => {
        logger.error("Mafia phase advance failed", { gameId: game.id, message: String(error) });
      });
    }, delay);
    timer.unref();
    this.#timers.set(game.id, timer);
  }

  async #advanceUntilFuture(gameId: string): Promise<void> {
    if (this.#stopped || this.#busy.has(gameId)) return;
    this.#busy.add(gameId);
    try {
      for (let attempt = 0; attempt < MAX_RECOVERY_ADVANCES; attempt += 1) {
        const snapshot = await this.#requiredSnapshot(gameId);
        if (!snapshot.game.phaseEndsAt || !["lobby", "active"].includes(snapshot.game.status)) {
          await this.#syncSpeakingPermissions(snapshot);
          await this.#renderSnapshot(snapshot);
          return;
        }
        if (snapshot.game.phaseEndsAt.getTime() > Date.now()) {
          this.#schedule(snapshot);
          await this.#syncSpeakingPermissions(snapshot);
          await this.#renderSnapshot(snapshot);
          return;
        }
        const result = await this.economy.advanceMafia(gameId, snapshot.game.version);
        if (!result.accepted && result.reason === "not_due") {
          this.#schedule(await this.#requiredSnapshot(gameId));
          return;
        }
        if (!result.accepted && result.reason !== "stale") return;
      }
      logger.warn("Mafia recovery advance limit reached", { gameId });
      this.#schedule(await this.#requiredSnapshot(gameId));
    } finally {
      this.#busy.delete(gameId);
    }
  }

  async #renderSnapshot(snapshot: MafiaSnapshot): Promise<void> {
    const { game } = snapshot;
    if (!game.messageId) return;
    await this.#publishSnapshot(snapshot);
  }

  async #publishSnapshot(snapshot: MafiaSnapshot): Promise<void> {
    const { game } = snapshot;
    const channel = await this.client.channels.fetch(game.channelId).catch(() => null);
    if (!channel?.isSendable()) return;

    const previousMessageId = game.messageId;
    if (previousMessageId && channel.isTextBased() && !channel.isDMBased()) {
      this.#messageToGame.delete(previousMessageId);
      try {
        const previousMessage = await channel.messages.fetch(previousMessageId);
        await previousMessage.delete();
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? Number(error.code)
          : null;
        if (code !== 10_008) {
          this.#messageToGame.set(previousMessageId, game.id);
          logger.warn("Could not delete previous Mafia message; replacement cancelled", {
            gameId: game.id,
            messageId: previousMessageId,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
    }

    const nextMessage = await channel.send(mafiaPublicPayload(snapshot));
    try {
      await this.economy.setMafiaMessage(game.id, nextMessage.id);
    } catch (error) {
      await nextMessage.delete().catch(() => undefined);
      throw error;
    }

    if (["lobby", "active"].includes(game.status)) {
      this.#messageToGame.set(nextMessage.id, game.id);
    }
  }

  async #syncSpeakingPermissions(snapshot: MafiaSnapshot): Promise<void> {
    if (snapshot.game.status === "lobby") return;
    const channel = await this.client.channels.fetch(snapshot.game.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.isThread()) return;

    for (const player of snapshot.players) {
      const shouldSpeak = snapshot.game.status !== "active" || player.alive;
      try {
        if (!shouldSpeak) {
          let originalState = player.speakPermissionState;
          if (!originalState) {
            const overwrite = channel.permissionOverwrites.cache.get(player.userId);
            originalState = overwrite?.allow.has(PermissionFlagsBits.SendMessages)
              ? "allow"
              : overwrite?.deny.has(PermissionFlagsBits.SendMessages)
                ? "deny"
                : "inherit";
            await this.economy.setMafiaSpeakPermissionState(snapshot.game.id, player.userId, originalState);
            player.speakPermissionState = originalState;
          }
          await channel.permissionOverwrites.edit(
            player.userId,
            { SendMessages: false },
            { reason: `Eliminated from Mafia game ${snapshot.game.id}` },
          );
        } else if (player.speakPermissionState) {
          const restored = player.speakPermissionState === "inherit"
            ? null
            : player.speakPermissionState === "allow";
          await channel.permissionOverwrites.edit(
            player.userId,
            { SendMessages: restored },
            { reason: `Mafia speaking permission restored for game ${snapshot.game.id}` },
          );
          await this.economy.setMafiaSpeakPermissionState(snapshot.game.id, player.userId, null);
          player.speakPermissionState = null;
        }
      } catch (error) {
        logger.warn("Could not synchronize Mafia speaking permission", {
          gameId: snapshot.game.id,
          userId: player.userId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #restorePublicMessage(gameId: string, channelId: string): Promise<void> {
    if (this.#stopped) return;
    const snapshot = await this.#requiredSnapshot(gameId);
    if (!["lobby", "active"].includes(snapshot.game.status)) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return;
    const message = await channel.send(mafiaPublicPayload(snapshot));
    await this.economy.setMafiaMessage(gameId, message.id);
    this.#messageToGame.set(message.id, gameId);
  }

  async #requiredSnapshot(gameId: string): Promise<MafiaSnapshot> {
    const snapshot = await this.economy.mafiaSnapshot(gameId);
    if (!snapshot) throw new Error("Mafia game not found");
    return snapshot;
  }

  async #playerLabels(snapshot: MafiaSnapshot): Promise<Map<string, string>> {
    const pairs = await Promise.all(snapshot.players.map(async (player, index) => {
      const user = this.client.users.cache.get(player.userId)
        ?? await this.client.users.fetch(player.userId).catch(() => null);
      return [player.userId, user?.globalName ?? user?.username ?? `Player ${index + 1}`] as const;
    }));
    return new Map(pairs);
  }

  #mutationReason(reason: string): string {
    const reasons: Record<string, string> = {
      closed: "This lobby or phase has closed.",
      full: "The lobby already has 12 players.",
      already_playing: "You are already in another open Mafia game in this server.",
      host_must_cancel: "The host must cancel the lobby instead of leaving it.",
      not_joined: "You are not in this lobby.",
      host_only: "Only the host can do that.",
      not_enough_players: "At least five players are required.",
      players_not_ready: "Every player must press Ready before the host can start.",
      invalid_setting: "That lobby setting is not valid.",
      invalid_roles: "The role setup could not be generated.",
      player_mismatch: "The lobby changed while the game was starting. Try again.",
      phase_closed: "That phase has already ended.",
      no_action: "Your role has no action in this phase.",
      invalid_target: "That player cannot be selected.",
      not_alive: "Eliminated players cannot vote.",
    };
    return reasons[reason] ?? "That action could not be completed.";
  }

  async #interactionError(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    error: unknown,
  ): Promise<void> {
    logger.error("Mafia interaction failed", {
      customId: interaction.customId,
      userId: interaction.user.id,
      message: error instanceof Error ? error.message : String(error),
    });
    if (interaction.replied || interaction.deferred) return;
    await interaction.reply(mafiaNoticePayload("Mafia error", "That action could not be completed. Try again."));
  }
}
