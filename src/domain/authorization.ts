/**
 * HawkBot Admin: the single decision behind every admin-gated capability
 * (`/hawkbot config`, `/hawkbot event create`, the season CSV export, and the
 * Reaction Cutoff Verification failure DM). Pure data and a pure function —
 * no Slack — so the rule, including the Owner fallback, is testable
 * without a live workspace. See ADR-0004 and CONTEXT.md, HawkBot Admin.
 */
export function isHawkBotAdmin(args: {
  userId: string;
  groupMemberIds: ReadonlySet<string>;
  isWorkspaceOwner: boolean;
}): boolean {
  // A Slack workspace Owner always qualifies, regardless of the HawkBot
  // Admin group's state — otherwise an empty or unconfigured group would
  // mean nobody could run the command needed to fix it.
  return args.isWorkspaceOwner || args.groupMemberIds.has(args.userId);
}

export type TeamRole = "student" | "mentor" | "skipped";

/**
 * Team Role: which Roster members the No Response Alert Report is allowed
 * to evaluate, decided from `student_usergroup`/`mentor_usergroup`
 * membership — no Slack, no database, same shape as `isHawkBotAdmin`. A
 * double-membership tie favors Student over Mentor, deliberately, since the
 * report's whole purpose is catching real student disengagement; someone in
 * neither group is skipped rather than defaulted into either role, so an
 * unclassified channel guest (a parent, alum, etc.) is never evaluated. See
 * CONTEXT.md, Roster.
 */
export function resolveTeamRole(args: {
  userId: string;
  studentGroupMemberIds: ReadonlySet<string>;
  mentorGroupMemberIds: ReadonlySet<string>;
}): TeamRole {
  if (args.studentGroupMemberIds.has(args.userId)) return "student";
  if (args.mentorGroupMemberIds.has(args.userId)) return "mentor";
  return "skipped";
}
