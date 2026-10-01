import { startBot } from "./bot.js";
import { config } from "./config.js";
import { startHealthServer } from "./health.js";
import { logger } from "./logger.js";
import { enablePresence } from "./presence.js";

enablePresence(config.PRESENCE);

const runtime = await startBot();
const healthServer = startHealthServer(runtime.client);
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("Shutting down", { signal });

  try {
    healthServer.close();
    await runtime.stop();
    runtime.client.destroy();
  } finally {
    process.exit(0);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});
