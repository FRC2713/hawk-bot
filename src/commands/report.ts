import type { WebClient } from "@slack/web-api";
import { SLASH_COMMAND } from "../brand.js";
import { getPersonSeasonOutcomes, getTeamSeasonOutcomes } from "../db/repo.js";
import {
  attendancePercent,
  currentSeasonRange,
  formatDateRange,
  formatSeasonAttendanceTable,
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

async function buildTeamRows(
  client: WebClient,
  range: { start: Date; end: Date }
): Promise<AttendanceCsvRow[]> {
  const byUser = getTeamSeasonOutcomes(
    range.start.toISOString(),
    range.end.toISOString()
  );
  const rows: AttendanceCsvRow[] = [];
  for (const [userId, outcomes] of byUser) {
    const { attending, notAttending, noResponse, hours } = summarize(outcomes);
    const info = await client.users
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
  return rows;
}

/**
 * `files.uploadV2`'s own response can't be trusted to say whether a file
 * actually got shared — its file object leaves `ims`/`channels`/`shares`
 * empty even for uploads that genuinely succeed (a known gap in Slack's
 * newer upload API, still open upstream: slackapi/node-slack-sdk#2040).
 * The DM's real message history is the only place that reliably shows
 * whether the file landed. Slack shares a file asynchronously after
 * `completeUploadExternal` returns — it runs a security scan first — so
 * this polls briefly rather than checking once.
 */
async function confirmDelivered(
  client: WebClient,
  dmChannel: string,
  fileId: string | undefined
): Promise<boolean> {
  if (!fileId) return false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    const history = await client.conversations
      .history({ channel: dmChannel, limit: 10 })
      .catch((error) => {
        // Swallowing this silently would make a missing-scope or
        // rate-limited call indistinguishable from "checked and it's
        // genuinely not there" — the exact failure mode this function
        // exists to avoid repeating.
        log.warn("season export delivery check: conversations.history failed", {
          dmChannel,
          fileId,
          attempt,
          error: String(error),
        });
        return undefined;
      });
    if (history?.messages?.some((m) => m.files?.some((f) => f.id === fileId)))
      return true;
  }
  return false;
}

export const report: Command = {
  name: "report",
  summary: "Attendance reports — your own hours, a season export, or a preview",
  usage:
    "report attendance me [start end] | report attendance export | report attendance preview",
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

    if (verb.toLowerCase() === "preview") {
      if (!(await ctx.isAdmin())) {
        return {
          text: "Only Hawk Bot admins can preview the whole team's attendance.",
        };
      }
      // Shows the export's own data as plain reply text — the same
      // response_url path every other reply in this app already uses
      // reliably — instead of as a file attachment. Isolates whether a
      // stuck export is a data problem (this will look wrong too) or a
      // file-delivery problem (this will look right, `export` won't).
      const range = currentSeasonRange(new Date());
      const rows = await buildTeamRows(ctx.client, range);
      const preview = rows.slice(0, 20);
      if (preview.length === 0) {
        return {
          text: "No season attendance data yet — the export would just be a header row.",
        };
      }
      return {
        text: `*Season attendance preview — first ${preview.length} of ${rows.length}, ${formatDateRange(range.start, range.end)}*\n${formatSeasonAttendanceTable(preview)}`,
      };
    }

    if (verb.toLowerCase() === "export") {
      if (!(await ctx.isAdmin())) {
        return {
          text: "Only Hawk Bot admins can export the whole team's attendance.",
        };
      }
      const range = currentSeasonRange(new Date());
      const rows = await buildTeamRows(ctx.client, range);

      const dmChannel = await openDirectMessage(ctx.client, ctx.userId);
      if (!dmChannel) {
        return { text: "Couldn't open a DM to send the export — try again?" };
      }
      const upload = await ctx.client.filesUploadV2({
        channel_id: dmChannel,
        filename: `attendance-season-${isoDate(range.start)}.csv`,
        filetype: "csv",
        content: toAttendanceCsv(rows),
        initial_comment: `Season attendance export, ${formatDateRange(range.start, range.end)}.`,
      });

      const fileId = upload.files[0]?.files?.[0]?.id;
      if (!(await confirmDelivered(ctx.client, dmChannel, fileId))) {
        // Everything we've checked so far — the file object's own
        // sharing fields — has turned out to be unreliable noise (see
        // confirmDelivered's comment). Capture the raw completeUploadExternal
        // response so a real failure (an `error`/`warning` field we haven't
        // been looking at) is finally visible, instead of another
        // secondhand theory. Put it in the reply itself, not only the log —
        // the admin running this command may not have log access, and
        // they're the one who can actually see it.
        const diagnostics = JSON.stringify(
          upload.files.map((completion) => ({
            ok: completion.ok,
            error: completion.error,
            files: completion.files?.map((f) => ({
              id: f.id,
              channels: f.channels,
              groups: f.groups,
              ims: f.ims,
              shares: f.shares,
            })),
          }))
        );
        log.error("season export uploaded but not confirmed delivered", {
          userId: ctx.userId,
          dmChannel,
          fileId,
          uploadResponse: diagnostics,
        });
        return {
          text: [
            "The export uploaded to Slack but didn't land in your DM — try again, and tell a coach if it keeps happening.",
            "Diagnostic detail (safe to share for troubleshooting):",
            "```",
            diagnostics,
            "```",
          ].join("\n"),
        };
      }

      return { text: "Sent you a DM with the season attendance CSV." };
    }

    return { text: `Usage: \`${SLASH_COMMAND} ${report.usage}\`` };
  },
};
