import { WebClient } from "@slack/web-api";
import {
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
import { fetchTeamCalendarEvents } from "./calendar/client.js";
import {
  anyInstallation,
  getAttendanceForEvent,
  getEventByCalendarId,
  getRoster,
  getSetting,
  insertEvent,
  listEventsDueForCheckin,
  listEventsDueForCutoff,
  markCheckinPosted,
  markEventFinalized,
  markEventRemoved,
  markVerificationFailed,
  setHoursCredited,
  snapshotRoster,
  updateEventFromCalendar,
  type EventRow,
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

/**
 * Pulls the Team Meeting Calendar, applies Meeting Type derivation, and runs
 * Calendar Change Handling for anything already tracked. Multi-Day entries
 * are recognized (via mapCalendarEvent) but skipped entirely — deferred
 * past v1, see CONTEXT.md.
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
    if (mapped.meetingType === "multi_day") continue;

    const existing = getEventByCalendarId(mapped.calendarEventId);

    if (!existing) {
      if (mapped.cancelled) continue;
      insertEvent({
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
  const reason =
    verification.reason === "resync_failed"
      ? "the reaction resync itself failed (a Slack API call errored)"
      : `${verification.missingUserIds.length} reacted user(s) have no matching attendance record`;
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
    await postDueCheckins(client, botUserId);
    await finalizeDueCutoffs(client, botUserId);
  } catch (err) {
    log.error("scheduler tick failed", { error: String(err) });
  }
}

export function startScheduler(): NodeJS.Timeout {
  return setInterval(() => void runSchedulerTick(), POLL_INTERVAL_MS);
}
