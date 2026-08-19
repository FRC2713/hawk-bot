import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attendancePercent,
  attendanceStatusFor,
  currentSeasonRange,
  describeVerificationFailure,
  formatAttendanceReportSummary,
  formatAttendanceReportTable,
  formatDateRange,
  formatSeasonAttendanceTable,
  hoursCredited,
  isClockReaction,
  isoDate,
  isThumbsUpReaction,
  needsLateNudge,
  resolveAllDayHours,
  stillNeedsLateNudge,
  toAttendanceCsv,
  verifyAttendanceCoverage,
  type AttendanceReportRow,
} from "../src/domain/attendance.js";

// Season math reads wall-clock dates via local Date methods, which depend on
// the process's TZ. Pin it so this test's expectations don't depend on the
// machine running it.
process.env.TZ = "UTC";

test("thumbs up is recognized regardless of skin tone", () => {
  assert.equal(isThumbsUpReaction("+1"), true);
  assert.equal(isThumbsUpReaction("+1::skin-tone-2"), true);
  assert.equal(isThumbsUpReaction("thumbsup"), true);
  assert.equal(isThumbsUpReaction("thumbsup::skin-tone-5"), true);
  assert.equal(isThumbsUpReaction("-1"), false);
});

test("every standard clock-face emoji is recognized, on the hour and half hour", () => {
  for (let hour = 1; hour <= 12; hour++) {
    assert.equal(isClockReaction(`clock${hour}`), true, `clock${hour}`);
    assert.equal(isClockReaction(`clock${hour}30`), true, `clock${hour}30`);
  }
});

test("alarm clock and stopwatch count as clock reactions, but unrelated emoji do not", () => {
  assert.equal(isClockReaction("alarm_clock"), true);
  assert.equal(isClockReaction("stopwatch"), true);
  assert.equal(isClockReaction("timer_clock"), true);
  assert.equal(isClockReaction("tada"), false);
  assert.equal(isClockReaction("x"), false);
});

test("a thumbs up is Attending, no matter what else is on the post", () => {
  assert.equal(attendanceStatusFor(["+1"]), "attending");
  assert.equal(attendanceStatusFor(["+1", "clock3"]), "attending");
  assert.equal(attendanceStatusFor(["+1", "tada"]), "attending");
});

test("a bare clock reaction with no thumbs up is Not Attending", () => {
  assert.equal(attendanceStatusFor(["clock3"]), "not_attending");
});

test("any other reaction with no thumbs up is Not Attending", () => {
  assert.equal(attendanceStatusFor(["x"]), "not_attending");
});

test("no reaction at all is No Response, distinct from Not Attending", () => {
  assert.equal(attendanceStatusFor([]), "no_response");
});

test("a clock reaction with no thumbs up needs a nudge; paired with thumbs up it does not", () => {
  assert.equal(needsLateNudge(["clock3"]), true);
  assert.equal(needsLateNudge(["alarm_clock"]), true);
  assert.equal(needsLateNudge(["+1", "clock3"]), false);
  assert.equal(needsLateNudge(["+1"]), false);
  assert.equal(needsLateNudge(["x"]), false);
});

test("the delayed nudge re-check agrees with needsLateNudge, from an attendance row instead of a live reaction list", () => {
  assert.equal(
    stillNeedsLateNudge({ status: "not_attending", hasClockReaction: true }),
    true
  );
  // Thumbs up landed since — status flipped to attending.
  assert.equal(
    stillNeedsLateNudge({ status: "attending", hasClockReaction: true }),
    false
  );
  // Clock reaction removed since.
  assert.equal(
    stillNeedsLateNudge({ status: "not_attending", hasClockReaction: false }),
    false
  );
  // Every reaction removed since.
  assert.equal(
    stillNeedsLateNudge({ status: null, hasClockReaction: false }),
    false
  );
});

test("hourly hours credited is the scheduled duration", () => {
  const hours = hoursCredited({
    meetingType: "hourly",
    startsAt: new Date("2026-01-06T18:00:00Z"),
    endsAt: new Date("2026-01-06T20:30:00Z"),
    defaultAllDayHours: 8,
  });
  assert.equal(hours, 2.5);
});

test("all-day hours credited is the configured default, regardless of the calendar's own times", () => {
  const hours = hoursCredited({
    meetingType: "all_day",
    startsAt: new Date("2026-01-06T00:00:00Z"),
    endsAt: new Date("2026-01-07T00:00:00Z"),
    defaultAllDayHours: 6,
  });
  assert.equal(hours, 6);
});

test("the season starts July 1st and rolls over exactly then", () => {
  assert.equal(
    currentSeasonRange(new Date("2026-06-30T23:59:59Z")).start.toISOString(),
    "2025-07-01T00:00:00.000Z"
  );
  assert.equal(
    currentSeasonRange(new Date("2026-07-01T00:00:00Z")).start.toISOString(),
    "2026-07-01T00:00:00.000Z"
  );
  assert.equal(
    currentSeasonRange(new Date("2026-07-01T00:00:00Z")).end.toISOString(),
    "2027-07-01T00:00:00.000Z"
  );
});

test("attendance percent is out of every event that was not a no-response, plus no-response itself", () => {
  assert.equal(attendancePercent(3, 1, 1), 60);
  assert.equal(attendancePercent(0, 0, 0), 0);
});

test("isoDate reads YYYY-MM-DD off the UTC calendar date", () => {
  assert.equal(isoDate(new Date("2026-07-01T00:00:00Z")), "2026-07-01");
});

test("formatDateRange is human-readable, not the raw ISO dates", () => {
  assert.equal(
    formatDateRange(
      new Date("2026-07-01T00:00:00Z"),
      new Date("2027-07-01T00:00:00Z")
    ),
    "Jul 1, 2026 – Jul 1, 2027"
  );
});

test("CSV export escapes fields that contain commas or quotes", () => {
  const csv = toAttendanceCsv([
    {
      userId: "U1",
      displayName: "Ada, Lovelace",
      eventsAttending: 4,
      eventsNotAttending: 1,
      eventsNoResponse: 0,
      hoursCredited: 10,
    },
  ]);
  const lines = csv.trim().split("\n");
  assert.equal(
    lines[0],
    "user_id,display_name,attending,not_attending,no_response,attendance_percent,hours_credited"
  );
  assert.match(lines[1] ?? "", /^U1,"Ada, Lovelace",4,1,0,80,10$/);
});

test("the season attendance table is the same aligned, code-block style as the report table", () => {
  const table = formatSeasonAttendanceTable([
    {
      userId: "U1",
      displayName: "Ada",
      eventsAttending: 4,
      eventsNotAttending: 1,
      eventsNoResponse: 0,
      hoursCredited: 10,
    },
  ]);
  assert.match(table, /^```\n/);
  assert.match(table, /\n```$/);
  assert.match(
    table,
    /Name\s+Attending\s+Not Attending\s+No Response\s+Attendance\s+Hours/
  );
  assert.match(table, /Ada\s+4\s+1\s+0\s+80%\s+10/);
});

test("an empty season attendance table says so rather than showing a bare header", () => {
  assert.equal(
    formatSeasonAttendanceTable([]),
    "```\n(no attendance data yet)\n```"
  );
});

test("default All-Day hours falls back to the starting default until set", () => {
  assert.equal(resolveAllDayHours(undefined), 8);
  assert.equal(resolveAllDayHours("6.5"), 6.5);
});

test("verification fails outright if the resync itself failed, regardless of coverage", () => {
  const result = verifyAttendanceCoverage({
    resyncSucceeded: false,
    reactedUserIds: [],
    recordedUserIds: [],
  });
  assert.deepEqual(result, { ok: false, reason: "resync_failed" });
});

test("a resync failure detail carries through to the result and the description", () => {
  const result = verifyAttendanceCoverage({
    resyncSucceeded: false,
    resyncFailureDetail: "I'm not a member of that channel.",
    reactedUserIds: [],
    recordedUserIds: [],
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "resync_failed",
    detail: "I'm not a member of that channel.",
  });
  assert.equal(
    describeVerificationFailure(
      result as Extract<typeof result, { ok: false }>
    ),
    "the reaction resync failed: I'm not a member of that channel."
  );
});

test("verification passes when every reacted user has a recorded row", () => {
  const result = verifyAttendanceCoverage({
    resyncSucceeded: true,
    reactedUserIds: ["U1", "U2"],
    recordedUserIds: ["U1", "U2"],
  });
  assert.deepEqual(result, { ok: true });
});

test("verification fails and names exactly who's missing when a reacted user has no recorded row", () => {
  const result = verifyAttendanceCoverage({
    resyncSucceeded: true,
    reactedUserIds: ["U1", "U2", "U3"],
    recordedUserIds: ["U1"],
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "coverage_mismatch",
    missingUserIds: ["U2", "U3"],
  });
});

test("a stale recorded row for someone who removed their reaction doesn't fail verification", () => {
  const result = verifyAttendanceCoverage({
    resyncSucceeded: true,
    reactedUserIds: ["U1"],
    recordedUserIds: ["U1", "U2"],
  });
  assert.deepEqual(result, { ok: true });
});

test("the report summary states counts and credited hours, not a summed total, and reads as a final report", () => {
  const rows: AttendanceReportRow[] = [
    { displayName: "Ada", status: "attending", reactions: ["+1"], note: null },
    {
      displayName: "Grace",
      status: "attending",
      reactions: ["+1"],
      note: null,
    },
    {
      displayName: "Alan",
      status: "not_attending",
      reactions: ["x"],
      note: null,
    },
    {
      displayName: "Barbara",
      status: "no_response",
      reactions: [],
      note: null,
    },
  ];
  const summary = formatAttendanceReportSummary({
    eventTitle: "Team Meeting",
    rows,
    hoursPerAttendee: 2,
    startsAt: new Date("2026-08-17T18:30:00Z"),
    endsAt: new Date("2026-08-17T20:30:00Z"),
    meetingType: "hourly",
  });
  assert.equal(
    summary,
    [
      ":calendar: *Meeting Attendance Report*",
      "> *Team Meeting*",
      "> Monday, August 17, 6:30 PM–8:30 PM (2h credited)",
      "",
      "• 2 attended :thumbsup:",
      "• 1 didn't attend :x:",
      "• 1 no response :no_entry_sign:",
    ].join("\n")
  );
});

test("an all-day meeting's report summary shows just the date, with its fixed credited hours", () => {
  const rows: AttendanceReportRow[] = [
    { displayName: "Ada", status: "attending", reactions: ["+1"], note: null },
  ];
  const summary = formatAttendanceReportSummary({
    eventTitle: "Regionals",
    rows,
    hoursPerAttendee: 8,
    startsAt: new Date("2026-08-17T00:00:00Z"),
    endsAt: new Date("2026-08-18T00:00:00Z"),
    meetingType: "all_day",
  });
  assert.equal(
    summary,
    [
      ":calendar: *Meeting Attendance Report*",
      "> *Regionals*",
      "> Monday, August 17 (8h credited)",
      "",
      "• 1 attended :thumbsup:",
      "• 0 didn't attend :x:",
      "• 0 no response :no_entry_sign:",
    ].join("\n")
  );
});

test("the report table shows one aligned row per person, with a placeholder for no reactions", () => {
  const rows: AttendanceReportRow[] = [
    { displayName: "Ada", status: "attending", reactions: ["+1"], note: null },
    {
      displayName: "Barbara",
      status: "no_response",
      reactions: [],
      note: null,
    },
  ];
  const table = formatAttendanceReportTable(rows);
  assert.match(table, /^```\n/);
  assert.match(table, /\n```$/);
  assert.match(table, /Ada\s+Attended\s+\+1/);
  assert.match(table, /Barbara\s+No Response\s+—/);
});

test("the report table appends a person's Attendance Note when they left one", () => {
  const rows: AttendanceReportRow[] = [
    {
      displayName: "Alan",
      status: "not_attending",
      reactions: ["x"],
      note: "sick",
    },
  ];
  const table = formatAttendanceReportTable(rows);
  assert.match(table, /Alan\s+Didn't Attend\s+x\s+sick/);
});

test("an empty roster renders a placeholder instead of an empty table", () => {
  const table = formatAttendanceReportTable([]);
  assert.equal(table, "```\n(no one on the roster)\n```");
});
