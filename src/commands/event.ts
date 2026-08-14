import { SLASH_COMMAND } from "../brand.js";
import { insertEvent } from "../db/repo.js";
import {
  DEFAULT_CHECKIN_OFFSETS,
  checkinPostTime,
  reactionCutoff,
} from "../domain/calendar.js";
import type { Command } from "./types.js";

/**
 * Test/dev fixture only — see ADR-0002. The Team Meeting Calendar is the
 * real, production source of Events; this exists so the feature can be
 * exercised before that sync is wired up.
 */
export const event: Command = {
  name: "event",
  summary:
    "Create a test Event by hand — dev/test only, never for real meetings",
  usage: "event create <title>|<start ISO>|<end ISO>|[location]",
  adminOnly: true,
  async run(ctx) {
    const [verb] = ctx.args;
    if (verb?.toLowerCase() !== "create") {
      return { text: `Usage: \`${SLASH_COMMAND} ${event.usage}\`` };
    }

    const raw = ctx.rest.replace(/^create\s*/i, "");
    const [title, startStr, endStr, location] = raw
      .split("|")
      .map((s) => s.trim());
    if (!title || !startStr || !endStr) {
      return { text: `Usage: \`${SLASH_COMMAND} ${event.usage}\`` };
    }

    const startsAt = new Date(startStr);
    const endsAt = new Date(endStr);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return {
        text: "Couldn't parse those dates — use ISO format, e.g. 2026-01-06T18:00",
      };
    }

    const id = insertEvent({
      calendarEventId: null,
      source: "manual_test",
      title,
      description: "",
      location: location ?? "",
      meetingType: "hourly",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      checkinAt: checkinPostTime(
        { meetingType: "hourly", startsAt },
        DEFAULT_CHECKIN_OFFSETS
      ).toISOString(),
      reactionCutoffAt: reactionCutoff({
        meetingType: "hourly",
        startsAt,
        endsAt,
      }).toISOString(),
    });

    return {
      text: [
        `Created test Event #${id} — *${title}*.`,
        "This is a test fixture (source: manual_test) — never used for real meetings; see ADR-0002.",
        "Its Check-in Post goes out at the next scheduler tick once due.",
      ].join("\n"),
    };
  },
};
