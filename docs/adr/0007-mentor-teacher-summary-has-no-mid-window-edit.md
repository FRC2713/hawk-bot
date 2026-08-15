# The Mentor/Teacher Weekly Summary does not reflect mid-week changes in place, unlike the Weekly Summary Post

ADR-0005 established in-place editing as how a weekly digest in this app stays accurate through the period it covers. The Mentor/Teacher Weekly Summary deliberately doesn't follow that: a change to a Mentor/Teacher Event between posts just shows up corrected on the next scheduled post — no item-snapshot table, no live edit in between.

The Weekly Summary Post is a standing reference the whole team checks through the week, which is what justifies the machinery ADR-0005 built to keep it accurate. The Mentor/Teacher Weekly Summary is a narrower, admin-only digest with a 2-week span already built in to absorb some drift — nobody is tracking it moment-to-moment the way the team tracks the Weekly Summary Post, so a correction landing on the next post (at most one cycle late) was judged not worth a second copy of the rewrite-in-place machinery.

Worth revisiting if admins start relying on it for anything more time-sensitive than planning-ahead visibility.
