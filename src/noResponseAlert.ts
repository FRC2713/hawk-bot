import type { WebClient } from "@slack/web-api";
import { SLASH_COMMAND } from "./brand.js";
import {
  DEFAULT_NO_RESPONSE_ALERT_TIMING,
  formatNoResponseAlertDetail,
  formatNoResponseAlertSummary,
  isNoResponseStreak,
  resolveNoResponseAlertRoles,
  resolveNoResponseAlertThreshold,
  type FlaggedPerson,
  type RecentMeetingOutcome,
} from "./domain/noResponseAlert.js";
import {
  isWeeklySummaryDue,
  resolveWeeklySummaryTiming,
} from "./domain/weeklySummary.js";
import {
  getMostRecentNoResponseAlert,
  getRecentOutcomesForUser,
  getSetting,
  insertNoResponseAlert,
} from "./db/repo.js";
import { log } from "./logger.js";
import { listHawkBotAdmins, resolveUserGroupMemberIds } from "./slack/authz.js";
import { openDirectMessage } from "./slack/dm.js";
import { fetchChannelRoster } from "./slack/roster.js";

/**
 * DMs every HawkBot Admin that the No Response Alert Report's channel is
 * configured but `student_usergroup` and/or `mentor_usergroup` isn't — the
 * report refuses to guess at who counts as a student rather than risk
 * naming a parent, alum, or other channel guest. Same DM-every-admin pattern
 * as `notifyVerificationFailure` in `scheduler.ts`.
 */
async function notifyTeamRoleMisconfiguration(
  client: WebClient,
  missingKeys: readonly string[]
): Promise<void> {
  const plural = missingKeys.length > 1;
  const text = [
    `⚠️ The No Response Alert Report is configured to post, but ${missingKeys
      .map((k) => `\`${k}\``)
      .join(" and ")} ${plural ? "aren't" : "isn't"} set.`,
    `It won't evaluate anyone until ${plural ? "both are" : "it is"} — set ${plural ? "them" : "it"} with \`${SLASH_COMMAND} config set <key> <value>\`.`,
  ].join("\n");

  for (const userId of await listHawkBotAdmins(client)) {
    const dmChannel = await openDirectMessage(client, userId);
    if (!dmChannel) continue;
    await client.chat.postMessage({ channel: dmChannel, text }).catch((err) =>
      log.error("could not DM Team Role misconfiguration", {
        userId,
        error: String(err),
      })
    );
  }
}

/**
 * The No Response Alert Report: if due, flags anyone currently on the
 * Roster (the announcements channel's live membership, not a historical
 * snapshot — see CONTEXT.md, Roster) whose most recent `threshold` Team
 * Meeting outcomes were all No Response, and posts one top-level message
 * with a Students list and a Mentors list threaded underneath it —
 * separately, so someone in both groups is named in both. Silent when
 * nobody qualifies — no "all clear" message, see CONTEXT.md — but a row is
 * still recorded either way, so the due-check advances instead of
 * re-evaluating the whole Roster on every scheduler tick for the rest of a
 * silent week. Turned off by leaving `no_response_alert_channel` unset,
 * same convention as the Mentor/Teacher Weekly Summary.
 */
export async function postDueNoResponseAlert(
  client: WebClient,
  botUserId: string
): Promise<void> {
  const channelId = getSetting("no_response_alert_channel");
  if (!channelId) return;

  const timingSetting = getSetting("no_response_alert_time");
  const timing = timingSetting
    ? resolveWeeklySummaryTiming(timingSetting)
    : DEFAULT_NO_RESPONSE_ALERT_TIMING;
  const mostRecent = getMostRecentNoResponseAlert();
  const lastPostedAt = mostRecent ? new Date(mostRecent.posted_at) : null;
  const now = new Date();
  if (!isWeeklySummaryDue(lastPostedAt, timing, now)) return;

  const studentGroupId = getSetting("student_usergroup");
  const mentorGroupId = getSetting("mentor_usergroup");
  if (!studentGroupId || !mentorGroupId) {
    const missingKeys = [
      !studentGroupId ? "student_usergroup" : null,
      !mentorGroupId ? "mentor_usergroup" : null,
    ].filter((k): k is string => k !== null);
    await notifyTeamRoleMisconfiguration(client, missingKeys);
    // Same convention as a nobody-flagged week: a message_ts-null row still
    // advances the due-check, so this recurs on the next due occurrence
    // (weekly) rather than every 5-minute scheduler tick.
    insertNoResponseAlert({ channel: channelId, messageTs: null });
    log.warn("no response alert: student/mentor usergroup not configured", {
      missingKeys,
    });
    return;
  }

  const announceChannel = getSetting("announce_channel");
  if (!announceChannel) return;

  const roster = await fetchChannelRoster(client, announceChannel, botUserId);

  const [studentMemberIds, mentorMemberIds] = await Promise.all([
    resolveUserGroupMemberIds(client, studentGroupId),
    resolveUserGroupMemberIds(client, mentorGroupId),
  ]);

  const threshold = resolveNoResponseAlertThreshold(
    getSetting("no_response_alert_threshold")
  );

  const studentFlagged: FlaggedPerson[] = [];
  const mentorFlagged: FlaggedPerson[] = [];
  for (const userId of roster) {
    const roles = resolveNoResponseAlertRoles({
      userId,
      studentGroupMemberIds: studentMemberIds,
      mentorGroupMemberIds: mentorMemberIds,
    });
    if (roles.length === 0) continue;

    const recent: RecentMeetingOutcome[] = getRecentOutcomesForUser(
      userId,
      threshold
    ).map((row) => ({
      status: row.status,
      title: row.title,
      startsAt: new Date(row.starts_at),
    }));
    if (!isNoResponseStreak(recent, threshold)) continue;

    const info = await client.users.info({ user: userId }).catch((err) => {
      log.error("no response alert: could not look up user", {
        userId,
        error: String(err),
      });
      return undefined;
    });
    const displayName = info?.user?.real_name ?? info?.user?.name ?? userId;
    const person: FlaggedPerson = {
      displayName,
      // recent is newest-first (see getRecentOutcomesForUser); the message
      // reads oldest-to-newest, like a timeline.
      missedMeetings: [...recent].reverse().map((r) => ({
        title: r.title,
        startsAt: r.startsAt,
      })),
    };
    // A person in both groups gets the same block pushed onto both lists —
    // see resolveNoResponseAlertRoles.
    if (roles.includes("student")) studentFlagged.push(person);
    if (roles.includes("mentor")) mentorFlagged.push(person);
  }

  if (studentFlagged.length === 0 && mentorFlagged.length === 0) {
    insertNoResponseAlert({ channel: channelId, messageTs: null });
    log.info("no response alert: nobody flagged this week");
    return;
  }

  const posted = await client.chat.postMessage({
    channel: channelId,
    text: formatNoResponseAlertSummary({ threshold }),
  });
  if (!posted.channel || !posted.ts) {
    log.error("no response alert post did not return a channel/ts");
    return;
  }
  if (studentFlagged.length > 0) {
    await client.chat.postMessage({
      channel: posted.channel,
      thread_ts: posted.ts,
      text: formatNoResponseAlertDetail({
        role: "student",
        flagged: studentFlagged,
      }),
    });
  }
  if (mentorFlagged.length > 0) {
    await client.chat.postMessage({
      channel: posted.channel,
      thread_ts: posted.ts,
      text: formatNoResponseAlertDetail({
        role: "mentor",
        flagged: mentorFlagged,
      }),
    });
  }
  insertNoResponseAlert({ channel: posted.channel, messageTs: posted.ts });
  log.info("no response alert posted", {
    channel: posted.channel,
    ts: posted.ts,
    studentFlaggedCount: studentFlagged.length,
    mentorFlaggedCount: mentorFlagged.length,
  });
}
