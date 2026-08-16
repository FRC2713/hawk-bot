import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkinPostTime,
  diffEvent,
  mapCalendarEvent,
  reactionCutoff,
  resolveCheckinOffsets,
  upcomingEvents,
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
