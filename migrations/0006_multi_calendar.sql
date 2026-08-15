-- Multi-calendar support. An Event now carries which of the team's three
-- Google Calendars it came from. Only 'team_meeting' Events ever get a
-- Check-in Post or Attendance Tracking (see db/repo.ts,
-- listEventsDueForCheckin); 'informational' and 'mentor' Events are
-- listing-only. Existing rows default to 'team_meeting', since that is the
-- only calendar this app read before this migration.
ALTER TABLE events ADD COLUMN calendar_role TEXT NOT NULL DEFAULT 'team_meeting'
  CHECK (calendar_role IN ('team_meeting', 'informational', 'mentor'));

-- The Informational Calendar's weekly digest is a threaded reply under the
-- Team Meeting Weekly Summary Post, not its own top-level post — these stay
-- null until (if enabled) the first Informational Event of the week is
-- discovered, and are cleared along with the parent at the next weekly
-- rollover.
ALTER TABLE weekly_summaries ADD COLUMN informational_channel TEXT;
ALTER TABLE weekly_summaries ADD COLUMN informational_message_ts TEXT;

-- One row per Informational Event listed in a Weekly Summary Post's
-- Informational reply, snapshotting what the reply said about it the moment
-- it was first listed this week — mirrors weekly_summary_items exactly, so
-- the reply can be rewritten in place the same way the parent is.
CREATE TABLE weekly_summary_informational_items (
  weekly_summary_id     INTEGER NOT NULL REFERENCES weekly_summaries (id) ON DELETE CASCADE,
  event_id              INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  snapshot_title        TEXT NOT NULL,
  snapshot_meeting_type  TEXT NOT NULL,
  snapshot_starts_at     TEXT NOT NULL,
  snapshot_ends_at       TEXT NOT NULL,
  snapshot_location      TEXT NOT NULL,
  added_mid_week         INTEGER NOT NULL DEFAULT 0,
  removed                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (weekly_summary_id, event_id)
);

-- Mentor/Teacher Weekly Summary: one row per posted digest, same
-- delete-and-repost-fresh model as weekly_summaries, but with no per-item
-- snapshot table — there is no mid-window edit-in-place for this one (a
-- mid-week change shows up corrected on the next scheduled post instead),
-- so nothing needs to be diffed against.
CREATE TABLE mentor_summaries (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  week_start TEXT NOT NULL,
  week_end   TEXT NOT NULL,
  posted_at  TEXT NOT NULL
);

CREATE INDEX mentor_summaries_posted_at ON mentor_summaries (posted_at);
