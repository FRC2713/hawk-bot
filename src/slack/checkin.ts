import type { WebClient } from "@slack/web-api";
import type { EventRow } from "../db/repo.js";
import { formatEventWhen, type MeetingType } from "../domain/attendance.js";
import { log } from "../logger.js";
import { listHawkBotAdmins } from "./authz.js";
import {
  describeChannelAccessError,
  ensureChannelMembership,
} from "./channelAccess.js";
import { openDirectMessage } from "./dm.js";
import { fetchChannelRoster } from "./roster.js";

/**
 * Seeded on every Check-in Post so a team member can just click rather than
 * pick their own emoji — see CONTEXT.md, Event Check-in Post. Any one clock
 * face works as the seed; a person free to react with a different hour and
 * it still lands in the Clock Reaction category.
 */
export const PRE_POPULATED_REACTIONS = ["+1", "clock3", "x"] as const;

function formatEventTime(event: EventRow): string {
  return formatEventWhen(
    new Date(event.starts_at),
    new Date(event.ends_at),
    event.meeting_type as MeetingType
  );
}

/** Strikes through each non-blank line individually, rather than one span across the whole block, so a blank line can't break the formatting partway through. */
function strikethroughLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `~${line}~` : line))
    .join("\n");
}

const REACTION_LEGEND = [
  "",
  "React to let the team know:",
  "👍 — I'm coming",
  "🕐 — I'm coming, but running late or leaving early (reply in this thread with details if you want)",
  "❌, or anything else — I can't make it (reply in this thread with why, if you want)",
];

/** When, where, and description — shared by every post-title variant of the meeting details. */
function meetingDetailBodyLines(event: EventRow): string[] {
  const lines = [formatEventTime(event)];
  if (event.location) lines.push(`📍 ${event.location}`);
  if (event.description) lines.push(event.description);
  return lines;
}

/** Bolded, and linked to the calendar event when the Event has one. */
function linkedTitle(event: EventRow): string {
  return event.calendar_link
    ? `<${event.calendar_link}|*${event.title}*>`
    : `*${event.title}*`;
}

/**
 * Title, when, where, and description — the part of the post worth keeping
 * even once it's removed. `updateNote`, when given, marks the title line as
 * edited (Calendar Change Handling's "edited" case rewrites the post with
 * this rather than leaving it as originally written).
 */
function meetingDetailsText(event: EventRow, updateNote?: string): string {
  const titleLine = updateNote
    ? `<!channel> ✏️ ${linkedTitle(event)} _(updated: ${updateNote})_`
    : `<!channel> ${linkedTitle(event)}`;
  return [titleLine, ...meetingDetailBodyLines(event)].join("\n");
}

function checkinMessageText(event: EventRow): string {
  return [meetingDetailsText(event), ...REACTION_LEGEND].join("\n");
}

/**
 * The Reaction Cutoff's locked-post text, replacing `checkinMessageText`
 * once attendance closes — see ADR-0013. Drops `<!channel>` (nothing left
 * to ping about) and the reaction legend entirely (not struck through:
 * unlike Calendar Change Handling's "removed" case, there's no value in
 * showing what the legend used to say). Meeting details stay exactly as
 * `meetingDetailsText` already renders them, since the meeting itself
 * still happened.
 */
export function lockedCheckinMessageText(event: EventRow): string {
  const titleLine = `✅ ${linkedTitle(event)} — attendance closed`;
  return [titleLine, ...meetingDetailBodyLines(event)].join("\n");
}

/**
 * Posts the Event Check-in Post, pre-populates its reactions, and returns
 * the channel's current membership (minus the bot itself) to snapshot as
 * the Roster. Writing the result to the events/event_roster tables is the
 * caller's job — see scheduler.ts.
 */
export async function postCheckinPost(
  client: WebClient,
  event: EventRow,
  channelId: string,
  botUserId: string
): Promise<{ channel: string; ts: string; roster: string[] }> {
  const posted = await client.chat.postMessage({
    channel: channelId,
    text: checkinMessageText(event),
    unfurl_links: false,
  });
  const channel = posted.channel;
  const ts = posted.ts;
  if (!channel || !ts) {
    throw new Error(
      `chat.postMessage for event ${event.id} did not return a channel/ts`
    );
  }

  // A failure here (missing scope, rate limit, not a channel member, ...)
  // must not stop the caller from recording the post as sent — the message
  // is already live, and losing a seeded reaction is far cheaper than
  // reposting this same Event's Check-in every scheduler tick until the
  // failure clears (#33).
  await ensureChannelMembership(client, channel);

  const reactionFailures: string[] = [];
  for (const name of PRE_POPULATED_REACTIONS) {
    await client.reactions
      .add({ channel, timestamp: ts, name })
      .catch((err) => {
        log.error("could not seed check-in reaction", {
          eventId: event.id,
          channel,
          ts,
          name,
          error: String(err),
        });
        reactionFailures.push(describeChannelAccessError(err) ?? String(err));
      });
  }
  if (reactionFailures.length > 0) {
    await notifyReactionSeedFailure(
      client,
      event,
      channel,
      reactionFailures[0]!
    );
  }

  const roster = await fetchChannelRoster(client, channel, botUserId);

  return { channel, ts, roster };
}

/**
 * A missing seeded reaction is cosmetic — people can still react by hand —
 * but it used to be silent: nothing in Slack itself ever told an admin it
 * happened, only a container log line no one was looking at (issue #33).
 * One DM per Check-in Post reaches every HawkBot Admin, not just whoever
 * happens to notice the post looks bare.
 */
async function notifyReactionSeedFailure(
  client: WebClient,
  event: EventRow,
  channel: string,
  reason: string
): Promise<void> {
  const text = [
    `⚠️ Couldn't seed reactions on the Check-in Post for *${event.title}* in <#${channel}>.`,
    reason,
  ].join("\n");
  for (const userId of await listHawkBotAdmins(client)) {
    const dmChannel = await openDirectMessage(client, userId);
    if (!dmChannel) continue;
    await client.chat.postMessage({ channel: dmChannel, text }).catch((err) =>
      log.error("could not DM reaction-seed failure", {
        userId,
        eventId: event.id,
        error: String(err),
      })
    );
  }
}

/**
 * The Reaction Cutoff's lock step, replacing the old delete — see
 * ADR-0013. Rewrites the Check-in Post in place with
 * `lockedCheckinMessageText`; leaves every reaction on the post (seeded
 * and human) and the thread (Attendance Notes and all) exactly as they
 * are — a bot token can't touch a human's reaction or reply anyway, and
 * there's no reason to strip its own seeded ones either.
 */
export async function lockCheckinPost(
  client: WebClient,
  event: EventRow
): Promise<void> {
  if (!event.checkin_channel || !event.checkin_message_ts) return;
  await client.chat.update({
    channel: event.checkin_channel,
    ts: event.checkin_message_ts,
    text: lockedCheckinMessageText(event),
  });
}

/** One `~old~ → new` line per changed field worth showing a before/after for. */
function changedDetailLines(
  previous: EventRow,
  current: EventRow,
  changedFields: readonly string[]
): string[] {
  const lines: string[] = [];
  if (changedFields.includes("title")) {
    lines.push(`~*${previous.title}*~ → *${current.title}*`);
  }
  if (
    changedFields.includes("start time") ||
    changedFields.includes("end time")
  ) {
    lines.push(
      `🕐 ~${formatEventTime(previous)}~ → ${formatEventTime(current)}`
    );
  }
  if (changedFields.includes("location")) {
    lines.push(
      `📍 ~${previous.location || "(none)"}~ → ${current.location || "(none)"}`
    );
  }
  if (changedFields.includes("description")) {
    lines.push(
      `~${previous.description || "(none)"}~ → ${current.description || "(none)"}`
    );
  }
  return lines;
}

/**
 * Calendar Change Handling, the "edited" case: a threaded, channel-broadcast
 * reply naming what changed, showing the old value struck through next to
 * the new one for each changed field, and linking straight to the calendar
 * event — plus rewriting the original post itself with the new details,
 * marked with an ✏️ and which fields changed, rather than left as
 * originally written. Every existing reaction carries forward unchanged
 * either way.
 */
export async function announceEventEdited(
  client: WebClient,
  previous: EventRow,
  current: EventRow,
  changedFields: readonly string[]
): Promise<void> {
  if (!current.checkin_channel || !current.checkin_message_ts) return;

  const changedList = changedFields.join(", ");
  const linkLine = current.calendar_link
    ? `<${current.calendar_link}|View on the calendar>`
    : undefined;
  await client.chat.postMessage({
    channel: current.checkin_channel,
    thread_ts: current.checkin_message_ts,
    reply_broadcast: true,
    text: [
      `📝 *${current.title}* changed: ${changedList} updated.`,
      ...changedDetailLines(previous, current, changedFields),
      linkLine,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  await client.chat.update({
    channel: current.checkin_channel,
    ts: current.checkin_message_ts,
    text: [meetingDetailsText(current, changedList), ...REACTION_LEGEND].join(
      "\n"
    ),
  });
}

/**
 * Calendar Change Handling, the "removed" case: a threaded broadcast reply
 * naming the meeting and when it was scheduled — so it stands on its own
 * for anyone who only sees the thread notification — plus editing the
 * original post so the cancellation is visible without opening the thread.
 * The meeting details stay there too — struck through, not replaced — so
 * anyone glancing at the post still sees what the meeting was, not just
 * that something happened to it; the reaction legend is dropped since it's
 * no longer relevant to a removed Event. No Reaction Cutoff runs afterward.
 */
export async function announceEventRemoved(
  client: WebClient,
  event: EventRow
): Promise<void> {
  if (!event.checkin_channel || !event.checkin_message_ts) return;
  await client.chat.postMessage({
    channel: event.checkin_channel,
    thread_ts: event.checkin_message_ts,
    reply_broadcast: true,
    text: [
      `🚫 *${event.title}* has been removed from the calendar.`,
      formatEventTime(event),
    ].join("\n"),
  });
  await client.chat.update({
    channel: event.checkin_channel,
    ts: event.checkin_message_ts,
    text: [
      `🚫 ${linkedTitle(event)} — this meeting has been removed.`,
      "",
      strikethroughLines(meetingDetailsText(event)),
    ].join("\n"),
  });
}
