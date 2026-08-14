import { WebClient } from "@slack/web-api";
import {
  DEFAULT_ALL_DAY_HOURS,
  hoursCredited,
  type MeetingType,
} from "./domain/attendance.js";
import {
  DEFAULT_CHECKIN_OFFSETS,
  checkinPostTime,
  diffEvent,
  mapCalendarEvent,
  reactionCutoff,
  type CheckinPostOffsets,
  type MappedEvent,
} from "./domain/calendar.js";
import { fetchTeamCalendarEvents } from "./calendar/client.js";
import {
  anyInstallation,
  getAttendanceForEvent,
  getEventByCalendarId,
  getSetting,
  insertEvent,
  listEventsDueForCheckin,
  listEventsDueForCutoff,
  markCheckinPosted,
  markEventFinalized,
  markEventRemoved,
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
  const hourly = getSetting("checkin_offset_hourly_hours");
  const allday = getSetting("checkin_offset_allday_time");
  const [allDayHour, allDayMinute] = allday
    ? allday.split(":").map(Number)
    : [
        DEFAULT_CHECKIN_OFFSETS.allDayHour,
        DEFAULT_CHECKIN_OFFSETS.allDayMinute,
      ];
  return {
    hourlyHoursBefore: hourly
      ? Number(hourly)
      : DEFAULT_CHECKIN_OFFSETS.hourlyHoursBefore,
    allDayHour: allDayHour ?? DEFAULT_CHECKIN_OFFSETS.allDayHour,
    allDayMinute: allDayMinute ?? DEFAULT_CHECKIN_OFFSETS.allDayMinute,
  };
}

function defaultAllDayHours(): number {
  const setting = getSetting("default_all_day_hours");
  return setting ? Number(setting) : DEFAULT_ALL_DAY_HOURS;
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

async function finalizeDueCutoffs(
  client: WebClient,
  botUserId: string
): Promise<void> {
  const allDayHours = defaultAllDayHours();

  for (const event of listEventsDueForCutoff(new Date().toISOString())) {
    // One last reconciliation against Slack's live state before it's gone.
    await syncAttendanceFromSlack(client, event, botUserId);

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
