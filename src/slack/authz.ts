import type { WebClient } from "@slack/web-api";
import { getSetting } from "../db/repo.js";
import { isHawkBotAdmin as decideHawkBotAdmin } from "../domain/authorization.js";
import { log } from "../logger.js";

const TTL_MS = 5 * 60 * 1000;

/**
 * The HawkBot Admin group's member ids, for whichever group `admin_usergroup`
 * currently resolves to. Keyed by group id rather than a single slot, so
 * changing the setting is a cache miss rather than something that needs
 * explicit invalidation.
 */
let groupCache: { groupId: string; memberIds: Set<string>; at: number } | null =
  null;

async function groupMemberIds(
  client: WebClient,
  groupId: string
): Promise<Set<string>> {
  if (
    groupCache &&
    groupCache.groupId === groupId &&
    Date.now() - groupCache.at < TTL_MS
  ) {
    return groupCache.memberIds;
  }
  try {
    const res = await client.usergroups.users.list({ usergroup: groupId });
    const memberIds = new Set(res.users ?? []);
    groupCache = { groupId, memberIds, at: Date.now() };
    return memberIds;
  } catch (error) {
    // Stale-but-cached beats "everyone locked out because Slack hiccupped".
    if (groupCache?.groupId === groupId) return groupCache.memberIds;
    log.warn("could not resolve HawkBot Admin group membership", {
      groupId,
      error: String(error),
    });
    return new Set();
  }
}

/** The `admin_usergroup` setting's member set, or empty if it isn't set yet. */
function configuredGroupMemberIds(client: WebClient): Promise<Set<string>> {
  const groupId = getSetting("admin_usergroup");
  return groupId ? groupMemberIds(client, groupId) : Promise.resolve(new Set());
}

const ownerCache = new Map<string, { value: boolean; at: number }>();

async function isWorkspaceOwner(
  client: WebClient,
  userId: string
): Promise<boolean> {
  const cached = ownerCache.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const res = await client.users.info({ user: userId });
    const u = res.user;
    const value = Boolean(u?.is_owner || u?.is_primary_owner);
    ownerCache.set(userId, { value, at: Date.now() });
    return value;
  } catch (error) {
    log.warn("could not resolve workspace Owner status", {
      userId,
      error: String(error),
    });
    return false;
  }
}

/**
 * Authority for every admin-gated capability. Membership in the
 * `admin_usergroup` setting's Slack User Group grants it; a workspace Owner
 * always has it too, regardless of the group's state — see ADR-0004 and
 * CONTEXT.md, HawkBot Admin. The actual decision is domain/authorization.ts;
 * this just gathers the two inputs it needs from Slack.
 */
export async function isHawkBotAdmin(
  client: WebClient,
  userId: string
): Promise<boolean> {
  const [memberIds, owner] = await Promise.all([
    configuredGroupMemberIds(client),
    isWorkspaceOwner(client, userId),
  ]);
  return decideHawkBotAdmin({
    userId,
    groupMemberIds: memberIds,
    isWorkspaceOwner: owner,
  });
}

/** Test seam, and what a role/group change calls so it takes effect immediately. */
export function forgetAdminStatus(userId?: string): void {
  if (userId) ownerCache.delete(userId);
  else ownerCache.clear();
  groupCache = null;
}

async function listWorkspaceOwners(client: WebClient): Promise<string[]> {
  try {
    const res = await client.users.list({});
    return (res.members ?? [])
      .filter((u) => u.is_owner || u.is_primary_owner)
      .map((u) => u.id)
      .filter((id): id is string => Boolean(id));
  } catch (error) {
    log.warn("could not list workspace Owners", { error: String(error) });
    return [];
  }
}

/**
 * Every HawkBot Admin, for the Reaction Cutoff Verification failure DM —
 * every one of them gets notified, not just a single designated recipient.
 * See CONTEXT.md, Reaction Cutoff Verification.
 */
export async function listHawkBotAdmins(client: WebClient): Promise<string[]> {
  const [memberIds, owners] = await Promise.all([
    configuredGroupMemberIds(client),
    listWorkspaceOwners(client),
  ]);
  return [...new Set([...memberIds, ...owners])];
}
