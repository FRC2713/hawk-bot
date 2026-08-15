-- No Response Alert Report: one row per weekly due-check, purely to drive
-- the due-check itself (isWeeklySummaryDue reads posted_at the same way it
-- already does for mentor_summaries). A row is written every time the check
-- runs, whether or not anyone was flagged — message_ts is NULL for a
-- "checked, nobody flagged" run, so the due-check advances either way
-- rather than re-evaluating the whole Roster on every scheduler tick for
-- the rest of a silent week. Unlike weekly_summaries and mentor_summaries,
-- nothing about a past alert is ever edited or deleted — each week's post
-- (or non-post) stands alone — so there is no item/snapshot table.
CREATE TABLE no_response_alerts (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL,
  message_ts TEXT,
  posted_at  TEXT NOT NULL
);

CREATE INDEX no_response_alerts_posted_at ON no_response_alerts (posted_at);
