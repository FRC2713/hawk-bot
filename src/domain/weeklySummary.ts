/**
 * Weekly Summary Post: timing, the week it covers, and how it reflects
 * changes through that week. Pure data and pure functions — no Slack, no
 * database — so the rules are testable without either, same as
 * domain/calendar.ts and domain/attendance.ts.
 *
 * Day/time math is a wall-clock concept, so this module reads and builds
 * Dates with local-time methods and relies on the process's `TZ`
 * environment variable (see config.ts), same convention as domain/calendar.ts.
 */
import type { CalendarMeetingType } from "./calendar.js";

export type WeeklySummaryTiming = {
  /** 0 = Sunday .. 6 = Saturday, matching Date's local getDay(). */
  dayOfWeek: number;
  hour: number;
  minute: number;
};

/** Starting default, used until a HawkBot Admin sets `weekly_summary_time`. */
export const DEFAULT_WEEKLY_SUMMARY_TIMING: WeeklySummaryTiming = {
  dayOfWeek: 0,
  hour: 12,
  minute: 0,
};

const DAY_ABBREVIATIONS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Turns the raw `weekly_summary_time` setting string ("SUN 12:00") into a timing. */
export function resolveWeeklySummaryTiming(
  setting: string | undefined
): WeeklySummaryTiming {
  if (!setting) return DEFAULT_WEEKLY_SUMMARY_TIMING;
  const [dayToken, timeToken] = setting.trim().split(/\s+/);
  const [hourStr, minuteStr] = (timeToken ?? "").split(":");
  return {
    dayOfWeek: DAY_ABBREVIATIONS.indexOf((dayToken ?? "").toUpperCase()),
    hour: Number(hourStr),
    minute: Number(minuteStr),
  };
}

/** The most recent local occurrence of `timing` at or before `now`. */
function mostRecentOccurrenceOnOrBefore(
  now: Date,
  timing: WeeklySummaryTiming
): Date {
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    timing.hour,
    timing.minute
  );
  const daysSinceTarget = (candidate.getDay() - timing.dayOfWeek + 7) % 7;
  candidate.setDate(candidate.getDate() - daysSinceTarget);
  if (candidate.getTime() > now.getTime()) {
    candidate.setDate(candidate.getDate() - 7);
  }
  return candidate;
}

/**
 * True once the configured day/time has occurred since the last post (or
 * if nothing has ever posted) — so a missed tick catches up on the next
 * one instead of waiting a full week.
 */
export function isWeeklySummaryDue(
  lastPostedAt: Date | null,
  timing: WeeklySummaryTiming,
  now: Date
): boolean {
  const occurrence = mostRecentOccurrenceOnOrBefore(now, timing);
  return !lastPostedAt || lastPostedAt.getTime() < occurrence.getTime();
}

/** Local midnight of the next Monday strictly after `date`'s calendar day. */
function nextMondayStrictlyAfter(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const daysUntilMonday = (1 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMonday);
  return d;
}

export type WeekRange = { start: Date; end: Date };

/** The fixed Monday–Sunday week a Weekly Summary Post posted at `postedAt` covers. */
export function upcomingWeekRange(postedAt: Date): WeekRange {
  const start = nextMondayStrictlyAfter(postedAt);
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 7
  );
  return { start, end };
}

/**
 * Two consecutive Monday–Sunday weeks, starting the same Monday
 * `upcomingWeekRange` would — the Mentor/Teacher Weekly Summary's span,
 * wider than the Team Meeting Weekly Summary's so unavailability and travel
 * conflicts surface with more lead time.
 */
export function upcomingTwoWeekRange(postedAt: Date): WeekRange {
  const { start } = upcomingWeekRange(postedAt);
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 14
  );
  return { start, end };
}

/** Whether `date` falls within a Weekly Summary Post's week — the routing rule for Change Reflection. */
export function isWithinWeek(date: Date, range: WeekRange): boolean {
  return (
    date.getTime() >= range.start.getTime() &&
    date.getTime() < range.end.getTime()
  );
}

export type WeeklySummaryEventInfo = {
  title: string;
  meetingType: CalendarMeetingType;
  startsAt: Date;
  /**
   * For `multi_day`, this is Google's own exclusive end date (the day after
   * the last day), not an inclusive end — same convention as
   * domain/calendar.ts's MappedEvent.
   */
  endsAt: Date;
  location: string;
};

const DATE_FMT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
};
const TIME_FMT: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
};
const DAY_MS = 24 * 60 * 60 * 1000;

function formatWhen(info: WeeklySummaryEventInfo): string {
  if (info.meetingType === "hourly") {
    return `${info.startsAt.toLocaleDateString("en-US", DATE_FMT)}, ${info.startsAt.toLocaleTimeString("en-US", TIME_FMT)}–${info.endsAt.toLocaleTimeString("en-US", TIME_FMT)}`;
  }
  if (info.meetingType === "all_day") {
    return info.startsAt.toLocaleDateString("en-US", DATE_FMT);
  }
  const inclusiveEnd = new Date(info.endsAt.getTime() - DAY_MS);
  return `${info.startsAt.toLocaleDateString("en-US", DATE_FMT)} – ${inclusiveEnd.toLocaleDateString("en-US", DATE_FMT)}`;
}

/** One event's line: title, when, and location — the building block every render case shares. */
export function formatWeeklySummaryLine(info: WeeklySummaryEventInfo): string {
  const parts = [`*${info.title}*`, formatWhen(info)];
  if (info.location) parts.push(`📍 ${info.location}`);
  return parts.join(" — ");
}

/**
 * An edited Event: the snapshot (as first shown this week, never a chain of
 * every intermediate edit) struck through, plus a fresh current line and
 * which fields changed.
 */
export function renderEditedLine(args: {
  snapshot: WeeklySummaryEventInfo;
  current: WeeklySummaryEventInfo;
  changedFields: readonly string[];
}): string {
  return [
    `~${formatWeeklySummaryLine(args.snapshot)}~`,
    `${formatWeeklySummaryLine(args.current)} _(updated: ${args.changedFields.join(", ")})_`,
  ].join("\n");
}

/** A removed Event: struck through and labeled, staying visible rather than deleted from the listing. */
export function renderRemovedLine(snapshot: WeeklySummaryEventInfo): string {
  return `~${formatWeeklySummaryLine(snapshot)}~ _(removed)_`;
}

/** An Event discovered after the summary's initial post — tagged, not struck through (no "original" to contrast). */
export function renderNewLine(current: WeeklySummaryEventInfo): string {
  return `🆕 _New_ ${formatWeeklySummaryLine(current)}`;
}

/**
 * Which displayed fields differ between an Event's snapshot and its current
 * state — same field labels Calendar Change Handling's diffEvent uses, kept
 * separate since a Weekly Summary snapshot doesn't carry every field an
 * Event has (no description, since it isn't shown in a summary line).
 */
export function weeklySummaryChangedFields(
  snapshot: WeeklySummaryEventInfo,
  current: WeeklySummaryEventInfo
): string[] {
  const fields: string[] = [];
  if (snapshot.title !== current.title) fields.push("title");
  if (snapshot.location !== current.location) fields.push("location");
  if (snapshot.startsAt.getTime() !== current.startsAt.getTime()) {
    fields.push("start time");
  }
  if (snapshot.endsAt.getTime() !== current.endsAt.getTime()) {
    fields.push("end time");
  }
  return fields;
}

export type WeeklySummaryLineEntry = {
  /** The Event's start, purely for ordering — never shown. */
  sortKey: Date;
  text: string;
};

/**
 * Assembles the full message body, sorted chronologically regardless of
 * input order. `label` and `emptyText` default to the Team Meeting Weekly
 * Summary's own wording; the Informational reply and Mentor/Teacher Weekly
 * Summary override `label` so each reads as its own digest rather than a
 * repeat of "This Week".
 */
export function assembleWeeklySummaryMessage(args: {
  weekStart: Date;
  weekEnd: Date;
  entries: readonly WeeklySummaryLineEntry[];
  label?: string;
  emptyText?: string;
}): string {
  const lastDay = new Date(args.weekEnd.getTime() - DAY_MS);
  const label = args.label ?? "This Week";
  const header = `*${label}* — ${args.weekStart.toLocaleDateString("en-US", DATE_FMT)} to ${lastDay.toLocaleDateString("en-US", DATE_FMT)}`;

  if (args.entries.length === 0) {
    return [
      header,
      args.emptyText ?? "_Nothing on the calendar this week._",
    ].join("\n\n");
  }

  const sorted = [...args.entries].sort(
    (a, b) => a.sortKey.getTime() - b.sortKey.getTime()
  );
  return [header, ...sorted.map((e) => e.text)].join("\n\n");
}
