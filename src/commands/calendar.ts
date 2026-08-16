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
import { isCalendarId } from "../domain/settings.js";
import { formatWeeklySummaryLine } from "../domain/weeklySummary.js";
import { log } from "../logger.js";
import { CALENDAR_SOURCES } from "../scheduler.js";
import type { Command } from "./types.js";

const PREVIEW_COUNT = 3;

type Preview = { text: string; failed: boolean };

/**
 * A calendar Google publishes and anyone can read. Offered as a control:
 * running the probe against it separates "this account cannot read *any*
 * calendar" from "these particular calendars are not shared with it", which
 * is not a distinction the configured calendars can make on their own.
 */
const PUBLIC_CONTROL_CALENDAR = "en.usa#holiday@group.v.calendar.google.com";

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
  return previewCalendar(label, calendarId);
}

async function previewCalendar(
  label: string,
  calendarId: string
): Promise<Preview> {
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
  usage: "calendar | calendar <calendar-id> | calendar control",
  adminOnly: true,
  async run(ctx) {
    const identity = identityLine();
    const argument = ctx.rest.trim();

    if (argument) return probeReply(identity, argument);

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

/**
 * `/hawkbot calendar <id>` — read a calendar without storing it anywhere.
 *
 * Configuring an id to find out whether it works has a cost: the scheduler
 * picks it up on the next tick and starts creating Events, posting Check-ins
 * and rewriting the Weekly Summary from whatever it found. That makes the
 * obvious experiment — "does this account work against a calendar I know is
 * fine?" — one nobody should have to run against live settings.
 *
 * `calendar control` fills in a calendar Google publishes to everyone, which
 * is the control that separates "cannot read anything" from "cannot read
 * *these*". Neither answer is reachable from the configured calendars alone.
 */
async function probeReply(
  identity: string,
  argument: string
): Promise<{ text: string }> {
  const isControl = argument.toLowerCase() === "control";
  const calendarId = isControl ? PUBLIC_CONTROL_CALENDAR : argument;

  if (!isCalendarId(calendarId)) {
    return {
      text: [
        identity,
        `\`${calendarId}\` is not shaped like a calendar id.`,
        "Expected something like `team@group.calendar.google.com`, or `control` to test against a calendar Google publishes to everyone.",
        "If it looks correct, the paste carried an invisible character — retype it.",
      ].join("\n\n"),
    };
  }

  const label = isControl
    ? "Control — Google's public US Holidays calendar"
    : `Probe — \`${calendarId}\``;
  const { text, failed } = await previewCalendar(label, calendarId);

  const verdict = isControl
    ? failed
      ? "*This is the informative failure.* The account cannot read even a calendar Google publishes to the whole world, so nothing is wrong with your calendars or their sharing — the problem is the credential, its Cloud project, or a policy applying to the app itself."
      : "*The account can read public calendars fine.* So the credential, the project and the API all work, and the problem is specific to your calendars — they are not shared with this address, whatever the sharing dialog shows."
    : failed
      ? "_Not stored — this was a read-only probe._"
      : "_Not stored — this was a read-only probe. Set it for real with `/hawkbot config set <key> <id>`._";

  return { text: [identity, text, verdict].join("\n\n") };
}
