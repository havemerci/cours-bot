import { createServer, type Server } from "node:http";
import type { Client } from "discord.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

export function startHealthServer(client: Client): Server {
  const server = createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const ready = client.isReady();
    response.writeHead(ready ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ status: ready ? "ok" : "starting" }));
  });

  server.listen(config.PORT, "0.0.0.0", () => {
    logger.info("listening", { port: config.PORT });
  });
  return server;
}
