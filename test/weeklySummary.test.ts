import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_WEEKLY_SUMMARY_TIMING,
  assembleWeeklySummaryMessage,
  formatWeeklySummaryLine,
  isWeeklySummaryDue,
  renderEditedLine,
  renderNewLine,
  renderRemovedLine,
  resolveWeeklySummaryTiming,
  upcomingWeekRange,
  weeklySummaryChangedFields,
  type WeeklySummaryEventInfo,
} from "../src/domain/weeklySummary.js";

// Day/time math reads wall-clock dates via local Date methods, which depend
// on the process's TZ. Pin it so this test's expectations don't depend on
// the machine running it.
process.env.TZ = "UTC";

test("an unset Weekly Summary Timing falls back to Sunday noon", () => {
  assert.deepEqual(resolveWeeklySummaryTiming(undefined), {
    dayOfWeek: 0,
    hour: 12,
    minute: 0,
  });
  assert.deepEqual(
    resolveWeeklySummaryTiming("SUN 12:00"),
    DEFAULT_WEEKLY_SUMMARY_TIMING
  );
});

test("a set Weekly Summary Timing parses the day and time", () => {
  assert.deepEqual(resolveWeeklySummaryTiming("WED 09:30"), {
    dayOfWeek: 3,
    hour: 9,
    minute: 30,
  });
});

test("with no prior post, the Weekly Summary is always due", () => {
  const now = new Date("2026-01-07T15:00:00Z"); // a Wednesday
  assert.equal(
    isWeeklySummaryDue(null, DEFAULT_WEEKLY_SUMMARY_TIMING, now),
    true
  );
});

test("not due again until the next occurrence after the last post", () => {
  // 2026-01-04 is a Sunday.
  const lastPostedAt = new Date("2026-01-04T12:00:00Z");
  const laterSameWeek = new Date("2026-01-06T09:00:00Z"); // Tuesday
  assert.equal(
    isWeeklySummaryDue(
      lastPostedAt,
      DEFAULT_WEEKLY_SUMMARY_TIMING,
      laterSameWeek
    ),
    false
  );

  const nextSundayAfternoon = new Date("2026-01-11T13:00:00Z");
  assert.equal(
    isWeeklySummaryDue(
      lastPostedAt,
      DEFAULT_WEEKLY_SUMMARY_TIMING,
      nextSundayAfternoon
    ),
    true
  );
});

test("due exactly at the occurrence, not only strictly after it", () => {
  const lastPostedAt = new Date("2026-01-04T12:00:00Z");
  const nextOccurrenceExactly = new Date("2026-01-11T12:00:00Z");
  assert.equal(
    isWeeklySummaryDue(
      lastPostedAt,
      DEFAULT_WEEKLY_SUMMARY_TIMING,
      nextOccurrenceExactly
    ),
    true
  );
  // Posting right at that instant means it's no longer due an instant later.
  assert.equal(
    isWeeklySummaryDue(
      nextOccurrenceExactly,
      DEFAULT_WEEKLY_SUMMARY_TIMING,
      nextOccurrenceExactly
    ),
    false
  );
});

test("the upcoming week starts the day after a Sunday post", () => {
  const postedAt = new Date("2026-01-04T12:00:00Z"); // Sunday
  const range = upcomingWeekRange(postedAt);
  assert.equal(range.start.toISOString(), "2026-01-05T00:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-01-12T00:00:00.000Z");
});

test("posting on a Monday still means next Monday, not today", () => {
  const postedAt = new Date("2026-01-05T09:00:00Z"); // Monday
  const range = upcomingWeekRange(postedAt);
  assert.equal(range.start.toISOString(), "2026-01-12T00:00:00.000Z");
});

test("posting mid-week rolls forward to the following Monday", () => {
  const postedAt = new Date("2026-01-07T09:00:00Z"); // Wednesday
  const range = upcomingWeekRange(postedAt);
  assert.equal(range.start.toISOString(), "2026-01-12T00:00:00.000Z");
});

const hourlyInfo: WeeklySummaryEventInfo = {
  title: "Team Meeting",
  meetingType: "hourly",
  startsAt: new Date("2026-01-06T18:00:00Z"),
  endsAt: new Date("2026-01-06T20:00:00Z"),
  location: "Room 204",
};

const allDayInfo: WeeklySummaryEventInfo = {
  title: "Build Day",
  meetingType: "all_day",
  startsAt: new Date("2026-01-10T00:00:00Z"),
  endsAt: new Date("2026-01-11T00:00:00Z"),
  location: "",
};

const multiDayInfo: WeeklySummaryEventInfo = {
  title: "Regional Competition",
  meetingType: "multi_day",
  startsAt: new Date("2026-03-05T00:00:00Z"),
  endsAt: new Date("2026-03-08T00:00:00Z"), // exclusive, per Google's convention
  location: "Convention Center",
};

test("an Hourly line shows the date, time range, and location", () => {
  const line = formatWeeklySummaryLine(hourlyInfo);
  assert.match(line, /Team Meeting/);
  assert.match(line, /6:00 PM.*8:00 PM/);
  assert.match(line, /Room 204/);
});

test("an All-Day line shows a single date and skips an empty location", () => {
  const line = formatWeeklySummaryLine(allDayInfo);
  assert.match(line, /Build Day/);
  assert.doesNotMatch(line, /📍/);
});

test("a Multi-Day line shows an inclusive date range, accounting for the exclusive end date", () => {
  const line = formatWeeklySummaryLine(multiDayInfo);
  assert.match(line, /Regional Competition/);
  // Exclusive end 2026-03-08 means the last real day is the 7th, not the 8th.
  assert.match(line, /Mar 5/);
  assert.match(line, /Mar 7/);
  assert.doesNotMatch(line, /Mar 8/);
});

test("an edited line strikes through the snapshot and tags what changed", () => {
  const edited = { ...hourlyInfo, location: "Room 310" };
  const line = renderEditedLine({
    snapshot: hourlyInfo,
    current: edited,
    changedFields: ["location"],
  });
  assert.match(line, /~.*Room 204.*~/);
  assert.match(line, /Room 310/);
  assert.match(line, /\(updated: location\)/);
});

test("a removed line strikes through the whole line and labels it removed", () => {
  const line = renderRemovedLine(hourlyInfo);
  assert.match(line, /~.*Team Meeting.*~/);
  assert.match(line, /\(removed\)/);
});

test("a new mid-week line is tagged, not struck through", () => {
  const line = renderNewLine(hourlyInfo);
  assert.match(line, /^🆕 \*New:\*/);
  assert.doesNotMatch(line, /~/);
});

test("the assembled message sorts entries chronologically regardless of input order", () => {
  const message = assembleWeeklySummaryMessage({
    weekStart: new Date("2026-01-05T00:00:00Z"),
    weekEnd: new Date("2026-01-12T00:00:00Z"),
    entries: [
      { sortKey: new Date("2026-01-10T00:00:00Z"), text: "Second event" },
      { sortKey: new Date("2026-01-06T00:00:00Z"), text: "First event" },
    ],
  });
  assert.ok(message.indexOf("First event") < message.indexOf("Second event"));
});

test("an empty week says so rather than showing a bare header", () => {
  const message = assembleWeeklySummaryMessage({
    weekStart: new Date("2026-01-05T00:00:00Z"),
    weekEnd: new Date("2026-01-12T00:00:00Z"),
    entries: [],
  });
  assert.match(message, /nothing/i);
});

test("no changed fields when the snapshot and current state match", () => {
  assert.deepEqual(weeklySummaryChangedFields(hourlyInfo, hourlyInfo), []);
});

test("changed fields names exactly the displayed fields that differ", () => {
  const current: WeeklySummaryEventInfo = {
    ...hourlyInfo,
    location: "Room 310",
    endsAt: new Date("2026-01-06T21:00:00Z"),
  };
  assert.deepEqual(weeklySummaryChangedFields(hourlyInfo, current).sort(), [
    "end time",
    "location",
  ]);
});
