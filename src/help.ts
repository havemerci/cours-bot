import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  Events,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Client,
  type Message,
} from "discord.js";
import { logger } from "./logger.js";

type HelpPage = "home" | "earn" | "games" | "casino" | "rewards";

const pageAliases: Record<string, HelpPage> = {
  home: "home", overview: "home", commands: "home",
  earn: "earn", economy: "earn", balance: "earn", daily: "earn", fish: "earn", pray: "earn", mine: "earn", salvage: "earn", lb: "earn",
  games: "games", game: "games", give: "games", ttt: "games", c4: "games", mafia: "games", mafialb: "games",
  mafiastats: "games", mafiahistory: "games", stats: "games", history: "games",
  casino: "casino", bet: "casino", coinflip: "casino", roulette: "casino", slots: "casino", blackjack: "casino", bj: "casino",
  rewards: "rewards", boost: "rewards", bump: "rewards", activity: "rewards", msglb: "rewards",
  flag: "rewards", anime: "rewards", chat: "rewards", ping: "rewards", restart: "rewards",
  addmoney: "rewards", removemoney: "rewards", setbalance: "rewards", freeze: "rewards", audit: "rewards",
};

const labels: Array<[HelpPage, string]> = [
  ["home", "Overview"], ["earn", "Economy"], ["games", "Player games"],
  ["casino", "Casino"], ["rewards", "Rewards"],
];

function pageContent(page: HelpPage, prefix: string): string {
  if (page === "earn") return [
    "### ◈ Economy and earning",
    `\`${prefix}daily\` · **2,500** Assurite every 24 hours`,
    `\`${prefix}fish\` · **500** Assurite`,
    `\`${prefix}pray\` · **750** Assurite`,
    `\`${prefix}mine\` · **1,000** Assurite`,
    `\`${prefix}salvage\` · **1,250** Assurite`,
    "-# Repeatable earning commands have a 60-second cooldown.",
    "",
    `\`${prefix}balance\` · View your current balance`,
    `\`${prefix}lb\` · View the server's ten richest members and your rank`,
    "",
    "**Examples**",
    `> ${prefix}daily`,
    `> ${prefix}balance`,
    `> ${prefix}lb`,
  ].join("\n");

  if (page === "games") return [
    "### Player games and transfers",
    `\`${prefix}give @user amount\` · Send your Assurite to another member`,
    "-# Maximum 25,000 per transfer and 100,000 per UTC day.",
    `> ${prefix}give @ilybabemwah 5,000`,
    "",
    `\`${prefix}ttt @user [amount]\` · Tic-tac-toe`,
    `\`${prefix}c4 @user [amount]\` · Connect Four`,
    "-# Leave out the amount for a free game. Wagers require at least 2,500 per player.",
    "-# The opponent must accept. Both stakes are reserved; the winner takes the opponent's stake. Draws and timeouts refund both players.",
    "",
    `\`${prefix}mafia\` · Start a 5–12 player social deduction lobby`,
    "-# Everyone readies up before the host starts. Settings control timing, roles, reveals, Doctor rules, revives, and vote privacy.",
    "-# Night choices are private. Three consecutive missed actions or votes cause an AFK elimination.",
    "-# Detective investigations create odd/even Mafia-count clues for overlapping groups; previous clues stay in a private notebook.",
    "-# Doctors protect living players or revive eliminated players. Speaking access returns after revival or when the game ends.",
    "-# Night lasts 60 seconds, discussion lasts two minutes, and voting lasts 60 seconds. Tied votes eliminate nobody.",
    `\`${prefix}mafialb\` · View the server's Mafia wins leaderboard and your rank`,
    `\`${prefix}mafiastats [@user]\` · Detailed record, streaks, and achievements`,
    `\`${prefix}mafia history\` · Recent matches with private action recaps`,
    "-# Players receive 250 Assurite; winners receive 1,000 total. Mafia rewards are capped at 2,500 per UTC day.",
    "",
    "**Examples**",
    `> ${prefix}ttt @ilybabemwah`,
    `> ${prefix}c4 @ilybabemwah 10,000`,
    `> ${prefix}mafia`,
    `> ${prefix}mafialb`,
    `> ${prefix}mafiastats @ilybabemwah`,
    `> ${prefix}mafia history`,
  ].join("\n");

  if (page === "casino") return [
    "### Casino",
    `\`${prefix}bet amount\` · 50/50 Hit or Miss · **100–50,000**`,
    `> ${prefix}bet 2,500`,
    "-# A hit wins profit equal to your bet; a miss loses the stake.",
    "",
    `\`${prefix}coinflip amount heads|tails\` · 48% win chance · 2× total return`,
    `> ${prefix}coinflip 1,000 heads`,
    "",
    `\`${prefix}roulette amount choice\` · red/black pays 2× · green/exact number pays 36×`,
    `> ${prefix}roulette 2,500 red`,
    `> ${prefix}roulette 500 17`,
    "-# Red/black maximum: 25,000. Green/exact maximum: 2,500.",
    "",
    `\`${prefix}slots amount\` · **100–10,000** · up to 15× return`,
    `> ${prefix}slots 1,000`,
    "",
    `\`${prefix}blackjack amount\` · **100–25,000** · blackjack pays 3:2`,
    `> ${prefix}blackjack 5,000`,
    "-# Hit draws, Stand holds, Double doubles the stake for one card, and Split separates a matching pair.",
  ].join("\n");

  if (page === "rewards") return [
    "### Automatic rewards and activity",
    "**+5,000 Assurite** when you boost the server.",
    "**+5,000 Assurite** when you DISBOARD bump.",
    "**+5,000 Assurite daily** when you vote on Discadia.",
    "",
    "**Chat rounds · +1,250 Assurite**",
    "After every 50 human messages in <#1533467066529747144>, a random Guess the Flag or Guess the Anime round starts.",
    "-# Type your answer in chat. Only the first correct answer wins; rounds close after 15 seconds and reveal the answer.",
    "-# Anime accepts partial English, Japanese, romaji, and alternate titles. For flags, type the country name.",
    "",
    "**Owner tools**",
    `\`${prefix}ping\` · Check gateway and message latency`,
    `\`${prefix}restart\` · Restart the process`,
    "-# Restricted to @ilybabemwah",
    `\`${prefix}addmoney @user amount\` · Add Assurite`,
    `\`${prefix}removemoney @user amount\` · Remove Assurite`,
    `\`${prefix}setbalance @user amount\` · Set an exact balance`,
    `\`${prefix}freeze @user\` · Freeze or unfreeze an account`,
    `\`${prefix}economy audit @user\` · View recent administrative changes`,
    "-# Economy administration is restricted to cour",
    "",
    "Messages are counted Monday–Sunday in UTC. After the week closes, the most active member receives <@&1554082572739551262>.",
  ].join("\n");

  return [
    "### Assurite guide",
    "Earn currency, challenge other members, or try the casino. Choose a section below for syntax, limits, and examples.",
    "",
    `**Quick start**`,
    `> ${prefix}daily · claim your daily reward`,
    `> ${prefix}balance · check your Assurite`,
    `> ${prefix}ttt @user · start a free game`,
    `> ${prefix}bet 2,500 · play Hit/Miss`,
    "",
    `Use \`${prefix}help command\` for the relevant page, such as \`${prefix}help blackjack\` or \`${prefix}help give\`.`,
  ].join("\n");
}

function payload(ownerId: string, page: HelpPage, prefix: string) {
  const buttons = new ActionRowBuilder<ButtonBuilder>();
  for (const [key, label] of labels) {
    buttons.addComponents(new ButtonBuilder()
      .setCustomId(`help:${ownerId}:${key}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(key === page));
  }
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(pageContent(page, prefix)))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(buttons);
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: { parse: [] as never[], repliedUser: false as const },
  };
}

export class HelpManager {
  public constructor(readonly client: Client, readonly prefix: string) {
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton() && interaction.customId.startsWith("help:")) {
        void this.#button(interaction).catch((error) => logger.error("Help interaction failed", { message: String(error) }));
      }
    });
  }

  public async handle(message: Message): Promise<boolean> {
    if (!message.content.startsWith(this.prefix)) return false;
    const args = message.content.slice(this.prefix.length).trim().toLowerCase().split(/\s+/);
    if (!["help", "commands", "guide"].includes(args[0]!)) return false;
    const page = args[1] ? pageAliases[args[1]] : "home";
    if (!page) {
      await message.reply(payload(message.author.id, "home", this.prefix));
      return true;
    }
    await message.reply(payload(message.author.id, page, this.prefix));
    return true;
  }

  async #button(interaction: ButtonInteraction): Promise<void> {
    const [, ownerId, requested] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "Open your own guide with the help command.", flags: MessageFlags.Ephemeral });
      return;
    }
    const page = pageAliases[requested ?? ""] ?? "home";
    await interaction.update(payload(ownerId, page, this.prefix));
  }
}
