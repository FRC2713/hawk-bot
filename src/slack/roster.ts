import type { WebClient } from "@slack/web-api";

/**
 * A channel's full current membership, minus the bot itself — the Roster's
 * definition (see CONTEXT.md, Roster). Pages through conversations.members
 * rather than trusting the first page, since Slack paginates a channel's
 * membership list once it's large enough. Shared by the Event Check-in
 * Post's snapshot Roster (checkin.ts) and the No Response Alert's live
 * Roster (noResponseAlert.ts) — same definition, one place to fix it.
 */
export async function fetchChannelRoster(
  client: WebClient,
  channel: string,
  botUserId: string
): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.members({ channel, cursor });
    members.push(...(page.members ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return members.filter((id) => id !== botUserId);
}
