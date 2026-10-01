import { randomInt } from "node:crypto";
import type { MafiaRole, MafiaRolePreset } from "./types.js";

export interface MafiaRoleCounts {
  mafia: number;
  detective: number;
  doctor: number;
  villager: number;
}

export function roleCounts(playerCount: number, preset: MafiaRolePreset = "balanced"): MafiaRoleCounts {
  if (!Number.isInteger(playerCount) || playerCount < 5 || playerCount > 12) {
    throw new RangeError("Mafia requires 5 to 12 players");
  }
  const mafia = playerCount <= 6 ? 1 : playerCount <= 9 ? 2 : 3;
  if (preset === "vanilla") {
    return { mafia, detective: 0, doctor: 0, villager: playerCount - mafia };
  }
  const detective = 1;
  const doctor = preset === "classic" || playerCount === 5 ? 0 : 1;
  return { mafia, detective, doctor, villager: playerCount - mafia - detective - doctor };
}

export function assignRoles(
  userIds: readonly string[],
  preset: MafiaRolePreset = "balanced",
  chooseIndex: (upperExclusive: number) => number = randomInt,
): Array<{ userId: string; role: MafiaRole }> {
  const counts = roleCounts(userIds.length, preset);
  const roles: MafiaRole[] = [
    ...Array<MafiaRole>(counts.mafia).fill("mafia"),
    ...Array<MafiaRole>(counts.detective).fill("detective"),
    ...Array<MafiaRole>(counts.doctor).fill("doctor"),
    ...Array<MafiaRole>(counts.villager).fill("villager"),
  ];
  for (let index = roles.length - 1; index > 0; index -= 1) {
    const swapIndex = chooseIndex(index + 1);
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new RangeError("Role randomizer returned an invalid index");
    }
    [roles[index], roles[swapIndex]] = [roles[swapIndex]!, roles[index]!];
  }
  return userIds.map((userId, index) => ({ userId, role: roles[index]! }));
}
