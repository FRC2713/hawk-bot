import type { KnownBlock, WebClient } from "@slack/web-api";
import { APP_NAME, SLASH_COMMAND } from "../brand.js";
import { COMMANDS } from "../commands/registry.js";
import { getSetting } from "../db/repo.js";
import { log } from "../logger.js";

/**
 * The App Home tab: what a student sees when they click Hawk Bot in the
 * sidebar. It is generated from the command registry, so a new command shows
 * up here without anyone remembering to add it.
 */
export function homeView(): { type: "home"; blocks: KnownBlock[] } {
  const note = getSetting("home_note");

  const commands = COMMANDS.map(
    (c) => `• \`${SLASH_COMMAND} ${c.name}\` — ${c.summary}`
  ).join("\n");

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: APP_NAME, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Red Hawk Robotics' team assistant. Type \`${SLASH_COMMAND}\` anywhere in Slack.`,
      },
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: commands } },
  ];

  if (note) {
    blocks.push(
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: note } }
    );
  }

  return { type: "home", blocks };
}

export async function publishHome(
  client: WebClient,
  userId: string
): Promise<void> {
  try {
    await client.views.publish({ user_id: userId, view: homeView() });
  } catch (error) {
    // A failed Home render is invisible to the user — they see the last one,
    // or an empty tab — so it has to be loud somewhere.
    log.warn("could not publish app home", { userId, error: String(error) });
  }
}
