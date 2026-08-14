import type { WebClient } from "@slack/web-api";
import { log } from "../logger.js";

/**
 * Authority comes from Slack, not from a list in this app.
 *
 * The workspace already knows who runs the team — Owners and Admins are the
 * people the coaches actually trust with it. A second roster here would be one
 * more thing to keep current, and the failure mode of a stale one is someone
 * still holding a permission after they have left.
 */
export async function isWorkspaceAdmin(
  client: WebClient,
  userId: string
): Promise<boolean> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const res = await client.users.info({ user: userId });
    const u = res.user;
    const value = Boolean(u?.is_admin || u?.is_owner || u?.is_primary_owner);
    cache.set(userId, { value, at: Date.now() });
    return value;
  } catch (error) {
    // Denying on error is the safe direction, but it presents as "the bot
    // ignored me", so say why in the log — the usual cause is a missing
    // `users:read` scope after a manifest edit.
    log.warn("could not resolve admin status", {
      userId,
      error: String(error),
    });
    return false;
  }
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: boolean; at: number }>();

/** Test seam, and what a role change calls so it takes effect immediately. */
export function forgetAdminStatus(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
