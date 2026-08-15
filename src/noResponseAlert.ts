import type { WebClient } from "@slack/web-api";
import {
  DEFAULT_NO_RESPONSE_ALERT_TIMING,
  formatNoResponseAlertMessage,
  isNoResponseStreak,
  resolveNoResponseAlertThreshold,
  type FlaggedPerson,
  type RecentMeetingOutcome,
} from "./domain/noResponseAlert.js";
import {
  isWeeklySummaryDue,
  resolveWeeklySummaryTiming,
} from "./domain/weeklySummary.js";
import {
  getMostRecentNoResponseAlert,
  getRecentOutcomesForUser,
  getSetting,
  insertNoResponseAlert,
} from "./db/repo.js";
import { log } from "./logger.js";
import { fetchChannelRoster } from "./slack/roster.js";

/**
 * The No Response Alert Report: if due, flags anyone currently on the
 * Roster (the announcements channel's live membership, not a historical
 * snapshot — see CONTEXT.md, Roster) whose most recent `threshold` Team
 * Meeting outcomes were all No Response, and posts one message naming them
 * and what they missed. Silent when nobody qualifies — no "all clear"
 * message, see CONTEXT.md — but a row is still recorded either way, so the
 * due-check advances instead of re-evaluating the whole Roster on every
 * scheduler tick for the rest of a silent week. Turned off by leaving
 * `no_response_alert_channel` unset, same convention as the Mentor/Teacher
 * Weekly Summary.
 */
export async function postDueNoResponseAlert(
  client: WebClient,
  botUserId: string
): Promise<void> {
  const channelId = getSetting("no_response_alert_channel");
  if (!channelId) return;

  const timingSetting = getSetting("no_response_alert_time");
  const timing = timingSetting
    ? resolveWeeklySummaryTiming(timingSetting)
    : DEFAULT_NO_RESPONSE_ALERT_TIMING;
  const mostRecent = getMostRecentNoResponseAlert();
  const lastPostedAt = mostRecent ? new Date(mostRecent.posted_at) : null;
  const now = new Date();
  if (!isWeeklySummaryDue(lastPostedAt, timing, now)) return;

  const announceChannel = getSetting("announce_channel");
  if (!announceChannel) return;

  const roster = await fetchChannelRoster(client, announceChannel, botUserId);

  const threshold = resolveNoResponseAlertThreshold(
    getSetting("no_response_alert_threshold")
  );

  const flagged: FlaggedPerson[] = [];
  for (const userId of roster) {
    const recent: RecentMeetingOutcome[] = getRecentOutcomesForUser(
      userId,
      threshold
    ).map((row) => ({
      status: row.status,
      title: row.title,
      startsAt: new Date(row.starts_at),
    }));
    if (!isNoResponseStreak(recent, threshold)) continue;

    const info = await client.users.info({ user: userId }).catch((err) => {
      log.error("no response alert: could not look up user", {
        userId,
        error: String(err),
      });
      return undefined;
    });
    const displayName = info?.user?.real_name ?? info?.user?.name ?? userId;
    flagged.push({
      displayName,
      // recent is newest-first (see getRecentOutcomesForUser); the message
      // reads oldest-to-newest, like a timeline.
      missedMeetings: [...recent].reverse().map((r) => ({
        title: r.title,
        startsAt: r.startsAt,
      })),
    });
  }

  if (flagged.length === 0) {
    insertNoResponseAlert({ channel: channelId, messageTs: null });
    log.info("no response alert: nobody flagged this week");
    return;
  }

  const text = formatNoResponseAlertMessage({ threshold, flagged });
  const posted = await client.chat.postMessage({ channel: channelId, text });
  if (!posted.channel || !posted.ts) {
    log.error("no response alert post did not return a channel/ts");
    return;
  }
  insertNoResponseAlert({ channel: posted.channel, messageTs: posted.ts });
  log.info("no response alert posted", {
    channel: posted.channel,
    ts: posted.ts,
    flaggedCount: flagged.length,
  });
}
