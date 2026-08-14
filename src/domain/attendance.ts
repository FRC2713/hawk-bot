/**
 * Attendance rules for Event Check-in Posts: reaction to status, hours
 * credited, Season boundaries, and CSV shaping. Pure data and pure
 * functions — no Slack, no database — so the rules are testable without
 * either, same as domain/settings.ts.
 */

const CLOCK_HOUR_NAMES: readonly string[] = Array.from(
  { length: 12 },
  (_, i) => {
    const hour = i + 1;
    return [`clock${hour}`, `clock${hour}30`];
  }
).flat();

/** Slack's clock-face set, plus the other emoji people reach for to mean "time". */
const CLOCK_REACTION_NAMES = new Set([
  ...CLOCK_HOUR_NAMES,
  "alarm_clock",
  "stopwatch",
  "timer_clock",
]);

const THUMBS_UP_NAMES = new Set(["+1", "thumbsup"]);

/** Slack appends `::skin-tone-N` to a reaction name; the category ignores it. */
function baseReactionName(emojiName: string): string {
  return emojiName.split("::")[0] ?? emojiName;
}

export function isThumbsUpReaction(emojiName: string): boolean {
  return THUMBS_UP_NAMES.has(baseReactionName(emojiName));
}

export function isClockReaction(emojiName: string): boolean {
  return CLOCK_REACTION_NAMES.has(baseReactionName(emojiName));
}

export type AttendanceStatus = "attending" | "not_attending" | "no_response";

/**
 * The whole of the attendance rule: a 👍 (any skin tone) is Attending, no
 * matter what else is present. Anything else present with no 👍 is Not
 * Attending. Nothing at all is No Response. See ADR-0003.
 */
export function attendanceStatusFor(
  emojiNames: readonly string[]
): AttendanceStatus {
  if (emojiNames.length === 0) return "no_response";
  return emojiNames.some(isThumbsUpReaction) ? "attending" : "not_attending";
}

/**
 * True when a Clock Reaction is present without a 👍 from the same person —
 * they likely meant "I'm coming, just late" but will land in Not Attending
 * unless nudged to add 👍 too.
 */
export function needsLateNudge(emojiNames: readonly string[]): boolean {
  return (
    emojiNames.some(isClockReaction) && !emojiNames.some(isThumbsUpReaction)
  );
}

export type MeetingType = "hourly" | "all_day";

/** Starting default, used until a Hawk Bot admin sets `default_all_day_hours`. */
export const DEFAULT_ALL_DAY_HOURS = 8;

export function hoursCredited(args: {
  meetingType: MeetingType;
  startsAt: Date;
  endsAt: Date;
  defaultAllDayHours: number;
}): number {
  if (args.meetingType === "all_day") return args.defaultAllDayHours;
  const ms = args.endsAt.getTime() - args.startsAt.getTime();
  return ms / (1000 * 60 * 60);
}

export type SeasonRange = { start: Date; end: Date };

/**
 * Season is fixed at July 1 – June 30, not yet configurable. "July 1" is a
 * wall-clock date, so this reads `now` with local-time methods and relies
 * on the process's `TZ` environment variable (see config.ts).
 */
export function currentSeasonRange(now: Date): SeasonRange {
  const july = 6; // getMonth is zero-indexed
  const startYear =
    now.getMonth() > july || (now.getMonth() === july && now.getDate() >= 1)
      ? now.getFullYear()
      : now.getFullYear() - 1;
  const start = new Date(startYear, july, 1);
  const end = new Date(startYear + 1, july, 1);
  return { start, end };
}

export function attendancePercent(
  attending: number,
  notAttending: number,
  noResponse: number
): number {
  const total = attending + notAttending + noResponse;
  if (total === 0) return 0;
  return Math.round((attending / total) * 100);
}

export type AttendanceCsvRow = {
  userId: string;
  displayName: string;
  eventsAttending: number;
  eventsNotAttending: number;
  eventsNoResponse: number;
  hoursCredited: number;
};

const CSV_HEADER =
  "user_id,display_name,attending,not_attending,no_response,attendance_percent,hours_credited";

function csvField(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toAttendanceCsv(rows: readonly AttendanceCsvRow[]): string {
  const lines = rows.map((row) => {
    const percent = attendancePercent(
      row.eventsAttending,
      row.eventsNotAttending,
      row.eventsNoResponse
    );
    return [
      csvField(row.userId),
      csvField(row.displayName),
      csvField(row.eventsAttending),
      csvField(row.eventsNotAttending),
      csvField(row.eventsNoResponse),
      csvField(percent),
      csvField(row.hoursCredited),
    ].join(",");
  });
  return [CSV_HEADER, ...lines].join("\n") + "\n";
}
