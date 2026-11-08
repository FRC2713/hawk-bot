/**
 * Which channel an Event's Check-in Post goes to.
 *
 * An FTC Event is a Team Meeting Calendar Event whose title *starts with* a
 * marker an admin sets (`ftc_event_marker`, by team convention 🟧); its post
 * goes to the opt-in `ftc_channel` instead of `announce_channel`. Starts-with
 * is deliberate: a joint meeting carries the marker mid-title as a tag
 * ("Team Meeting 🟦 🟧 (FRC and FTC …)") and is for everyone. See
 * docs/adr/0016-ftc-meetings-check-in-to-an-opt-in-channel.md.
 *
 * Pure — no database, no Slack — so every caller (the poster, the summary
 * pointer, the calendar preview, the No Response Alert) agrees on what "on"
 * means and the rule is testable on its own.
 */
export type FtcRouting = { marker: string; channel: string };

/** The routing, or `undefined` when it is off: both settings must be set. */
export function resolveFtcRouting(settings: {
  marker: string | undefined;
  channel: string | undefined;
}): FtcRouting | undefined {
  const marker = settings.marker?.trim();
  const channel = settings.channel?.trim();
  if (!marker || !channel) return undefined;
  return { marker, channel };
}

/**
 * The channel an Event's Check-in Post goes to: the FTC channel for an FTC
 * Event when routing is on, otherwise the announcements channel (which may be
 * unset, in which case nothing is posted).
 */
export function resolveCheckinChannel(
  event: { title: string },
  settings: {
    announceChannel: string | undefined;
    ftcMarker: string | undefined;
    ftcChannel: string | undefined;
  }
): string | undefined {
  const routing = resolveFtcRouting({
    marker: settings.ftcMarker,
    channel: settings.ftcChannel,
  });
  if (routing && startsWithMarker(event.title, routing.marker)) {
    return routing.channel;
  }
  return settings.announceChannel;
}

function startsWithMarker(title: string, marker: string): boolean {
  return title.trimStart().toLowerCase().startsWith(marker.toLowerCase());
}

/**
 * The channel to point readers at from a summary line — set only for a Team
 * Meeting Event whose Check-in Post is not in the announcements channel, since
 * that is the one place a student wouldn't already look. Once the post is out
 * its recorded channel is the truth; before that, derive it the way the
 * poster will.
 */
export function checkinPointer(
  event: {
    title: string;
    calendarRole: string;
    checkinChannel: string | null;
  },
  settings: {
    announceChannel: string | undefined;
    ftcMarker: string | undefined;
    ftcChannel: string | undefined;
  }
): string | undefined {
  if (event.calendarRole !== "team_meeting") return undefined;
  // A recorded channel is the truth, but only the FTC channel is worth a
  // pointer: comparing against the *current* announce_channel would flag every
  // old post once that setting changes.
  const channel =
    event.checkinChannel ?? resolveCheckinChannel(event, settings);
  const ftcChannel = resolveFtcRouting({
    marker: settings.ftcMarker,
    channel: settings.ftcChannel,
  })?.channel;
  return channel && channel === ftcChannel ? channel : undefined;
}
