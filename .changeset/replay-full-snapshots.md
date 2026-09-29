---
"@reliableapp/frontend-core": patch
---

Session replays are always playable, and the masking attributes from the docs work.

- **Replays now always start from a full-page snapshot.** Up to 1.5.0 rrweb took one only at page load and the SDK kept the last ~70 seconds, so an error more than a minute into a visit uploaded page changes with nothing to apply them to (about 60% of production replays played as a blank frame). The recorder now takes a fresh snapshot every 30 seconds while the page changes, and when the tab becomes visible again. Each upload starts at the last snapshot before the 60-second window, so recordings are 60 to 90 seconds long. On a page that has not changed in a while, a snapshot is taken at the time of the error.
- **Oversized recordings are trimmed at a snapshot,** so they still replay. A single event over 5 MB is skipped instead of looping.
- **`data-rr-block` and `data-rr-mask` now work** alongside `data-rl-block` and `data-rl-mask`. The dashboard docs told people to use the `data-rr-` names, which the SDK ignored, so content meant to be hidden was recorded.
