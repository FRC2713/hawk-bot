import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCalendarId,
  SETTINGS,
  checkSetting,
  unwrapChannel,
  unwrapUserGroupHandle,
} from "../src/domain/settings.js";

test("an unknown key is refused, and the message names the known ones", () => {
  const result = checkSetting("announcement_channel", "C0123456789");
  assert.equal(result.ok, false);
  if (result.ok) return;
  for (const s of SETTINGS) assert.match(result.reason, new RegExp(s.key));
});

test("a channel id is accepted; a channel name is not", () => {
  assert.equal(checkSetting("announce_channel", "C0123456789").ok, true);
  assert.equal(checkSetting("announce_channel", "#general").ok, false);
});

test("Slack's escaped channel mention is unwrapped rather than rejected", () => {
  assert.equal(unwrapChannel("<#C0123456789|general>"), "C0123456789");
  const result = checkSetting("announce_channel", "<#C0123456789|general>");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, "C0123456789");
});

test("a blank value never lands in the database", () => {
  assert.equal(checkSetting("home_note", "   ").ok, false);
});

test("free text is bounded", () => {
  assert.equal(checkSetting("home_note", "Tue/Thu 6-9pm").ok, true);
  assert.equal(checkSetting("home_note", "x".repeat(201)).ok, false);
});

test("the Team Meeting Calendar id has to look like a calendar id", () => {
  assert.equal(
    checkSetting("team_meeting_calendar_id", "team@group.calendar.google.com")
      .ok,
    true
  );
  assert.equal(checkSetting("team_meeting_calendar_id", "   ").ok, false);
  // Google's own long-form Workspace ids, and the two other legal shapes.
  assert.equal(
    checkSetting(
      "team_meeting_calendar_id",
      "c_f28f2b2f7fac90b1a6c8bb2819b15f054799129d919c05b22c7e68b7752165cc@group.calendar.google.com"
    ).ok,
    true
  );
  assert.equal(checkSetting("team_meeting_calendar_id", "primary").ok, true);
  assert.equal(
    checkSetting(
      "team_meeting_calendar_id",
      "en.usa#holiday@group.v.calendar.google.com"
    ).ok,
    true
  );
});

// The failure this exists for: an id pasted out of a browser can carry a
// character that renders as nothing, survives trim(), and percent-encodes into
// the request path — so Google 404s a calendar that is shared correctly, and
// every message that echoes the value back looks perfect.
test("a calendar id carrying an invisible character is refused, not stored", () => {
  const clean = "team@group.calendar.google.com";
  for (const [name, invisible] of [
    ["zero-width space", "​"],
    ["zero-width joiner", "‍"],
    ["non-breaking space", " "],
    ["byte-order mark", "﻿"],
  ] as const) {
    const pasted = clean.replace("@", `${invisible}@`);
    // Precondition: it really is indistinguishable by the old length check.
    assert.equal(pasted.trim().length > 0, true, name);
    assert.notEqual(pasted, clean, name);

    const result = checkSetting("team_meeting_calendar_id", pasted);
    assert.equal(result.ok, false, `${name} should be refused`);
    if (!result.ok) assert.match(result.reason, /invisible character/);
  }
});

test("the Hourly check-in offset is a positive whole number of hours", () => {
  assert.equal(checkSetting("checkin_offset_hourly_hours", "4").ok, true);
  assert.equal(checkSetting("checkin_offset_hourly_hours", "0").ok, false);
  assert.equal(checkSetting("checkin_offset_hourly_hours", "4.5").ok, false);
  assert.equal(checkSetting("checkin_offset_hourly_hours", "soon").ok, false);
});

test("the All-Day check-in time is a 24-hour HH:MM", () => {
  assert.equal(checkSetting("checkin_offset_allday_time", "16:00").ok, true);
  assert.equal(checkSetting("checkin_offset_allday_time", "4:00 PM").ok, false);
  assert.equal(checkSetting("checkin_offset_allday_time", "25:00").ok, false);
});

test("default All-Day hours is a positive number, fractional allowed", () => {
  assert.equal(checkSetting("default_all_day_hours", "8").ok, true);
  assert.equal(checkSetting("default_all_day_hours", "6.5").ok, true);
  assert.equal(checkSetting("default_all_day_hours", "0").ok, false);
  assert.equal(checkSetting("default_all_day_hours", "-2").ok, false);
});

test("the attendance report channel is a channel id like any other channel setting", () => {
  assert.equal(
    checkSetting("attendance_report_channel", "C0123456789").ok,
    true
  );
  assert.equal(checkSetting("attendance_report_channel", "#general").ok, false);
});

test("the admin usergroup accepts a plain handle, with or without a leading @", () => {
  assert.equal(checkSetting("admin_usergroup", "hawkbot-admins").ok, true);
  const result = checkSetting("admin_usergroup", "@hawkbot-admins");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, "hawkbot-admins");
});

test("Slack's escaped usergroup mention is unwrapped to the bare handle", () => {
  assert.equal(
    unwrapUserGroupHandle("<!subteam^S0123456|@hawkbot-admins>"),
    "hawkbot-admins"
  );
  const result = checkSetting(
    "admin_usergroup",
    "<!subteam^S0123456|@hawkbot-admins>"
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, "hawkbot-admins");
});

test("the weekly summary time is a day plus a 24-hour time", () => {
  assert.equal(checkSetting("weekly_summary_time", "SUN 12:00").ok, true);
  assert.equal(checkSetting("weekly_summary_time", "sun 12:00").ok, true);
  assert.equal(checkSetting("weekly_summary_time", "Sunday 12:00").ok, false);
  assert.equal(checkSetting("weekly_summary_time", "SUN 25:00").ok, false);
  assert.equal(checkSetting("weekly_summary_time", "12:00").ok, false);
});

test("the Informational and Mentor/Teacher Calendar ids are shape-checked, same as the Team Meeting Calendar id", () => {
  assert.equal(
    checkSetting("informational_calendar_id", "info@group.calendar.google.com")
      .ok,
    true
  );
  assert.equal(checkSetting("informational_calendar_id", "   ").ok, false);
  assert.equal(
    checkSetting("mentor_calendar_id", "mentors@group.calendar.google.com").ok,
    true
  );
  assert.equal(checkSetting("mentor_calendar_id", "   ").ok, false);
});

test("the mentor summary channel is a channel id like any other channel setting", () => {
  assert.equal(checkSetting("mentor_summary_channel", "C0123456789").ok, true);
  assert.equal(
    checkSetting("mentor_summary_channel", "#admin-official").ok,
    false
  );
});

test("the mentor summary time is a day plus a 24-hour time, same shape as the weekly summary time", () => {
  assert.equal(checkSetting("mentor_summary_time", "SUN 12:00").ok, true);
  assert.equal(checkSetting("mentor_summary_time", "Sunday 12:00").ok, false);
});

test("the no response alert channel is a channel id like any other channel setting", () => {
  assert.equal(
    checkSetting("no_response_alert_channel", "C0123456789").ok,
    true
  );
  assert.equal(
    checkSetting("no_response_alert_channel", "#admin-ra").ok,
    false
  );
});

test("the no response alert time is a day plus a 24-hour time, same shape as the weekly summary time", () => {
  assert.equal(checkSetting("no_response_alert_time", "MON 09:00").ok, true);
  assert.equal(
    checkSetting("no_response_alert_time", "Monday 09:00").ok,
    false
  );
});

test("the no response alert threshold is a positive whole number of meetings", () => {
  assert.equal(checkSetting("no_response_alert_threshold", "3").ok, true);
  assert.equal(checkSetting("no_response_alert_threshold", "0").ok, false);
  assert.equal(checkSetting("no_response_alert_threshold", "2.5").ok, false);
  assert.equal(checkSetting("no_response_alert_threshold", "three").ok, false);
});

test("the student usergroup accepts a plain handle, with or without a leading @", () => {
  assert.equal(checkSetting("student_usergroup", "hawk-students").ok, true);
  const result = checkSetting("student_usergroup", "@hawk-students");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, "hawk-students");
});

test("Slack's escaped usergroup mention is unwrapped for the student usergroup too", () => {
  const result = checkSetting(
    "student_usergroup",
    "<!subteam^S0123456|@hawk-students>"
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, "hawk-students");
});

test("the mentor usergroup accepts a plain handle, with or without a leading @", () => {
  assert.equal(checkSetting("mentor_usergroup", "hawk-mentors").ok, true);
  const result = checkSetting("mentor_usergroup", "@hawk-mentors");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, "hawk-mentors");
});

test("Slack's escaped usergroup mention is unwrapped for the mentor usergroup too", () => {
  const result = checkSetting(
    "mentor_usergroup",
    "<!subteam^S0123456|@hawk-mentors>"
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, "hawk-mentors");
});

// The ad-hoc probe (`/hawkbot calendar <id>`) has to apply the same shape rule
// `config set` applies, or it would happily test an id the bot could never be
// configured with — and report success for something unusable.
test("isCalendarId accepts the shapes Google issues and rejects invisible characters", () => {
  assert.equal(isCalendarId("team@group.calendar.google.com"), true);
  assert.equal(isCalendarId("primary"), true);
  assert.equal(
    isCalendarId("en.usa#holiday@group.v.calendar.google.com"),
    true
  );
  assert.equal(
    isCalendarId(
      "c_f28f2b2f7fac90b1a6c8bb2819b15f054799129d919c05b22c7e68b7752165cc@group.calendar.google.com"
    ),
    true
  );
  assert.equal(isCalendarId("  team@group.calendar.google.com  "), true);

  assert.equal(isCalendarId(""), false);
  assert.equal(isCalendarId("not-an-id"), false);
  assert.equal(isCalendarId("team​@group.calendar.google.com"), false);
  assert.equal(isCalendarId("team @group.calendar.google.com"), false);
});
