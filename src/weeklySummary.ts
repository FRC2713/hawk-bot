import type { WebClient } from "@slack/web-api";
import {
  assembleWeeklySummaryMessage,
  formatWeeklySummaryLine,
  isWeeklySummaryDue,
  isWithinWeek,
  renderEditedLine,
  renderNewLine,
  renderRemovedLine,
  resolveWeeklySummaryTiming,
  upcomingWeekRange,
  weeklySummaryChangedFields,
  type WeeklySummaryEventInfo,
  type WeeklySummaryLineEntry,
} from "./domain/weeklySummary.js";
import {
  getEvent,
  getMostRecentWeeklySummary,
  getSetting,
  getWeeklySummaryItem,
  insertWeeklySummary,
  insertWeeklySummaryItem,
  listEventsStartingInRange,
  listWeeklySummaryItems,
  markWeeklySummaryItemRemoved,
  type EventRow,
  type WeeklySummaryItemRow,
  type WeeklySummaryRow,
} from "./db/repo.js";
import { log } from "./logger.js";
import {
  deleteWeeklySummary,
  postWeeklySummary,
  updateWeeklySummary,
} from "./slack/weeklySummary.js";

function toWeeklySummaryEventInfo(row: EventRow): WeeklySummaryEventInfo {
  return {
    title: row.title,
    meetingType: row.meeting_type,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    location: row.location,
  };
}

function snapshotToEventInfo(
  item: WeeklySummaryItemRow
): WeeklySummaryEventInfo {
  return {
    title: item.snapshot_title,
    meetingType: item.snapshot_meeting_type,
    startsAt: new Date(item.snapshot_starts_at),
    endsAt: new Date(item.snapshot_ends_at),
    location: item.snapshot_location,
  };
}

/** Snapshots an Event's current details into a Weekly Summary Post's items — shared by the initial post and a mid-week addition. */
function snapshotWeeklySummaryItem(
  weeklySummaryId: number,
  event: EventRow,
  addedMidWeek: boolean
): void {
  insertWeeklySummaryItem({
    weeklySummaryId,
    eventId: event.id,
    snapshotTitle: event.title,
    snapshotMeetingType: event.meeting_type,
    snapshotStartsAt: event.starts_at,
    snapshotEndsAt: event.ends_at,
    snapshotLocation: event.location,
    addedMidWeek,
  });
}

/**
 * Rebuilds the Weekly Summary Post's whole message from every item it
 * holds, rather than patching in just the one that changed — the same
 * "resync from source of truth" approach as attendance, and it means no
 * rendered text needs to be stored, only the original snapshot each item
 * is diffed against.
 */
async function rebuildAndUpdateWeeklySummary(
  client: WebClient,
  summary: WeeklySummaryRow
): Promise<void> {
  const entries: WeeklySummaryLineEntry[] = [];
  for (const item of listWeeklySummaryItems(summary.id)) {
    const snapshotInfo = snapshotToEventInfo(item);
    const event = item.removed ? undefined : getEvent(item.event_id);

    if (!event) {
      entries.push({
        sortKey: snapshotInfo.startsAt,
        text: renderRemovedLine(snapshotInfo),
      });
      continue;
    }

    const currentInfo = toWeeklySummaryEventInfo(event);
    if (item.added_mid_week) {
      // No "original" to contrast a mid-week addition against — always
      // show its current details, still tagged, for the rest of the week.
      entries.push({
        sortKey: currentInfo.startsAt,
        text: renderNewLine(currentInfo),
      });
      continue;
    }

    const changedFields = weeklySummaryChangedFields(snapshotInfo, currentInfo);
    const text =
      changedFields.length > 0
        ? renderEditedLine({
            snapshot: snapshotInfo,
            current: currentInfo,
            changedFields,
          })
        : formatWeeklySummaryLine(currentInfo);
    entries.push({ sortKey: currentInfo.startsAt, text });
  }

  const text = assembleWeeklySummaryMessage({
    weekStart: new Date(summary.week_start),
    weekEnd: new Date(summary.week_end),
    entries,
  });
  await updateWeeklySummary(client, summary.channel, summary.message_ts, text);
}

/**
 * Routes a new/edited/removed Event into the currently-active Weekly
 * Summary Post, if it falls within the week that post covers — runs
 * independently of, and in parallel with, Calendar Change Handling on the
 * Event's own Check-in Post. See CONTEXT.md, Weekly Summary Change Reflection.
 */
export async function reflectWeeklySummaryChange(
  client: WebClient,
  event: EventRow,
  kind: "changed" | "removed"
): Promise<void> {
  const summary = getMostRecentWeeklySummary();
  if (!summary) return;

  const range = {
    start: new Date(summary.week_start),
    end: new Date(summary.week_end),
  };
  if (!isWithinWeek(new Date(event.starts_at), range)) return;

  const existingItem = getWeeklySummaryItem(summary.id, event.id);

  if (kind === "removed") {
    if (!existingItem) return; // was never listed — nothing to reflect
    markWeeklySummaryItemRemoved(summary.id, event.id);
  } else if (!existingItem) {
    // A brand-new Event, or one whose start just moved into this week.
    snapshotWeeklySummaryItem(summary.id, event, true);
  }
  // Already listed and edited: nothing to write — the rebuild below diffs
  // the current Event against the stored snapshot itself.

  await rebuildAndUpdateWeeklySummary(client, summary).catch((err) =>
    log.error("could not update weekly summary", {
      weeklySummaryId: summary.id,
      eventId: event.id,
      error: String(err),
    })
  );
}

/** If due, deletes the previous Weekly Summary Post and posts this week's. */
export async function postDueWeeklySummary(client: WebClient): Promise<void> {
  const channelId = getSetting("announce_channel");
  if (!channelId) return;

  const timing = resolveWeeklySummaryTiming(getSetting("weekly_summary_time"));
  const mostRecent = getMostRecentWeeklySummary();
  const lastPostedAt = mostRecent ? new Date(mostRecent.posted_at) : null;
  const now = new Date();
  if (!isWeeklySummaryDue(lastPostedAt, timing, now)) return;

  if (mostRecent) {
    await deleteWeeklySummary(
      client,
      mostRecent.channel,
      mostRecent.message_ts
    ).catch((err) =>
      log.error("could not delete previous weekly summary", {
        weeklySummaryId: mostRecent.id,
        error: String(err),
      })
    );
  }

  const { start, end } = upcomingWeekRange(now);
  const events = listEventsStartingInRange(
    start.toISOString(),
    end.toISOString()
  );

  const entries: WeeklySummaryLineEntry[] = events.map((event) => ({
    sortKey: new Date(event.starts_at),
    text: formatWeeklySummaryLine(toWeeklySummaryEventInfo(event)),
  }));
  const text = assembleWeeklySummaryMessage({
    weekStart: start,
    weekEnd: end,
    entries,
  });

  const { channel, ts } = await postWeeklySummary(client, channelId, text);
  const weeklySummaryId = insertWeeklySummary({
    channel,
    messageTs: ts,
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
  });

  for (const event of events) {
    snapshotWeeklySummaryItem(weeklySummaryId, event, false);
  }

  log.info("weekly summary posted", {
    weeklySummaryId,
    channel,
    ts,
    eventCount: events.length,
  });
}
