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
  getWeeklySummaryInformationalItem,
  getWeeklySummaryItem,
  insertWeeklySummary,
  insertWeeklySummaryInformationalItem,
  insertWeeklySummaryItem,
  listEventsStartingInRange,
  listWeeklySummaryInformationalItems,
  listWeeklySummaryItems,
  markWeeklySummaryInformationalItemRemoved,
  markWeeklySummaryItemRemoved,
  setInformationalReply,
  type EventRow,
  type WeeklySummaryItemRow,
  type WeeklySummaryRow,
} from "./db/repo.js";
import { log } from "./logger.js";
import {
  postInformationalReply,
  postWeeklySummary,
  updateWeeklySummary,
} from "./slack/weeklySummary.js";

export function toWeeklySummaryEventInfo(
  row: EventRow
): WeeklySummaryEventInfo {
  return {
    title: row.title,
    meetingType: row.meeting_type,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    location: row.location,
  };
}

/** Shared by both weekly_summary_items and weekly_summary_informational_items — same snapshot columns on both. */
type SummaryItemSnapshot = Pick<
  WeeklySummaryItemRow,
  | "snapshot_title"
  | "snapshot_meeting_type"
  | "snapshot_starts_at"
  | "snapshot_ends_at"
  | "snapshot_location"
>;

function snapshotToEventInfo(
  item: SummaryItemSnapshot
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

/** Snapshots an Event's current details into an Informational reply's items — shared by the initial post and a mid-week addition. */
function snapshotWeeklySummaryInformationalItem(
  weeklySummaryId: number,
  event: EventRow,
  addedMidWeek: boolean
): void {
  insertWeeklySummaryInformationalItem({
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

type SummaryItemRow = SummaryItemSnapshot & {
  event_id: number;
  added_mid_week: number;
  removed: number;
};

/**
 * Turns a Weekly Summary Post's (or Informational reply's) stored items into
 * rendered, sorted entries — the same "resync from source of truth"
 * approach as attendance, and it means no rendered text needs to be stored,
 * only the original snapshot each item is diffed against. Shared by the
 * parent post and the Informational reply, since both diff the same way.
 */
function buildEntriesFromItems(
  items: readonly SummaryItemRow[]
): WeeklySummaryLineEntry[] {
  const entries: WeeklySummaryLineEntry[] = [];
  for (const item of items) {
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
  return entries;
}

async function rebuildAndUpdateWeeklySummary(
  client: WebClient,
  summary: WeeklySummaryRow
): Promise<void> {
  const entries = buildEntriesFromItems(listWeeklySummaryItems(summary.id));
  const text = assembleWeeklySummaryMessage({
    weekStart: new Date(summary.week_start),
    weekEnd: new Date(summary.week_end),
    entries,
  });
  await updateWeeklySummary(client, summary.channel, summary.message_ts, text);
}

async function rebuildAndUpdateInformationalReply(
  client: WebClient,
  summary: WeeklySummaryRow
): Promise<void> {
  if (!summary.informational_channel || !summary.informational_message_ts) {
    return; // nothing posted yet this week — reflectInformationalReplyChange creates it instead
  }
  const entries = buildEntriesFromItems(
    listWeeklySummaryInformationalItems(summary.id)
  );
  const text = assembleWeeklySummaryMessage({
    weekStart: new Date(summary.week_start),
    weekEnd: new Date(summary.week_end),
    entries,
    label: "Informational Calendar",
  });
  await updateWeeklySummary(
    client,
    summary.informational_channel,
    summary.informational_message_ts,
    text
  );
}

/**
 * Routes a new/edited/removed Informational Event into the current week's
 * Informational reply, posting it fresh (threaded under the parent) the
 * first time an Informational Event shows up this week, and rewriting it
 * in place after that — mirrors reflectWeeklySummaryChange's own model.
 * Does nothing once the Informational Calendar is disabled, so a stale
 * reply from before it was turned off is never touched again.
 */
async function reflectInformationalReplyChange(
  client: WebClient,
  event: EventRow,
  kind: "changed" | "removed"
): Promise<void> {
  if (!getSetting("informational_calendar_id")) return;

  const summary = getMostRecentWeeklySummary();
  if (!summary) return;

  const range = {
    start: new Date(summary.week_start),
    end: new Date(summary.week_end),
  };
  if (!isWithinWeek(new Date(event.starts_at), range)) return;

  const existingItem = getWeeklySummaryInformationalItem(summary.id, event.id);

  if (kind === "removed") {
    if (!existingItem) return; // was never listed — nothing to reflect
    markWeeklySummaryInformationalItemRemoved(summary.id, event.id);
  } else if (!existingItem) {
    snapshotWeeklySummaryInformationalItem(summary.id, event, true);
  }

  if (!summary.informational_channel || !summary.informational_message_ts) {
    const entries = buildEntriesFromItems(
      listWeeklySummaryInformationalItems(summary.id)
    );
    if (entries.length === 0) return; // a removal of something never really shown
    const text = assembleWeeklySummaryMessage({
      weekStart: range.start,
      weekEnd: range.end,
      entries,
      label: "Informational Calendar",
    });
    await postInformationalReply(
      client,
      summary.channel,
      summary.message_ts,
      text
    )
      .then(({ channel, ts }) => setInformationalReply(summary.id, channel, ts))
      .catch((err) =>
        log.error("could not post informational reply", {
          weeklySummaryId: summary.id,
          eventId: event.id,
          error: String(err),
        })
      );
    return;
  }

  await rebuildAndUpdateInformationalReply(client, summary).catch((err) =>
    log.error("could not update informational reply", {
      weeklySummaryId: summary.id,
      eventId: event.id,
      error: String(err),
    })
  );
}

/**
 * Routes a new/edited/removed Event into the current week's Weekly Summary
 * Post, Informational reply, or nowhere — runs independently of, and in
 * parallel with, Calendar Change Handling on the Event's own Check-in Post.
 * A Team Meeting Event goes into the Weekly Summary Post itself; an
 * Informational Event goes into that post's Informational reply; a
 * Mentor/Teacher Event does nothing here — it has no mid-window
 * edit-in-place, see mentorSummary.ts. See CONTEXT.md, Weekly Summary
 * Change Reflection.
 */
export async function reflectWeeklySummaryChange(
  client: WebClient,
  event: EventRow,
  kind: "changed" | "removed"
): Promise<void> {
  if (event.calendar_role === "mentor") return;
  if (event.calendar_role === "informational") {
    await reflectInformationalReplyChange(client, event, kind);
    return;
  }

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

/**
 * If due, posts this week's Weekly Summary Post — alongside every prior
 * week's, never replacing them (see ADR-0014) — then, if the Informational
 * Calendar is enabled and has anything in range, posts this week's
 * Informational reply threaded under it.
 */
export async function postDueWeeklySummary(client: WebClient): Promise<void> {
  const channelId = getSetting("announce_channel");
  if (!channelId) return;

  const timing = resolveWeeklySummaryTiming(getSetting("weekly_summary_time"));
  const mostRecent = getMostRecentWeeklySummary();
  const lastPostedAt = mostRecent ? new Date(mostRecent.posted_at) : null;
  const now = new Date();
  if (!isWeeklySummaryDue(lastPostedAt, timing, now)) return;

  const { start, end } = upcomingWeekRange(now);
  const events = listEventsStartingInRange(
    start.toISOString(),
    end.toISOString(),
    "team_meeting"
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

  if (getSetting("informational_calendar_id")) {
    const infoEvents = listEventsStartingInRange(
      start.toISOString(),
      end.toISOString(),
      "informational"
    );
    if (infoEvents.length > 0) {
      const infoEntries: WeeklySummaryLineEntry[] = infoEvents.map((event) => ({
        sortKey: new Date(event.starts_at),
        text: formatWeeklySummaryLine(toWeeklySummaryEventInfo(event)),
      }));
      const infoText = assembleWeeklySummaryMessage({
        weekStart: start,
        weekEnd: end,
        entries: infoEntries,
        label: "Informational Calendar",
      });
      await postInformationalReply(client, channel, ts, infoText)
        .then(({ channel: replyChannel, ts: replyTs }) => {
          setInformationalReply(weeklySummaryId, replyChannel, replyTs);
          for (const event of infoEvents) {
            snapshotWeeklySummaryInformationalItem(
              weeklySummaryId,
              event,
              false
            );
          }
        })
        .catch((err) =>
          log.error("could not post informational reply", {
            weeklySummaryId,
            error: String(err),
          })
        );
    }
  }
}
