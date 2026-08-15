# Hawk Bot

The Red Hawk Robotics team assistant for Slack — see `CLAUDE.md` for the technical shape. This file is the glossary for concepts that live in the domain, not the code.

## Language

**Event**:
A calendar entry pulled from one of the team's three Google Calendars, one-for-one with that calendar's entry — it becomes real the instant a mentor creates it there, no approval step. Has a title, date/time, location, description, and a Calendar Role. Every Event has a Meeting Type, derived from its date/time shape. Only a Team Meeting Calendar Event is something people are expected to attend and carries scheduled hours toward attendance credit; an Informational or Mentor/Teacher Calendar Event is listing-only — see Calendar Role.

**Team Meeting Calendar**:
The Google Calendar mentors use to create, edit, and delete team meetings directly — the source of truth for Team Meeting Events, the only ones Attendance Tracking runs against. Mentors manage it in Google Calendar itself, not in Slack (in-Slack event management is a future upgrade); Hawk Bot reads it and reflects changes automatically.

**Informational Calendar** / **Mentor/Teacher Calendar**:
Two other calendars the team keeps, each independently enabled by a HawkBot Admin setting its calendar id: Informational (placeholder/FYI dates, school closures — visible to everyone, no action needed) and Mentor/Teacher (adult-only unavailability and admin meetings). Neither feeds Attendance Tracking — only the Team Meeting Calendar does; see Calendar Role. Informational Events surface in the Weekly Summary Post's Informational Reply; Mentor/Teacher Events surface in the Mentor/Teacher Weekly Summary.

**Calendar Role**:
Which of the team's three Google Calendars an Event came from — `team_meeting`, `informational`, or `mentor` — fixed at the moment the Event is first synced, never reassigned. The one gate for whether an Event gets an Event Check-in Post and Attendance Tracking at all: only `team_meeting` does, regardless of Meeting Type. An Informational or Mentor/Teacher Event still gets a Meeting Type (for line formatting) and still participates in calendar sync's add/edit/remove detection — it's simply never eligible for a Check-in Post. See ADR-0006 for why all three calendars store Events in one place rather than three.

**Meeting Type**:
Classifies an Event by its time shape, and determines the Check-in Post timing rule applied to it. Derived directly from the calendar entry's own start/end, not chosen separately:

- **Hourly** — fixed start and end time on a single day (e.g. 10am–2pm).
- **All-Day** — a full-day calendar entry where start date = end date.
- **Multi-Day** — a full-day calendar entry spanning a start date and a later end date (e.g. a competition). Deferred — not handled by v1.
  _Avoid_: "event type"

**Event Check-in Post**:
The single Slack message posted before an Event that both reminds the team of it and serves as the surface people react to for attendance. Includes the Event's title, date/time, location, description, and a short reminder of what each reaction means. Posted to the announcements channel with an `@channel` mention. The bot pre-populates it with 👍, a Clock Reaction, and ❌ so a team member can just click an existing reaction rather than pick their own emoji from scratch; picking something else entirely still works and is read the same way. The bot deletes it at the Reaction Cutoff, which finalizes attendance for that Event.
_Avoid_: pre-event reminder post, check-in post (as if separate from the reminder)

**Check-in Post Timing**:
How long before an Event its Check-in Post goes out. Set per Meeting Type (not per individual Event) by Hawk Bot admins. Starting defaults: Hourly posts 4 hours before the scheduled start; All-Day posts at 4pm the day before.

**Calendar Change Handling**:
What happens when the Team Meeting Calendar changes after an Event's Check-in Post has already gone out. The original post is never deleted or reposted for an edit — the Event record behind it is simply updated (including a duration change), and any reactions already collected carry forward unchanged. What the bot does depends on the kind of change:

- **Edited** (any field — time, duration, location, description, etc.): reply in a thread on the original Check-in Post, broadcast to the channel (Slack's "also send to channel"), naming what changed and linking straight to the calendar event — _and_ rewrite the original post itself with the new details, marked with an ✏️ and which fields changed, rather than leaving it as originally written.
- **Removed**: reply in the thread the same way, announcing the cancellation, _and_ edit the original post's text in place — the removal notice up top, the meeting's details kept below it (struck through, not deleted, minus the now-irrelevant reaction legend) — so the cancellation is visible, with context, to someone who never opens the thread. No Reaction Cutoff runs and no hours are credited for a removed Event.

**Reaction Cutoff**:
The moment the bot deletes an Event's Check-in Post, freezing whatever reaction state existed at that instant as final for that Event. Immediately before deleting, the bot re-fetches the post's live reactions from Slack and reconciles them against its own running tally, so the frozen state matches what people actually see on the message, not just what the bot's event stream caught. Default: midnight of the event day — unless the Event's scheduled end time is at or after midnight, in which case the cutoff moves to 10am the next morning.

**Attending / Not Attending / No Response**:
The three attendance outcomes for a team member on an Event, fixed at the Reaction Cutoff. Attending means a 👍 (any skin tone) reaction is present — full scheduled-hours credit, regardless of what else is also on the post. Not Attending means at least one reaction is present but no 👍. No Response means no reaction at all.
_Avoid_: "coming" / "not coming" — use Attending / Not Attending

**Clock Reaction**:
Any clock-face, alarm-clock, or stopwatch emoji reaction on an Event Check-in Post, used to flag an expected late arrival or early departure. Purely informational — it never confers Attending on its own; only a 👍 does. If a Clock Reaction lands without a 👍 from the same person, the bot waits 30 seconds and checks again before DMing them a nudge with a link back to the post — long enough that reacting 🕐 then 👍 a moment later (a very ordinary way to mean "I'm coming, just late") never triggers a nudge that's already stale by the time it lands.

**Attendance Note**:
An optional free-text detail a team member adds by replying in the thread on the Event Check-in Post — e.g. an expected arrival time alongside a Clock Reaction, or a reason alongside a Not Attending reaction. The bot never prompts for it; a thread reply during the reaction window is captured if one shows up, and it's fine if it doesn't.

**Roster**:
The set of people an Event expects a response from. Currently defined as the announcements channel's membership list at the moment the Event Check-in Post is sent — there is no maintained team list yet. This is a known interim definition; it's expected to be replaced by an explicit external list of students and mentors.

**Season**:
The reporting window "attendance %" and hours-credited figures default to. Fixed at July 1 through the following June 30 for now, not admin-configurable — a known interim rule, expected to become adjustable later. "This season" means the most recent July 1 up to now.

**Attendance Reporting**:
v1 has exactly two reporting surfaces; everything else the original spec sketched (per-event breakdowns, no-response lists, a leaderboard) is explicitly deferred to a later feature. A team member's own Season attendance %/hours is self-serve, open to anyone — it's their own data. A full CSV export of the whole team's Season attendance is admin-only and delivered by DM to whoever ran it, never posted into a channel — a bulk export of everyone's data is a different exposure than a personal lookup.

**Reaction Cutoff Verification**:
Immediately after the Reaction Cutoff's live resync and immediately before deleting the Check-in Post, the bot checks two things: the resync's Slack API calls completed without error, and every person with a qualifying reaction on the message has a matching attendance record. If either check fails, the bot does **not** delete the post or finalize the Event — it records the failure, DMs every HawkBot Admin, and leaves the Event alone. Nothing retries automatically; an admin has to explicitly re-run the cutoff for that Event once whatever went wrong is understood.

**Event Attendance Report**:
Posted to a private `#hawkbot-attendance-report`-style channel (exact channel is an admin-configurable setting) immediately after an Event successfully clears its Reaction Cutoff and its Check-in Post is deleted — one report per Event, never batched. Kept short in the channel itself:

- **Top-level message**: the Event's name, the Attending/Not Attending/No Response counts, and the hours the Event was worth per attendee (e.g. "12 attended (2 hrs each) · 3 didn't attend · 2 no response") — not a summed grand total, since every Attending person on one Event is credited the same hours. Past tense throughout, unlike the Attending/Not Attending/No Response terms elsewhere — this posts after the Reaction Cutoff, so it's reporting what happened, not describing a still-open response window.
- **Threaded reply**: a monospace table, one row per person — Name, derived Status ("Attended"/"Didn't Attend"/"No Response", same past-tense reasoning), the raw reaction(s) they left, and their Attendance Note if any. Showing derived Status alongside the raw reactions means a reader doesn't need to know the 👍-wins-regardless precedence rule by heart.

No link out to another surface — the detail lives entirely inside the thread reply.

**HawkBot Admin**:
Replaces "Slack workspace Owner/Admin" as the authorization model for every admin-gated capability (`/hawk config`, `/hawk event create`, the season CSV export, and the Reaction Cutoff Verification failure DM) — full replacement, not an additional either/or check. Defined by membership in a dedicated Slack User Group — not Slack's built-in Admins group — so a team can grant bot-admin duties (mentors, team leads) without handing out full Slack workspace administration. An admin configures it by handle (e.g. `hawkbot-admins`); the bot resolves that to the group's Slack-internal id once, at set-time, and checks membership against the id from then on. Slack workspace Owners always retain HawkBot Admin rights regardless of the group's state, as a bootstrap/lockout safety net — otherwise an empty or unconfigured group would mean nobody could run the command needed to fix it. Group membership is cached (same 5-minute-TTL shape as the old per-user admin cache), rather than looked up per check.

**Weekly Summary Post**:
A single Slack message posted to the announcements channel at an admin-configurable day/time (default Sunday, noon), listing every Event scheduled for the fixed upcoming Monday–Sunday week — a full planning digest, including Hourly, All-Day, and Multi-Day Events alike, regardless of whether an Event already has (or will soon have) its own Event Check-in Post. Only one Weekly Summary Post exists at a time: the previous week's is deleted before the new one is posted. This is the first place Multi-Day Events are tracked as Events at all — nothing about their attendance mechanics changes; they're still deferred — this just makes them visible for planning.
_Avoid_: "7-day summary" (ambiguous with a rolling window — see Weekly Summary Change Reflection)

**Weekly Summary Change Reflection**:
How the Weekly Summary Post stays accurate through the week it covers. Unlike Calendar Change Handling — which pairs a threaded, broadcast reply with rewriting the original post — this is in-place editing only, no thread and no broadcast:

- **Edited Event**: the event's whole line is struck through, with a fresh line below giving the current details and a short "(updated: field, field)" tag — reusing the same changed-fields list Calendar Change Handling already computes. Always compares against the Event's state as first shown in _this week's_ summary, not a chain of every intermediate edit — a second edit before the week ends still shows one strikethrough (original vs. current), not two.
- **Removed Event**: the line is struck through and labeled removed, staying visible rather than being deleted from the listing.
- **New Event discovered mid-week**: appended to the already-posted summary immediately, not held until next week — tagged "🆕 _New_" so it's obviously not something everyone already saw Sunday. Unlike an edited or removed Event, it stays tagged for the rest of that week rather than the tag being a one-time strikethrough-style annotation, since there's no "original" version of the line to contrast it against.

This keeps reflecting an Event's changes for the rest of the week even after that Event gets its own Event Check-in Post — Calendar Change Handling's threaded, broadcast reply is an _additional_, more active notification for people already tracking that specific Event, not a replacement. A summary that went stale for any Event with a Check-in Post would defeat the point of it being a reliable weekly reference. See ADR-0005 for why this is in-place editing rather than the threaded-reply design originally sketched.

**Informational Reply**:
The Informational Calendar's digest, if enabled: a threaded reply under that week's Weekly Summary Post, covering the same Monday–Sunday week, rather than a separate top-level post or broadcast. Posted the first time an Informational Event shows up in a given week — not posted at all for a week with none, so an enabled-but-empty week stays silent rather than adding noise. Follows Weekly Summary Change Reflection's own rules for the rest of the week (edited/removed/new), and is deleted alongside the parent Weekly Summary Post at the next weekly rollover. See ADR-0008 for why this threads when the Weekly Summary Post itself deliberately doesn't (ADR-0005).

**Mentor/Teacher Weekly Summary**:
The Mentor/Teacher Calendar's digest, if enabled: its own post, on its own admin-configurable day/time, to an admin-only channel (not the team announcements channel) — separate audience, separate schedule from the Weekly Summary Post. Covers a two-week span (two consecutive Monday–Sunday weeks) rather than one, for more lead time on travel and unavailability conflicts. Deleted and reposted fresh each cycle like the Weekly Summary Post, but with no Weekly Summary Change Reflection — see ADR-0007. Safe for an adult-only channel despite the "no user scopes, shared with minors" rule in `CLAUDE.md`: a Mentor/Teacher Event only ever reveals that someone is unavailable, never why or where.
