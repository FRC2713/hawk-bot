import assert from "node:assert/strict";
import { test } from "node:test";
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
  upcomingEvents,
  withoutDaySuffix,
} from "../src/domain/calendar.js";

// Midnight/day-before math reads wall-clock dates via local Date methods,
// which depend on the process's TZ. Pin it so this test's expectations
// don't depend on the machine running it.
process.env.TZ = "UTC";

const hourlyRaw = {
  id: "evt1",
  status: "confirmed" as const,
  summary: "Team Meeting",
  description: "Bring your laptop",
  location: "Room 204",
  start: { dateTime: "2026-01-06T18:00:00.000Z" },
  end: { dateTime: "2026-01-06T20:00:00.000Z" },
};

const allDayRaw = {
  id: "evt2",
  status: "confirmed" as const,
  summary: "Build Day",
  start: { date: "2026-01-10" },
  // Google's Calendar API end.date is exclusive: a single-day all-day event
  // has end.date one day after start.date.
  end: { date: "2026-01-11" },
};

const multiDayRaw = {
  id: "evt3",
  status: "confirmed" as const,
  summary: "Regional Competition",
  start: { date: "2026-03-05" },
  end: { date: "2026-03-08" },
};

test("a timed calendar event maps to Hourly", () => {
  const event = mapCalendarEvent(hourlyRaw);
  assert.equal(event.meetingType, "hourly");
  assert.equal(event.title, "Team Meeting");
  assert.equal(event.location, "Room 204");
  assert.equal(event.startsAt.toISOString(), "2026-01-06T18:00:00.000Z");
  assert.equal(event.endsAt.toISOString(), "2026-01-06T20:00:00.000Z");
});

test("a single-day all-day calendar event maps to All-Day, accounting for Google's exclusive end date", () => {
  const event = mapCalendarEvent(allDayRaw);
  assert.equal(event.meetingType, "all_day");
});

test("an all-day calendar event spanning multiple days maps to Multi-Day", () => {
  const event = mapCalendarEvent(multiDayRaw);
  assert.equal(event.meetingType, "multi_day");
});

test("a cancelled calendar event maps as cancelled regardless of shape", () => {
  const event = mapCalendarEvent({ ...hourlyRaw, status: "cancelled" });
  assert.equal(event.cancelled, true);
});

test("a missing title falls back rather than throwing", () => {
  const event = mapCalendarEvent({ ...hourlyRaw, summary: undefined });
  assert.equal(event.title, "(untitled)");
});

test("an Hourly cutoff defaults to midnight ending the day it starts", () => {
  const event = mapCalendarEvent(hourlyRaw); // 6-8pm UTC, well before midnight
  assert.equal(reactionCutoff(event).toISOString(), "2026-01-07T00:00:00.000Z");
});

test("an Hourly event ending at or after midnight gets a 10am cutoff instead", () => {
  const event = mapCalendarEvent({
    ...hourlyRaw,
    start: { dateTime: "2026-01-06T22:00:00.000Z" },
    end: { dateTime: "2026-01-07T01:00:00.000Z" },
  });
  assert.equal(reactionCutoff(event).toISOString(), "2026-01-07T10:00:00.000Z");
});

test("an All-Day cutoff is always midnight ending that day, never the 10am rule", () => {
  const event = mapCalendarEvent(allDayRaw);
  assert.equal(reactionCutoff(event).toISOString(), "2026-01-11T00:00:00.000Z");
});

test("Check-in Post Timing for Hourly is N hours before the scheduled start", () => {
  const event = mapCalendarEvent(hourlyRaw);
  const offsets = {
    hourlyHoursBefore: 4,
    allDayHour: 16,
    allDayMinute: 0,
  };
  assert.equal(
    checkinPostTime(event, offsets).toISOString(),
    "2026-01-06T14:00:00.000Z"
  );
});

test("Check-in Post Timing for All-Day is a fixed time the day before", () => {
  const event = mapCalendarEvent(allDayRaw);
  const offsets = {
    hourlyHoursBefore: 4,
    allDayHour: 16,
    allDayMinute: 0,
  };
  assert.equal(
    checkinPostTime(event, offsets).toISOString(),
    "2026-01-09T16:00:00.000Z"
  );
});

test("a removed event is classified as removed even if other fields also changed", () => {
  const previous = mapCalendarEvent(hourlyRaw);
  const current = mapCalendarEvent({ ...hourlyRaw, status: "cancelled" });
  assert.deepEqual(diffEvent(previous, current), { kind: "removed" });
});

test("an edit lists every field that changed", () => {
  const previous = mapCalendarEvent(hourlyRaw);
  const current = mapCalendarEvent({
    ...hourlyRaw,
    location: "Room 310",
    end: { dateTime: "2026-01-06T21:00:00.000Z" },
  });
  const change = diffEvent(previous, current);
  assert.equal(change.kind, "edited");
  if (change.kind !== "edited") return;
  assert.deepEqual(change.changedFields.sort(), ["end time", "location"]);
});

test("no change is reported as unchanged", () => {
  const previous = mapCalendarEvent(hourlyRaw);
  const current = mapCalendarEvent(hourlyRaw);
  assert.deepEqual(diffEvent(previous, current), { kind: "unchanged" });
});

test("unset Check-in Post Timing settings fall back to the starting defaults", () => {
  assert.deepEqual(resolveCheckinOffsets(undefined, undefined), {
    hourlyHoursBefore: 4,
    allDayHour: 16,
    allDayMinute: 0,
  });
});

test("a set Check-in Post Timing overrides only the setting that was set", () => {
  assert.deepEqual(resolveCheckinOffsets("2", undefined), {
    hourlyHoursBefore: 2,
    allDayHour: 16,
    allDayMinute: 0,
  });
  assert.deepEqual(resolveCheckinOffsets(undefined, "09:30"), {
    hourlyHoursBefore: 4,
    allDayHour: 9,
    allDayMinute: 30,
  });
});

const now = new Date("2026-01-06T00:00:00.000Z");
const soon = mapCalendarEvent({
  ...hourlyRaw,
  id: "soon",
  start: { dateTime: "2026-01-06T12:00:00.000Z" },
  end: { dateTime: "2026-01-06T13:00:00.000Z" },
});
const later = mapCalendarEvent({
  ...hourlyRaw,
  id: "later",
  start: { dateTime: "2026-01-08T12:00:00.000Z" },
  end: { dateTime: "2026-01-08T13:00:00.000Z" },
});
const past = mapCalendarEvent({
  ...hourlyRaw,
  id: "past",
  start: { dateTime: "2026-01-01T12:00:00.000Z" },
  end: { dateTime: "2026-01-01T13:00:00.000Z" },
});
const cancelled = mapCalendarEvent({
  ...hourlyRaw,
  id: "cancelled",
  status: "cancelled",
  start: { dateTime: "2026-01-07T12:00:00.000Z" },
  end: { dateTime: "2026-01-07T13:00:00.000Z" },
});

test("upcomingEvents drops past and cancelled events, earliest first", () => {
  assert.deepEqual(
    upcomingEvents([later, past, cancelled, soon], now, 3).map(
      (e) => e.calendarEventId
    ),
    ["soon", "later"]
  );
});

test("upcomingEvents caps at count", () => {
  assert.equal(upcomingEvents([soon, later], now, 1).length, 1);
});

/* ------------------------------------------------- Multi-Day Child Events */

const multiDayParent = mapCalendarEvent(multiDayRaw); // evt3, Mar 5 (incl.) – Mar 8 (excl.) = 3 days
const checkinOffsets = {
  hourlyHoursBefore: 4,
  allDayHour: 16,
  allDayMinute: 0,
};

test("a 3-day Multi-Day Event generates one Child per day, labeled Day N of M", () => {
  const result = multiDayChildEvents(multiDayParent, checkinOffsets, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.children.length, 3);
  assert.deepEqual(
    result.children.map((c) => c.calendarEventId),
    ["evt3::2026-03-05", "evt3::2026-03-06", "evt3::2026-03-07"]
  );
  assert.deepEqual(
    result.children.map((c) => c.title),
    [
      "Regional Competition (Day 1 of 3)",
      "Regional Competition (Day 2 of 3)",
      "Regional Competition (Day 3 of 3)",
    ]
  );
  assert.ok(result.children.every((c) => c.meetingType === "all_day"));
});

test("each Multi-Day Child spans exactly its own calendar day, exclusive end", () => {
  const result = multiDayChildEvents(multiDayParent, checkinOffsets, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [day1, day2, day3] = result.children;
  assert.ok(day1 && day2 && day3);
  assert.equal(day1.startsAt.toISOString(), "2026-03-05T00:00:00.000Z");
  assert.equal(day1.endsAt.toISOString(), "2026-03-06T00:00:00.000Z");
  assert.equal(day2.startsAt.toISOString(), "2026-03-06T00:00:00.000Z");
  assert.equal(day2.endsAt.toISOString(), "2026-03-07T00:00:00.000Z");
  assert.equal(day3.startsAt.toISOString(), "2026-03-07T00:00:00.000Z");
  assert.equal(day3.endsAt.toISOString(), "2026-03-08T00:00:00.000Z");
});

test("every Multi-Day Child shares the same front-loaded Check-in time, N days before the first day", () => {
  const result = multiDayChildEvents(multiDayParent, checkinOffsets, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const checkinTimes = result.children.map((c) => c.checkinAt.toISOString());
  assert.deepEqual(checkinTimes, [
    "2026-03-03T16:00:00.000Z",
    "2026-03-03T16:00:00.000Z",
    "2026-03-03T16:00:00.000Z",
  ]);
});

test("a Multi-Day Child, run through the existing All-Day Reaction Cutoff formula, gets an independent per-day cutoff", () => {
  const result = multiDayChildEvents(multiDayParent, checkinOffsets, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const cutoffs = result.children.map((c) =>
    reactionCutoff({
      meetingType: c.meetingType,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
    }).toISOString()
  );
  // Distinct, one per day, despite every Child sharing one checkinAt above.
  assert.deepEqual(cutoffs, [
    "2026-03-06T00:00:00.000Z",
    "2026-03-07T00:00:00.000Z",
    "2026-03-08T00:00:00.000Z",
  ]);
});

test(`a span at the ${MULTI_DAY_MAX_DAYS}-day cap still generates Children`, () => {
  const tenDayEvent = mapCalendarEvent({
    ...multiDayRaw,
    start: { date: "2026-03-05" },
    end: { date: "2026-03-15" }, // exclusive end, 10 calendar days
  });
  const result = multiDayChildEvents(tenDayEvent, checkinOffsets, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.children.length, MULTI_DAY_MAX_DAYS);
});

test(`a span one day over the ${MULTI_DAY_MAX_DAYS}-day cap is rejected, not truncated`, () => {
  const elevenDayEvent = mapCalendarEvent({
    ...multiDayRaw,
    start: { date: "2026-03-05" },
    end: { date: "2026-03-16" }, // exclusive end, 11 calendar days
  });
  const result = multiDayChildEvents(elevenDayEvent, checkinOffsets, 2);
  assert.deepEqual(result, { ok: false, dayCount: 11 });
});

test("reconcileMultiDayChildren creates a Child for a day added to the span", () => {
  assert.deepEqual(
    reconcileMultiDayChildren(
      ["evt3::day1", "evt3::day2", "evt3::day3"],
      ["evt3::day1", "evt3::day2", "evt3::day3", "evt3::day4"]
    ),
    { toCreate: ["evt3::day4"], toRemove: [] }
  );
});

test("reconcileMultiDayChildren removes a Child for a day dropped from the middle of the span", () => {
  assert.deepEqual(
    reconcileMultiDayChildren(
      ["evt3::day1", "evt3::day2", "evt3::day3"],
      ["evt3::day1", "evt3::day3"]
    ),
    { toCreate: [], toRemove: ["evt3::day2"] }
  );
});

test("reconcileMultiDayChildren removes a Child for a day dropped off the end of the span", () => {
  assert.deepEqual(
    reconcileMultiDayChildren(
      ["evt3::day1", "evt3::day2", "evt3::day3"],
      ["evt3::day1", "evt3::day2"]
    ),
    { toCreate: [], toRemove: ["evt3::day3"] }
  );
});

test("reconcileMultiDayChildren is a no-op when the span hasn't changed", () => {
  const ids = ["evt3::day1", "evt3::day2", "evt3::day3"];
  assert.deepEqual(reconcileMultiDayChildren(ids, ids), {
    toCreate: [],
    toRemove: [],
  });
});

test("a Multi-Day Event whose span shifts (not just grows or shrinks) keeps the same id for a day that stays in the span", () => {
  // Mar 5-7 (3 days) shifts to Mar 6-8 (still 3 days, one day later).
  const before = multiDayChildEvents(multiDayParent, checkinOffsets, 2);
  const shifted = mapCalendarEvent({
    ...multiDayRaw,
    start: { date: "2026-03-06" },
    end: { date: "2026-03-09" },
  });
  const after = multiDayChildEvents(shifted, checkinOffsets, 2);
  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  if (!before.ok || !after.ok) return;

  const { toCreate, toRemove } = reconcileMultiDayChildren(
    before.children.map((c) => c.calendarEventId),
    after.children.map((c) => c.calendarEventId)
  );
  // Mar 6 and Mar 7 are in both spans and must not be recreated; only
  // Mar 5 (dropped) and Mar 8 (added) should move.
  assert.deepEqual(toCreate, ["evt3::2026-03-08"]);
  assert.deepEqual(toRemove, ["evt3::2026-03-05"]);
});

test("withoutDaySuffix strips the Day-N-of-M tag but leaves the rest of the title alone", () => {
  assert.equal(
    withoutDaySuffix("Regional Competition (Day 2 of 3)"),
    "Regional Competition"
  );
  assert.equal(
    withoutDaySuffix("Regional Competition (Day 2 of 4)"),
    "Regional Competition",
    "a day count that only changed because another day was added/removed still strips cleanly"
  );
  assert.equal(
    withoutDaySuffix("State Championship (Day 2 of 3)"),
    "State Championship",
    "a real title edit alongside the Child's own suffix still leaves a comparably different base title"
  );
  assert.equal(
    withoutDaySuffix("Team Meeting"),
    "Team Meeting",
    "a title with no suffix at all is returned unchanged"
  );
});

test("an unset Multi-Day Check-in lead time falls back to the starting default", () => {
  assert.equal(resolveMultiDayDaysBefore(undefined), 2);
});

test("a set Multi-Day Check-in lead time overrides the default", () => {
  assert.equal(resolveMultiDayDaysBefore("3"), 3);
});
