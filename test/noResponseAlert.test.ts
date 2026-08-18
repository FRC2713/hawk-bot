import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_NO_RESPONSE_ALERT_THRESHOLD,
  DEFAULT_NO_RESPONSE_ALERT_TIMING,
  formatNoResponseAlertDetail,
  formatNoResponseAlertSummary,
  isNoResponseStreak,
  resolveNoResponseAlertRoles,
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

test("the summary names the threshold and nothing about who's flagged", () => {
  const text = formatNoResponseAlertSummary({ threshold: 3 });
  assert.match(text, /Missed 3 meetings with no response/);
});

test("someone solely in the mentor group resolves to just mentor", () => {
  assert.deepEqual(
    resolveNoResponseAlertRoles({
      userId: "U1",
      studentGroupMemberIds: new Set(),
      mentorGroupMemberIds: new Set(["U1"]),
    }),
    ["mentor"]
  );
});

test("someone solely in the student group resolves to just student", () => {
  assert.deepEqual(
    resolveNoResponseAlertRoles({
      userId: "U1",
      studentGroupMemberIds: new Set(["U1"]),
      mentorGroupMemberIds: new Set(),
    }),
    ["student"]
  );
});

test("someone in both groups resolves to both roles, not a tie-break", () => {
  assert.deepEqual(
    resolveNoResponseAlertRoles({
      userId: "U1",
      studentGroupMemberIds: new Set(["U1"]),
      mentorGroupMemberIds: new Set(["U1"]),
    }),
    ["student", "mentor"]
  );
});

test("someone in neither group resolves to no roles", () => {
  assert.deepEqual(
    resolveNoResponseAlertRoles({
      userId: "U1",
      studentGroupMemberIds: new Set(["U2"]),
      mentorGroupMemberIds: new Set(["U3"]),
    }),
    []
  );
});

test("both groups empty still resolves to no roles, not a default one", () => {
  assert.deepEqual(
    resolveNoResponseAlertRoles({
      userId: "U1",
      studentGroupMemberIds: new Set(),
      mentorGroupMemberIds: new Set(),
    }),
    []
  );
});

test("the detail is headed by its role's label", () => {
  const text = formatNoResponseAlertDetail({ role: "mentor", flagged: [] });
  assert.match(text, /^\*Mentors\*/);
});

test("the detail names one flagged person and every meeting they missed", () => {
  const text = formatNoResponseAlertDetail({
    role: "student",
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
  assert.match(text, /Jordan Smith/);
  assert.match(text, /Team Practice/);
  assert.match(text, /Scrimmage Prep/);
  assert.equal(text.match(/Team Practice/g)?.length, 2);
});

test("differing meeting lists fall back to a block per flagged person", () => {
  const text = formatNoResponseAlertDetail({
    role: "student",
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
  // Per-person mode bolds each name as its own block header.
  assert.match(text, /\*Jordan Smith\*/);
  assert.match(text, /\*Alex Chen\*/);
});

test("identical meeting lists are printed once, with names just bulleted underneath", () => {
  const sharedMeetings = [
    { title: "Team Practice", startsAt: new Date(Date.UTC(2026, 7, 5)) },
    { title: "Scrimmage Prep", startsAt: new Date(Date.UTC(2026, 7, 7)) },
    { title: "Team Practice", startsAt: new Date(Date.UTC(2026, 7, 12)) },
  ];
  const text = formatNoResponseAlertDetail({
    role: "mentor",
    flagged: [
      { displayName: "Jordan Smith", missedMeetings: sharedMeetings },
      { displayName: "Alex Chen", missedMeetings: sharedMeetings },
    ],
  });
  assert.match(text, /• Jordan Smith/);
  assert.match(text, /• Alex Chen/);
  // Not bolded as a per-person block header, and the meeting lines appear
  // exactly once rather than once per person.
  assert.doesNotMatch(text, /\*Jordan Smith\*/);
  assert.equal(text.match(/Team Practice/g)?.length, 2);
  assert.equal(text.match(/Scrimmage Prep/g)?.length, 1);
});

test("a differing subset among otherwise-matching people still falls back to per-person blocks", () => {
  const firstMeeting = {
    title: "Team Practice",
    startsAt: new Date(Date.UTC(2026, 7, 5)),
  };
  const sharedMeetings = [
    firstMeeting,
    { title: "Team Practice", startsAt: new Date(Date.UTC(2026, 7, 12)) },
  ];
  const text = formatNoResponseAlertDetail({
    role: "student",
    flagged: [
      { displayName: "Jordan Smith", missedMeetings: sharedMeetings },
      { displayName: "Alex Chen", missedMeetings: sharedMeetings },
      {
        displayName: "Sam Lee",
        // Same first meeting, different second one — recently rejoined.
        missedMeetings: [
          firstMeeting,
          { title: "Build Session", startsAt: new Date(Date.UTC(2026, 7, 12)) },
        ],
      },
    ],
  });
  assert.match(text, /\*Jordan Smith\*/);
  assert.match(text, /\*Sam Lee\*/);
  assert.match(text, /Build Session/);
});

test("a lone flagged person always gets their own block, never the bulleted-list shorthand", () => {
  const text = formatNoResponseAlertDetail({
    role: "student",
    flagged: [
      {
        displayName: "Jordan Smith",
        missedMeetings: [
          { title: "Team Practice", startsAt: new Date(Date.UTC(2026, 7, 5)) },
        ],
      },
    ],
  });
  assert.match(text, /\*Jordan Smith\*/);
  assert.doesNotMatch(text, /• Jordan Smith/);
});
