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
  /** Google's own direct link to view the event, e.g. for Calendar Change Handling. */
  htmlLink?: string;
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
  calendarLink: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A calendar all-day date ("2026-01-10") as local midnight of that day. */
function parseDateOnly(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** The inverse of `parseDateOnly` — a local calendar date as "YYYY-MM-DD". */
function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
    calendarLink: raw.htmlLink ?? null,
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

/**
 * A Multi-Day Event's synthetic per-day Child — an ordinary All-Day Event
 * that gets its own Event Check-in Post, Reaction Cutoff, and Event
 * Attendance Report, reusing that machinery unmodified (see CONTEXT.md,
 * Multi-Day Child Event). `checkinAt` is identical across every Child of
 * the same Multi-Day Event — front-loaded, N days before the span's first
 * day — but each Child's own Reaction Cutoff (computed by the caller via
 * the existing `reactionCutoff()`, keyed to that Child's own
 * `startsAt`/`endsAt`) still lands independently at the end of its own day.
 */
export type MultiDayChildSpec = {
  calendarEventId: string;
  dayNumber: number;
  title: string;
  meetingType: "all_day";
  startsAt: Date;
  endsAt: Date;
  checkinAt: Date;
};

/**
 * A Multi-Day Event longer than this many days is flagged for a HawkBot
 * Admin to handle manually rather than generating Children for it — see
 * CONTEXT.md, Multi-Day Child Event. Comfortably above any realistic FRC
 * competition length.
 */
export const MULTI_DAY_MAX_DAYS = 10;

export type MultiDayChildEventsResult =
  { ok: true; children: MultiDayChildSpec[] } | { ok: false; dayCount: number };

/**
 * One Multi-Day Child per calendar day of the span, `Day N of M` baked into
 * each title at generation time. `endsAt` follows the same Google
 * exclusive-end convention as every other All-Day Event (see MappedEvent).
 *
 * Each Child's `calendarEventId` is keyed by its actual calendar date
 * (`<parent id>::YYYY-MM-DD`), not by its offset from the start of the
 * current span — a span shift (the whole event moving a day earlier or
 * later, not just growing or shrinking) still identifies "the day that is
 * Mar 6" as the same Child it always was, so `reconcileMultiDayChildren`
 * only ever creates/removes the days that actually entered or left the
 * span, and never reattaches one day's already-collected attendance to a
 * different date.
 */
export function multiDayChildEvents(
  parent: {
    calendarEventId: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
  },
  offsets: CheckinPostOffsets,
  multiDayDaysBefore: number
): MultiDayChildEventsResult {
  const dayCount = Math.round(
    (parent.endsAt.getTime() - parent.startsAt.getTime()) / DAY_MS
  );
  if (dayCount > MULTI_DAY_MAX_DAYS) return { ok: false, dayCount };

  const checkinAt = new Date(
    parent.startsAt.getFullYear(),
    parent.startsAt.getMonth(),
    parent.startsAt.getDate() - multiDayDaysBefore,
    offsets.allDayHour,
    offsets.allDayMinute
  );

  const children: MultiDayChildSpec[] = [];
  for (let i = 0; i < dayCount; i++) {
    const dayNumber = i + 1;
    const startsAt = new Date(
      parent.startsAt.getFullYear(),
      parent.startsAt.getMonth(),
      parent.startsAt.getDate() + i
    );
    children.push({
      calendarEventId: `${parent.calendarEventId}::${formatDateOnly(startsAt)}`,
      dayNumber,
      title: `${parent.title} (Day ${dayNumber} of ${dayCount})`,
      meetingType: "all_day",
      startsAt,
      endsAt: midnightEnding(startsAt),
      checkinAt,
    });
  }
  return { ok: true, children };
}

/** The "(Day N of M)" suffix `multiDayChildEvents` bakes into a Child's title. */
const DAY_SUFFIX_RE = / \(Day \d+ of \d+\)$/;

/**
 * Strips a Child's Day-N-of-M suffix, so its title can be compared for a
 * real edit without a shift in M — the total day count, which changes
 * whenever any day (not necessarily this one) is added to or dropped from
 * the span — being mistaken for an edit to this day's own title.
 */
export function withoutDaySuffix(title: string): string {
  return title.replace(DAY_SUFFIX_RE, "");
}

/** Starting default, used until a Hawk Bot admin sets `checkin_offset_multiday_days`. */
export const DEFAULT_MULTIDAY_DAYS_BEFORE = 2;

export function resolveMultiDayDaysBefore(setting: string | undefined): number {
  return setting ? Number(setting) : DEFAULT_MULTIDAY_DAYS_BEFORE;
}

/**
 * Diffs a Multi-Day Event's currently-stored Child ids against the set its
 * (possibly just-edited) span now calls for — which Children to create for
 * a newly added day, and which to mark removed for a dropped one. Pure: the
 * caller decides what removal actually means for an already-finalized
 * Child (never retroactively altered) versus one that hasn't posted yet.
 */
export function reconcileMultiDayChildren(
  existingChildCalendarEventIds: readonly string[],
  desiredChildCalendarEventIds: readonly string[]
): { toCreate: string[]; toRemove: string[] } {
  const existingSet = new Set(existingChildCalendarEventIds);
  const desiredSet = new Set(desiredChildCalendarEventIds);
  return {
    toCreate: desiredChildCalendarEventIds.filter((id) => !existingSet.has(id)),
    toRemove: existingChildCalendarEventIds.filter((id) => !desiredSet.has(id)),
  };
}

/**
 * The next `count` non-cancelled events starting at or after `now`, earliest
 * first — what "upcoming" means for a calendar preview. Shared by any
 * feature that needs to show what's coming up on a calendar, so the rule
 * lives here once rather than being re-decided (and re-tested, or not
 * tested at all) at each call site.
 */
export function upcomingEvents(
  events: readonly MappedEvent[],
  now: Date,
  count: number
): MappedEvent[] {
  return events
    .filter((e) => !e.cancelled && e.startsAt.getTime() >= now.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, count);
}
