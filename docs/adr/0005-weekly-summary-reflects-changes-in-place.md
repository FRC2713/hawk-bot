# The Weekly Summary reflects changes by editing the message in place, not threaded replies

The original design for this feature called for calendar changes within the current week to post as a threaded, broadcast reply on the Weekly Summary Post — the same mechanism Calendar Change Handling already uses on an Event Check-in Post. Instead, the Weekly Summary Post is edited in place: the affected Event's line gets struck through, with a fresh line underneath giving the current details and which fields changed.

A threaded reply on the summary would have meant two competing "this changed" mechanisms once an Event also has its own Check-in Post — one thread on the summary, one thread on the Check-in Post, for the same edit. In-place editing sidesteps that entirely: the summary always shows the current, accurate state of the whole week at a glance, and the Check-in Post's threaded reply remains the one *active* notification — the thing that actually pings people — once an Event is close enough to have one. The summary's job is to be a reliable passive reference, not to compete for attention.

This also means the summary keeps reflecting an Event's changes for the entire week it covers, even after that Event gets its own Check-in Post — the two mechanisms run in parallel for the rest of that Event's life within the current week, not handed off from one to the other.
