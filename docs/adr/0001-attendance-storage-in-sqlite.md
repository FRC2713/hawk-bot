# Attendance data lives in Hawk Bot's own SQLite DB, not a Google Sheet

Attendance responses (reactions, hours credited, follow-up notes) are stored in Hawk Bot's existing SQLite database rather than a Google Sheet or a Sheet+DB hybrid. The requirement that any team member can pull attendance reports via a Slack command needs structured, queryable data regardless of what else exists — a Sheet doesn't remove that need, it duplicates it. (Google credentials are entering this app regardless, for the separate Google Calendar → Event sourcing decision — so "avoids Google API credentials entirely" is no longer part of this reasoning, just the "one source of truth per kind of data" part.)

**This may need to be reevaluated as the project develops.** If mentors want a spreadsheet for external sharing (e.g. grant reporting) that Slack commands can't serve well, the likely next step is an export command, not moving the source of truth off SQLite.
