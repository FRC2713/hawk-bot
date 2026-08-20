import assert from "node:assert/strict";
import { test } from "node:test";
import { lockedCheckinMessageText } from "../src/slack/checkin.js";
import type { EventRow } from "../src/db/repo.js";

process.env.TZ = "UTC";

const baseEvent: EventRow = {
  id: 1,
  calendar_event_id: "abc",
  calendar_link: null,
  source: "google_calendar",
  calendar_role: "team_meeting",
  title: "Team Meeting",
  description: "Regular build season meeting.",
  location: "Main Shop",
  meeting_type: "hourly",
  starts_at: "2026-08-20T18:00:00Z",
  ends_at: "2026-08-20T20:00:00Z",
  checkin_at: "2026-08-20T14:00:00-04:00",
  reaction_cutoff_at: "2026-08-21T00:00:00-04:00",
  checkin_channel: "C123",
  checkin_message_ts: "1700000000.000100",
  checkin_posted_at: "2026-08-20T14:00:00-04:00",
  finalized_at: null,
  removed_at: null,
  verification_failed_at: null,
  multiday_parent_id: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

test("the locked message says attendance is closed", () => {
  const text = lockedCheckinMessageText(baseEvent);
  assert.match(text, /attendance closed/);
});

test("the locked message drops the @channel mention", () => {
  const text = lockedCheckinMessageText(baseEvent);
  assert.doesNotMatch(text, /<!channel>/);
});

test("the locked message drops the reaction legend entirely", () => {
  const text = lockedCheckinMessageText(baseEvent);
  assert.doesNotMatch(text, /React to let the team know/);
  assert.doesNotMatch(text, /👍/);
  assert.doesNotMatch(text, /🕐/);
  assert.doesNotMatch(text, /❌/);
});

test("the locked message keeps the title, time, location, and description", () => {
  const text = lockedCheckinMessageText(baseEvent);
  assert.match(text, /Team Meeting/);
  assert.match(text, /6:00 PM.*8:00 PM/);
  assert.match(text, /Main Shop/);
  assert.match(text, /Regular build season meeting\./);
});

test("the locked message skips an empty location and description", () => {
  const text = lockedCheckinMessageText({
    ...baseEvent,
    location: "",
    description: "",
  });
  assert.doesNotMatch(text, /📍/);
  assert.equal(text.split("\n").length, 2);
});

test("the locked message links the title when the Event has a calendar link", () => {
  const text = lockedCheckinMessageText({
    ...baseEvent,
    calendar_link: "https://calendar.google.com/event?eid=abc123",
  });
  assert.match(
    text,
    /^✅ <https:\/\/calendar\.google\.com\/event\?eid=abc123\|\*Team Meeting\*> — attendance closed/
  );
});

test("the locked message shows a plain bolded title when there's no calendar link", () => {
  const text = lockedCheckinMessageText(baseEvent);
  assert.match(text, /^✅ \*Team Meeting\* — attendance closed/);
});
