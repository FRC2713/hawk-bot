# Informational and Mentor/Teacher Events share the Events table via Calendar Role, not separate tables per calendar

Pulling in the Informational and Mentor/Teacher Calendars reuses the existing `events` table with a new `calendar_role` column (`team_meeting` / `informational` / `mentor`), rather than giving each calendar its own table. Meeting Type derivation, snapshot storage, and add/edit/remove change detection are identical regardless of which calendar an Event came from — only downstream behavior (Check-in Post eligibility, which weekly digest an Event feeds) branches on Calendar Role, so one shared sync pipeline serves all three calendars instead of three parallel ones.

This updates the "future upgrade" consequence noted in ADR-0002 — that ADR's core decision (Events come from Google Calendar, not created in Slack) still stands; only its assumption that Attendance Tracking would keep reading a single calendar no longer holds.
