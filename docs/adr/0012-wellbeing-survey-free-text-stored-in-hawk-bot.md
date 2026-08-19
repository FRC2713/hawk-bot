# Wellbeing survey free text is stored in hawk-bot, not hawk-mod

**Status**: accepted, pending leadership review (see tracking issue)

The student wellbeing/connection survey (Quick Pulse + Deeper Check-in) captures freeform text from students — e.g. what they need help with, or how they're feeling in their own words. `CLAUDE.md` documents an explicit boundary between the two sibling apps: hawk-mod stores "consent records, minors' message text"; hawk-bot stores "an install token, a few settings." Freeform student disclosures are squarely "minors' message text" by that definition.

We're storing it in hawk-bot's own SQLite anyway, alongside the survey's structured fields (mood score, needs-help flag, overwhelm score, theme tag), rather than routing it through hawk-mod or dropping it from v1. This keeps the whole survey feature self-contained in one app with one data model, avoiding a cross-service dependency for what is otherwise a Slack-interaction feature like everything else in hawk-bot.

This is a deliberate, named exception to the app-boundary rule in `CLAUDE.md` — not an oversight. It has not yet been reviewed with team leadership; that review may result in free text being removed from the survey or moved into hawk-mod later. See the tracking issue for that review.
