import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";

export interface GamePayload {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: never[]; repliedUser: false };
}

export type GameType = "c4" | "ttt";

const format = new Intl.NumberFormat("en-US");

function payload(container: ContainerBuilder): GamePayload {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

function gameName(type: GameType): string {
  return type === "c4" ? "Connect Four" : "Tic-tac-toe";
}

function stakeLine(wager: number): string {
  return wager > 0 ? `**${format.format(wager)} Assurite each**` : "No wager";
}

export function invitationPayload(input: {
  id: string;
  type: GameType;
  challengerId: string;
  opponentId: string;
  wager: number;
}): GamePayload {
  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`game:accept:${input.id}`).setLabel("Accept").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`game:decline:${input.id}`).setLabel("Decline").setStyle(ButtonStyle.Secondary),
  );
  return payload(
    new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### ${gameName(input.type)}\n<@${input.challengerId}> challenged <@${input.opponentId}>\n-# ${stakeLine(input.wager)} · expires in 2 minutes`,
        ),
      )
      .addActionRowComponents(actions),
  );
}

export function tttPayload(input: {
  id: string;
  challengerId: string;
  opponentId: string;
  currentId: string;
  wager: number;
  board: ReadonlyArray<string | null>;
  result?: string;
}): GamePayload {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### Tic-tac-toe\n<@${input.challengerId}> **X**  ·  <@${input.opponentId}> **O**\n-# ${stakeLine(input.wager)}${input.result ? "" : ` · <@${input.currentId}>'s turn`}`,
    ),
  );

  for (let row = 0; row < 3; row += 1) {
    const buttons = new ActionRowBuilder<ButtonBuilder>();
    for (let column = 0; column < 3; column += 1) {
      const index = row * 3 + column;
      const mark = input.board[index];
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId(`game:move:${input.id}:${index}`)
          .setLabel(mark ?? "·")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(Boolean(mark) || Boolean(input.result)),
      );
    }
    container.addActionRowComponents(buttons);
  }

  if (input.result) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(input.result));
  }
  return payload(container);
}

export function c4Payload(input: {
  id: string;
  challengerId: string;
  opponentId: string;
  currentId: string;
  wager: number;
  board: ReadonlyArray<ReadonlyArray<number>>;
  result?: string;
}): GamePayload {
  const grid = input.board
    .map((row) => row.map((cell) => cell === 1 ? "🔴" : cell === 2 ? "🟡" : "⚪").join(""))
    .join("\n");
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### Connect Four\n${grid}\n<@${input.challengerId}> 🔴  ·  <@${input.opponentId}> 🟡\n-# ${stakeLine(input.wager)}${input.result ? "" : ` · <@${input.currentId}>'s turn`}`,
    ),
  );

  if (!input.result) {
    for (const columns of [[0, 1, 2, 3], [4, 5, 6]]) {
      const controls = new ActionRowBuilder<ButtonBuilder>();
      for (const column of columns) {
        controls.addComponents(
          new ButtonBuilder()
            .setCustomId(`game:move:${input.id}:${column}`)
            .setLabel(String(column + 1))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(input.board[0]![column] !== 0),
        );
      }
      container.addActionRowComponents(controls);
    }
  }

  if (input.result) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(input.result));
  }
  return payload(container);
}

export function closedGamePayload(type: GameType, text: string): GamePayload {
  return payload(
    new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${gameName(type)}\n${text}`),
    ),
  );
}
