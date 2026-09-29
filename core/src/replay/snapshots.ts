// Keeping every uploaded replay chunk playable.
//
// rrweb can only replay from a full snapshot of the page: a Meta event
// (type 4) followed by a FullSnapshot (type 2). Everything after that is
// incremental changes to it. rrweb takes one when recording starts and,
// with checkoutEveryNms, again every CHECKOUT_EVERY_MS while the page
// changes. Up to 1.5.0 there were no periodic snapshots and the buffer
// kept only the last ~70s, so any error more than a minute into a visit
// uploaded changes with nothing to apply them to: in production about 60%
// of chunks replayed as a blank frame.

import type { StoredEvent } from './idb';

/** rrweb EventType.Meta, which starts every full snapshot. */
const META = 4;

/** How often rrweb takes a fresh full snapshot while the page changes. */
export const CHECKOUT_EVERY_MS = 30_000;

export function isSnapshotStart(event: unknown): boolean {
    return (event as { type?: unknown } | null)?.type === META;
}

/**
 * The part of a tab's stored events to upload for a window starting at
 * `windowStart`: from the last snapshot at or before the window, so the
 * chunk covers the whole window and starts with something replayable (up
 * to CHECKOUT_EVERY_MS earlier than the window). When there is no snapshot
 * before the window, from the first one inside it. Null when the events
 * contain no snapshot at all.
 */
export function fromLastSnapshot(events: StoredEvent[], windowStart: number): StoredEvent[] | null {
    let start = -1;
    for (let i = 0; i < events.length; i++) {
        if (!isSnapshotStart(events[i]!.data)) continue;
        if (events[i]!.timestamp <= windowStart || start === -1) start = i;
        if (events[i]!.timestamp > windowStart) break;
    }
    return start === -1 ? null : events.slice(start);
}

/**
 * Drop older events to fit a size budget without losing replayability:
 * cut at the first snapshot at or after `from`, else the last snapshot
 * before it. Plain `from` only when there is no snapshot at all.
 */
export function trimToSnapshot(events: unknown[], from: number): unknown[] {
    let before = -1;
    for (let i = 0; i < events.length; i++) {
        if (!isSnapshotStart(events[i])) continue;
        if (i >= from) return events.slice(i);
        before = i;
    }
    return before > 0 ? events.slice(before) : events.slice(from);
}
