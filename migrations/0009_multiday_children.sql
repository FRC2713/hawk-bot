-- Multi-Day Child Events. A Multi-Day Event's attendance is tracked via
-- synthetic per-day Child Events (ordinary all_day rows), not by the
-- Multi-Day Event itself. This column links a Child back to its parent —
-- NULL for every ordinary Event, set only on a Child. Used both to exclude
-- Children from Weekly Summary listings (see listEventsStartingInRange) and
-- to find "every Child of this parent" when a competition's span changes on
-- a later sync (see reconcileMultiDayChildren). See CONTEXT.md, Multi-Day
-- Child Event.
ALTER TABLE events ADD COLUMN multiday_parent_id INTEGER REFERENCES events (id);

CREATE INDEX events_multiday_parent ON events (multiday_parent_id)
  WHERE multiday_parent_id IS NOT NULL;
