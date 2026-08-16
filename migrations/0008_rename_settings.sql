-- Two settings.ts keys renamed for clarity, without losing whatever a coach
-- already configured: `timezone_note` was never about timezones — it's a
-- free-text App Home blurb — so it's now `home_note`. `google_calendar_id`
-- didn't say which of the team's three calendars it was, unlike its
-- siblings `informational_calendar_id`/`mentor_calendar_id`, so it's now
-- `team_meeting_calendar_id`. A no-op on a fresh install with no matching
-- rows.
UPDATE settings SET key = 'home_note' WHERE key = 'timezone_note';
UPDATE settings SET key = 'team_meeting_calendar_id' WHERE key = 'google_calendar_id';
