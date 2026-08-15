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

/**
 * The same rule as needsLateNudge, re-derived from an already-resynced
 * attendance row's status/has_clock_reaction instead of a live reaction
 * list — what the nudge's delayed re-check reads, so confirming someone
 * still lacks a 👍 doesn't need a second Slack fetch just to ask that.
 */
export function stillNeedsLateNudge(row: {
  status: "attending" | "not_attending" | null;
  hasClockReaction: boolean;
}): boolean {
  return row.status === "not_attending" && row.hasClockReaction;
}

export type MeetingType = "hourly" | "all_day";

/** Starting default, used until a Hawk Bot admin sets `default_all_day_hours`. */
export const DEFAULT_ALL_DAY_HOURS = 8;

/** Turns the raw `default_all_day_hours` setting string into a number. */
export function resolveAllDayHours(setting: string | undefined): number {
  return setting ? Number(setting) : DEFAULT_ALL_DAY_HOURS;
}

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

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: "resync_failed" }
  | { ok: false; reason: "coverage_mismatch"; missingUserIds: string[] };

/**
 * Reaction Cutoff Verification: the resync's own Slack calls have to have
 * succeeded, and every person with a currently-qualifying reaction has to
 * have a matching attendance record. A stale record for someone who since
 * removed their reaction is not a failure — only a reaction with nothing
 * recorded for it is, since that's the shape of bug this guards against.
 */
export function verifyAttendanceCoverage(args: {
  resyncSucceeded: boolean;
  reactedUserIds: readonly string[];
  recordedUserIds: readonly string[];
}): VerificationResult {
  if (!args.resyncSucceeded) return { ok: false, reason: "resync_failed" };
  const recorded = new Set(args.recordedUserIds);
  const missingUserIds = args.reactedUserIds.filter((id) => !recorded.has(id));
  if (missingUserIds.length > 0) {
    return { ok: false, reason: "coverage_mismatch", missingUserIds };
  }
  return { ok: true };
}

/** One plain-English description of a failed verification, shared by the admin DM and the retry command's reply. */
export function describeVerificationFailure(
  result: Extract<VerificationResult, { ok: false }>
): string {
  return result.reason === "resync_failed"
    ? "the reaction resync failed (a Slack API call errored)"
    : `${result.missingUserIds.length} reacted user(s) have no matching attendance record`;
}

export type AttendanceReportRow = {
  displayName: string;
  status: AttendanceStatus;
  /** Raw reaction names, e.g. ["+1", "clock3"]; empty for No Response. */
  reactions: readonly string[];
  note: string | null;
};

/**
 * The Event Attendance Report's top-level channel message — kept to a
 * couple of lines. States hours per attendee, not a summed total, since
 * every Attending person on one Event is credited the same hours. Past
 * tense throughout — this posts after the Reaction Cutoff, once responses
 * are locked, so it's reporting what happened, not what's expected to.
 */
export function formatAttendanceReportSummary(args: {
  eventTitle: string;
  rows: readonly AttendanceReportRow[];
  hoursPerAttendee: number;
}): string {
  const attending = args.rows.filter((r) => r.status === "attending").length;
  const notAttending = args.rows.filter(
    (r) => r.status === "not_attending"
  ).length;
  const noResponse = args.rows.filter((r) => r.status === "no_response").length;
  return [
    `*${args.eventTitle}*`,
    `${attending} attended (${args.hoursPerAttendee} hrs each) · ${notAttending} didn't attend · ${noResponse} no response`,
  ].join("\n");
}

/** Past tense, same reasoning as the summary above — reported after the fact. */
const STATUS_LABEL: Record<AttendanceStatus, string> = {
  attending: "Attended",
  not_attending: "Didn't Attend",
  no_response: "No Response",
};

/**
 * The Event Attendance Report's threaded detail: one aligned row per
 * person — name, derived status (so a reader doesn't need to know the
 * 👍-wins-regardless precedence rule by heart), raw reactions, and their
 * Attendance Note if any.
 */
export function formatAttendanceReportTable(
  rows: readonly AttendanceReportRow[]
): string {
  if (rows.length === 0) return "```\n(no one on the roster)\n```";

  const reactionsText = (r: AttendanceReportRow) =>
    r.reactions.length > 0 ? r.reactions.join(" ") : "—";

  const nameWidth = Math.max(4, ...rows.map((r) => r.displayName.length));
  const statusWidth = Math.max(
    6,
    ...Object.values(STATUS_LABEL).map((s) => s.length)
  );
  const reactionsWidth = Math.max(
    9,
    ...rows.map((r) => reactionsText(r).length)
  );

  const header =
    "Name".padEnd(nameWidth) +
    "  " +
    "Status".padEnd(statusWidth) +
    "  " +
    "Reactions".padEnd(reactionsWidth) +
    "  " +
    "Note";

  const lines = rows.map((r) =>
    (
      r.displayName.padEnd(nameWidth) +
      "  " +
      STATUS_LABEL[r.status].padEnd(statusWidth) +
      "  " +
      reactionsText(r).padEnd(reactionsWidth) +
      "  " +
      (r.note ?? "")
    ).trimEnd()
  );

  return ["```", header, ...lines, "```"].join("\n");
}
