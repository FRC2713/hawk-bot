import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import {
  attendanceStatusFor,
  isClockReaction,
  needsLateNudge,
  stillNeedsLateNudge,
} from "../domain/attendance.js";
import {
  clearAttendanceReaction,
  getAttendanceForEvent,
  getEventByCheckinMessage,
  markNudged,
  setAttendanceNote,
  upsertAttendanceReaction,
  wasNudged,
  type EventRow,
} from "../db/repo.js";
import { log } from "../logger.js";
import { openDirectMessage } from "./dm.js";

/**
 * Rebuilds every attendance row for an Event from Slack's own current
 * reaction state, rather than diffing add/remove events incrementally.
 * Simpler, self-correcting, and it's the same code path the Reaction
 * Cutoff's final reconciliation pass uses — see CONTEXT.md, Reaction Cutoff.
 *
 * Returns everyone's current reaction names (excluding the bot's own), and
 * throws rather than swallowing a Slack API failure — both are what
 * Reaction Cutoff Verification and the Event Attendance Report need from a
 * resync: who has a qualifying reaction, and what they actually reacted with.
 */
export async function syncAttendanceFromSlack(
  client: WebClient,
  event: EventRow,
  botUserId: string
): Promise<{ reactions: Map<string, string[]> }> {
  if (!event.checkin_channel || !event.checkin_message_ts) {
    return { reactions: new Map() };
  }

  const result = await client.reactions.get({
    channel: event.checkin_channel,
    timestamp: event.checkin_message_ts,
    full: true,
  });

  const byUser = new Map<string, string[]>();
  for (const reaction of result.message?.reactions ?? []) {
    const name = reaction.name;
    if (!name) continue;
    for (const userId of reaction.users ?? []) {
      if (userId === botUserId) continue;
      const names = byUser.get(userId) ?? [];
      names.push(name);
      byUser.set(userId, names);
    }
  }

  for (const [userId, names] of byUser) {
    const status = attendanceStatusFor(names);
    if (status === "no_response") continue; // can't happen: names is non-empty
    upsertAttendanceReaction(
      event.id,
      userId,
      status,
      names.some(isClockReaction)
    );
  }

  const existing = getAttendanceForEvent(event.id);
  for (const row of existing) {
    if (row.status !== null && !byUser.has(row.user_id)) {
      clearAttendanceReaction(event.id, row.user_id);
    }
  }

  for (const [userId, names] of byUser) {
    if (!needsLateNudge(names) || wasNudged(event.id, userId)) continue;
    scheduleNudgeCheck(client, event, userId);
  }

  return { reactions: byUser };
}

const NUDGE_DELAY_MS = 30 * 1000;

/**
 * Pending delayed nudge checks, keyed by `${eventId}:${userId}` — a resync
 * that fires again while one's already pending (e.g. two reaction events in
 * quick succession) doesn't stack a second timer on top of it.
 */
const pendingNudgeChecks = new Map<string, NodeJS.Timeout>();

/**
 * Waits before deciding whether to nudge, rather than sending the instant a
 * bare Clock Reaction is seen — someone who clicks 🕐 then 👍 a moment later
 * would otherwise get a nudge they didn't need, since each reaction fires
 * its own Slack event and this check would run on the first one alone.
 * Every resync in between keeps the attendance row current, so the delayed
 * check re-reads that rather than needing a second Slack fetch.
 */
function scheduleNudgeCheck(
  client: WebClient,
  event: EventRow,
  userId: string
): void {
  const key = `${event.id}:${userId}`;
  if (pendingNudgeChecks.has(key) || wasNudged(event.id, userId)) return;

  const timer = setTimeout(() => {
    pendingNudgeChecks.delete(key);
    void runNudgeCheck(client, event, userId);
  }, NUDGE_DELAY_MS);
  timer.unref?.();
  pendingNudgeChecks.set(key, timer);
}

async function runNudgeCheck(
  client: WebClient,
  event: EventRow,
  userId: string
): Promise<void> {
  const row = getAttendanceForEvent(event.id).find((r) => r.user_id === userId);
  if (!row) return;
  if (
    !stillNeedsLateNudge({
      status: row.status,
      hasClockReaction: Boolean(row.has_clock_reaction),
    })
  ) {
    return;
  }
  if (wasNudged(event.id, userId)) return;

  // Best-effort: a DM failure here (DMs restricted, etc.) must not throw —
  // Reaction Cutoff Verification wraps the resync in try/catch to detect an
  // actual data-sync failure, and conflating an unrelated nudge failure
  // with that would wrongly block a whole Event's cutoff. Not marking it
  // nudged means a future resync schedules another attempt.
  try {
    await sendLateNudge(client, event, userId);
    markNudged(event.id, userId);
  } catch (err) {
    log.warn("could not send late nudge", {
      eventId: event.id,
      userId,
      error: String(err),
    });
  }
}

async function sendLateNudge(
  client: WebClient,
  event: EventRow,
  userId: string
): Promise<void> {
  if (!event.checkin_channel || !event.checkin_message_ts) return;
  const permalink = await client.chat
    .getPermalink({
      channel: event.checkin_channel,
      message_ts: event.checkin_message_ts,
    })
    .catch(() => undefined);
  const link = permalink?.permalink;
  const dmChannel = await openDirectMessage(client, userId);
  if (!dmChannel) return;
  await client.chat.postMessage({
    channel: dmChannel,
    text: [
      `Got a clock reaction from you on *${event.title}*, but no 👍.`,
      "Without a 👍 you'll be logged as not attending — add one too if you're coming, just running late.",
      link ? `<${link}|Jump to the post>` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

/** True for a genuine, non-edited user message that's a reply in a thread. */
function isThreadReply(event: {
  subtype?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
}): event is { thread_ts: string; ts: string; user: string } {
  return (
    event.subtype === undefined &&
    typeof event.user === "string" &&
    typeof event.thread_ts === "string" &&
    event.thread_ts !== event.ts
  );
}

export function registerAttendanceEvents(app: App): void {
  app.event("reaction_added", async ({ event, client, context }) => {
    if (event.item.type !== "message") return;
    const row = getEventByCheckinMessage(event.item.channel, event.item.ts);
    if (!row || row.finalized_at || row.removed_at) return;
    await syncAttendanceFromSlack(client, row, context.botUserId ?? "");
  });

  app.event("reaction_removed", async ({ event, client, context }) => {
    if (event.item.type !== "message") return;
    const row = getEventByCheckinMessage(event.item.channel, event.item.ts);
    if (!row || row.finalized_at || row.removed_at) return;
    await syncAttendanceFromSlack(client, row, context.botUserId ?? "");
  });

  app.event("message", async ({ event, context }) => {
    if (!isThreadReply(event)) return;
    // Otherwise the bot's own Calendar Change Handling replies ("this
    // meeting changed...") get captured as if a person had left them.
    if (event.user === context.botUserId) return;
    const row = getEventByCheckinMessage(
      (event as { channel: string }).channel,
      event.thread_ts
    );
    if (!row || row.finalized_at || row.removed_at) return;
    const text = (event as { text?: string }).text;
    if (!text) return;
    setAttendanceNote(row.id, event.user, text);
    log.info("attendance note captured", {
      eventId: row.id,
      userId: event.user,
    });
  });
}
