import type { ActivityName } from "./types.js";

interface ActivityPresentation {
  title: string;
  emoji: string;
  success: string;
}

export const activities: Readonly<Record<ActivityName, ActivityPresentation>> = {
  daily: {
    title: "Daily claim",
    emoji: "◈",
    success: "Your daily reserve has arrived.",
  },
  fish: {
    title: "Fishing haul",
    emoji: "◌",
    success: "A clean catch made it back to shore.",
  },
  pray: {
    title: "Prayer answered",
    emoji: "✦",
    success: "Fortune has been granted upon you by the Assure Gods.",
  },
  mine: {
    title: "Mining run",
    emoji: "◆",
    success: "You struck a vein and made a profit.",
  },
  salvage: {
    title: "Salvage recovered",
    emoji: "◇", 
    success: "Useful pieces surfaced from the wreckage.",
  },
};
