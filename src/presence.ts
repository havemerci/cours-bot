import { createRequire } from "node:module";
import { logger } from "./logger.js";

export function enablePresence(enabled: boolean): void {
  if (!enabled) return;

  const require = createRequire(import.meta.url);
  const ws = require("@discordjs/ws") as typeof import("@discordjs/ws");
  const properties = ws.DefaultWebSocketManagerOptions.identifyProperties as unknown as {
    browser: string;
  };

  properties.browser = "Discord VR";
  logger.info("presence ok.");
}
