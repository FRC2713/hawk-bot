import type { WebClient } from "@slack/web-api";

/**
 * Posting, editing, and deleting the Weekly Summary Post and its
 * Informational Calendar reply. Deliberately plain — no broadcast (see
 * ADR-0005) — each message is always rebuilt and replaced in place, never
 * appended to at the Slack API level. The scheduler decides what the
 * current full text should be; this module just gets it onto (or off of)
 * Slack. The Informational reply is the one exception that does thread —
 * see postInformationalReply — but is still edited/deleted the same
 * generic way as the parent once it exists.
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

/**
 * Posts the Informational Calendar's digest as a threaded reply under a
 * Weekly Summary Post. Once posted, it's edited and deleted exactly like
 * the parent — via updateWeeklySummary/deleteWeeklySummary below — so no
 * separate update/delete function exists for it.
 */
export async function postInformationalReply(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string
): Promise<{ channel: string; ts: string }> {
  const posted = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
    unfurl_links: false,
  });
  if (!posted.channel || !posted.ts) {
    throw new Error(
      "chat.postMessage for the Informational reply did not return a channel/ts"
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
