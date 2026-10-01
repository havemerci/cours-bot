import { Events, MessageFlags, type ButtonInteraction, type Client, type Message } from "discord.js";
import { logger } from "../logger.js";
import { EconomyService } from "../services/economy.js";
import { c4Draw, c4Winner, tttDraw, tttWinner, type TttCell } from "./logic.js";
import {
  c4Payload,
  closedGamePayload,
  invitationPayload,
  tttPayload,
  type GameType,
} from "./ui.js";

interface BaseGame {
  id: string;
  type: GameType;
  challengerId: string;
  opponentId: string;
  wager: number;
  currentId: string;
  status: "pending" | "active" | "complete";
  message: Message;
  timer: NodeJS.Timeout;
}

interface TttGame extends BaseGame {
  type: "ttt";
  board: TttCell[];
}

interface C4Game extends BaseGame {
  type: "c4";
  board: number[][];
}

type Game = TttGame | C4Game;

const INVITE_TIMEOUT_MS = 2 * 60_000;
const GAME_TIMEOUT_MS = 15 * 60_000;

export class GameManager {
  readonly #games = new Map<string, Game>();
  readonly #busy = new Set<string>();

  public constructor(
    client: Client,
    readonly economy: EconomyService,
  ) {
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton() && interaction.customId.startsWith("game:")) {
        void this.#handleButton(interaction).catch((error: unknown) => {
          logger.error("Game interaction failed", {
            customId: interaction.customId,
            userId: interaction.user.id,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
  }

  public async challenge(input: {
    source: Message;
    type: GameType;
    opponentId: string;
    wager: number;
  }): Promise<void> {
    const guildId = input.source.guildId;
    if (!guildId) throw new Error("Games can only be played in a server");

    const id = await this.economy.createGame({
      guildId,
      channelId: input.source.channelId,
      type: input.type,
      challengerId: input.source.author.id,
      opponentId: input.opponentId,
      wager: input.wager,
    });

    const message = await input.source.reply(invitationPayload({
      id,
      type: input.type,
      challengerId: input.source.author.id,
      opponentId: input.opponentId,
      wager: input.wager,
    }));
    await this.economy.setGameMessage(id, message.id);

    const timer = setTimeout(() => void this.#expireInvitation(id), INVITE_TIMEOUT_MS);
    timer.unref();
    const base = {
      id,
      challengerId: input.source.author.id,
      opponentId: input.opponentId,
      wager: input.wager,
      currentId: input.source.author.id,
      status: "pending" as const,
      message,
      timer,
    };
    const game: Game = input.type === "ttt"
      ? { ...base, type: "ttt", board: Array<TttCell>(9).fill(null) }
      : { ...base, type: "c4", board: Array.from({ length: 6 }, () => Array<number>(7).fill(0)) };
    this.#games.set(id, game);
  }

  public async refundExpired(): Promise<void> {
    const count = await this.economy.refundExpiredGames();
    if (count > 0) logger.info("Refunded expired economy games", { count });
  }

  async #handleButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const id = parts[2];
    if (!id || !action) return;
    const game = this.#games.get(id);
    if (!game) {
      await this.#ephemeral(interaction, "That game is no longer active.");
      return;
    }

    if (action === "accept") {
      await this.#accept(interaction, game);
      return;
    }
    if (action === "decline") {
      await this.#decline(interaction, game);
      return;
    }
    if (action === "move") {
      const move = Number(parts[3]);
      if (Number.isInteger(move)) await this.#move(interaction, game, move);
    }
  }

  async #accept(interaction: ButtonInteraction, game: Game): Promise<void> {
    if (interaction.user.id !== game.opponentId) {
      await this.#ephemeral(interaction, "Only the challenged player can accept.");
      return;
    }
    if (game.status !== "pending" || this.#busy.has(game.id)) {
      await this.#ephemeral(interaction, "That challenge is no longer available.");
      return;
    }

    this.#busy.add(game.id);
    await interaction.deferUpdate();
    try {
      const activation = await this.economy.activateGame(game.id, game.opponentId);
      if (!activation.accepted) {
        game.status = "complete";
        clearTimeout(game.timer);
        this.#games.delete(game.id);
        const text = activation.reason === "insufficient_balance"
          ? "The game could not start because one player no longer has enough Assurite."
          : "This invitation expired.";
        await game.message.edit(closedGamePayload(game.type, text));
        return;
      }

      clearTimeout(game.timer);
      game.status = "active";
      game.timer = setTimeout(() => void this.#expireActiveGame(game.id), GAME_TIMEOUT_MS);
      game.timer.unref();
      await game.message.edit(this.#activePayload(game));
    } finally {
      this.#busy.delete(game.id);
    }
  }

  async #decline(interaction: ButtonInteraction, game: Game): Promise<void> {
    if (![game.challengerId, game.opponentId].includes(interaction.user.id)) {
      await this.#ephemeral(interaction, "This invitation is not for you.");
      return;
    }
    if (game.status !== "pending" || this.#busy.has(game.id)) {
      await this.#ephemeral(interaction, "That challenge is no longer available.");
      return;
    }

    this.#busy.add(game.id);
    await interaction.deferUpdate();
    try {
      await this.economy.cancelGame(game.id, interaction.user.id);
      clearTimeout(game.timer);
      game.status = "complete";
      this.#games.delete(game.id);
      const text = interaction.user.id === game.opponentId ? "Challenge declined." : "Challenge cancelled.";
      await game.message.edit(closedGamePayload(game.type, text));
    } finally {
      this.#busy.delete(game.id);
    }
  }

  async #move(interaction: ButtonInteraction, game: Game, move: number): Promise<void> {
    if (game.status !== "active") {
      await this.#ephemeral(interaction, "That game is not active.");
      return;
    }
    if (interaction.user.id !== game.currentId) {
      await this.#ephemeral(interaction, "It is not your turn.");
      return;
    }
    if (this.#busy.has(game.id)) {
      await this.#ephemeral(interaction, "That move is already being handled.");
      return;
    }
    if (!this.#isValidMove(game, move)) {
      await this.#ephemeral(interaction, "Choose an open space.");
      return;
    }

    this.#busy.add(game.id);
    await interaction.deferUpdate();
    try {
      this.#applyMove(game, move);
      const winnerId = this.#winner(game);
      const draw = !winnerId && this.#isDraw(game);
      if (winnerId || draw) {
        const settled = await this.economy.settleGame(game.id, winnerId);
        clearTimeout(game.timer);
        game.status = "complete";
        const result = !settled
          ? `**Game expired**${game.wager > 0 ? " · wagers returned" : ""}`
          : winnerId
            ? `**<@${winnerId}> wins**${game.wager > 0 ? ` · +${game.wager.toLocaleString("en-US")} Assurite` : ""}`
            : `**Draw**${game.wager > 0 ? " · wagers returned" : ""}`;
        await game.message.edit(this.#activePayload(game, result));
        this.#games.delete(game.id);
        return;
      }

      game.currentId = game.currentId === game.challengerId ? game.opponentId : game.challengerId;
      await game.message.edit(this.#activePayload(game));
    } finally {
      this.#busy.delete(game.id);
    }
  }

  #isValidMove(game: Game, move: number): boolean {
    if (game.type === "ttt") return move >= 0 && move < 9 && game.board[move] === null;
    return move >= 0 && move < 7 && game.board[0]![move] === 0;
  }

  #applyMove(game: Game, move: number): void {
    const player = game.currentId === game.challengerId ? 1 : 2;
    if (game.type === "ttt") {
      game.board[move] = player === 1 ? "X" : "O";
      return;
    }
    for (let row = 5; row >= 0; row -= 1) {
      if (game.board[row]![move] === 0) {
        game.board[row]![move] = player;
        return;
      }
    }
  }

  #winner(game: Game): string | null {
    const player = game.type === "ttt" ? tttWinner(game.board) : c4Winner(game.board);
    return player === 1 ? game.challengerId : player === 2 ? game.opponentId : null;
  }

  #isDraw(game: Game): boolean {
    return game.type === "ttt" ? tttDraw(game.board) : c4Draw(game.board);
  }

  #activePayload(game: Game, result?: string) {
    const common = {
      id: game.id,
      challengerId: game.challengerId,
      opponentId: game.opponentId,
      currentId: game.currentId,
      wager: game.wager,
      ...(result === undefined ? {} : { result }),
    };
    return game.type === "ttt"
      ? tttPayload({ ...common, board: game.board })
      : c4Payload({ ...common, board: game.board });
  }

  async #expireInvitation(id: string): Promise<void> {
    const game = this.#games.get(id);
    if (!game || game.status !== "pending" || this.#busy.has(id)) return;
    this.#busy.add(id);
    try {
      await this.economy.cancelGame(id, game.challengerId);
      game.status = "complete";
      this.#games.delete(id);
      await game.message.edit(closedGamePayload(game.type, "Invitation expired."));
    } catch (error) {
      logger.error("Could not expire game invitation", { id, message: String(error) });
    } finally {
      this.#busy.delete(id);
    }
  }

  async #expireActiveGame(id: string): Promise<void> {
    const game = this.#games.get(id);
    if (!game || game.status !== "active" || this.#busy.has(id)) return;
    this.#busy.add(id);
    try {
      await this.economy.settleGame(id, null);
      game.status = "complete";
      this.#games.delete(id);
      await game.message.edit(this.#activePayload(game, `**Game expired**${game.wager > 0 ? " · wagers returned" : ""}`));
    } catch (error) {
      logger.error("Could not expire active game", { id, message: String(error) });
    } finally {
      this.#busy.delete(id);
    }
  }

  async #ephemeral(interaction: ButtonInteraction, content: string): Promise<void> {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
