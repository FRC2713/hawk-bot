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
