// Session replay — always-on DOM recording with a sliding window.
//
// Records via rrweb, buffers in IndexedDB, flushes on error/click/network
// events. After the initial flush, continues recording for 10s
// post-incident and PATCHes the chunk with the extended buffer.
//
// Flow:
//   1. rrweb.record() streams DOM events into a memory batch, with a fresh
//      full snapshot every 30s while the page changes (snapshots.ts)
//   2. Every 500ms, batch is written to IndexedDB + pruned to RETAIN_MS
//   3. On trigger (error, rage click, dead click, network failure):
//      a. Read the last 60s from IDB, starting at the snapshot before them
//         (so up to ~90s) → compress → POST /ingest/replays
//      b. Start 10s post-incident timer
//      c. After 10s → read from the same snapshot to now → compress → PATCH /ingest/replays/:uuid
//   4. Visibility hidden → pause recording (no point capturing invisible
//      tab); visible again → fresh snapshot, since hidden changes were lost
//
// Replays are per tab: events are stored with this tab's id and a flush only
// reads its own tab's events, so two open tabs never mix into one replay. The
// id lives in sessionStorage, which is per tab and survives reloads, so a
// replay can still show the page the user reloaded or navigated away from.
// Sessions that lost the sample roll upload no replays.

import { record } from 'rrweb';
import { deflate } from 'pako';
import type { SdkContext } from '../context';
import { writeEvents, pruneEvents, readEvents, type StoredEvent } from './idb';
import { CHECKOUT_EVERY_MS, fromLastSnapshot, trimToSnapshot } from './snapshots';
import { uuid } from '../util/uuid';

const WINDOW_MS = 60_000;          // 60s pre-incident
const POST_INCIDENT_MS = 10_000;   // 10s after trigger
const BATCH_INTERVAL_MS = 500;     // IDB write cadence
const MIN_FLUSH_GAP_MS = 10_000;   // Don't flush same window twice within 10s
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB compressed limit

// How far back a flush looks for the snapshot its window starts from, and
// so how long events are kept: the window, the post-incident extension,
// one checkout interval, and a margin. While a page changes, rrweb takes a
// snapshot at most CHECKOUT_EVERY_MS after the last one, so any window with
// events in it has a snapshot inside this horizon (see snapshots.ts).
const LOOKBACK_MS = CHECKOUT_EVERY_MS + 10_000;
const RETAIN_MS   = WINDOW_MS + POST_INCIDENT_MS + LOOKBACK_MS;

const TAB_KEY = 'reliable:tab';

let teardown: (() => void) | null = null;

/** This tab's id: stable across reloads of the tab, distinct between tabs. */
function currentTabId(): string {
    try {
        const existing = sessionStorage.getItem(TAB_KEY);
        if (existing) return existing;
        const fresh = uuid();
        sessionStorage.setItem(TAB_KEY, fresh);
        return fresh;
    } catch {
        return uuid();
    }
}

export function initReplay(ctx: SdkContext): void {
    if (teardown) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (typeof indexedDB === 'undefined') return;

    const { config, session, logger } = ctx;
    const tabId = currentTabId();

    // ── rrweb recording ─────────────────────────────────────────────────

    const memBatch: StoredEvent[] = [];
    let recording = true;
    let lastFlushTime = 0;
    let pendingChunkUuid: string | null = null;
    let postIncidentTimer: ReturnType<typeof setTimeout> | null = null;

    const stopRrweb = record({
        emit(event) {
            if (!recording) return;
            memBatch.push({ timestamp: Date.now(), tab: tabId, data: event });
        },
        // Swallow internal rrweb errors (e.g. node.matches on text nodes)
        // so they don't bubble to window.onerror and trigger infinite loops.
        errorHandler: (err) => {
            logger.debug('rrweb internal error (suppressed)', err);
        },
        // A fresh full snapshot every 30s while the page changes, so the
        // buffer always holds one to replay a window from.
        checkoutEveryNms: CHECKOUT_EVERY_MS,
        maskAllInputs: true,
        // data-rl-* are the SDK's attributes. The dashboard docs told people
        // to use data-rr-block (and data-rr-mask) instead, which did nothing:
        // honor both, so anyone who followed the docs is actually protected.
        maskTextSelector: '[data-rl-mask], [data-rr-mask]',
        blockSelector: '[data-rl-block], [data-rr-block]',
        sampling: {
            mousemove: true,
            scroll: 150,
            input: 'last',
        },
    });

    // ── Periodic IDB flush + prune ──────────────────────────────────────

    const batchTimer = setInterval(async () => {
        if (memBatch.length === 0) return;
        const batch = memBatch.splice(0);
        try {
            await writeEvents(batch);
            await pruneEvents(Date.now() - RETAIN_MS);
        } catch (err) {
            logger.debug('replay IDB write failed', err);
        }
    }, BATCH_INTERVAL_MS);

    // ── Visibility pause/resume ─────────────────────────────────────────

    function onVisibility(): void {
        const visible = document.visibilityState === 'visible';
        const resuming = visible && !recording;
        recording = visible;
        // Changes made while hidden were not stored, so later changes would
        // refer to page state the recording never saw. Start again from a
        // fresh snapshot.
        if (resuming) takeSnapshot();
    }

    function takeSnapshot(): void {
        try {
            record.takeFullSnapshot(true);
        } catch (err) {
            logger.debug('replay snapshot failed', err);
        }
    }
    document.addEventListener('visibilitychange', onVisibility);

    // ── Flush API ───────────────────────────────────────────────────────

    async function compress(events: unknown[]): Promise<string | null> {
        const json = JSON.stringify(events);
        const compressed = deflate(json);

        if (compressed.length > MAX_PAYLOAD_BYTES) {
            // One event over the limit cannot be trimmed (this used to recurse
            // forever on events.slice(0)).
            if (events.length < 2) return null;
            logger.warn('replay payload exceeds 5MB, truncating');
            // Drop the older half, cutting at a snapshot so it still replays.
            return compress(trimToSnapshot(events, Math.floor(events.length / 2)));
        }

        // Convert Uint8Array to base64.
        let binary = '';
        for (let i = 0; i < compressed.length; i++) {
            binary += String.fromCharCode(compressed[i]!);
        }
        return btoa(binary);
    }

    async function flushInitial(triggerEventUuid: string): Promise<void> {
        // Dark sessions (lost the sample roll, or sampled out by the project
        // setting) send nothing else, and replays are no exception.
        if (!session.current().sampled) return;
        const now = Date.now();
        if (now - lastFlushTime < MIN_FLUSH_GAP_MS) {
            logger.debug('replay flush skipped — too soon since last flush');
            return;
        }
        lastFlushTime = now;

        // Write any pending memory batch first.
        if (memBatch.length > 0) {
            const batch = memBatch.splice(0);
            try { await writeEvents(batch); } catch {}
        }

        const endTs = now;
        const windowStart = endTs - WINDOW_MS;

        try {
            // Start from the snapshot the window replays from (up to one
            // checkout interval before it), never from mid-stream changes.
            let slice = fromLastSnapshot(
                await readEvents(tabId, windowStart - LOOKBACK_MS, endTs),
                windowStart,
            );
            if (!slice) {
                // Nothing stored since the last snapshot aged out, which means
                // the page has not changed since: a snapshot taken now shows
                // what the user was looking at. Not while hidden, where the
                // page is not being recorded at all.
                if (!recording) {
                    logger.debug('replay flush skipped — tab hidden, no snapshot');
                    return;
                }
                takeSnapshot();
                const batch = memBatch.splice(0);
                try { await writeEvents(batch); } catch {}
                slice = fromLastSnapshot(await readEvents(tabId, endTs, Date.now()), Date.now());
            }
            if (!slice) {
                logger.debug('replay flush skipped — no snapshot to replay from');
                return;
            }

            const startTs = slice[0]!.timestamp;
            const events = slice.map((e) => e.data);
            const compressed = await compress(events);
            if (!compressed) {
                logger.warn('replay flush skipped — a single event exceeds 5MB');
                return;
            }
            const sess = session.current();

            const payload = {
                session_uuid: sess.uuid,
                trigger_event_uuid: triggerEventUuid,
                started_at: new Date(startTs).toISOString(),
                ended_at: new Date(endTs).toISOString(),
                snapshot_count: events.length,
                compressed_events: compressed,
            };

            // Direct POST (not through transport — replay has its own endpoint).
            const res = await fetch(`${config.endpoint}/replays`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-reliable-key': config.publicKey,
                },
                body: JSON.stringify(payload),
                credentials: 'omit',
            });

            if (res.ok) {
                const body = await res.json();
                pendingChunkUuid = body?.data?.uuid ?? null;
                logger.debug('replay initial flush sent', pendingChunkUuid, events.length, 'events');

                // Start post-incident timer.
                schedulePostIncident(startTs);
            } else {
                logger.warn('replay flush failed', res.status);
            }
        } catch (err) {
            logger.debug('replay flush error', err);
        }
    }

    function schedulePostIncident(originalStartTs: number): void {
        if (postIncidentTimer) clearTimeout(postIncidentTimer);

        postIncidentTimer = setTimeout(async () => {
            postIncidentTimer = null;
            if (!pendingChunkUuid) return;

            // Write any remaining memory batch.
            if (memBatch.length > 0) {
                const batch = memBatch.splice(0);
                try { await writeEvents(batch); } catch {}
            }

            const endTs = Date.now();
            try {
                // From the same snapshot the initial upload started at.
                const events = (await readEvents(tabId, originalStartTs, endTs)).map((e) => e.data);
                if (events.length === 0) return;

                const compressed = await compress(events);
                if (!compressed) return;

                const res = await fetch(`${config.endpoint}/replays/${pendingChunkUuid}`, {
                    method: 'PATCH',
                    headers: {
                        'content-type': 'application/json',
                        'x-reliable-key': config.publicKey,
                    },
                    body: JSON.stringify({
                        ended_at: new Date(endTs).toISOString(),
                        snapshot_count: events.length,
                        compressed_events: compressed,
                    }),
                    credentials: 'omit',
                });

                if (res.ok) {
                    logger.debug('replay extended with post-incident', events.length, 'events');
                } else {
                    logger.warn('replay extend failed', res.status);
                }
            } catch (err) {
                logger.debug('replay extend error', err);
            }

            pendingChunkUuid = null;
        }, POST_INCIDENT_MS);
    }

    // ── Flush on page unload (best effort, no post-incident) ────────────

    function onPageHide(): void {
        if (postIncidentTimer) {
            clearTimeout(postIncidentTimer);
            postIncidentTimer = null;
        }
        // If there's a pending extension, try to send it now with keepalive.
        if (pendingChunkUuid && memBatch.length > 0) {
            const batch = memBatch.splice(0);
            // Synchronous-ish best effort — can't await in pagehide.
            try {
                writeEvents(batch).catch(() => {});
            } catch {}
        }
    }
    window.addEventListener('pagehide', onPageHide);

    // ── Public trigger (called by errors, clicks, network modules) ──────

    (ctx as SdkContextWithReplay).__replayFlush = flushInitial;

    // ── Teardown ────────────────────────────────────────────────────────

    teardown = () => {
        stopRrweb?.();
        clearInterval(batchTimer);
        if (postIncidentTimer) clearTimeout(postIncidentTimer);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        teardown = null;
    };

    logger.debug('replay instrumentation installed');
}

export function destroyReplay(): void {
    teardown?.();
}

// ── Trigger helper for other modules ────────────────────────────────────

interface SdkContextWithReplay {
    __replayFlush?: (triggerEventUuid: string) => Promise<void>;
}

/** Called by error/click/network modules to trigger a replay flush. */
export function triggerReplayFlush(ctx: unknown, triggerEventUuid: string): void {
    const flush = (ctx as SdkContextWithReplay).__replayFlush;
    if (flush) {
        void flush(triggerEventUuid);
    }
}
