import type { WebClient } from "@slack/web-api";
import type { EventRow } from "../db/repo.js";

/**
 * Seeded on every Check-in Post so a team member can just click rather than
 * pick their own emoji — see CONTEXT.md, Event Check-in Post. Any one clock
 * face works as the seed; a person free to react with a different hour and
 * it still lands in the Clock Reaction category.
 */
export const PRE_POPULATED_REACTIONS = ["+1", "clock3", "x"] as const;

function formatEventTime(event: EventRow): string {
  const start = new Date(event.starts_at);
  const dateStr = start.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  if (event.meeting_type === "all_day") return dateStr;
  const end = new Date(event.ends_at);
  const timeFmt: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  return `${dateStr}, ${start.toLocaleTimeString("en-US", timeFmt)}–${end.toLocaleTimeString("en-US", timeFmt)}`;
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

/**
 * Title, when, where, and description — the part of the post worth keeping
 * even once it's removed. `updateNote`, when given, marks the title line as
 * edited (Calendar Change Handling's "edited" case rewrites the post with
 * this rather than leaving it as originally written).
 */
function meetingDetailsText(event: EventRow, updateNote?: string): string {
  const titleLine = updateNote
    ? `<!channel> ✏️ *${event.title}* _(updated: ${updateNote})_`
    : `<!channel> *${event.title}*`;
  const lines = [titleLine, formatEventTime(event)];
  if (event.location) lines.push(`📍 ${event.location}`);
  if (event.description) lines.push(event.description);
  return lines.join("\n");
}

function checkinMessageText(event: EventRow): string {
  return [meetingDetailsText(event), ...REACTION_LEGEND].join("\n");
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

  for (const name of PRE_POPULATED_REACTIONS) {
    await client.reactions.add({ channel, timestamp: ts, name });
  }

  const members = await client.conversations.members({ channel });
  const roster = (members.members ?? []).filter((id) => id !== botUserId);

  return { channel, ts, roster };
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
 * Calendar Change Handling, the "removed" case: the same threaded broadcast
 * reply, plus editing the original post so the cancellation is visible
 * without opening the thread. The meeting details stay — struck through,
 * not replaced — so anyone glancing at the post still sees what the
 * meeting was, not just that something happened to it; the reaction
 * legend is dropped since it's no longer relevant to a removed Event. No
 * Reaction Cutoff runs afterward.
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
    text: `🚫 *${event.title}* has been removed from the calendar.`,
  });
  await client.chat.update({
    channel: event.checkin_channel,
    ts: event.checkin_message_ts,
    text: [
      `🚫 *${event.title}* — this meeting has been removed.`,
      "",
      strikethroughLines(meetingDetailsText(event)),
    ].join("\n"),
  });
}
