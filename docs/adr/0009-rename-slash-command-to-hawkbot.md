# Rename the slash command from /hawk to /hawkbot

The workspace this app installs into has other hawk-themed bots, and `/hawk` is generic enough to collide with them in the Slack command picker. We're renaming the top-level slash command to `/hawkbot`, matching the existing "HawkBot Admin" usergroup naming already established by ADR-0004. This is a hard cutover — `/hawk` is deregistered, not kept as an alias — since this is an internal team tool and the disruption of a one-time relearn is small.
