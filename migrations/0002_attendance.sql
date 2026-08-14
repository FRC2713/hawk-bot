-- Attendance Tracking. See CONTEXT.md for the vocabulary (Event, Meeting
-- Type, Event Check-in Post, Reaction Cutoff, Roster, Attendance Note) and
-- docs/adr/ for the decisions behind this shape.

-- An Event, sourced 1:1 from the Team Meeting Calendar, or created manually
-- for testing (source = 'manual_test', never used in production — see
-- ADR-0002). checkin_at and reaction_cutoff_at are computed once, from
-- domain/calendar.ts, when the row is written; the scheduler polls against
-- them rather than recomputing on every tick.
CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  calendar_event_id  TEXT UNIQUE,
  source             TEXT NOT NULL CHECK (source IN ('google_calendar', 'manual_test')),
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  meeting_type       TEXT NOT NULL CHECK (meeting_type IN ('hourly', 'all_day', 'multi_day')),
  starts_at          TEXT NOT NULL,
  ends_at            TEXT NOT NULL,
  checkin_at         TEXT NOT NULL,
  reaction_cutoff_at TEXT NOT NULL,
  checkin_channel    TEXT,
  checkin_message_ts TEXT,
  checkin_posted_at  TEXT,
  finalized_at       TEXT,
  removed_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX events_due_checkin ON events (checkin_at)
  WHERE checkin_posted_at IS NULL AND removed_at IS NULL;
CREATE INDEX events_due_cutoff ON events (reaction_cutoff_at)
  WHERE checkin_posted_at IS NOT NULL AND finalized_at IS NULL AND removed_at IS NULL;

-- Roster: who the announcements channel's membership included at the moment
-- an Event's Check-in Post went out. A person in this table with no
-- attendance row is No Response; a person never in this table for this
-- Event isn't counted at all (they weren't in the channel to respond).
CREATE TABLE event_roster (
  event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

-- One row per person who has reacted and/or left an Attendance Note on an
-- Event's Check-in Post. `status` is NULL for someone who left a note but
-- currently has no qualifying reaction (or removed it) — that still reads
-- as No Response, but the note survives rather than being deleted, since a
-- reaction resync only ever touches status/has_clock_reaction, never note.
-- hours_credited is snapshotted once, at Reaction Cutoff finalize time, so
-- a later change to default_all_day_hours never rewrites past reports.
CREATE TABLE attendance (
  event_id           INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL,
  status             TEXT CHECK (status IN ('attending', 'not_attending')),
  has_clock_reaction INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  hours_credited     REAL,
  nudged_at          TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
