-- Weekly Summary Post: one row per posted digest. The scheduler looks up the
-- most recent row both to know which message to delete before posting the
-- next one, and to know the currently-active week for routing mid-week
-- changes. See CONTEXT.md, Weekly Summary Post.
CREATE TABLE weekly_summaries (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  week_start TEXT NOT NULL,
  week_end   TEXT NOT NULL,
  posted_at  TEXT NOT NULL
);

CREATE INDEX weekly_summaries_posted_at ON weekly_summaries (posted_at);

-- One row per Event listed in a Weekly Summary Post, snapshotting what the
-- post said about it the moment it was first listed this week — Weekly
-- Summary Change Reflection always diffs against this snapshot, never
-- against the previous edit, so a second change before the week ends still
-- shows one strikethrough, not a chain. See CONTEXT.md, Weekly Summary
-- Change Reflection.
CREATE TABLE weekly_summary_items (
  weekly_summary_id    INTEGER NOT NULL REFERENCES weekly_summaries (id) ON DELETE CASCADE,
  event_id             INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  snapshot_title        TEXT NOT NULL,
  snapshot_meeting_type TEXT NOT NULL,
  snapshot_starts_at    TEXT NOT NULL,
  snapshot_ends_at      TEXT NOT NULL,
  snapshot_location     TEXT NOT NULL,
  -- True for an Event appended after the Weekly Summary Post's initial send
  -- — drives the "🆕 New" tag, which (unlike edited/removed) never expires
  -- within the week, since there's no "original" line to contrast it with.
  added_mid_week     INTEGER NOT NULL DEFAULT 0,
  removed            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (weekly_summary_id, event_id)
);
