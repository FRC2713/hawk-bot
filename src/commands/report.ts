import { SLASH_COMMAND } from "../brand.js";
import { getPersonSeasonOutcomes, getTeamSeasonOutcomes } from "../db/repo.js";
import {
  attendancePercent,
  currentSeasonRange,
  formatDateRange,
  isoDate,
  toAttendanceCsv,
  type AttendanceCsvRow,
} from "../domain/attendance.js";
import { log } from "../logger.js";
import { openDirectMessage } from "../slack/dm.js";
import type { Command } from "./types.js";

type Outcome = {
  status: "attending" | "not_attending" | null;
  hoursCredited: number | null;
};

function summarize(outcomes: readonly Outcome[]) {
  let attending = 0;
  let notAttending = 0;
  let noResponse = 0;
  let hours = 0;
  for (const o of outcomes) {
    if (o.status === "attending") {
      attending++;
      hours += o.hoursCredited ?? 0;
    } else if (o.status === "not_attending") {
      notAttending++;
    } else {
      noResponse++;
    }
  }
  return { attending, notAttending, noResponse, hours };
}

/** An explicit `YYYY-MM-DD YYYY-MM-DD` override; falls back to the Season. */
function parseRange(
  args: readonly string[]
): { start: Date; end: Date } | undefined {
  const [startStr, endStr] = args;
  if (!startStr || !endStr) return undefined;
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return undefined;
  return { start, end };
}

export const report: Command = {
  name: "report",
  summary: "Attendance reports — your own hours, or a season export",
  usage: "report attendance me [start end] | report attendance export",
  async run(ctx) {
    const [area, verb, ...rest] = ctx.args;
    if (area?.toLowerCase() !== "attendance" || !verb) {
      return { text: `Usage: \`${SLASH_COMMAND} ${report.usage}\`` };
    }

    if (verb.toLowerCase() === "me") {
      const range = parseRange(rest) ?? currentSeasonRange(new Date());
      const outcomes = getPersonSeasonOutcomes(
        ctx.userId,
        range.start.toISOString(),
        range.end.toISOString()
      );
      const { attending, notAttending, noResponse, hours } =
        summarize(outcomes);
      return {
        text: [
          `*Your attendance, ${formatDateRange(range.start, range.end)}*`,
          `• Attending: ${attending}`,
          `• Not attending: ${notAttending}`,
          `• No response: ${noResponse}`,
          `• Attendance: ${attendancePercent(attending, notAttending, noResponse)}%`,
          `• Hours credited: ${hours}`,
        ].join("\n"),
      };
    }

    if (verb.toLowerCase() === "export") {
      if (!(await ctx.isAdmin())) {
        return {
          text: "Only Hawk Bot admins can export the whole team's attendance.",
        };
      }
      const range = currentSeasonRange(new Date());
      const byUser = getTeamSeasonOutcomes(
        range.start.toISOString(),
        range.end.toISOString()
      );

      const rows: AttendanceCsvRow[] = [];
      for (const [userId, outcomes] of byUser) {
        const { attending, notAttending, noResponse, hours } =
          summarize(outcomes);
        const info = await ctx.client.users
          .info({ user: userId })
          .catch(() => undefined);
        const displayName = info?.user?.real_name ?? info?.user?.name ?? userId;
        rows.push({
          userId,
          displayName,
          eventsAttending: attending,
          eventsNotAttending: notAttending,
          eventsNoResponse: noResponse,
          hoursCredited: hours,
        });
      }

      const dmChannel = await openDirectMessage(ctx.client, ctx.userId);
      if (!dmChannel) {
        return { text: "Couldn't open a DM to send the export — try again?" };
      }
      const upload = await ctx.client.filesUploadV2({
        channel_id: dmChannel,
        filename: `attendance-season-${isoDate(range.start)}.csv`,
        content: toAttendanceCsv(rows),
        initial_comment: `Season attendance export, ${formatDateRange(range.start, range.end)}.`,
      });

      // Slack's own upload flow can report `ok: true` and still not actually
      // share the file anywhere (empty `ims`/`channels`/`shares` on the
      // completed file) — a known Slack-side flakiness with file uploads,
      // not something a thrown error would ever catch. Confirm the file
      // landed in the DM before telling the admin it did.
      const delivered = upload.files.some((completion) =>
        completion.files?.some((file) => file.ims?.includes(dmChannel))
      );
      if (!delivered) {
        log.error("season export uploaded but not confirmed delivered", {
          userId: ctx.userId,
          dmChannel,
        });
        return {
          text: "The export uploaded to Slack but didn't land in your DM — try again, and tell a coach if it keeps happening.",
        };
      }

      return { text: "Sent you a DM with the season attendance CSV." };
    }

    return { text: `Usage: \`${SLASH_COMMAND} ${report.usage}\`` };
  },
};
