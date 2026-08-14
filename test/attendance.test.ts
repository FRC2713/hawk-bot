import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attendancePercent,
  attendanceStatusFor,
  currentSeasonRange,
  hoursCredited,
  isClockReaction,
  isThumbsUpReaction,
  needsLateNudge,
  toAttendanceCsv,
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
