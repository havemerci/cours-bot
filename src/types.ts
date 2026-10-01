export const activityNames = ["daily", "fish", "pray", "mine", "salvage"] as const;

export type ActivityName = (typeof activityNames)[number];

export interface ClaimResult {
  claimed: boolean;
  reward: number;
  balance: number;
  nextClaimAt: Date;
}
