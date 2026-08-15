import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
  assert.equal(checkSetting("timezone_note", "   ").ok, false);
});

test("free text is bounded", () => {
  assert.equal(checkSetting("timezone_note", "Tue/Thu 6-9pm").ok, true);
  assert.equal(checkSetting("timezone_note", "x".repeat(201)).ok, false);
});

test("the Team Meeting Calendar id just needs to be non-blank", () => {
  assert.equal(
    checkSetting("google_calendar_id", "team@group.calendar.google.com").ok,
    true
  );
  assert.equal(checkSetting("google_calendar_id", "   ").ok, false);
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
