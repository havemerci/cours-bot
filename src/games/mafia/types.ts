export type MafiaRole = "mafia" | "detective" | "doctor" | "villager";
export type MafiaPhase = "lobby" | "night" | "discussion" | "voting" | "completed";
export type MafiaStatus = "lobby" | "active" | "completed" | "cancelled";
export type MafiaWinner = "town" | "mafia";
export type MafiaSpeakPermissionState = "allow" | "deny" | "inherit";
export type MafiaRolePreset = "balanced" | "classic" | "vanilla";

export interface MafiaGame {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  hostId: string;
  status: MafiaStatus;
  phase: MafiaPhase;
  day: number;
  version: number;
  winner: MafiaWinner | null;
  lastEvent: Record<string, unknown>;
  phaseEndsAt: Date | null;
  nightSeconds: number;
  discussionSeconds: number;
  votingSeconds: number;
  revealRoles: boolean;
  doctorSelfProtect: boolean;
  revivesEnabled: boolean;
  anonymousVoting: boolean;
  rolePreset: MafiaRolePreset;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface MafiaPlayer {
  gameId: string;
  userId: string;
  role: MafiaRole | null;
  alive: boolean;
  nightTargetId: string | null;
  voteTargetId: string | null;
  lastInvestigatedId: string | null;
  speakPermissionState: MafiaSpeakPermissionState | null;
  ready: boolean;
  missedTurns: number;
  actedThisPhase: boolean;
  votedThisPhase: boolean;
  joinedAt: Date;
}

export interface MafiaSnapshot {
  game: MafiaGame;
  players: MafiaPlayer[];
}

export interface MafiaMutation {
  accepted: boolean;
  reason: string;
  version: number;
}

export interface MafiaLeaderboardEntry {
  userId: string;
  wins: number;
  rank: number;
  isTarget: boolean;
}

export interface MafiaStats {
  userId: string;
  wins: number;
  gamesPlayed: number;
  townWins: number;
  mafiaWins: number;
  investigations: number;
  successfulInvestigations: number;
  successfulProtections: number;
  revives: number;
  survivals: number;
  currentWinStreak: number;
  longestWinStreak: number;
  achievements: string[];
}

export interface MafiaHistoryEntry {
  id: string;
  winner: MafiaWinner;
  players: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface MafiaRecapEvent {
  day: number;
  phase: string;
  event: Record<string, unknown>;
}

export interface MafiaDetectiveClue {
  day: number;
  clue: string;
}
