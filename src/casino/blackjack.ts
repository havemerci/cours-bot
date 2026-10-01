import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, Events,
  MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder,
  type ButtonInteraction, type Client, type Message,
} from "discord.js";
import sharp from "sharp";
import { logger } from "../logger.js";
import { EconomyService, type BlackjackGame } from "../services/economy.js";
import { cardRank as rank, handValue, isNatural as natural } from "./blackjack-logic.js";

type Hand = { cards: string[]; bet: number; status: "active" | "stood" | "bust"; result?: string };
type State = { dealer: string[]; hands: Hand[]; activeHand: number; result?: string };
const CARD_DIR = resolve(process.cwd(), "assets", "bj-cards");
const MAX_BET = 25_000;

function parseState(game: BlackjackGame): State { return structuredClone(game.state) as unknown as State; }
function asRecord(state: State): Record<string, unknown> { return state as unknown as Record<string, unknown>; }

async function addCards(container: ContainerBuilder, files: AttachmentBuilder[], cards: string[], prefix: string, hidden = false) {
  const shown = cards.slice(0, 9).map((card) => ({ card, file: `${card}.png` }));
  if (hidden && shown.length > 1) shown[1] = { card: "Hidden card", file: "card_back.png" };
  const images = await Promise.all(shown.map((entry) => sharp(resolve(CARD_DIR, entry.file))
    .resize(64, 90, { fit: "fill" }).png().toBuffer()));
  const strip = await sharp({ create: { width: 650, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(images.map((input, index) => ({ input, left: 4 + index * 71, top: 4 }))).png().toBuffer();
  const name = `${prefix}-${randomUUID()}.png`;
  files.push(new AttachmentBuilder(strip, { name }));
  container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(`attachment://${name}`).setDescription(shown.map((entry) => entry.card).join(", ")),
  ));
}

async function view(id: string, state: State, active: boolean, balance?: number) {
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### Blackjack\n**Dealer · ${active ? "?" : handValue(state.dealer).total}**`,
  ));
  const files: AttachmentBuilder[] = [];
  await addCards(container, files, state.dealer, "dealer", active);
  for (const [index, hand] of state.hands.entries()) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**${state.hands.length > 1 ? `Hand ${index + 1}` : "Your hand"} · ${handValue(hand.cards).total} · ${hand.bet.toLocaleString("en-US")} Assurite**${hand.result ? `\n${hand.result}` : ""}`,
    ));
    await addCards(container, files, hand.cards, `hand-${index}`);
  }
  if (state.result || balance !== undefined) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    [state.result, balance === undefined ? "" : `-# Balance · ${balance.toLocaleString("en-US")} Assurite`].filter(Boolean).join("\n"),
  ));
  if (active) {
    const hand = state.hands[state.activeHand]!;
    const canSplit = state.hands.length === 1 && hand.cards.length === 2 && rank(hand.cards[0]!) === rank(hand.cards[1]!);
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bj:hit:${id}`).setLabel("Hit").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bj:stand:${id}`).setLabel("Stand").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`bj:double:${id}`).setLabel("Double").setStyle(ButtonStyle.Secondary).setDisabled(hand.cards.length !== 2),
      new ButtonBuilder().setCustomId(`bj:split:${id}`).setLabel("Split").setStyle(ButtonStyle.Secondary).setDisabled(!canSplit),
    ));
  }
  return { flags: MessageFlags.IsComponentsV2 as const, components: [container], files, attachments: [] as never[] };
}

async function playDealer(economy: EconomyService, guildId: string, state: State): Promise<void> {
  if (state.hands.every((hand) => hand.status === "bust")) return;
  while (true) {
    const value = handValue(state.dealer);
    if (value.total > 17 || (value.total === 17 && !value.soft)) return;
    state.dealer.push((await economy.drawBlackjackCards(guildId, 1))[0]!);
  }
}

async function nextHandOrDealer(economy: EconomyService, guildId: string, state: State): Promise<boolean> {
  const next = state.hands.findIndex((hand, index) => index > state.activeHand && hand.status === "active");
  if (next >= 0) { state.activeHand = next; return false; }
  await playDealer(economy, guildId, state);
  return true;
}

function resolveHands(state: State): number {
  const dealer = handValue(state.dealer).total;
  const dealerNatural = natural(state.dealer);
  let payout = 0;
  const results: string[] = [];
  for (const [index, hand] of state.hands.entries()) {
    const player = handValue(hand.cards).total;
    const playerNatural = state.hands.length === 1 && natural(hand.cards);
    let result: string;
    if (player > 21) result = "Bust";
    else if (dealerNatural && playerNatural) { result = "Push"; payout += hand.bet; }
    else if (dealerNatural) result = "Dealer blackjack";
    else if (playerNatural) { result = "Blackjack · 3:2"; payout += Math.floor(hand.bet * 2.5); }
    else if (dealer > 21 || player > dealer) { result = "Win"; payout += hand.bet * 2; }
    else if (player === dealer) { result = "Push"; payout += hand.bet; }
    else result = "Loss";
    hand.result = result;
    hand.status = player > 21 ? "bust" : "stood";
    results.push(`${state.hands.length > 1 ? `Hand ${index + 1}: ` : ""}${result}`);
  }
  state.result = results.join(" · ");
  return payout;
}

export class BlackjackManager {
  #timer: NodeJS.Timeout | null = null;
  public constructor(readonly client: Client, readonly economy: EconomyService) {
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton() && interaction.customId.startsWith("bj:")) {
        void this.#button(interaction).catch((error) => logger.error("Blackjack action failed", { message: String(error) }));
      }
    });
  }

  public async handle(message: Message, prefix: string): Promise<boolean> {
    if (!message.guildId || !message.content.startsWith(prefix)) return false;
    const args = message.content.slice(prefix.length).trim().toLowerCase().split(/\s+/);
    const direct = ["blackjack", "bj", "21"].includes(args[0]!);
    const casinoSubcommand = args[0] === "casino" && ["blackjack", "bj", "21"].includes(args[1]!);
    if (!direct && !casinoSubcommand) return false;
    const bet = Number(args[casinoSubcommand ? 2 : 1]?.replaceAll(",", ""));
    if (!Number.isSafeInteger(bet) || bet < 100 || bet > MAX_BET) {
      await message.reply(`Use \`${prefix}blackjack <100-${MAX_BET.toLocaleString("en-US")}>\`.`); return true;
    }
    const dealt = await this.economy.drawBlackjackCards(message.guildId, 4);
    const state: State = { dealer: [dealt[1]!, dealt[3]!], hands: [{ cards: [dealt[0]!, dealt[2]!], bet, status: "active" }], activeHand: 0 };
    const id = randomUUID();
    const started = await this.economy.startBlackjack({ id, guildId: message.guildId, channelId: message.channelId,
      userId: message.author.id, bet, state: asRecord(state) });
    if (!started.success) {
      await message.reply(started.failureReason === "active_game" ? "Finish your active blackjack game first." : "You do not have enough Assurite.");
      return true;
    }
    const terminal = natural(state.hands[0]!.cards) || natural(state.dealer);
    if (terminal) {
      const payout = resolveHands(state);
      const settled = await this.economy.settleBlackjack({ id, userId: message.author.id, version: 0,
        state: asRecord(state), additionalBet: 0, payout });
      const response = await message.reply(await view(id, state, false, settled.balance));
      await this.economy.setBlackjackMessage(id, response.id);
      return true;
    }
    const response = await message.reply(await view(id, state, true, started.balance));
    await this.economy.setBlackjackMessage(id, response.id);
    return true;
  }

  public start(): void {
    if (this.#timer) return;
    void this.#expire().catch((error) => logger.error("Blackjack expiry failed", { message: String(error) }));
    this.#timer = setInterval(() => void this.#expire().catch((error) => logger.error("Blackjack expiry failed", { message: String(error) })), 60_000);
    this.#timer.unref();
  }
  public stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  async #button(interaction: ButtonInteraction): Promise<void> {
    const [, action, id] = interaction.customId.split(":");
    if (!id || !action) return;
    const game = await this.economy.getBlackjack(id);
    if (!game || game.userId !== interaction.user.id || game.status !== "active") {
      await interaction.reply({ content: game ? "This isn't your active hand." : "That hand no longer exists.", flags: MessageFlags.Ephemeral }); return;
    }
    await interaction.deferUpdate();
    if (new Date(game.expiresAt).getTime() <= Date.now()) {
      await this.economy.expireBlackjack(id); const expired = await this.economy.getBlackjack(id);
      if (expired) await interaction.editReply(await view(id, parseState(expired), false)); return;
    }
    const state = parseState(game);
    const hand = state.hands[state.activeHand]!;
    let additionalBet = 0;
    let terminal = false;
    if (action === "hit") {
      hand.cards.push((await this.economy.drawBlackjackCards(game.guildId, 1))[0]!);
      const value = handValue(hand.cards).total;
      if (value >= 21) { hand.status = value > 21 ? "bust" : "stood"; terminal = await nextHandOrDealer(this.economy, game.guildId, state); }
    } else if (action === "stand") {
      hand.status = "stood"; terminal = await nextHandOrDealer(this.economy, game.guildId, state);
    } else if (action === "double") {
      if (hand.cards.length !== 2) { await interaction.followUp({ content: "You can only double on two cards.", flags: MessageFlags.Ephemeral }); return; }
      additionalBet = hand.bet; hand.bet *= 2; hand.cards.push((await this.economy.drawBlackjackCards(game.guildId, 1))[0]!);
      hand.status = handValue(hand.cards).total > 21 ? "bust" : "stood";
      terminal = await nextHandOrDealer(this.economy, game.guildId, state);
    } else if (action === "split") {
      if (state.hands.length !== 1 || hand.cards.length !== 2 || rank(hand.cards[0]!) !== rank(hand.cards[1]!)) {
        await interaction.followUp({ content: "This hand cannot be split.", flags: MessageFlags.Ephemeral }); return;
      }
      additionalBet = hand.bet;
      const second = hand.cards.pop()!;
      const cards = await this.economy.drawBlackjackCards(game.guildId, 2);
      state.hands = [
        { cards: [hand.cards[0]!, cards[0]!], bet: hand.bet, status: "active" },
        { cards: [second, cards[1]!], bet: hand.bet, status: "active" },
      ];
      state.activeHand = 0;
      if (rank(state.hands[0]!.cards[0]!) === "A") {
        state.hands.forEach((item) => { item.status = "stood"; });
        await playDealer(this.economy, game.guildId, state); terminal = true;
      }
    } else return;

    if (terminal) {
      const payout = resolveHands(state);
      const settled = await this.economy.settleBlackjack({ id, userId: interaction.user.id, version: game.version,
        state: asRecord(state), additionalBet, payout });
      if (!settled.success) { await interaction.followUp({ content: "That action could not settle. Check your balance or use the latest buttons.", flags: MessageFlags.Ephemeral }); return; }
      await interaction.editReply(await view(id, state, false, settled.balance));
    } else {
      const updated = await this.economy.updateBlackjack({ id, userId: interaction.user.id, version: game.version,
        state: asRecord(state), additionalBet });
      if (!updated.success) { await interaction.followUp({ content: "That action could not complete. Check your balance or use the latest buttons.", flags: MessageFlags.Ephemeral }); return; }
      await interaction.editReply(await view(id, state, true, updated.balance));
    }
  }

  async #expire(): Promise<void> {
    for (const game of await this.economy.expiredBlackjack()) {
      if (!await this.economy.expireBlackjack(game.id) || !game.messageId) continue;
      const channel = await this.client.channels.fetch(game.channelId).catch(() => null);
      if (!channel?.isTextBased() || !("messages" in channel)) continue;
      const message = await channel.messages.fetch(game.messageId).catch(() => null);
      const expired = await this.economy.getBlackjack(game.id);
      if (message && expired) await message.edit(await view(game.id, parseState(expired), false)).catch(() => undefined);
    }
  }
}
