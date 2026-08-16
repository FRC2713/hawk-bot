import { fetchCalendarEvents } from "../calendar/client.js";
import { getSetting } from "../db/repo.js";
import { mapCalendarEvent, upcomingEvents } from "../domain/calendar.js";
import { formatWeeklySummaryLine } from "../domain/weeklySummary.js";
import { log } from "../logger.js";
import { CALENDAR_SOURCES } from "../scheduler.js";
import type { Command } from "./types.js";

const PREVIEW_COUNT = 3;

async function previewOne(
  settingKey: (typeof CALENDAR_SOURCES)[number]["settingKey"],
  label: string
): Promise<string> {
  const calendarId = getSetting(settingKey);
  if (!calendarId) {
    return `*${label}*\n_not configured — \`${settingKey}\` is unset_`;
  }

  let raw;
  try {
    raw = await fetchCalendarEvents(calendarId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `*${label}*\n:warning: ${message}`;
  }

  // Mapping can fail per-event (e.g. a cancelled instance missing its
  // start/end) — skip that one rather than letting it take down the whole
  // preview, same as syncOneCalendar's per-event handling in scheduler.ts.
  const mapped = [];
  for (const rawEvent of raw) {
    try {
      mapped.push(mapCalendarEvent(rawEvent));
    } catch (err) {
      log.error("could not map calendar event", {
        id: rawEvent.id,
        error: String(err),
      });
    }
  }

  const upcoming = upcomingEvents(mapped, new Date(), PREVIEW_COUNT);
  if (upcoming.length === 0) {
    return `*${label}*\n_connected, nothing in the next 60 days_`;
  }

  return [
    `*${label}*`,
    ...upcoming.map((e) => `• ${formatWeeklySummaryLine(e)}`),
  ].join("\n");
}

/**
 * Manual smoke test for the Google Calendar connection: the next few events
 * on each configured calendar, fetched live from Google rather than read
 * back from the synced database. A bad service-account credential or a
 * calendar that was never shared with it shows up here as an inline error —
 * in Slack, immediately — rather than only as a scheduler-tick log line an
 * operator without host access can't reach.
 */
export const calendar: Command = {
  name: "calendar",
  summary: "Preview the next few events on each connected calendar",
  adminOnly: true,
  async run() {
    const sections = await Promise.all(
      CALENDAR_SOURCES.map(({ settingKey, label }) =>
        previewOne(settingKey, label)
      )
    );
    return { text: sections.join("\n\n") };
  },
};
