import { decrypt, encrypt } from "../crypto.js";
import type { SettingKey } from "../domain/settings.js";
import { db } from "./client.js";

const nowIso = () => new Date().toISOString();

/* ----------------------------------------------------------- installations */

export type StoredInstallation = {
  teamId: string;
  enterpriseId: string | null;
  payload: unknown;
  scopes: string | null;
  installedAt: string;
  updatedAt: string;
};

type InstallationRow = {
  team_id: string;
  enterprise_id: string | null;
  payload_enc: string;
  scopes: string | null;
  installed_at: string;
  updated_at: string;
};

export function saveInstallation(args: {
  teamId: string;
  enterpriseId?: string | null;
  payload: unknown;
  scopes?: string | null;
}): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO installations (team_id, enterprise_id, payload_enc, scopes,
                                  installed_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (team_id) DO UPDATE SET
         enterprise_id = excluded.enterprise_id,
         payload_enc   = excluded.payload_enc,
         scopes        = excluded.scopes,
         updated_at    = excluded.updated_at,
         revoked_at    = NULL`
    )
    .run(
      args.teamId,
      args.enterpriseId ?? null,
      encrypt(JSON.stringify(args.payload)),
      args.scopes ?? null,
      now,
      now
    );
}

export function getInstallation(
  teamId: string
): StoredInstallation | undefined {
  const row = db()
    .prepare<[string], InstallationRow>(
      "SELECT * FROM installations WHERE team_id = ? AND revoked_at IS NULL"
    )
    .get(teamId);
  if (!row) return undefined;
  return {
    teamId: row.team_id,
    enterpriseId: row.enterprise_id,
    payload: JSON.parse(decrypt(row.payload_enc)),
    scopes: row.scopes,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Marked rather than deleted. "Uninstalled on the 3rd" and "was never
 * installed" are different answers to the same support question, and only one
 * of them is a person's decision.
 */
export function revokeInstallation(teamId: string): void {
  db()
    .prepare(
      "UPDATE installations SET revoked_at = ?, updated_at = ? WHERE team_id = ?"
    )
    .run(nowIso(), nowIso(), teamId);
}

export function anyInstallation(): StoredInstallation | undefined {
  const row = db()
    .prepare<[], InstallationRow>(
      "SELECT * FROM installations WHERE revoked_at IS NULL LIMIT 1"
    )
    .get();
  return row ? getInstallation(row.team_id) : undefined;
}

/* ---------------------------------------------------------------- settings */

export type SettingRow = {
  key: string;
  value: string;
  set_by: string;
  updated_at: string;
};

export function getSetting(key: SettingKey): string | undefined {
  return db()
    .prepare<[string], { value: string }>(
      "SELECT value FROM settings WHERE key = ?"
    )
    .get(key)?.value;
}

export function setSetting(
  key: SettingKey,
  value: string,
  setBy: string
): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO settings (key, value, set_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value      = excluded.value,
         set_by     = excluded.set_by,
         updated_at = excluded.updated_at`
    )
    .run(key, value, setBy, now);
}

export function listSettings(): SettingRow[] {
  return db()
    .prepare<[], SettingRow>("SELECT * FROM settings ORDER BY key")
    .all();
}

/* ------------------------------------------------------------------ events */

export type MeetingTypeRow = "hourly" | "all_day" | "multi_day";
export type EventSource = "google_calendar" | "manual_test";
/**
 * Which of the team's three Google Calendars an Event came from. Only
 * 'team_meeting' Events ever get a Check-in Post or Attendance Tracking —
 * see listEventsDueForCheckin. Set once at insert, never changed.
 */
export type EventCalendarRole = "team_meeting" | "informational" | "mentor";

export type EventRow = {
  id: number;
  calendar_event_id: string | null;
  calendar_link: string | null;
  source: EventSource;
  calendar_role: EventCalendarRole;
  title: string;
  description: string;
  location: string;
  meeting_type: MeetingTypeRow;
  starts_at: string;
  ends_at: string;
  checkin_at: string;
  reaction_cutoff_at: string;
  checkin_channel: string | null;
  checkin_message_ts: string | null;
  checkin_posted_at: string | null;
  finalized_at: string | null;
  removed_at: string | null;
  verification_failed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type NewEvent = {
  calendarEventId: string | null;
  calendarLink: string | null;
  source: EventSource;
  calendarRole: EventCalendarRole;
  title: string;
  description: string;
  location: string;
  meetingType: MeetingTypeRow;
  startsAt: string;
  endsAt: string;
  checkinAt: string;
  reactionCutoffAt: string;
};

export function insertEvent(event: NewEvent): number {
  const now = nowIso();
  const result = db()
    .prepare(
      `INSERT INTO events (calendar_event_id, calendar_link, source, calendar_role, title, description, location,
                            meeting_type, starts_at, ends_at, checkin_at, reaction_cutoff_at,
                            created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.calendarEventId,
      event.calendarLink,
      event.source,
      event.calendarRole,
      event.title,
      event.description,
      event.location,
      event.meetingType,
      event.startsAt,
      event.endsAt,
      event.checkinAt,
      event.reactionCutoffAt,
      now,
      now
    );
  return Number(result.lastInsertRowid);
}

/** Everything a calendar sync might change about an already-known Event — calendar_role is set once at insert and never changes. */
export function updateEventFromCalendar(
  id: number,
  patch: Omit<NewEvent, "calendarEventId" | "source" | "calendarRole">
): void {
  const now = nowIso();
  db()
    .prepare(
      `UPDATE events SET
         calendar_link = ?, title = ?, description = ?, location = ?, meeting_type = ?,
         starts_at = ?, ends_at = ?, checkin_at = ?, reaction_cutoff_at = ?,
         updated_at = ?
       WHERE id = ?`
    )
    .run(
      patch.calendarLink,
      patch.title,
      patch.description,
      patch.location,
      patch.meetingType,
      patch.startsAt,
      patch.endsAt,
      patch.checkinAt,
      patch.reactionCutoffAt,
      now,
      id
    );
}

export function getEventByCalendarId(
  calendarEventId: string
): EventRow | undefined {
  return db()
    .prepare<[string], EventRow>(
      "SELECT * FROM events WHERE calendar_event_id = ?"
    )
    .get(calendarEventId);
}

export function getEvent(id: number): EventRow | undefined {
  return db()
    .prepare<[number], EventRow>("SELECT * FROM events WHERE id = ?")
    .get(id);
}

/** Resolves a reaction or thread-reply event back to the Event it's on. */
export function getEventByCheckinMessage(
  channel: string,
  messageTs: string
): EventRow | undefined {
  return db()
    .prepare<[string, string], EventRow>(
      "SELECT * FROM events WHERE checkin_channel = ? AND checkin_message_ts = ?"
    )
    .get(channel, messageTs);
}

/** A removed Event runs no Reaction Cutoff and credits no hours. */
export function markEventRemoved(id: number): void {
  const now = nowIso();
  db()
    .prepare("UPDATE events SET removed_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
}

export function markCheckinPosted(
  id: number,
  channel: string,
  messageTs: string
): void {
  const now = nowIso();
  db()
    .prepare(
      `UPDATE events SET
         checkin_channel = ?, checkin_message_ts = ?, checkin_posted_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(channel, messageTs, now, now, id);
}

export function markEventFinalized(id: number): void {
  const now = nowIso();
  db()
    .prepare("UPDATE events SET finalized_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
}

/** Reaction Cutoff Verification failed — blocks deletion/finalization. */
export function markVerificationFailed(id: number): void {
  const now = nowIso();
  db()
    .prepare(
      "UPDATE events SET verification_failed_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(now, now, id);
}

/** Cleared at the start of a manual retry, so the attempt starts fresh. */
export function clearVerificationFailed(id: number): void {
  const now = nowIso();
  db()
    .prepare(
      "UPDATE events SET verification_failed_at = NULL, updated_at = ? WHERE id = ?"
    )
    .run(now, id);
}

/** Only the Team Meeting Calendar ever produces a Check-in Post — Informational and Mentor/Teacher Events are listing-only. */
export function listEventsDueForCheckin(nowIsoStr: string): EventRow[] {
  return db()
    .prepare<[string], EventRow>(
      `SELECT * FROM events
       WHERE checkin_posted_at IS NULL AND removed_at IS NULL
         AND calendar_role = 'team_meeting'
         AND meeting_type != 'multi_day' AND checkin_at <= ?`
    )
    .all(nowIsoStr);
}

/** Excludes anything already flagged by Reaction Cutoff Verification — those only move via a manual retry. */
export function listEventsDueForCutoff(nowIsoStr: string): EventRow[] {
  return db()
    .prepare<[string], EventRow>(
      `SELECT * FROM events
       WHERE checkin_posted_at IS NOT NULL AND finalized_at IS NULL
         AND removed_at IS NULL AND verification_failed_at IS NULL
         AND reaction_cutoff_at <= ?`
    )
    .all(nowIsoStr);
}

/* ----------------------------------------------------------------- roster */

/** Snapshots who the Check-in Post's channel included at the moment it posted. */
export function snapshotRoster(
  eventId: number,
  userIds: readonly string[]
): void {
  const insert = db().prepare(
    "INSERT OR IGNORE INTO event_roster (event_id, user_id) VALUES (?, ?)"
  );
  db().transaction((ids: readonly string[]) => {
    for (const userId of ids) insert.run(eventId, userId);
  })(userIds);
}

export function getRoster(eventId: number): string[] {
  return db()
    .prepare<[number], { user_id: string }>(
      "SELECT user_id FROM event_roster WHERE event_id = ?"
    )
    .all(eventId)
    .map((r) => r.user_id);
}

/* ------------------------------------------------------------- attendance */

export type AttendanceRow = {
  event_id: number;
  user_id: string;
  status: "attending" | "not_attending" | null;
  has_clock_reaction: number;
  note: string | null;
  hours_credited: number | null;
  nudged_at: string | null;
  updated_at: string;
};

/** Written by a reaction resync — see slack/reactions.ts. */
export function upsertAttendanceReaction(
  eventId: number,
  userId: string,
  status: "attending" | "not_attending",
  hasClockReaction: boolean
): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO attendance (event_id, user_id, status, has_clock_reaction, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (event_id, user_id) DO UPDATE SET
         status = excluded.status,
         has_clock_reaction = excluded.has_clock_reaction,
         updated_at = excluded.updated_at`
    )
    .run(eventId, userId, status, hasClockReaction ? 1 : 0, now);
}

/**
 * The person removed every reaction. Their Attendance Note, if any, is left
 * alone — only a reaction resync ever touches status/has_clock_reaction.
 */
export function clearAttendanceReaction(eventId: number, userId: string): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO attendance (event_id, user_id, status, has_clock_reaction, updated_at)
       VALUES (?, ?, NULL, 0, ?)
       ON CONFLICT (event_id, user_id) DO UPDATE SET
         status = NULL, has_clock_reaction = 0, updated_at = excluded.updated_at`
    )
    .run(eventId, userId, now);
}

export function setAttendanceNote(
  eventId: number,
  userId: string,
  note: string
): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO attendance (event_id, user_id, note, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (event_id, user_id) DO UPDATE SET
         note = excluded.note, updated_at = excluded.updated_at`
    )
    .run(eventId, userId, note, now);
}

/** Snapshotted once at Reaction Cutoff finalize time — see migrations/0002. */
export function setHoursCredited(
  eventId: number,
  userId: string,
  hours: number
): void {
  db()
    .prepare(
      "UPDATE attendance SET hours_credited = ? WHERE event_id = ? AND user_id = ?"
    )
    .run(hours, eventId, userId);
}

export function wasNudged(eventId: number, userId: string): boolean {
  const row = db()
    .prepare<[number, string], { nudged_at: string | null }>(
      "SELECT nudged_at FROM attendance WHERE event_id = ? AND user_id = ?"
    )
    .get(eventId, userId);
  return row?.nudged_at != null;
}

/** One-shot per person per Event — see domain/attendance.ts, needsLateNudge. */
export function markNudged(eventId: number, userId: string): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO attendance (event_id, user_id, has_clock_reaction, nudged_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (event_id, user_id) DO UPDATE SET
         nudged_at = excluded.nudged_at, updated_at = excluded.updated_at`
    )
    .run(eventId, userId, now, now);
}

export function getAttendanceForEvent(eventId: number): AttendanceRow[] {
  return db()
    .prepare<[number], AttendanceRow>(
      "SELECT * FROM attendance WHERE event_id = ?"
    )
    .all(eventId);
}

/* -------------------------------------------------------------- reporting */

export type PersonEventOutcome = {
  meetingType: MeetingTypeRow;
  status: "attending" | "not_attending" | null;
  hoursCredited: number | null;
};

// source = 'google_calendar' keeps manual_test Events (see ADR-0002) out of
// every real report and export. Shared by every "countable event" query —
// season outcomes and the No Response Alert's recent-outcomes lookup alike —
// so a future change to what counts never has to be made in two places.
const COUNTABLE_EVENT_WHERE = `
  e.removed_at IS NULL AND e.finalized_at IS NOT NULL
    AND e.source = 'google_calendar'
    AND e.meeting_type IN ('hourly', 'all_day')
`;

const SEASON_OUTCOMES_WHERE = `
  WHERE ${COUNTABLE_EVENT_WHERE}
    AND e.starts_at >= ? AND e.starts_at < ?
`;

const SEASON_OUTCOMES_SQL = `
  SELECT e.meeting_type, a.status, a.hours_credited
  FROM events e
  JOIN event_roster r ON r.event_id = e.id AND r.user_id = ?
  LEFT JOIN attendance a ON a.event_id = e.id AND a.user_id = r.user_id
  ${SEASON_OUTCOMES_WHERE}
`;

/** Every finalized Event in range this person's Roster included them on. */
export function getPersonSeasonOutcomes(
  userId: string,
  startIso: string,
  endIso: string
): PersonEventOutcome[] {
  return db()
    .prepare<
      [string, string, string],
      {
        meeting_type: MeetingTypeRow;
        status: "attending" | "not_attending" | null;
        hours_credited: number | null;
      }
    >(SEASON_OUTCOMES_SQL)
    .all(userId, startIso, endIso)
    .map((r) => ({
      meetingType: r.meeting_type,
      status: r.status,
      hoursCredited: r.hours_credited,
    }));
}

/** The same, for every person who appears on any Roster in range — for export. */
export function getTeamSeasonOutcomes(
  startIso: string,
  endIso: string
): Map<string, PersonEventOutcome[]> {
  const rows = db()
    .prepare<
      [string, string],
      {
        user_id: string;
        meeting_type: MeetingTypeRow;
        status: "attending" | "not_attending" | null;
        hours_credited: number | null;
      }
    >(
      `SELECT r.user_id, e.meeting_type, a.status, a.hours_credited
       FROM events e
       JOIN event_roster r ON r.event_id = e.id
       LEFT JOIN attendance a ON a.event_id = e.id AND a.user_id = r.user_id
       ${SEASON_OUTCOMES_WHERE}`
    )
    .all(startIso, endIso);

  const byUser = new Map<string, PersonEventOutcome[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({
      meetingType: r.meeting_type,
      status: r.status,
      hoursCredited: r.hours_credited,
    });
    byUser.set(r.user_id, list);
  }
  return byUser;
}

export type RecentOutcomeRow = {
  title: string;
  starts_at: string;
  status: "attending" | "not_attending" | null;
};

/**
 * One person's most recent tracked-meeting outcomes, newest first — same
 * countable-event filters as SEASON_OUTCOMES_WHERE, ordered and limited
 * instead of date-ranged. The extra calendar_role check is defensive
 * belt-and-suspenders: every event_roster row is already team_meeting-only
 * in practice (see snapshotRoster/listEventsDueForCheckin), but nothing in
 * the schema enforces that. Feeds domain/noResponseAlert.ts's
 * isNoResponseStreak.
 */
export function getRecentOutcomesForUser(
  userId: string,
  limit: number
): RecentOutcomeRow[] {
  return db()
    .prepare<[string, number], RecentOutcomeRow>(
      `SELECT e.title, e.starts_at, a.status
       FROM events e
       JOIN event_roster r ON r.event_id = e.id AND r.user_id = ?
       LEFT JOIN attendance a ON a.event_id = e.id AND a.user_id = r.user_id
       WHERE ${COUNTABLE_EVENT_WHERE}
         AND e.calendar_role = 'team_meeting'
       ORDER BY e.starts_at DESC
       LIMIT ?`
    )
    .all(userId, limit);
}

/* --------------------------------------------------------- weekly summary */

/**
 * Every non-removed Event starting in range for one Calendar Role, any
 * Meeting Type — for the Team Meeting Weekly Summary, the Informational
 * reply, and the Mentor/Teacher Weekly Summary alike.
 */
export function listEventsStartingInRange(
  startIso: string,
  endIso: string,
  calendarRole: EventCalendarRole
): EventRow[] {
  return db()
    .prepare<[EventCalendarRole, string, string], EventRow>(
      `SELECT * FROM events
       WHERE removed_at IS NULL AND calendar_role = ?
         AND starts_at >= ? AND starts_at < ?
       ORDER BY starts_at`
    )
    .all(calendarRole, startIso, endIso);
}

export type WeeklySummaryRow = {
  id: number;
  channel: string;
  message_ts: string;
  week_start: string;
  week_end: string;
  posted_at: string;
  /** Null until (if the Informational Calendar is enabled) the first Informational Event of the week is discovered. */
  informational_channel: string | null;
  informational_message_ts: string | null;
};

export function insertWeeklySummary(args: {
  channel: string;
  messageTs: string;
  weekStart: string;
  weekEnd: string;
}): number {
  const result = db()
    .prepare(
      `INSERT INTO weekly_summaries (channel, message_ts, week_start, week_end, posted_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(args.channel, args.messageTs, args.weekStart, args.weekEnd, nowIso());
  return Number(result.lastInsertRowid);
}

/** The currently-active Weekly Summary Post, if one has ever been sent. */
export function getMostRecentWeeklySummary(): WeeklySummaryRow | undefined {
  return db()
    .prepare<[], WeeklySummaryRow>(
      "SELECT * FROM weekly_summaries ORDER BY posted_at DESC LIMIT 1"
    )
    .get();
}

export type WeeklySummaryItemRow = {
  weekly_summary_id: number;
  event_id: number;
  snapshot_title: string;
  snapshot_meeting_type: MeetingTypeRow;
  snapshot_starts_at: string;
  snapshot_ends_at: string;
  snapshot_location: string;
  added_mid_week: number;
  removed: number;
};

export type NewWeeklySummaryItem = {
  weeklySummaryId: number;
  eventId: number;
  snapshotTitle: string;
  snapshotMeetingType: MeetingTypeRow;
  snapshotStartsAt: string;
  snapshotEndsAt: string;
  snapshotLocation: string;
  addedMidWeek: boolean;
};

/** Snapshots an Event's details as first shown in this Weekly Summary Post — Change Reflection always diffs against this, never the previous edit. */
export function insertWeeklySummaryItem(item: NewWeeklySummaryItem): void {
  db()
    .prepare(
      `INSERT INTO weekly_summary_items
         (weekly_summary_id, event_id, snapshot_title, snapshot_meeting_type,
          snapshot_starts_at, snapshot_ends_at, snapshot_location, added_mid_week)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      item.weeklySummaryId,
      item.eventId,
      item.snapshotTitle,
      item.snapshotMeetingType,
      item.snapshotStartsAt,
      item.snapshotEndsAt,
      item.snapshotLocation,
      item.addedMidWeek ? 1 : 0
    );
}

export function getWeeklySummaryItem(
  weeklySummaryId: number,
  eventId: number
): WeeklySummaryItemRow | undefined {
  return db()
    .prepare<[number, number], WeeklySummaryItemRow>(
      "SELECT * FROM weekly_summary_items WHERE weekly_summary_id = ? AND event_id = ?"
    )
    .get(weeklySummaryId, eventId);
}

/** Every item on a Weekly Summary Post — the rebuild-from-scratch source when reflecting a change. */
export function listWeeklySummaryItems(
  weeklySummaryId: number
): WeeklySummaryItemRow[] {
  return db()
    .prepare<[number], WeeklySummaryItemRow>(
      "SELECT * FROM weekly_summary_items WHERE weekly_summary_id = ?"
    )
    .all(weeklySummaryId);
}

export function markWeeklySummaryItemRemoved(
  weeklySummaryId: number,
  eventId: number
): void {
  db()
    .prepare(
      "UPDATE weekly_summary_items SET removed = 1 WHERE weekly_summary_id = ? AND event_id = ?"
    )
    .run(weeklySummaryId, eventId);
}

/** Recorded the first time the Informational Calendar has an Event within a given week's post — see weeklySummary.ts. */
export function setInformationalReply(
  weeklySummaryId: number,
  channel: string,
  messageTs: string
): void {
  db()
    .prepare(
      "UPDATE weekly_summaries SET informational_channel = ?, informational_message_ts = ? WHERE id = ?"
    )
    .run(channel, messageTs, weeklySummaryId);
}

/* ---------------------------------------------- weekly summary: informational */

export type WeeklySummaryInformationalItemRow = {
  weekly_summary_id: number;
  event_id: number;
  snapshot_title: string;
  snapshot_meeting_type: MeetingTypeRow;
  snapshot_starts_at: string;
  snapshot_ends_at: string;
  snapshot_location: string;
  added_mid_week: number;
  removed: number;
};

export type NewWeeklySummaryInformationalItem = {
  weeklySummaryId: number;
  eventId: number;
  snapshotTitle: string;
  snapshotMeetingType: MeetingTypeRow;
  snapshotStartsAt: string;
  snapshotEndsAt: string;
  snapshotLocation: string;
  addedMidWeek: boolean;
};

/** Mirrors insertWeeklySummaryItem, for the Informational reply's own item set. */
export function insertWeeklySummaryInformationalItem(
  item: NewWeeklySummaryInformationalItem
): void {
  db()
    .prepare(
      `INSERT INTO weekly_summary_informational_items
         (weekly_summary_id, event_id, snapshot_title, snapshot_meeting_type,
          snapshot_starts_at, snapshot_ends_at, snapshot_location, added_mid_week)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      item.weeklySummaryId,
      item.eventId,
      item.snapshotTitle,
      item.snapshotMeetingType,
      item.snapshotStartsAt,
      item.snapshotEndsAt,
      item.snapshotLocation,
      item.addedMidWeek ? 1 : 0
    );
}

export function getWeeklySummaryInformationalItem(
  weeklySummaryId: number,
  eventId: number
): WeeklySummaryInformationalItemRow | undefined {
  return db()
    .prepare<[number, number], WeeklySummaryInformationalItemRow>(
      "SELECT * FROM weekly_summary_informational_items WHERE weekly_summary_id = ? AND event_id = ?"
    )
    .get(weeklySummaryId, eventId);
}

export function listWeeklySummaryInformationalItems(
  weeklySummaryId: number
): WeeklySummaryInformationalItemRow[] {
  return db()
    .prepare<[number], WeeklySummaryInformationalItemRow>(
      "SELECT * FROM weekly_summary_informational_items WHERE weekly_summary_id = ?"
    )
    .all(weeklySummaryId);
}

export function markWeeklySummaryInformationalItemRemoved(
  weeklySummaryId: number,
  eventId: number
): void {
  db()
    .prepare(
      "UPDATE weekly_summary_informational_items SET removed = 1 WHERE weekly_summary_id = ? AND event_id = ?"
    )
    .run(weeklySummaryId, eventId);
}

/* --------------------------------------------------------- mentor summary */

export type MentorSummaryRow = {
  id: number;
  channel: string;
  message_ts: string;
  week_start: string;
  week_end: string;
  posted_at: string;
};

/** No item table — the Mentor/Teacher Weekly Summary has no mid-window edit-in-place, see mentorSummary.ts. */
export function insertMentorSummary(args: {
  channel: string;
  messageTs: string;
  weekStart: string;
  weekEnd: string;
}): number {
  const result = db()
    .prepare(
      `INSERT INTO mentor_summaries (channel, message_ts, week_start, week_end, posted_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(args.channel, args.messageTs, args.weekStart, args.weekEnd, nowIso());
  return Number(result.lastInsertRowid);
}

export function getMostRecentMentorSummary(): MentorSummaryRow | undefined {
  return db()
    .prepare<[], MentorSummaryRow>(
      "SELECT * FROM mentor_summaries ORDER BY posted_at DESC LIMIT 1"
    )
    .get();
}

/* --------------------------------------------------- no response alert */

export type NoResponseAlertRow = {
  id: number;
  channel: string;
  message_ts: string | null;
  posted_at: string;
};

/**
 * No item table — each week's alert is independent, never edited or
 * deleted, see noResponseAlert.ts. `messageTs` is null for a "checked,
 * nobody flagged" run — still a row, so the due-check advances either way.
 */
export function insertNoResponseAlert(args: {
  channel: string;
  messageTs: string | null;
}): number {
  const result = db()
    .prepare(
      `INSERT INTO no_response_alerts (channel, message_ts, posted_at)
       VALUES (?, ?, ?)`
    )
    .run(args.channel, args.messageTs, nowIso());
  return Number(result.lastInsertRowid);
}

export function getMostRecentNoResponseAlert(): NoResponseAlertRow | undefined {
  return db()
    .prepare<[], NoResponseAlertRow>(
      "SELECT * FROM no_response_alerts ORDER BY posted_at DESC LIMIT 1"
    )
    .get();
}
