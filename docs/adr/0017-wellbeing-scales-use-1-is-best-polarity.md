# Both wellbeing 1-5 scales store 1 = best, 5 = worst

The original feature brief's mood row — "😞 😕 😐 🙂 😄 (maps to 1-5)" — reads left-to-right as 😞=1 ... 😄=5, i.e. higher number = better mood. The Deep Check-in overwhelm scale ("figuring things out ↔ I feel lost") was always the opposite polarity: 1 = confident/figuring things out (best), 5 = lost (worst). Nobody noticed the mismatch until a question about what actually gets persisted (an option's Block Kit `value`, never the emoji itself — the emoji is display-only) forced naming the mapping explicitly for the first time.

We picked one polarity for both: **1 = best, 5 = worst**, everywhere in this feature. This also matches the mood scale's display order after the best-on-top reordering (😄 first, 😞 last) — the stored value now lines up with position on screen, which the original left-to-right mapping no longer did once the display was reordered.

**Consequence**: the Baseline-Drop Trigger's direction flips. Under the old mood polarity (5=best), a declining student's scores went *down*, so "at least 1.5 points *below* trailing average" was the correct condition. Under this polarity (1=best), a declining student's scores go *up* toward 5, so the trigger condition is now "at least 1.5 points *above* trailing average." The trigger's name (Baseline-Drop Trigger) still describes the real-world thing being detected — a drop in wellbeing — not the arithmetic sign; anyone implementing it needs to read the direction from CONTEXT.md, not infer it from the name.

The overwhelm scale's polarity is unchanged by this decision — it already matched. Only the mood scale's stored values change (and only because the display order changed first); nothing about `needs_help` or `theme_tag` is affected.
