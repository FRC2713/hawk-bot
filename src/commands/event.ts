import { SLASH_COMMAND } from "../brand.js";
import {
  clearVerificationFailed,
  getEvent,
  getSetting,
  insertEvent,
} from "../db/repo.js";
import {
  checkinPostTime,
  reactionCutoff,
  resolveCheckinOffsets,
} from "../domain/calendar.js";
import { attemptEventCutoff } from "../scheduler.js";
import type { Command } from "./types.js";

async function runRetryCutoff(
  ctx: Parameters<Command["run"]>[0]
): Promise<{ text: string }> {
  const idStr = ctx.args[1];
  const id = idStr ? Number(idStr) : NaN;
  if (!idStr || Number.isNaN(id)) {
    return { text: `Usage: \`${SLASH_COMMAND} event retry-cutoff <id>\`` };
  }

  const existing = getEvent(id);
  if (!existing) return { text: `No Event #${id}.` };
  if (!existing.verification_failed_at) {
    return {
      text: `Event #${id} hasn't failed Reaction Cutoff Verification — nothing to retry.`,
    };
  }

  clearVerificationFailed(id);
  const refreshed = getEvent(id);
  if (!refreshed) return { text: `Event #${id} disappeared mid-retry.` };

  const result = await attemptEventCutoff(ctx.client, ctx.botUserId, refreshed);
  if (result.ok) {
    return { text: `Event #${id} finalized successfully.` };
  }
  const why =
    result.reason === "resync_failed"
      ? "the resync failed again"
      : `${result.missingUserIds.length} user(s) are still missing`;
  return { text: `Retry failed again for Event #${id}: ${why}.` };
}

/**
 * Test/dev fixture only — see ADR-0002. The Team Meeting Calendar is the
 * real, production source of Events; this exists so the feature can be
 * exercised before that sync is wired up.
 */
export const event: Command = {
  name: "event",
  summary:
    "Create a test Event by hand, or retry a failed Reaction Cutoff Verification",
  usage:
    "event create <title>|<start ISO>|<end ISO>|[location] | event retry-cutoff <id>",
  adminOnly: true,
  async run(ctx) {
    const [verb] = ctx.args;

    if (verb?.toLowerCase() === "retry-cutoff") {
      return runRetryCutoff(ctx);
    }

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

    const offsets = resolveCheckinOffsets(
      getSetting("checkin_offset_hourly_hours"),
      getSetting("checkin_offset_allday_time")
    );

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
        offsets
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
