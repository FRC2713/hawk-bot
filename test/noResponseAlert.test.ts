import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_NO_RESPONSE_ALERT_THRESHOLD,
  DEFAULT_NO_RESPONSE_ALERT_TIMING,
  formatNoResponseAlertMessage,
  isNoResponseStreak,
  resolveNoResponseAlertThreshold,
  type RecentMeetingOutcome,
} from "../src/domain/noResponseAlert.js";

process.env.TZ = "UTC";

function outcome(
  status: "attending" | "not_attending" | null,
  daysAgo: number,
  title = "Team Practice"
): RecentMeetingOutcome {
  return {
    status,
    title,
    startsAt: new Date(Date.UTC(2026, 7, 15 - daysAgo)),
  };
}

test("exactly threshold outcomes, all No Response, is flagged", () => {
  const outcomes = [outcome(null, 0), outcome(null, 2), outcome(null, 5)];
  assert.equal(isNoResponseStreak(outcomes, 3), true);
});

test("more outcomes than threshold, trailing window all No Response, is still flagged even though older history wasn't", () => {
  const outcomes = [
    outcome(null, 0),
    outcome(null, 2),
    outcome(null, 5),
    outcome("attending", 8),
    outcome("attending", 10),
  ];
  assert.equal(isNoResponseStreak(outcomes, 3), true);
});

test("a real response as the most recent outcome breaks the streak, even if older ones were No Response", () => {
  const outcomes = [
    outcome("not_attending", 0),
    outcome(null, 2),
    outcome(null, 5),
  ];
  assert.equal(isNoResponseStreak(outcomes, 3), false);
});

test("a real response further back than the most recent one also breaks the streak", () => {
  const outcomes = [
    outcome(null, 0),
    outcome("attending", 2),
    outcome(null, 5),
    outcome(null, 8),
  ];
  assert.equal(isNoResponseStreak(outcomes, 3), false);
});

test("fewer outcomes than threshold is never flagged, regardless of status", () => {
  const outcomes = [outcome(null, 0), outcome(null, 2)];
  assert.equal(isNoResponseStreak(outcomes, 3), false);
});

test("no outcomes at all is never flagged", () => {
  assert.equal(isNoResponseStreak([], 3), false);
});

test("the default schedule is Monday 9am, distinct from the Weekly Summary Post's Sunday noon default", () => {
  assert.deepEqual(DEFAULT_NO_RESPONSE_ALERT_TIMING, {
    dayOfWeek: 1,
    hour: 9,
    minute: 0,
  });
});

test("an unset threshold setting falls back to the default", () => {
  assert.equal(
    resolveNoResponseAlertThreshold(undefined),
    DEFAULT_NO_RESPONSE_ALERT_THRESHOLD
  );
});

test("a set threshold setting parses to a number", () => {
  assert.equal(resolveNoResponseAlertThreshold("5"), 5);
});

test("the message names one flagged person and every meeting they missed", () => {
  const text = formatNoResponseAlertMessage({
    threshold: 3,
    flagged: [
      {
        displayName: "Jordan Smith",
        missedMeetings: [
          { title: "Team Practice", startsAt: new Date(Date.UTC(2026, 7, 5)) },
          {
            title: "Scrimmage Prep",
            startsAt: new Date(Date.UTC(2026, 7, 7)),
          },
          { title: "Team Practice", startsAt: new Date(Date.UTC(2026, 7, 12)) },
        ],
      },
    ],
  });
  assert.match(text, /3 meetings in a row/);
  assert.match(text, /Jordan Smith/);
  assert.match(text, /Team Practice/);
  assert.match(text, /Scrimmage Prep/);
  assert.equal(text.match(/Team Practice/g)?.length, 2);
});

test("the message includes a block for every flagged person", () => {
  const text = formatNoResponseAlertMessage({
    threshold: 3,
    flagged: [
      {
        displayName: "Jordan Smith",
        missedMeetings: [
          { title: "Team Practice", startsAt: new Date(Date.UTC(2026, 7, 5)) },
        ],
      },
      {
        displayName: "Alex Chen",
        missedMeetings: [
          { title: "Build Session", startsAt: new Date(Date.UTC(2026, 7, 6)) },
        ],
      },
    ],
  });
  assert.match(text, /Jordan Smith/);
  assert.match(text, /Alex Chen/);
  assert.match(text, /Build Session/);
});
