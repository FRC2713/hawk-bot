import type { WebClient } from "@slack/web-api";
import type { Resolution } from "../domain/configDisplay.js";
import { log } from "../logger.js";
import { slackErrorCode } from "./slackErrors.js";

/**
 * Maps a Slack API failure from resolving a channel or usergroup name to
 * `"not_found"` or `"no_access"`, the two confirmed-problem `Resolution`
 * statuses — sibling to `describeChannelAccessError` in `channelAccess.ts`.
 * Anything outside this known set returns `undefined`, so a caller can fall
 * back to `"unknown"` (bare id, no annotation) rather than crying wolf over
 * what might just be a transient Slack hiccup.
 *
 * `channel_not_found` is Slack's code for both "that channel is gone" and "I
 * can't see that channel" (a private channel the bot isn't in) — the same
 * ambiguity `describeChannelAccessError` documents. `formatResolvedValue`
 * words the channel `not_found` message to cover both rather than asserting
 * deletion.
 */
export function describeNameResolutionError(
  err: unknown
): "not_found" | "no_access" | undefined {
  switch (slackErrorCode(err)) {
    case "channel_not_found":
      return "not_found";
    case "missing_scope":
    case "not_in_channel":
      return "no_access";
    default:
      return undefined;
  }
}

const TTL_MS = 5 * 60 * 1000;

/**
 * Every channel name this app has resolved recently for `/hawkbot config`
 * display, keyed by channel id — same shape as `groupCache`/`ownerCache` in
 * `authz.ts`. A confirmed `not_found`/`no_access` result is cached the same
 * as a success: those are stable facts (a deleted channel stays deleted),
 * and caching them is what keeps a persistently broken setting from hitting
 * Slack on every single `config` call. An unclassified/transient failure is
 * never cached, so the next call gets a fresh chance to succeed.
 */
const channelCache = new Map<string, { resolution: Resolution; at: number }>();

/** Resolves a channel id to its current name, for `/hawkbot config` display. */
export async function resolveChannelName(
  client: WebClient,
  channelId: string
): Promise<Resolution> {
  const cached = channelCache.get(channelId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.resolution;
  try {
    const res = await client.conversations.info({ channel: channelId });
    const name = res.channel?.name;
    const resolution: Resolution = name
      ? { status: "ok", name }
      : { status: "not_found" };
    channelCache.set(channelId, { resolution, at: Date.now() });
    return resolution;
  } catch (error) {
    // Stale-but-cached beats flashing "no longer resolves" over a Slack hiccup.
    if (cached) return cached.resolution;
    const known = describeNameResolutionError(error);
    if (!known) {
      log.warn("could not resolve channel name for config display", {
        channelId,
        error: String(error),
      });
      return { status: "unknown" };
    }
    const resolution: Resolution = { status: known };
    channelCache.set(channelId, { resolution, at: Date.now() });
    return resolution;
  }
}

type SlackUsergroup = NonNullable<
  Awaited<ReturnType<WebClient["usergroups"]["list"]>>["usergroups"]
>[number];

/**
 * The workspace's full usergroup list, 5-minute cached with in-flight
 * de-duplication. There's no `usergroups.info` — the only way to resolve a
 * group id to its handle is to fetch the whole list and match client-side —
 * so this is cached once at list granularity, not once per id: without this,
 * `admin_usergroup`, `student_usergroup`, and `mentor_usergroup` resolving
 * concurrently on one `/hawkbot config` call would each fire their own
 * identical full-list fetch. `include_disabled` is set so a merely-disabled
 * (not deleted) group still resolves by name rather than reading as gone.
 */
let usergroupListCache: { list: SlackUsergroup[]; at: number } | undefined;
let usergroupListInFlight: Promise<SlackUsergroup[]> | undefined;

function fetchUsergroupList(client: WebClient): Promise<SlackUsergroup[]> {
  if (usergroupListCache && Date.now() - usergroupListCache.at < TTL_MS) {
    return Promise.resolve(usergroupListCache.list);
  }
  if (usergroupListInFlight) return usergroupListInFlight;
  usergroupListInFlight = (async () => {
    try {
      const res = await client.usergroups.list({ include_disabled: true });
      const list = res.usergroups ?? [];
      usergroupListCache = { list, at: Date.now() };
      return list;
    } catch (error) {
      if (usergroupListCache) return usergroupListCache.list;
      throw error;
    } finally {
      usergroupListInFlight = undefined;
    }
  })();
  return usergroupListInFlight;
}

/** Resolves a Slack User Group id to its current handle, for `/hawkbot config` display. */
export async function resolveUsergroupHandle(
  client: WebClient,
  groupId: string
): Promise<Resolution> {
  try {
    const list = await fetchUsergroupList(client);
    const match = list.find((g) => g.id === groupId);
    return match?.handle
      ? { status: "ok", name: match.handle }
      : { status: "not_found" };
  } catch (error) {
    const known = describeNameResolutionError(error);
    if (!known) {
      log.warn("could not resolve usergroup handle for config display", {
        groupId,
        error: String(error),
      });
      return { status: "unknown" };
    }
    return { status: known };
  }
}

/** Resolves a channel or usergroup id to its display name, dispatching on `kind`. */
export function resolveName(
  client: WebClient,
  kind: "channel" | "usergroup",
  id: string
): Promise<Resolution> {
  return kind === "channel"
    ? resolveChannelName(client, id)
    : resolveUsergroupHandle(client, id);
}
