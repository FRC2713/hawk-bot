# Deep Check-in fires on a global occurrence counter, not a calendar schedule

The original sketch offered "weekly or bi-weekly" for Deep Check-in. We rejected any calendar-based cadence — even reusing the Weekly Summary Post's existing Sunday-noon clock — because a fixed day-of-week introduces survey bias: if the team's Saturday meetings are reliably higher-energy than a Sunday one, a fixed weekly day always samples the same bias into the trend data, rather than the team's actual mood.

Instead, Deep Check-in rides a single global counter across Quick Pulse sends (not tracked per student): every Xth occurrence (default 4) is a Deep Check-in instead of a Quick Pulse for whoever's due at that moment, and the counter resets. This reuses the exact same per-meeting trigger point Quick Pulse already has (see ADR-0013) rather than introducing a second, calendar-driven clock alongside it — one trigger mechanism for both flows.

The theme rotation for Deep Check-in's third question (connection → inspiration → contribution) advances the same way: once per Deep Check-in occurrence, globally, not per student.
