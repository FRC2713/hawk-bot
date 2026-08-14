import type { WebClient } from "@slack/web-api";

/** Opens (or reuses) Hawk Bot's own DM with someone, per the `im:write` scope. */
export async function openDirectMessage(
  client: WebClient,
  userId: string
): Promise<string | undefined> {
  const dm = await client.conversations.open({ users: userId });
  return dm.channel?.id;
}
