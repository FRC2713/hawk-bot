import {
  fetchAccessibleCalendars,
  fetchCalendarEvents,
  serviceAccountEmail,
} from "../calendar/client.js";
import { getSetting } from "../db/repo.js";
import { mapCalendarEvent, upcomingEvents } from "../domain/calendar.js";
import {
  describeCalendarInventory,
  type ConfiguredCalendar,
} from "../domain/calendarAccess.js";
import { formatWeeklySummaryLine } from "../domain/weeklySummary.js";
import { log } from "../logger.js";
import { CALENDAR_SOURCES } from "../scheduler.js";
import type { Command } from "./types.js";

const PREVIEW_COUNT = 3;

type Preview = { text: string; failed: boolean };

async function previewOne(
  settingKey: (typeof CALENDAR_SOURCES)[number]["settingKey"],
  label: string
): Promise<Preview> {
  const calendarId = getSetting(settingKey);
  if (!calendarId) {
    return {
      text: `*${label}*\n_not configured — \`${settingKey}\` is unset_`,
      failed: false,
    };
  }

  let raw;
  try {
    raw = await fetchCalendarEvents(calendarId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `*${label}*\n:warning: ${message}`, failed: true };
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
    return {
      text: `*${label}*\n_connected, nothing in the next 60 days_`,
      failed: false,
    };
  }

  return {
    text: [
      `*${label}*`,
      ...upcoming.map((e) => `• ${formatWeeklySummaryLine(e)}`),
    ].join("\n"),
    failed: false,
  };
}

/**
 * The inventory, shown only when something failed.
 *
 * It is the answer to the question a per-calendar 404 leaves open — is the id
 * wrong, or is no share in effect — and it costs an extra API call, so it
 * earns its place on a failure and would just be noise on a healthy run.
 */
async function inventorySection(): Promise<string> {
  const configured: ConfiguredCalendar[] = [];
  for (const { settingKey, label } of CALENDAR_SOURCES) {
    const calendarId = getSetting(settingKey);
    if (calendarId) configured.push({ label, calendarId });
  }

  try {
    return describeCalendarInventory(
      configured,
      await fetchAccessibleCalendars()
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `*What Google says this service account can actually see*\n:warning: Couldn't read the account's calendar list either.\n${message}`;
  }
}

/**
 * Who Hawk Bot authenticates to Google as — the address a mentor has to put
 * in the calendar's sharing dialog.
 *
 * It is the first line of the reply because it is the answer to the most
 * common failure and it is otherwise unobtainable: it lives inside a base64
 * credential that only exists in a GitHub secret and a 600-mode .env on a
 * host nobody SSHes into. Every "the bot can't see the calendar" report is
 * one lookup away from resolved once this is on screen.
 */
function identityLine(): string {
  try {
    return `Authenticating to Google as \`${serviceAccountEmail()}\`\n_Each calendar below must be shared with that address ("See all event details")._`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `:warning: Can't read the service account credential.\n${message}`;
  }
}

/**
 * Manual smoke test for the Google Calendar connection: who it connects as,
 * and the next few events on each configured calendar, fetched live from
 * Google rather than read back from the synced database. A bad
 * service-account credential or a calendar that was never shared with it
 * shows up here as an inline error — in Slack, immediately — rather than
 * only as a scheduler-tick log line an operator without host access can't
 * reach.
 *
 * When anything fails it also reports what the account can reach at all,
 * because the per-calendar error alone cannot separate a wrong id from a
 * share that never took effect.
 */
export const calendar: Command = {
  name: "calendar",
  summary: "Preview the next few events on each connected calendar",
  adminOnly: true,
  async run() {
    const identity = identityLine();
    const previews = await Promise.all(
      CALENDAR_SOURCES.map(({ settingKey, label }) =>
        previewOne(settingKey, label)
      )
    );

    const sections = previews.map((p) => p.text);
    if (previews.some((p) => p.failed)) {
      sections.push(await inventorySection());
    }

    return { text: [identity, ...sections].join("\n\n") };
  },
};
