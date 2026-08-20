import type { WebClient } from "@slack/web-api";
import {
  assembleWeeklySummaryMessage,
  calendarSubscribeLink,
  formatWeeklySummaryLine,
  isWeeklySummaryDue,
  resolveWeeklySummaryTiming,
  upcomingTwoWeekRange,
  type WeeklySummaryLineEntry,
} from "./domain/weeklySummary.js";
import {
  getMostRecentMentorSummary,
  getSetting,
  insertMentorSummary,
  listEventsStartingInRange,
} from "./db/repo.js";
import { log } from "./logger.js";
import { postWeeklySummary } from "./slack/weeklySummary.js";
import { toWeeklySummaryEventInfo } from "./weeklySummary.js";

/**
 * The Mentor/Teacher Weekly Summary: if due, sends a fresh post covering
 * the 14 days starting tomorrow — a rolling look-ahead (see
 * upcomingTwoWeekRange), wider than the Team Meeting Weekly Summary's
 * one-week span for more lead time on travel and unavailability conflicts.
 * Every prior post stays, never replaced (see ADR-0014). Unlike the Team
 * Meeting Weekly Summary, there is no mid-window edit-in-place here — a
 * change mid-week shows up corrected on the next scheduled post rather
 * than a live edit, since this is an admin-only FYI digest, not something
 * people are actively tracking.
 */
export async function postDueMentorSummary(client: WebClient): Promise<void> {
  const calendarId = getSetting("mentor_calendar_id");
  const channelId = getSetting("mentor_summary_channel");
  if (!calendarId || !channelId) return;

  const timing = resolveWeeklySummaryTiming(getSetting("mentor_summary_time"));
  const mostRecent = getMostRecentMentorSummary();
  const lastPostedAt = mostRecent ? new Date(mostRecent.posted_at) : null;
  const now = new Date();
  if (!isWeeklySummaryDue(lastPostedAt, timing, now)) return;

  const { start, end } = upcomingTwoWeekRange(now);
  const events = listEventsStartingInRange(
    start.toISOString(),
    end.toISOString(),
    "mentor"
  );

  const entries: WeeklySummaryLineEntry[] = events.map((event) => ({
    sortKey: new Date(event.starts_at),
    text: formatWeeklySummaryLine(toWeeklySummaryEventInfo(event)),
  }));
  const text = assembleWeeklySummaryMessage({
    weekStart: start,
    weekEnd: end,
    entries,
    label: "Mentor/Teacher Calendar",
    emptyText: "_Nothing on the Mentor/Teacher Calendar these two weeks._",
    subscribeLink: calendarSubscribeLink(calendarId),
  });

  const { channel, ts } = await postWeeklySummary(client, channelId, text);
  const mentorSummaryId = insertMentorSummary({
    channel,
    messageTs: ts,
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
  });

  log.info("mentor summary posted", {
    mentorSummaryId,
    channel,
    ts,
    eventCount: events.length,
  });
}
