import { WebClient } from "@slack/web-api";
import { SLASH_COMMAND } from "./brand.js";
import {
  describeVerificationFailure,
  formatAttendanceReportSummary,
  formatAttendanceReportTable,
  hoursCredited,
  resolveAllDayHours,
  verifyAttendanceCoverage,
  type AttendanceReportRow,
  type AttendanceStatus,
  type MeetingType,
  type VerificationResult,
} from "./domain/attendance.js";
import {
  checkinPostTime,
  diffEvent,
  mapCalendarEvent,
  MULTI_DAY_MAX_DAYS,
  multiDayChildEvents,
  reactionCutoff,
  reconcileMultiDayChildren,
  resolveCheckinOffsets,
  resolveMultiDayDaysBefore,
  withoutDaySuffix,
  type CheckinPostOffsets,
  type MappedEvent,
} from "./domain/calendar.js";
import { fetchCalendarEvents } from "./calendar/client.js";
import {
  anyInstallation,
  getAttendanceForEvent,
  getEvent,
  getEventByCalendarId,
  getRoster,
  getSetting,
  insertEvent,
  listEventsDueForCheckin,
  listEventsDueForCutoff,
  listMultiDayChildren,
  markCheckinPosted,
  markEventFinalized,
  markEventRemoved,
  markVerificationFailed,
  setHoursCredited,
  snapshotRoster,
  updateEventFromCalendar,
  type EventCalendarRole,
  type EventRow,
} from "./db/repo.js";
import { log } from "./logger.js";
import {
  announceEventEdited,
  announceEventRemoved,
  postCheckinPost,
} from "./slack/checkin.js";
import { syncAttendanceFromSlack } from "./slack/attendanceEvents.js";
import { listHawkBotAdmins } from "./slack/authz.js";
import { describeChannelAccessError } from "./slack/channelAccess.js";
import { openDirectMessage } from "./slack/dm.js";
import { postDueMentorSummary } from "./mentorSummary.js";
import { postDueNoResponseAlert } from "./noResponseAlert.js";
import type { SettingKey } from "./domain/settings.js";
import {
  postDueWeeklySummary,
  reflectWeeklySummaryChange,
} from "./weeklySummary.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

type Installed = { client: WebClient; botUserId: string };

function currentInstallation(): Installed | undefined {
  const installation = anyInstallation();
  if (!installation) return undefined;
  const payload = installation.payload as {
    bot?: { token?: string; userId?: string };
  };
  const token = payload.bot?.token;
  const botUserId = payload.bot?.userId;
  if (!token || !botUserId) return undefined;
  return { client: new WebClient(token), botUserId };
}

function checkinOffsets(): CheckinPostOffsets {
  return resolveCheckinOffsets(
    getSetting("checkin_offset_hourly_hours"),
    getSetting("checkin_offset_allday_time")
  );
}

function defaultAllDayHours(): number {
  return resolveAllDayHours(getSetting("default_all_day_hours"));
}

function multiDayDaysBefore(): number {
  return resolveMultiDayDaysBefore(getSetting("checkin_offset_multiday_days"));
}

function toMappedEvent(row: EventRow): MappedEvent {
  return {
    calendarEventId: row.calendar_event_id ?? "",
    title: row.title,
    description: row.description,
    location: row.location,
    meetingType: row.meeting_type,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    cancelled: false,
    calendarLink: row.calendar_link,
  };
}

/**
 * A Multi-Day Child's MappedEvent, for reuse with `diffEvent` — same shape
 * `toMappedEvent` produces for a stored row, but built from a freshly
 * generated MultiDayChildSpec plus the parent's current
 * description/location/link (a Child has no calendar entry of its own to
 * read those from; it inherits them unchanged from its Multi-Day Event
 * parent every sync).
 */
function toChildMappedEvent(
  spec: {
    calendarEventId: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
  },
  parentMapped: MappedEvent
): MappedEvent {
  return {
    calendarEventId: spec.calendarEventId,
    title: spec.title,
    description: parentMapped.description,
    location: parentMapped.location,
    meetingType: "all_day",
    startsAt: spec.startsAt,
    endsAt: spec.endsAt,
    cancelled: false,
    calendarLink: parentMapped.calendarLink,
  };
}

/**
 * DMs every HawkBot Admin that a Multi-Day Event was too long to
 * auto-generate Children for — see domain/calendar.ts, MULTI_DAY_MAX_DAYS.
 * Mirrors notifyVerificationFailure's DM-every-admin shape.
 */
async function notifyMultiDayOverCap(
  client: WebClient,
  parentMapped: MappedEvent,
  dayCount: number
): Promise<void> {
  const text = [
    `⚠️ *${parentMapped.title}* spans ${dayCount} days, over the ${MULTI_DAY_MAX_DAYS}-day limit for automatic Multi-Day Check-in Posts.`,
    "No Check-in Posts were generated for it — this one needs to be handled manually.",
  ].join("\n");

  for (const userId of await listHawkBotAdmins(client)) {
    const dmChannel = await openDirectMessage(client, userId);
    if (!dmChannel) continue;
    await client.chat.postMessage({ channel: dmChannel, text }).catch((err) =>
      log.error("could not DM multi-day over-cap notice", {
        userId,
        calendarEventId: parentMapped.calendarEventId,
        error: String(err),
      })
    );
  }
}

/**
 * `markEventRemoved` plus the "announce it, but only if it was already
 * live" step every Removed path needs — the pre-existing single-Event
 * removed branch and both new Multi-Day Child removal call sites all do
 * exactly this, so it lives once here instead of three times. Refuses to
 * touch a row that's already removed or already finalized: a finalized
 * Event's recorded attendance is never retroactively altered by sync,
 * Multi-Day Children included (see `syncOneCalendar`'s own
 * `existing.finalized_at || existing.removed_at` guard).
 */
async function removeEventAndAnnounce(
  client: WebClient,
  row: EventRow
): Promise<void> {
  if (row.removed_at || row.finalized_at) return;
  markEventRemoved(row.id);
  if (row.checkin_posted_at) {
    await announceEventRemoved(client, row);
  }
}

/**
 * Marks every still-live, not-yet-finalized Multi-Day Child of a cancelled
 * Multi-Day Event removed, announcing the cancellation on any that already
 * had a live Check-in Post — the same single-Event Removed handling every
 * other Event gets, just run once per Child. See CONTEXT.md, Multi-Day
 * Child Event.
 */
async function removeAllMultiDayChildren(
  client: WebClient,
  parentId: number
): Promise<void> {
  for (const child of listMultiDayChildren(parentId)) {
    await removeEventAndAnnounce(client, child);
  }
}

function stripDaySuffix(mapped: MappedEvent): MappedEvent {
  return { ...mapped, title: withoutDaySuffix(mapped.title) };
}

/**
 * Generates/reconciles a Multi-Day Event's per-day Children against its
 * current span — creating a Child for a newly added day, marking removed
 * one for a dropped day (never touching an already-finalized Child's
 * recorded attendance), and propagating a parent-level field edit (title,
 * description, location) to every still-live Child, reusing the exact
 * single-Event Calendar Change Handling flow once per Child. Every other
 * mechanic (Check-in Post, Reaction Cutoff, Event Attendance Report) needs
 * no special handling here at all — a Child is an ordinary all_day Event
 * once it exists, and `postDueCheckins`/`finalizeDueCutoffs` pick it up the
 * same way they would any other. See CONTEXT.md, Multi-Day Child Event.
 */
async function syncMultiDayChildren(
  client: WebClient,
  parentRow: EventRow,
  parentMapped: MappedEvent,
  offsets: CheckinPostOffsets
): Promise<void> {
  const result = multiDayChildEvents(
    parentMapped,
    offsets,
    multiDayDaysBefore()
  );
  if (!result.ok) {
    await notifyMultiDayOverCap(client, parentMapped, result.dayCount);
    return;
  }

  const existingChildren = listMultiDayChildren(parentRow.id);
  const { toCreate, toRemove } = reconcileMultiDayChildren(
    existingChildren.map((c) => c.calendar_event_id ?? ""),
    result.children.map((c) => c.calendarEventId)
  );

  for (const spec of result.children) {
    if (!toCreate.includes(spec.calendarEventId)) continue;
    insertEvent({
      calendarEventId: spec.calendarEventId,
      calendarLink: parentMapped.calendarLink,
      source: "google_calendar",
      calendarRole: parentRow.calendar_role,
      title: spec.title,
      description: parentMapped.description,
      location: parentMapped.location,
      meetingType: spec.meetingType,
      startsAt: spec.startsAt.toISOString(),
      endsAt: spec.endsAt.toISOString(),
      checkinAt: spec.checkinAt.toISOString(),
      reactionCutoffAt: reactionCutoff({
        meetingType: spec.meetingType,
        startsAt: spec.startsAt,
        endsAt: spec.endsAt,
      }).toISOString(),
      multidayParentId: parentRow.id,
    });
  }

  for (const child of existingChildren) {
    if (!toRemove.includes(child.calendar_event_id ?? "")) continue;
    await removeEventAndAnnounce(client, child);
  }

  const continuing = existingChildren.filter(
    (c) =>
      !c.removed_at &&
      !c.finalized_at &&
      !toRemove.includes(c.calendar_event_id ?? "")
  );
  for (const child of continuing) {
    const spec = result.children.find(
      (s) => s.calendarEventId === child.calendar_event_id
    );
    if (!spec) continue;

    const current = toChildMappedEvent(spec, parentMapped);
    const change = diffEvent(
      stripDaySuffix(toMappedEvent(child)),
      stripDaySuffix(current)
    );
    if (change.kind !== "edited") continue;

    updateEventFromCalendar(child.id, {
      calendarLink: current.calendarLink,
      title: current.title,
      description: current.description,
      location: current.location,
      meetingType: current.meetingType,
      startsAt: current.startsAt.toISOString(),
      endsAt: current.endsAt.toISOString(),
      checkinAt: spec.checkinAt.toISOString(),
      reactionCutoffAt: reactionCutoff({
        meetingType: current.meetingType,
        startsAt: current.startsAt,
        endsAt: current.endsAt,
      }).toISOString(),
    });
    const updatedChild = getEvent(child.id);
    if (updatedChild && child.checkin_posted_at) {
      await announceEventEdited(
        client,
        child,
        updatedChild,
        change.changedFields
      );
    }
  }
}

/**
 * The team's three Google Calendars, each read through the same shared
 * service account, and the Calendar Role their Events are tagged with once
 * stored — see db/repo.ts, EventCalendarRole. Informational and
 * Mentor/Teacher are only synced once a HawkBot Admin sets their id;
 * setting/clearing that id is the whole on/off toggle for each (see
 * domain/settings.ts) — nothing else gates whether they're polled.
 *
 * Exported so `commands/calendar.ts`'s manual preview reads the same list
 * rather than keeping its own — two lists of "which SettingKey is a
 * calendar" would drift the next time one gets renamed, the way
 * `google_calendar_id` already has (migration 0008).
 */
export const CALENDAR_SOURCES: readonly {
  settingKey: SettingKey;
  calendarRole: EventCalendarRole;
  label: string;
}[] = [
  {
    settingKey: "team_meeting_calendar_id",
    calendarRole: "team_meeting",
    label: "Team Meeting",
  },
  {
    settingKey: "informational_calendar_id",
    calendarRole: "informational",
    label: "Informational",
  },
  {
    settingKey: "mentor_calendar_id",
    calendarRole: "mentor",
    label: "Mentor/Teacher",
  },
];

/**
 * Pulls one calendar, applies Meeting Type derivation, and runs Calendar
 * Change Handling for anything already tracked, plus Weekly Summary Change
 * Reflection for anything within the current week — reflectWeeklySummaryChange
 * itself routes by the Event's Calendar Role (see weeklySummary.ts). Multi-Day
 * entries are tracked as Events too (for a Weekly Summary listing — see
 * CONTEXT.md, Weekly Summary Post) but never get a Check-in Post or
 * attendance tracking, which stays deferred, and stays exclusive to
 * `team_meeting` Events regardless of Meeting Type (see
 * listEventsDueForCheckin).
 */
async function syncOneCalendar(
  client: WebClient,
  calendarId: string,
  calendarRole: EventCalendarRole
): Promise<void> {
  // Read as the impersonated Workspace user when delegation is configured —
  // see calendar/client.ts, CalendarAccess, for why a Workspace often leaves
  // no other option.
  const raw = await fetchCalendarEvents(calendarId, {
    subject: getSetting("google_impersonated_user"),
  });
  const offsets = checkinOffsets();

  for (const rawEvent of raw) {
    let mapped: MappedEvent;
    try {
      mapped = mapCalendarEvent(rawEvent);
    } catch (err) {
      log.error("could not map calendar event", {
        id: rawEvent.id,
        error: String(err),
      });
      continue;
    }

    const existing = getEventByCalendarId(mapped.calendarEventId);

    if (!existing) {
      if (mapped.cancelled) continue;
      const newId = insertEvent({
        calendarEventId: mapped.calendarEventId,
        calendarLink: mapped.calendarLink,
        source: "google_calendar",
        calendarRole,
        title: mapped.title,
        description: mapped.description,
        location: mapped.location,
        meetingType: mapped.meetingType,
        startsAt: mapped.startsAt.toISOString(),
        endsAt: mapped.endsAt.toISOString(),
        checkinAt: checkinPostTime(mapped, offsets).toISOString(),
        reactionCutoffAt: reactionCutoff(mapped).toISOString(),
      });
      const newRow = getEvent(newId);
      if (newRow) {
        await reflectWeeklySummaryChange(client, newRow, "changed");
        if (
          mapped.meetingType === "multi_day" &&
          calendarRole === "team_meeting"
        ) {
          await syncMultiDayChildren(client, newRow, mapped, offsets);
        }
      }
      continue;
    }

    if (existing.finalized_at || existing.removed_at) continue;

    const change = diffEvent(toMappedEvent(existing), mapped);
    if (change.kind === "unchanged") continue;

    if (change.kind === "removed") {
      await removeEventAndAnnounce(client, existing);
      await reflectWeeklySummaryChange(client, existing, "removed");
      if (existing.meeting_type === "multi_day") {
        await removeAllMultiDayChildren(client, existing.id);
      }
      continue;
    }

    // edited
    updateEventFromCalendar(existing.id, {
      calendarLink: mapped.calendarLink,
      title: mapped.title,
      description: mapped.description,
      location: mapped.location,
      meetingType: mapped.meetingType,
      startsAt: mapped.startsAt.toISOString(),
      endsAt: mapped.endsAt.toISOString(),
      checkinAt: checkinPostTime(mapped, offsets).toISOString(),
      reactionCutoffAt: reactionCutoff(mapped).toISOString(),
    });
    const updated = getEvent(existing.id);
    if (updated) {
      // existing is the stale pre-edit row, updated is fresh — announceEventEdited
      // needs both to show old-vs-new per field, and rewrites the post from updated.
      if (existing.checkin_posted_at) {
        await announceEventEdited(
          client,
          existing,
          updated,
          change.changedFields
        );
      }
      await reflectWeeklySummaryChange(client, updated, "changed");
      if (
        updated.meeting_type === "multi_day" &&
        updated.calendar_role === "team_meeting"
      ) {
        await syncMultiDayChildren(client, updated, mapped, offsets);
      } else if (existing.meeting_type === "multi_day") {
        // The span no longer maps to Multi-Day (e.g. shortened to a single
        // day) — any Children generated while it still was one are no
        // longer reconciled by anything else, so clean them up here rather
        // than leaving them orphaned.
        await removeAllMultiDayChildren(client, existing.id);
      }
    }
  }
}

async function syncCalendars(client: WebClient): Promise<void> {
  for (const { settingKey, calendarRole } of CALENDAR_SOURCES) {
    const calendarId = getSetting(settingKey);
    if (!calendarId) continue;
    await syncOneCalendar(client, calendarId, calendarRole);
  }
}

async function postDueCheckins(
  client: WebClient,
  botUserId: string
): Promise<void> {
  const channelId = getSetting("announce_channel");
  if (!channelId) return;

  for (const event of listEventsDueForCheckin(new Date().toISOString())) {
    const { channel, ts, roster } = await postCheckinPost(
      client,
      event,
      channelId,
      botUserId
    );
    markCheckinPosted(event.id, channel, ts);
    snapshotRoster(event.id, roster);
    log.info("check-in post sent", { eventId: event.id, channel, ts });
  }
}

async function notifyVerificationFailure(
  client: WebClient,
  event: EventRow,
  verification: Extract<VerificationResult, { ok: false }>
): Promise<void> {
  const reason = describeVerificationFailure(verification);
  const text = [
    `⚠️ Reaction Cutoff Verification failed for *${event.title}* (Event #${event.id}).`,
    `Reason: ${reason}`,
    "The Check-in Post was left in place — nothing was deleted or finalized.",
    `Once you understand what went wrong, run \`${SLASH_COMMAND} event retry-cutoff ${event.id}\`.`,
  ].join("\n");

  for (const userId of await listHawkBotAdmins(client)) {
    const dmChannel = await openDirectMessage(client, userId);
    if (!dmChannel) continue;
    await client.chat.postMessage({ channel: dmChannel, text }).catch((err) =>
      log.error("could not DM verification failure", {
        userId,
        eventId: event.id,
        error: String(err),
      })
    );
  }
}

async function buildReportRows(
  client: WebClient,
  event: EventRow,
  reactions: Map<string, string[]>
): Promise<AttendanceReportRow[]> {
  const attendanceByUser = new Map(
    getAttendanceForEvent(event.id).map((r) => [r.user_id, r])
  );

  const rows: AttendanceReportRow[] = [];
  for (const userId of getRoster(event.id)) {
    const info = await client.users
      .info({ user: userId })
      .catch(() => undefined);
    const displayName = info?.user?.real_name ?? info?.user?.name ?? userId;
    const attendanceRow = attendanceByUser.get(userId);
    const status: AttendanceStatus = attendanceRow?.status ?? "no_response";
    rows.push({
      displayName,
      status,
      reactions: reactions.get(userId) ?? [],
      note: attendanceRow?.note ?? null,
    });
  }
  return rows;
}

/** Skips quietly until an admin sets `attendance_report_channel`. */
async function postEventAttendanceReport(
  client: WebClient,
  event: EventRow,
  reactions: Map<string, string[]>
): Promise<void> {
  const channelId = getSetting("attendance_report_channel");
  if (!channelId) return;

  const rows = await buildReportRows(client, event, reactions);
  const hoursPerAttendee = hoursCredited({
    meetingType: event.meeting_type as MeetingType,
    startsAt: new Date(event.starts_at),
    endsAt: new Date(event.ends_at),
    defaultAllDayHours: defaultAllDayHours(),
  });

  const posted = await client.chat.postMessage({
    channel: channelId,
    text: formatAttendanceReportSummary({
      eventTitle: event.title,
      rows,
      hoursPerAttendee,
      startsAt: new Date(event.starts_at),
      endsAt: new Date(event.ends_at),
      meetingType: event.meeting_type as MeetingType,
    }),
  });
  if (posted.channel && posted.ts) {
    await client.chat.postMessage({
      channel: posted.channel,
      thread_ts: posted.ts,
      text: formatAttendanceReportTable(rows),
    });
  }
}

/**
 * Resync, verify, and — only on success — credit hours, delete the
 * Check-in Post, finalize, and post the Event Attendance Report. Shared by
 * the scheduler's normal sweep and the manual `/hawkbot event retry-cutoff`
 * command, so a retry is exactly the same flow run again on demand.
 */
export async function attemptEventCutoff(
  client: WebClient,
  botUserId: string,
  event: EventRow
): Promise<VerificationResult> {
  let reactions = new Map<string, string[]>();
  let resyncSucceeded = true;
  let resyncFailureDetail: string | undefined;
  try {
    ({ reactions } = await syncAttendanceFromSlack(client, event, botUserId));
  } catch (err) {
    resyncSucceeded = false;
    resyncFailureDetail = describeChannelAccessError(err);
    log.error("cutoff resync failed", {
      eventId: event.id,
      error: String(err),
    });
  }

  const recordedUserIds = getAttendanceForEvent(event.id)
    .filter((r) => r.status !== null)
    .map((r) => r.user_id);

  const verification = verifyAttendanceCoverage({
    resyncSucceeded,
    resyncFailureDetail,
    reactedUserIds: [...reactions.keys()],
    recordedUserIds,
  });

  if (!verification.ok) {
    markVerificationFailed(event.id);
    await notifyVerificationFailure(client, event, verification);
    log.error("cutoff verification failed", {
      eventId: event.id,
      verification,
    });
    return verification;
  }

  const allDayHours = defaultAllDayHours();
  for (const row of getAttendanceForEvent(event.id)) {
    if (row.status !== "attending") continue;
    const hours = hoursCredited({
      meetingType: event.meeting_type as MeetingType,
      startsAt: new Date(event.starts_at),
      endsAt: new Date(event.ends_at),
      defaultAllDayHours: allDayHours,
    });
    setHoursCredited(event.id, row.user_id, hours);
  }

  if (event.checkin_channel && event.checkin_message_ts) {
    await client.chat
      .delete({
        channel: event.checkin_channel,
        ts: event.checkin_message_ts,
      })
      .catch((err) =>
        log.error("could not delete check-in post", {
          eventId: event.id,
          error: String(err),
        })
      );
  }
  markEventFinalized(event.id);
  log.info("event finalized", { eventId: event.id });

  await postEventAttendanceReport(client, event, reactions);

  return verification;
}

async function finalizeDueCutoffs(
  client: WebClient,
  botUserId: string
): Promise<void> {
  for (const event of listEventsDueForCutoff(new Date().toISOString())) {
    await attemptEventCutoff(client, botUserId, event);
  }
}

export type SchedulerStepFailure = { step: string; error: string; at: string };
export type SchedulerStepResult =
  { step: string; ok: true } | { step: string; ok: false; error: string };

/**
 * Runs `fn`, catching and describing any rejection rather than letting it
 * propagate. Pure aside from `fn` itself — no shared state — so the
 * isolation behavior this exists for (a throwing step never stops the next
 * `runStep` call) is directly testable, see test/scheduler.test.ts.
 */
export async function runStep(
  step: string,
  fn: () => Promise<void>
): Promise<SchedulerStepResult> {
  try {
    await fn();
    return { step, ok: true };
  } catch (err) {
    return {
      step,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The steps below used to share one `try`, so an exception early in the list
 * (e.g. `syncCalendars` failing on a bad Google credential) silently
 * prevented every step after it from ever running — including, once,
 * `postDueWeeklySummary`. Each step now runs through `runStep`, which never
 * throws, so a broken calendar sync no longer takes down Check-ins,
 * cutoffs, or summaries with it.
 *
 * The last failure per step is kept in memory (not persisted — a restart
 * clearing it is fine) and surfaced through `/hawkbot status`, since an
 * operator without shell access to the host otherwise has no way to see a
 * tick failure at all.
 */
const lastStepFailures = new Map<string, SchedulerStepFailure>();
let lastTickAt: string | null = null;

async function recordStep(
  step: string,
  fn: () => Promise<void>
): Promise<void> {
  const result = await runStep(step, fn);
  if (result.ok) {
    lastStepFailures.delete(step);
    return;
  }
  log.error("scheduler step failed", { step, error: result.error });
  lastStepFailures.set(step, {
    step,
    error: result.error,
    at: new Date().toISOString(),
  });
}

export function getSchedulerDiagnostics(): {
  lastTickAt: string | null;
  failures: SchedulerStepFailure[];
} {
  return { lastTickAt, failures: [...lastStepFailures.values()] };
}

export async function runSchedulerTick(): Promise<void> {
  const installed = currentInstallation();
  if (!installed) return;
  const { client, botUserId } = installed;

  await recordStep("calendar sync", () => syncCalendars(client));
  await recordStep("weekly summary", () => postDueWeeklySummary(client));
  await recordStep("mentor summary", () => postDueMentorSummary(client));
  await recordStep("no-response alert", () =>
    postDueNoResponseAlert(client, botUserId)
  );
  await recordStep("check-ins", () => postDueCheckins(client, botUserId));
  await recordStep("cutoffs", () => finalizeDueCutoffs(client, botUserId));

  lastTickAt = new Date().toISOString();
}

export function startScheduler(): NodeJS.Timeout {
  return setInterval(() => void runSchedulerTick(), POLL_INTERVAL_MS);
}
