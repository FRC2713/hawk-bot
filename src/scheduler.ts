import { WebClient } from "@slack/web-api";
import {
  describeVerificationFailure,
  formatAttendanceReportSummary,
  formatAttendanceReportTable,
  hoursCredited,
  resolveAllDayHours,
  verifyAttendanceCoverage,
  type AttendanceReportRow,
  type AttendanceStatus,
  type MeetingType,
  type VerificationResult,
} from "./domain/attendance.js";
import {
  checkinPostTime,
  diffEvent,
  mapCalendarEvent,
  reactionCutoff,
  resolveCheckinOffsets,
  type CheckinPostOffsets,
  type MappedEvent,
} from "./domain/calendar.js";
import {
  DEFAULT_WEEKLY_SUMMARY_TIMING,
  assembleWeeklySummaryMessage,
  formatWeeklySummaryLine,
  isWeeklySummaryDue,
  renderEditedLine,
  renderNewLine,
  renderRemovedLine,
  resolveWeeklySummaryTiming,
  upcomingWeekRange,
  weeklySummaryChangedFields,
  type WeeklySummaryEventInfo,
  type WeeklySummaryLineEntry,
} from "./domain/weeklySummary.js";
import { fetchTeamCalendarEvents } from "./calendar/client.js";
import {
  anyInstallation,
  getAttendanceForEvent,
  getEvent,
  getEventByCalendarId,
  getMostRecentWeeklySummary,
  getRoster,
  getSetting,
  getWeeklySummaryItem,
  insertEvent,
  insertWeeklySummary,
  insertWeeklySummaryItem,
  listEventsDueForCheckin,
  listEventsDueForCutoff,
  listEventsStartingInRange,
  listWeeklySummaryItems,
  markCheckinPosted,
  markEventFinalized,
  markEventRemoved,
  markVerificationFailed,
  markWeeklySummaryItemRemoved,
  setHoursCredited,
  snapshotRoster,
  updateEventFromCalendar,
  type EventRow,
  type WeeklySummaryItemRow,
  type WeeklySummaryRow,
} from "./db/repo.js";
import { log } from "./logger.js";
import {
  announceEventEdited,
  announceEventRemoved,
  postCheckinPost,
} from "./slack/checkin.js";
import { syncAttendanceFromSlack } from "./slack/attendanceEvents.js";
import { listHawkBotAdmins } from "./slack/authz.js";
import { openDirectMessage } from "./slack/dm.js";
import {
  deleteWeeklySummary,
  postWeeklySummary,
  updateWeeklySummary,
} from "./slack/weeklySummary.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

type Installed = { client: WebClient; botUserId: string };

function currentInstallation(): Installed | undefined {
  const installation = anyInstallation();
  if (!installation) return undefined;
  const payload = installation.payload as {
    bot?: { token?: string; userId?: string };
  };
  const token = payload.bot?.token;
  const botUserId = payload.bot?.userId;
  if (!token || !botUserId) return undefined;
  return { client: new WebClient(token), botUserId };
}

function checkinOffsets(): CheckinPostOffsets {
  return resolveCheckinOffsets(
    getSetting("checkin_offset_hourly_hours"),
    getSetting("checkin_offset_allday_time")
  );
}

function defaultAllDayHours(): number {
  return resolveAllDayHours(getSetting("default_all_day_hours"));
}

function toMappedEvent(row: EventRow): MappedEvent {
  return {
    calendarEventId: row.calendar_event_id ?? "",
    title: row.title,
    description: row.description,
    location: row.location,
    meetingType: row.meeting_type,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    cancelled: false,
  };
}

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
async function reflectWeeklySummaryChange(
  client: WebClient,
  event: EventRow,
  kind: "changed" | "removed"
): Promise<void> {
  const summary = getMostRecentWeeklySummary();
  if (!summary) return;

  const weekStart = new Date(summary.week_start);
  const weekEnd = new Date(summary.week_end);
  const eventStart = new Date(event.starts_at);
  if (eventStart < weekStart || eventStart >= weekEnd) return;

  const existingItem = getWeeklySummaryItem(summary.id, event.id);

  if (kind === "removed") {
    if (!existingItem) return; // was never listed — nothing to reflect
    markWeeklySummaryItemRemoved(summary.id, event.id);
  } else if (!existingItem) {
    // A brand-new Event, or one whose start just moved into this week.
    insertWeeklySummaryItem({
      weeklySummaryId: summary.id,
      eventId: event.id,
      snapshotTitle: event.title,
      snapshotMeetingType: event.meeting_type,
      snapshotStartsAt: event.starts_at,
      snapshotEndsAt: event.ends_at,
      snapshotLocation: event.location,
      addedMidWeek: true,
    });
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
async function postDueWeeklySummary(client: WebClient): Promise<void> {
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
    insertWeeklySummaryItem({
      weeklySummaryId,
      eventId: event.id,
      snapshotTitle: event.title,
      snapshotMeetingType: event.meeting_type,
      snapshotStartsAt: event.starts_at,
      snapshotEndsAt: event.ends_at,
      snapshotLocation: event.location,
      addedMidWeek: false,
    });
  }

  log.info("weekly summary posted", {
    weeklySummaryId,
    channel,
    ts,
    eventCount: events.length,
  });
}

/**
 * Pulls the Team Meeting Calendar, applies Meeting Type derivation, and runs
 * Calendar Change Handling for anything already tracked, plus Weekly
 * Summary Change Reflection for anything within the current week. Multi-Day
 * entries are now tracked as Events too (for the Weekly Summary listing —
 * see CONTEXT.md, Weekly Summary Post) but never get a Check-in Post or
 * attendance tracking, which stays deferred.
 */
async function syncCalendar(client: WebClient): Promise<void> {
  const calendarId = getSetting("google_calendar_id");
  if (!calendarId) return;

  const raw = await fetchTeamCalendarEvents(calendarId);
  const offsets = checkinOffsets();

  for (const rawEvent of raw) {
    let mapped: MappedEvent;
    try {
      mapped = mapCalendarEvent(rawEvent);
    } catch (err) {
      log.error("could not map calendar event", {
        id: rawEvent.id,
        error: String(err),
      });
      continue;
    }

    const existing = getEventByCalendarId(mapped.calendarEventId);

    if (!existing) {
      if (mapped.cancelled) continue;
      const newId = insertEvent({
        calendarEventId: mapped.calendarEventId,
        source: "google_calendar",
        title: mapped.title,
        description: mapped.description,
        location: mapped.location,
        meetingType: mapped.meetingType,
        startsAt: mapped.startsAt.toISOString(),
        endsAt: mapped.endsAt.toISOString(),
        checkinAt: checkinPostTime(mapped, offsets).toISOString(),
        reactionCutoffAt: reactionCutoff(mapped).toISOString(),
      });
      const newRow = getEvent(newId);
      if (newRow) await reflectWeeklySummaryChange(client, newRow, "changed");
      continue;
    }

    if (existing.finalized_at || existing.removed_at) continue;

    const change = diffEvent(toMappedEvent(existing), mapped);
    if (change.kind === "unchanged") continue;

    if (change.kind === "removed") {
      markEventRemoved(existing.id);
      if (existing.checkin_posted_at) {
        await announceEventRemoved(client, existing);
      }
      await reflectWeeklySummaryChange(client, existing, "removed");
      continue;
    }

    // edited
    updateEventFromCalendar(existing.id, {
      title: mapped.title,
      description: mapped.description,
      location: mapped.location,
      meetingType: mapped.meetingType,
      startsAt: mapped.startsAt.toISOString(),
      endsAt: mapped.endsAt.toISOString(),
      checkinAt: checkinPostTime(mapped, offsets).toISOString(),
      reactionCutoffAt: reactionCutoff(mapped).toISOString(),
    });
    if (existing.checkin_posted_at) {
      await announceEventEdited(client, existing, change.changedFields);
    }
    const updated = getEvent(existing.id);
    if (updated) await reflectWeeklySummaryChange(client, updated, "changed");
  }
}

async function postDueCheckins(
  client: WebClient,
  botUserId: string
): Promise<void> {
  const channelId = getSetting("announce_channel");
  if (!channelId) return;

  for (const event of listEventsDueForCheckin(new Date().toISOString())) {
    const { channel, ts, roster } = await postCheckinPost(
      client,
      event,
      channelId,
      botUserId
    );
    markCheckinPosted(event.id, channel, ts);
    snapshotRoster(event.id, roster);
    log.info("check-in post sent", { eventId: event.id, channel, ts });
  }
}

async function notifyVerificationFailure(
  client: WebClient,
  event: EventRow,
  verification: Extract<VerificationResult, { ok: false }>
): Promise<void> {
  const reason = describeVerificationFailure(verification);
  const text = [
    `⚠️ Reaction Cutoff Verification failed for *${event.title}* (Event #${event.id}).`,
    `Reason: ${reason}`,
    "The Check-in Post was left in place — nothing was deleted or finalized.",
    `Once you understand what went wrong, run \`/hawk event retry-cutoff ${event.id}\`.`,
  ].join("\n");

  for (const userId of await listHawkBotAdmins(client)) {
    const dmChannel = await openDirectMessage(client, userId);
    if (!dmChannel) continue;
    await client.chat.postMessage({ channel: dmChannel, text }).catch((err) =>
      log.error("could not DM verification failure", {
        userId,
        eventId: event.id,
        error: String(err),
      })
    );
  }
}

async function buildReportRows(
  client: WebClient,
  event: EventRow,
  reactions: Map<string, string[]>
): Promise<AttendanceReportRow[]> {
  const attendanceByUser = new Map(
    getAttendanceForEvent(event.id).map((r) => [r.user_id, r])
  );

  const rows: AttendanceReportRow[] = [];
  for (const userId of getRoster(event.id)) {
    const info = await client.users
      .info({ user: userId })
      .catch(() => undefined);
    const displayName = info?.user?.real_name ?? info?.user?.name ?? userId;
    const attendanceRow = attendanceByUser.get(userId);
    const status: AttendanceStatus = attendanceRow?.status ?? "no_response";
    rows.push({
      displayName,
      status,
      reactions: reactions.get(userId) ?? [],
      note: attendanceRow?.note ?? null,
    });
  }
  return rows;
}

/** Skips quietly until an admin sets `attendance_report_channel`. */
async function postEventAttendanceReport(
  client: WebClient,
  event: EventRow,
  reactions: Map<string, string[]>
): Promise<void> {
  const channelId = getSetting("attendance_report_channel");
  if (!channelId) return;

  const rows = await buildReportRows(client, event, reactions);
  const hoursPerAttendee = hoursCredited({
    meetingType: event.meeting_type as MeetingType,
    startsAt: new Date(event.starts_at),
    endsAt: new Date(event.ends_at),
    defaultAllDayHours: defaultAllDayHours(),
  });

  const posted = await client.chat.postMessage({
    channel: channelId,
    text: formatAttendanceReportSummary({
      eventTitle: event.title,
      rows,
      hoursPerAttendee,
    }),
  });
  if (posted.channel && posted.ts) {
    await client.chat.postMessage({
      channel: posted.channel,
      thread_ts: posted.ts,
      text: formatAttendanceReportTable(rows),
    });
  }
}

/**
 * Resync, verify, and — only on success — credit hours, delete the
 * Check-in Post, finalize, and post the Event Attendance Report. Shared by
 * the scheduler's normal sweep and the manual `/hawk event retry-cutoff`
 * command, so a retry is exactly the same flow run again on demand.
 */
export async function attemptEventCutoff(
  client: WebClient,
  botUserId: string,
  event: EventRow
): Promise<VerificationResult> {
  let reactions = new Map<string, string[]>();
  let resyncSucceeded = true;
  try {
    ({ reactions } = await syncAttendanceFromSlack(client, event, botUserId));
  } catch (err) {
    resyncSucceeded = false;
    log.error("cutoff resync failed", {
      eventId: event.id,
      error: String(err),
    });
  }

  const recordedUserIds = getAttendanceForEvent(event.id)
    .filter((r) => r.status !== null)
    .map((r) => r.user_id);

  const verification = verifyAttendanceCoverage({
    resyncSucceeded,
    reactedUserIds: [...reactions.keys()],
    recordedUserIds,
  });

  if (!verification.ok) {
    markVerificationFailed(event.id);
    await notifyVerificationFailure(client, event, verification);
    log.error("cutoff verification failed", {
      eventId: event.id,
      verification,
    });
    return verification;
  }

  const allDayHours = defaultAllDayHours();
  for (const row of getAttendanceForEvent(event.id)) {
    if (row.status !== "attending") continue;
    const hours = hoursCredited({
      meetingType: event.meeting_type as MeetingType,
      startsAt: new Date(event.starts_at),
      endsAt: new Date(event.ends_at),
      defaultAllDayHours: allDayHours,
    });
    setHoursCredited(event.id, row.user_id, hours);
  }

  if (event.checkin_channel && event.checkin_message_ts) {
    await client.chat
      .delete({
        channel: event.checkin_channel,
        ts: event.checkin_message_ts,
      })
      .catch((err) =>
        log.error("could not delete check-in post", {
          eventId: event.id,
          error: String(err),
        })
      );
  }
  markEventFinalized(event.id);
  log.info("event finalized", { eventId: event.id });

  await postEventAttendanceReport(client, event, reactions);

  return verification;
}

async function finalizeDueCutoffs(
  client: WebClient,
  botUserId: string
): Promise<void> {
  for (const event of listEventsDueForCutoff(new Date().toISOString())) {
    await attemptEventCutoff(client, botUserId, event);
  }
}

export async function runSchedulerTick(): Promise<void> {
  const installed = currentInstallation();
  if (!installed) return;
  const { client, botUserId } = installed;

  try {
    await syncCalendar(client);
    await postDueWeeklySummary(client);
    await postDueCheckins(client, botUserId);
    await finalizeDueCutoffs(client, botUserId);
  } catch (err) {
    log.error("scheduler tick failed", { error: String(err) });
  }
}

export function startScheduler(): NodeJS.Timeout {
  return setInterval(() => void runSchedulerTick(), POLL_INTERVAL_MS);
}
