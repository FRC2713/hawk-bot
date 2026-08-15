/**
 * No Response Alert Report: the streak rule and message format for flagging
 * anyone on the Roster whose most recent tracked meetings were all No
 * Response. Pure data and pure functions — no Slack, no database — same
 * convention as domain/attendance.ts and domain/weeklySummary.ts.
 */
import { DATE_FMT, type WeeklySummaryTiming } from "./weeklySummary.js";

export type RecentMeetingOutcome = {
  status: "attending" | "not_attending" | null;
  title: string;
  startsAt: Date;
};

/** Starting default, used until a HawkBot Admin sets `no_response_alert_threshold`. */
export const DEFAULT_NO_RESPONSE_ALERT_THRESHOLD = 3;

/** Turns the raw `no_response_alert_threshold` setting string into a number. */
export function resolveNoResponseAlertThreshold(
  setting: string | undefined
): number {
  return setting ? Number(setting) : DEFAULT_NO_RESPONSE_ALERT_THRESHOLD;
}

/**
 * Starting default, used until a HawkBot Admin sets `no_response_alert_time`
 * — Monday 9am, deliberately distinct from the Weekly Summary Post's Sunday
 * noon default, so the two schedules don't collide when both are left unset.
 */
export const DEFAULT_NO_RESPONSE_ALERT_TIMING: WeeklySummaryTiming = {
  dayOfWeek: 1,
  hour: 9,
  minute: 0,
};

/**
 * True only when there are at least `threshold` outcomes available (this is
 * what protects a brand-new team member from being judged on history they
 * don't have) and every one of the most recent `threshold` is No Response.
 * `recentOutcomes` must already be ordered newest-first; any older history
 * beyond the trailing window never dilutes it, and a single real response
 * (Attending or Not Attending) anywhere inside the window breaks it.
 */
export function isNoResponseStreak(
  recentOutcomes: readonly RecentMeetingOutcome[],
  threshold: number
): boolean {
  if (recentOutcomes.length < threshold) return false;
  return recentOutcomes
    .slice(0, threshold)
    .every((outcome) => outcome.status === null);
}

export type FlaggedPerson = {
  displayName: string;
  missedMeetings: readonly { title: string; startsAt: Date }[];
};

/**
 * The No Response Alert Report's single message — no thread, unlike the
 * Event Attendance Report, since this is a short, scannable list rather
 * than a per-event breakdown. One block per flagged person: bold name, then
 * one `date – title` line per meeting they missed, in the order given.
 */
export function formatNoResponseAlertMessage(args: {
  threshold: number;
  flagged: readonly FlaggedPerson[];
}): string {
  const header = `*No response, ${args.threshold} meetings in a row*`;
  const blocks = args.flagged.map((person) => {
    const lines = person.missedMeetings.map(
      (m) => `${m.startsAt.toLocaleDateString("en-US", DATE_FMT)} – ${m.title}`
    );
    return [`*${person.displayName}*`, ...lines].join("\n");
  });
  return [header, ...blocks].join("\n\n");
}
