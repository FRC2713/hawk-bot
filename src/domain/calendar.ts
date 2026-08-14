/**
 * Mapping a raw Google Calendar event into an Event, Meeting Type
 * derivation, Reaction Cutoff and Check-in Post Timing computation, and
 * diffing two Event snapshots. Pure data and pure functions — no Google API
 * client, no Slack — so the rules are testable without either.
 *
 * "Midnight," "the day before," and all-day dates are wall-clock concepts,
 * so this module reads them with Date's local-time methods rather than the
 * UTC ones, and relies on the process's `TZ` environment variable (see
 * config.ts) being set to the team's real timezone. An Hourly event's own
 * start/end times come from Google as offset-qualified ISO strings, so
 * `new Date(...)` on those is already an unambiguous instant regardless of
 * `TZ` — only the wall-clock boundaries computed *from* an instant need it.
 */

export type RawCalendarEvent = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
};

export type CalendarMeetingType = "hourly" | "all_day" | "multi_day";

export type MappedEvent = {
  calendarEventId: string;
  title: string;
  description: string;
  location: string;
  meetingType: CalendarMeetingType;
  startsAt: Date;
  /**
   * For `all_day`/`multi_day`, this is Google's own exclusive end date (the
   * day after the last day of the event), not an inclusive end.
   */
  endsAt: Date;
  cancelled: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A calendar all-day date ("2026-01-10") as local midnight of that day. */
function parseDateOnly(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/**
 * Google represents an all-day event's end as the day *after* its last day,
 * even for a single-day event — a same-day event has `end.date` one day
 * past `start.date`, not equal to it. Meeting Type has to account for that
 * before comparing start/end, or every single-day event reads as Multi-Day.
 */
export function mapCalendarEvent(raw: RawCalendarEvent): MappedEvent {
  const isAllDay = raw.start.date !== undefined;

  let meetingType: CalendarMeetingType;
  let startsAt: Date;
  let endsAt: Date;

  if (isAllDay) {
    if (!raw.start.date || !raw.end.date) {
      throw new Error(`all-day calendar event ${raw.id} is missing a date`);
    }
    startsAt = parseDateOnly(raw.start.date);
    endsAt = parseDateOnly(raw.end.date);
    const inclusiveLastDay = new Date(endsAt.getTime() - DAY_MS);
    meetingType =
      inclusiveLastDay.getTime() === startsAt.getTime()
        ? "all_day"
        : "multi_day";
  } else {
    if (!raw.start.dateTime || !raw.end.dateTime) {
      throw new Error(`timed calendar event ${raw.id} is missing a time`);
    }
    startsAt = new Date(raw.start.dateTime);
    endsAt = new Date(raw.end.dateTime);
    meetingType = "hourly";
  }

  return {
    calendarEventId: raw.id,
    title: raw.summary ?? "(untitled)",
    description: raw.description ?? "",
    location: raw.location ?? "",
    meetingType,
    startsAt,
    endsAt,
    cancelled: raw.status === "cancelled",
  };
}

/** Local 00:00 of the day after `date` — "midnight ending that day". */
function midnightEnding(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

/**
 * Default: midnight ending the day the event starts. For Hourly events
 * whose end time falls at or after that midnight, the cutoff moves to
 * 10am the next morning instead, so people aren't locked out mid-meeting.
 * All-Day events always use the midnight default — there's no end time to
 * compare against.
 */
export function reactionCutoff(event: {
  meetingType: CalendarMeetingType;
  startsAt: Date;
  endsAt: Date;
}): Date {
  const midnight = midnightEnding(event.startsAt);
  if (event.meetingType !== "hourly") return midnight;
  if (event.endsAt.getTime() >= midnight.getTime()) {
    return new Date(midnight.getTime() + 10 * 60 * 60 * 1000);
  }
  return midnight;
}

export type CheckinPostOffsets = {
  /** Hours before an Hourly event's scheduled start. */
  hourlyHoursBefore: number;
  /** Local time of day, the day before an All-Day event, 24h clock. */
  allDayHour: number;
  allDayMinute: number;
};

/** Starting defaults, used until a Hawk Bot admin sets the corresponding setting. */
export const DEFAULT_CHECKIN_OFFSETS: CheckinPostOffsets = {
  hourlyHoursBefore: 4,
  allDayHour: 16,
  allDayMinute: 0,
};

/**
 * Turns the raw `checkin_offset_hourly_hours`/`checkin_offset_allday_time`
 * setting strings (see domain/settings.ts) into offsets, falling back to
 * DEFAULT_CHECKIN_OFFSETS for whichever isn't set. The one place this rule
 * is applied — the scheduler and the manual test-event command both read
 * settings via the same I/O, then call this so they can't drift apart.
 */
export function resolveCheckinOffsets(
  hourlyHoursSetting: string | undefined,
  allDayTimeSetting: string | undefined
): CheckinPostOffsets {
  const [allDayHour, allDayMinute] = allDayTimeSetting
    ? allDayTimeSetting.split(":").map(Number)
    : [
        DEFAULT_CHECKIN_OFFSETS.allDayHour,
        DEFAULT_CHECKIN_OFFSETS.allDayMinute,
      ];
  return {
    hourlyHoursBefore: hourlyHoursSetting
      ? Number(hourlyHoursSetting)
      : DEFAULT_CHECKIN_OFFSETS.hourlyHoursBefore,
    allDayHour: allDayHour ?? DEFAULT_CHECKIN_OFFSETS.allDayHour,
    allDayMinute: allDayMinute ?? DEFAULT_CHECKIN_OFFSETS.allDayMinute,
  };
}

export function checkinPostTime(
  event: { meetingType: CalendarMeetingType; startsAt: Date },
  offsets: CheckinPostOffsets
): Date {
  if (event.meetingType === "hourly") {
    return new Date(
      event.startsAt.getTime() - offsets.hourlyHoursBefore * 60 * 60 * 1000
    );
  }
  return new Date(
    event.startsAt.getFullYear(),
    event.startsAt.getMonth(),
    event.startsAt.getDate() - 1,
    offsets.allDayHour,
    offsets.allDayMinute
  );
}

export type EventChange =
  | { kind: "unchanged" }
  | { kind: "edited"; changedFields: string[] }
  | { kind: "removed" };

const COMPARABLE_FIELDS: readonly [
  keyof Pick<MappedEvent, "title" | "description" | "location">,
  string,
][] = [
  ["title", "title"],
  ["description", "description"],
  ["location", "location"],
];

/**
 * Classifies what happened to a calendar entry between two syncs. A
 * removal wins over any other field change — once an event is cancelled,
 * nothing else about it matters for Calendar Change Handling.
 */
export function diffEvent(
  previous: MappedEvent,
  current: MappedEvent
): EventChange {
  if (current.cancelled) return { kind: "removed" };

  const changedFields: string[] = [];
  for (const [field, label] of COMPARABLE_FIELDS) {
    if (previous[field] !== current[field]) changedFields.push(label);
  }
  if (previous.startsAt.getTime() !== current.startsAt.getTime()) {
    changedFields.push("start time");
  }
  if (previous.endsAt.getTime() !== current.endsAt.getTime()) {
    changedFields.push("end time");
  }

  return changedFields.length === 0
    ? { kind: "unchanged" }
    : { kind: "edited", changedFields };
}
