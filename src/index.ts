import { COMMANDS } from "./commands/registry.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { log } from "./logger.js";
import { createApp } from "./slack/app.js";

async function main() {
  const cfg = config();
  db(); // opens the database and applies migrations before serving anything
  const app = createApp();
  await app.start(cfg.PORT);
  log.info("hawk-bot started", {
    port: cfg.PORT,
    installUrl: `${cfg.PUBLIC_URL}/slack/install`,
    commands: COMMANDS.map((c) => c.name),
  });
}

main().catch((err) => {
  log.error("failed to start", { error: String(err) });
  process.exit(1);
});
