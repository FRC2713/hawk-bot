import type { WebClient } from "@slack/web-api";

/**
 * Posting, editing, and deleting the Weekly Summary Post. Deliberately
 * plain — no threading, no broadcast (see ADR-0005) — the whole message is
 * always rebuilt and replaced, never appended to at the Slack API level.
 * The scheduler decides what the current full text should be; this module
 * just gets it onto (or off of) Slack.
 */

export async function postWeeklySummary(
  client: WebClient,
  channel: string,
  text: string
): Promise<{ channel: string; ts: string }> {
  const posted = await client.chat.postMessage({
    channel,
    text,
    unfurl_links: false,
  });
  if (!posted.channel || !posted.ts) {
    throw new Error(
      "chat.postMessage for the Weekly Summary did not return a channel/ts"
    );
  }
  return { channel: posted.channel, ts: posted.ts };
}

export async function updateWeeklySummary(
  client: WebClient,
  channel: string,
  ts: string,
  text: string
): Promise<void> {
  await client.chat.update({ channel, ts, text });
}

export async function deleteWeeklySummary(
  client: WebClient,
  channel: string,
  ts: string
): Promise<void> {
  await client.chat.delete({ channel, ts });
}
