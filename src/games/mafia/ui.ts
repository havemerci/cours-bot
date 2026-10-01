import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from "discord.js";
import type {
  MafiaHistoryEntry,
  MafiaDetectiveClue,
  MafiaLeaderboardEntry,
  MafiaPlayer,
  MafiaRecapEvent,
  MafiaRole,
  MafiaSnapshot,
  MafiaStats,
} from "./types.js";

const roleNames: Record<MafiaRole, string> = {
  mafia: "Mafia",
  detective: "Detective",
  doctor: "Doctor",
  villager: "Villager",
};

const roleDescriptions: Record<MafiaRole, string> = {
  mafia: "Choose a town member to eliminate each night. You win when Mafia reaches parity with the town.",
  detective: "Build a clue notebook. Each investigation reveals whether a small group's Mafia count is odd or even.",
  doctor: "Protect a living player or revive a dead one each night.",
  villager: "Discuss & identify the Mafia, and vote on your choice.",
};

function deadline(date: Date | null): string {
  return date ? `<t:${Math.ceil(date.getTime() / 1_000)}:R>` : "soon";
}

function publicPayload(container: ContainerBuilder) {
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [container],
    allowedMentions: { parse: [] as never[], repliedUser: false as const },
  };
}

function privatePayload(container: ContainerBuilder) {
  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
    allowedMentions: { parse: [] as never[] },
  };
}

function playerList(players: readonly MafiaPlayer[], revealAll = false, revealDeaths = true): string {
  return players.map((player) => {
    const state = player.alive ? "alive" : "dead";
    const revealedRole = (revealAll || (!player.alive && revealDeaths)) && player.role ? ` · ${roleNames[player.role]}` : "";
    const ready = !player.role ? ` · ${player.ready ? "ready" : "waiting"}` : "";
    return `<@${player.userId}> · ${state}${ready}${revealedRole}`;
  }).join("\n");
}

function eventText(snapshot: MafiaSnapshot): string | null {
  const type = snapshot.game.lastEvent.type;
  if (type === "night") {
    const killedId = snapshot.game.lastEvent.killed_id;
    const role = snapshot.game.lastEvent.killed_role;
    const revivedId = snapshot.game.lastEvent.revived_id;
    const events: string[] = [];
    if (typeof revivedId === "string") events.push(`<@${revivedId}> was revived by the Doctor.`);
    if (typeof killedId === "string") {
      const reveal = snapshot.game.revealRoles ? ` Their role was **${roleNames[role as MafiaRole] ?? "Unknown"}**.` : "";
      events.push(`<@${killedId}> was found dead.${reveal}`);
    }
    const afk = snapshot.game.lastEvent.afk_ids;
    if (Array.isArray(afk) && afk.length) events.push(`${afk.map((id) => `<@${String(id)}>`).join(" · ")} eliminated for inactivity.`);
    return events.length ? events.join("\n") : "The town slept peacefully. Nobody died during the night.";
  }
  if (type === "vote") {
    const eliminatedId = snapshot.game.lastEvent.eliminated_id;
    const role = snapshot.game.lastEvent.eliminated_role;
    const result = typeof eliminatedId === "string"
      ? `<@${eliminatedId}> was eliminated.${snapshot.game.revealRoles ? ` Their role was **${roleNames[role as MafiaRole] ?? "Unknown"}**.` : ""}`
      : "The vote ended without a majority. Nobody was eliminated.";
    const summary = snapshot.game.lastEvent.vote_summary;
    const afk = snapshot.game.lastEvent.afk_ids;
    const inactivity = Array.isArray(afk) && afk.length
      ? `\n${afk.map((id) => `<@${String(id)}>`).join(" · ")} eliminated for inactivity.` : "";
    if (snapshot.game.anonymousVoting || !summary || typeof summary !== "object") return `${result}${inactivity}`;
    const tally = Object.entries(summary).map(([userId, votes]) => `<@${userId}> · ${String(votes)}`).join(" · ");
    return `${result}\nVotes · ${tally}${inactivity}`;
  }
  return null;
}

export function mafiaPublicPayload(snapshot: MafiaSnapshot) {
  const { game, players } = snapshot;
  if (game.status === "lobby") {
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mafia:join:${game.id}`).setLabel("Join").setStyle(ButtonStyle.Secondary)
        .setDisabled(players.length >= 12),
      new ButtonBuilder().setCustomId(`mafia:leave:${game.id}`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mafia:ready:${game.id}`).setLabel("Ready").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mafia:start:${game.id}`).setLabel("Start").setStyle(ButtonStyle.Secondary)
        .setDisabled(players.length < 5 || players.some((player) => !player.ready)),
      new ButtonBuilder().setCustomId(`mafia:cancel:${game.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );
    const settings = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mafia:settings:${game.id}`).setLabel("Settings").setStyle(ButtonStyle.Secondary),
    );
    return publicPayload(new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `Host · <@${game.hostId}>\nPlayers · **${players.length} / 12**\nPreset · ${game.rolePreset} · ${game.nightSeconds}s / ${game.discussionSeconds}s / ${game.votingSeconds}s\n-# Everyone must be ready · lobby closes ${deadline(game.phaseEndsAt)}`,
      ))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(playerList(players, false, game.revealRoles)))
      .addActionRowComponents(controls, settings));
  }

  if (game.status === "cancelled") {
    return publicPayload(new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent("The lobby closed before the game started."),
    ));
  }

  if (game.status === "completed") {
    const winner = game.winner === "mafia" ? "Mafia wins" : "Town wins";
    const rematch = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mafia:rematch:${game.id}`).setLabel("Rematch").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mafia:recap:${game.id}`).setLabel("Recap").setStyle(ButtonStyle.Secondary),
    );
    return publicPayload(new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${winner}**\n${eventText(snapshot) ?? "The game is over."}`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(playerList(players, true)))
      .addActionRowComponents(rematch));
  }

  const alive = players.filter((player) => player.alive).length;
  const phaseTitle = game.phase === "night" ? `Night ${game.day}`
    : game.phase === "discussion" ? `Day ${game.day} · Discussion`
      : `Day ${game.day} · Voting`;
  const phaseText = game.phase === "night"
    ? "The town sleeps. Players with night abilities can act."
    : game.phase === "discussion"
      ? "Discuss what happened and decide who seems suspicious."
      : "Cast your vote.";
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mafia:role:${game.id}`).setLabel("View role").setStyle(ButtonStyle.Secondary),
  );
  if (game.phase === "night") {
    controls.addComponents(new ButtonBuilder().setCustomId(`mafia:act:${game.id}`).setLabel("Night action").setStyle(ButtonStyle.Secondary));
  } else if (game.phase === "voting") {
    controls.addComponents(new ButtonBuilder().setCustomId(`mafia:vote:${game.id}`).setLabel("Vote").setStyle(ButtonStyle.Secondary));
  }
  const summary = eventText(snapshot);
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `**${phaseTitle}**\n${summary ? `${summary}\n\n` : ""}${phaseText}\n-# Ends ${deadline(game.phaseEndsAt)} · Alive ${alive} · Dead ${players.length - alive}`,
  ));
  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(playerList(players, false, game.revealRoles)))
    .addActionRowComponents(controls);
  return publicPayload(container);
}

export function mafiaRolePayload(
  snapshot: MafiaSnapshot,
  player: MafiaPlayer,
  detectiveClues: readonly MafiaDetectiveClue[] = [],
) {
  if (!player.role) return mafiaNoticePayload("Role unavailable", "Roles have not been assigned yet.");
  const lines = [
    `**Your role · ${roleNames[player.role]}**`,
    roleDescriptions[player.role],
    `-# Status · ${player.alive ? "Alive" : "Eliminated"}`,
  ];
  if (player.role === "mafia") {
    const teammates = snapshot.players.filter((entry) => entry.role === "mafia" && entry.userId !== player.userId);
    lines.push("", `**Mafia team**\n${teammates.length ? teammates.map((entry) => `<@${entry.userId}>`).join(" · ") : "You are the only Mafia member."}`);
  }
  if (player.role === "detective") {
    const notebook = detectiveClues.length
      ? detectiveClues.map((entry) => `Day ${entry.day} · ${entry.clue}`).join("\n")
      : "No clues collected yet.";
    lines.push("", `**Clue notebook**\n${notebook}`, "-# Odd means 1 or 3 Mafia. Even means 0 or 2. Overlap groups to narrow the possibilities.");
  }
  return privatePayload(new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n"))));
}

export function mafiaTargetPayload(input: {
  snapshot: MafiaSnapshot;
  player: MafiaPlayer;
  mode: "night" | "vote";
  labels: ReadonlyMap<string, string>;
}) {
  const { snapshot, player, mode } = input;
  const targets = snapshot.players.filter((target) => {
    if (mode === "night" && player.role === "doctor") {
      if (!target.alive && !snapshot.game.revivesEnabled) return false;
      if (target.userId === player.userId && !snapshot.game.doctorSelfProtect) return false;
      return true;
    }
    if (!target.alive) return false;
    if (mode === "vote") return target.userId !== player.userId;
    if (player.role === "mafia") return target.role !== "mafia";
    if (player.role === "detective") return target.userId !== player.userId;
    return player.role === "doctor";
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mafia:${mode}:${snapshot.game.id}:${snapshot.game.version}`)
    .setPlaceholder(mode === "night" ? "Choose your target" : "Cast your vote")
    .addOptions(targets.map((target) => {
      const option = new StringSelectMenuOptionBuilder()
        .setLabel((input.labels.get(target.userId) ?? `Player ${target.userId.slice(-4)}`).slice(0, 100))
        .setValue(target.userId);
      if (player.role === "doctor") {
        option.setDescription(target.alive ? "Protect tonight" : "Eliminated · revive tonight");
      }
      return option;
    }));
  const selected = mode === "night" ? player.nightTargetId : player.voteTargetId;
  const text = mode === "night"
    ? `**Night action**\nRole · **${player.role ? roleNames[player.role] : "Unknown"}**\n${selected ? `Current target · <@${selected}>` : "Choose a player."}`
    : `**Cast your vote**\n${selected ? `Current vote · <@${selected}>` : "Choose a player."}`;
  return privatePayload(new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)));
}

export function mafiaNoticePayload(title: string, text: string) {
  return privatePayload(new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(title.trim() ? `**${title}**\n${text}` : text),
  ));
}

export function mafiaPublicNoticePayload(title: string, text: string) {
  return publicPayload(new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(title.trim() ? `**${title}**\n${text}` : text),
  ));
}

export function mafiaLeaderboardPayload(entries: readonly MafiaLeaderboardEntry[]) {
  const leaders = entries.filter((entry) => entry.rank <= 10 || !entry.isTarget);
  const target = entries.find((entry) => entry.isTarget);
  const visibleLeaders = leaders.slice(0, 10);
  const lines = visibleLeaders.length
    ? visibleLeaders.map((entry) => `**${entry.rank}.** <@${entry.userId}> · **${entry.wins.toLocaleString("en-US")}** ${entry.wins === 1 ? "win" : "wins"}`)
    : ["No wins have been recorded."];
  if (target && !visibleLeaders.some((entry) => entry.userId === target.userId)) {
    lines.push("", `**Your position**`, `**${target.rank}.** <@${target.userId}> · **${target.wins.toLocaleString("en-US")}** ${target.wins === 1 ? "win" : "wins"}`);
  } else if (!target) {
    lines.push("", "-# Win a Mafia game to receive a server rank.");
  }
  return publicPayload(new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`\n${lines.join("\n")}`),
  ));
}

export function mafiaSettingsPayload(snapshot: MafiaSnapshot) {
  const { game } = snapshot;
  const preset = new StringSelectMenuBuilder()
    .setCustomId(`mafia:setting:role_preset:${game.id}`)
    .setPlaceholder(`Role preset · ${game.rolePreset}`)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Balanced").setDescription("Mafia, Detective, and Doctor").setValue("balanced"),
      new StringSelectMenuOptionBuilder().setLabel("Classic").setDescription("Mafia and Detective, no Doctor").setValue("classic"),
      new StringSelectMenuOptionBuilder().setLabel("Vanilla").setDescription("Mafia and Villagers only").setValue("vanilla"),
    );
  const pace = new StringSelectMenuBuilder()
    .setCustomId(`mafia:setting:pace:${game.id}`)
    .setPlaceholder(`Timing · ${game.nightSeconds}s / ${game.discussionSeconds}s / ${game.votingSeconds}s`)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Quick").setDescription("30s night · 60s discussion · 30s vote").setValue("quick"),
      new StringSelectMenuOptionBuilder().setLabel("Standard").setDescription("60s night · 120s discussion · 60s vote").setValue("standard"),
      new StringSelectMenuOptionBuilder().setLabel("Relaxed").setDescription("90s night · 180s discussion · 90s vote").setValue("relaxed"),
    );
  const toggles = new ActionRowBuilder<ButtonBuilder>().addComponents(
    settingToggle(game.id, "reveal_roles", "Role reveals", game.revealRoles),
    settingToggle(game.id, "doctor_self_protect", "Doctor self", game.doctorSelfProtect),
    settingToggle(game.id, "revives_enabled", "Revives", game.revivesEnabled),
    settingToggle(game.id, "anonymous_voting", "Anonymous", game.anonymousVoting),
  );
  return privatePayload(new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**Lobby settings**\nChanges apply when the host starts the game."))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(preset))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pace))
    .addActionRowComponents(toggles));
}

function settingToggle(gameId: string, key: string, label: string, enabled: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`mafia:setting:${key}:${gameId}:${String(!enabled)}`)
    .setLabel(`${label} · ${enabled ? "on" : "off"}`)
    .setStyle(ButtonStyle.Secondary);
}

const achievementNames: Record<string, string> = {
  first_victory: "First Victory", five_win_streak: "Five-win streak",
  perfect_detective: "Perfect Detective", last_mafia_standing: "Last Mafia Standing",
  successful_revival: "Successful Revival", survivor: "Untouched Survivor",
};

export function mafiaStatsPayload(stats: MafiaStats) {
  const rate = stats.gamesPlayed ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0;
  const investigationRate = stats.investigations
    ? `${stats.successfulInvestigations}/${stats.investigations}` : "0/0";
  const survivalRate = stats.gamesPlayed ? Math.round((stats.survivals / stats.gamesPlayed) * 100) : 0;
  const achievements = stats.achievements.length
    ? stats.achievements.map((item) => achievementNames[item] ?? item).join(" · ")
    : "None yet";
  return publicPayload(new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
    `**Mafia stats · <@${stats.userId}>**`,
    `Games · **${stats.gamesPlayed}** · Wins · **${stats.wins}** · Win rate · **${rate}%**`,
    `Town wins · **${stats.townWins}** · Mafia wins · **${stats.mafiaWins}** · Survival · **${survivalRate}%**`,
    `Investigations · **${investigationRate}** · Protections · **${stats.successfulProtections}** · Revives · **${stats.revives}**`,
    `Streak · **${stats.currentWinStreak}** · Best · **${stats.longestWinStreak}**`,
    `Achievements · ${achievements}`,
  ].join("\n"))));
}

export function mafiaHistoryPayload(entries: readonly MafiaHistoryEntry[]) {
  const text = entries.length ? entries.map((entry) => {
    const when = entry.completedAt ? `<t:${Math.floor(entry.completedAt.getTime() / 1_000)}:R>` : "recently";
    const duration = entry.startedAt && entry.completedAt
      ? `${Math.max(1, Math.round((entry.completedAt.getTime() - entry.startedAt.getTime()) / 60_000))}m` : "—";
    return `${entry.winner === "mafia" ? "Mafia" : "Town"} · ${entry.players} players · ${duration} · ${when}`;
  }).join("\n") : "No completed Mafia games yet.";
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Recent Mafia games**\n${text}`),
  );
  if (entries.length) {
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      entries.map((entry, index) => new ButtonBuilder()
        .setCustomId(`mafia:recap:${entry.id}`).setLabel(`Recap ${index + 1}`).setStyle(ButtonStyle.Secondary)),
    ));
  }
  return publicPayload(container);
}

export function mafiaRecapPayload(events: readonly MafiaRecapEvent[]) {
  const lines = events.slice(-25).map((entry) => {
    const type = entry.event.type;
    if (type === "role") return `<@${String(entry.event.user_id)}> · ${String(entry.event.role ?? "unknown")}`;
    if (type === "action") {
      const names: Record<string, string> = { mafia_vote: "targeted", investigate: "investigated", protect: "protected", vote: "voted for" };
      return `Day ${entry.day} · <@${String(entry.event.actor_id)}> ${names[String(entry.event.action)] ?? "selected"} <@${String(entry.event.target_id)}>`;
    }
    if (type === "night") {
      return `Day ${entry.day} · Night · ${entry.event.killed_id ? `<@${String(entry.event.killed_id)}> died` : "no death"}${entry.event.revived_id ? ` · <@${String(entry.event.revived_id)}> revived` : ""}`;
    }
    return `Day ${entry.day} · Vote · ${entry.event.eliminated_id ? `<@${String(entry.event.eliminated_id)}> eliminated` : "no elimination"}`;
  });
  return privatePayload(new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Post-game recap**\n${lines.length ? lines.join("\n") : "No recorded actions."}`),
  ));
}
