# Events are sourced from a dedicated Google Calendar, not created in Slack

Events for Attendance Tracking come from a Google Calendar — the Team Meeting Calendar — that mentors already use and will keep using as their day-to-day scheduling tool. Hawk Bot reads it and reflects changes into Slack automatically; it does not become the place mentors create or edit meetings. An event is real the moment it's created on the calendar, with no approval step in between.

The alternative — mentors creating events through a Slack command — was rejected for v1: it would mean mentors keeping two schedules in sync by hand (their calendar and Hawk Bot's), which is exactly the kind of drifting duplicate list this app's existing philosophy avoids (see the roster discussion in `CONTEXT.md`, and the admin-list reasoning in `CLAUDE.md`). In-Slack event management may still be worth building later as a convenience layer on top of the calendar, but it's explicitly a future upgrade, not part of this decision.

**Consequence**: a manual event-creation path still exists in the codebase, but only as a test/dev fixture — it is not exposed for production/deployed use. The team also maintains two other calendars (Informational, Mentor/Teacher) that are deliberately out of scope for Attendance Tracking in v1; pulling from multiple calendars is a future upgrade, not assumed by the current design.
