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

export type TeamRole = "student" | "mentor";

/**
 * Which of the No Response Alert Report's two threaded lists someone
 * belongs on, decided from `student_usergroup`/`mentor_usergroup`
 * membership — no Slack, no database. Membership in both groups returns
 * both roles, deliberately: the report lists that person under Students
 * *and* Mentors rather than picking one identity for them, since each
 * list is read by a different audience. Someone in neither group returns
 * no roles and is skipped entirely, so an unclassified channel guest (a
 * parent, alum, etc.) is never evaluated. See CONTEXT.md, Roster.
 */
export function resolveNoResponseAlertRoles(args: {
  userId: string;
  studentGroupMemberIds: ReadonlySet<string>;
  mentorGroupMemberIds: ReadonlySet<string>;
}): readonly TeamRole[] {
  const roles: TeamRole[] = [];
  if (args.studentGroupMemberIds.has(args.userId)) roles.push("student");
  if (args.mentorGroupMemberIds.has(args.userId)) roles.push("mentor");
  return roles;
}

export type FlaggedPerson = {
  displayName: string;
  missedMeetings: readonly { title: string; startsAt: Date }[];
};

/**
 * The No Response Alert Report's top-level message — same
 * summary-then-threaded-detail split as the Event Attendance Report, to
 * keep the channel itself down to one line per week.
 */
export function formatNoResponseAlertSummary(args: {
  threshold: number;
}): string {
  return `*Report: Missed ${args.threshold} meetings with no response*`;
}

const ROLE_LABEL: Record<TeamRole, string> = {
  student: "Students",
  mentor: "Mentors",
};

function meetingLine(m: { title: string; startsAt: Date }): string {
  return `${m.startsAt.toLocaleDateString("en-US", DATE_FMT)} – ${m.title}`;
}

function sameMeetings(
  a: readonly { title: string; startsAt: Date }[],
  b: readonly { title: string; startsAt: Date }[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      m.title === other.title &&
      m.startsAt.getTime() === other.startsAt.getTime()
    );
  });
}

/**
 * The shared missed-meeting list, if every flagged person's is identical —
 * the common case, since `event_roster` snapshots the whole channel per
 * event (see noResponseAlert.ts), so anyone with continuous membership
 * shares the same trailing window. Undefined the moment even one person's
 * window differs, which happens for roster churn (a recent join, or a
 * leave-then-rejoin) — and matters, because that person's window is the
 * correct one for them, not a stale copy of the group's. A lone flagged
 * person is never "uniform" — with nobody to share the list with there's
 * nothing to collapse.
 */
function uniformMeetingList(
  flagged: readonly FlaggedPerson[]
): readonly { title: string; startsAt: Date }[] | undefined {
  const [first, ...rest] = flagged;
  if (!first || rest.length === 0) return undefined;
  return rest.every((p) => sameMeetings(p.missedMeetings, first.missedMeetings))
    ? first.missedMeetings
    : undefined;
}

/**
 * One of the two threaded replies under the summary — Students and Mentors
 * post separately, each headed by its own role label, so a channel that
 * only cares about one audience can mute or skim the other thread.
 *
 * When every flagged person in the list shares the same missed meetings
 * (the common case — see `uniformMeetingList`), the meeting list is printed
 * once and names are just bulleted underneath, instead of repeating the
 * same three lines per person. Falls back to one block per person (bold
 * name, then its own `date – title` lines) the moment even one person's
 * window differs, so nobody's report is ever built from someone else's
 * attendance history.
 */
export function formatNoResponseAlertDetail(args: {
  role: TeamRole;
  flagged: readonly FlaggedPerson[];
}): string {
  const header = `*${ROLE_LABEL[args.role]}*`;

  const shared = uniformMeetingList(args.flagged);
  if (shared) {
    const meetings = shared.map(meetingLine).join("\n");
    const names = args.flagged.map((p) => `• ${p.displayName}`).join("\n");
    return [header, meetings, names].join("\n\n");
  }

  const blocks = args.flagged.map((person) =>
    [`*${person.displayName}*`, ...person.missedMeetings.map(meetingLine)].join(
      "\n"
    )
  );
  return [header, ...blocks].join("\n\n");
}
