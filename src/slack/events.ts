import type { App } from "@slack/bolt";
import { SLASH_COMMAND } from "../brand.js";
import { revokeInstallation } from "../db/repo.js";
import { log } from "../logger.js";
import { publishHome } from "./home.js";

export function registerEvents(app: App): void {
  app.event("app_home_opened", async ({ event, client }) => {
    // Fires for the Messages tab too; only the Home tab has a view to publish.
    if (event.tab !== "home") return;
    await publishHome(client, event.user);
  });

  // Being @-mentioned is how most people will first try to talk to a bot.
  // Answering with a pointer costs one message and saves a support question.
  app.event("app_mention", async ({ event, client }) => {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user ?? "",
      text: `I take slash commands: \`${SLASH_COMMAND} help\` lists them.`,
    });
  });

  // Slack sends this when the workspace uninstalls the app. Without it the
  // stored token stays behind, valid-looking and dead.
  app.event("app_uninstalled", async ({ body }) => {
    const teamId = (body as { team_id?: string }).team_id;
    if (!teamId) return;
    revokeInstallation(teamId);
    log.info("app uninstalled", { teamId });
  });
}
