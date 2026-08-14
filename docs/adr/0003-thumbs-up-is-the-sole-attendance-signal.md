# 👍 is the only reaction that confers Attending

Attendance credit on an Event Check-in Post comes from exactly one signal: whether a 👍 (any skin tone) reaction is present at the Reaction Cutoff. A Clock Reaction is informational only — even reacting with just a clock, and no 👍, is logged as Not Attending.

This is a deliberate narrowing from the feature's original framing, where a bare Clock Reaction was its own standalone "attending, just late" signal. Collapsing to a single boolean keeps the attendance rule trivial to state and to audit later ("was there a 👍 or not"), instead of a small state machine of reaction combinations that both the bot and every team member reading the post have to hold in their head. The risk — someone reacting with only a clock, meaning to signal they're coming late, and landing in Not Attending by mistake — is covered by a DM nudge (see `CONTEXT.md`, Clock Reaction) rather than by making the attendance rule itself more permissive.

Worth revisiting if the nudge turns out not to be enough and people keep getting miscounted despite it — that would be a sign the single-signal model is fighting how people actually react, not just how the code reads.
