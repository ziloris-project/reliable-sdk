// Session replay — always-on DOM recording with 60s sliding window.
//
// Records via rrweb, buffers in IndexedDB, flushes on error/click/network
// events. After the initial 60s flush, continues recording for 10s
// post-incident and PATCHes the chunk with the extended buffer.
//
// Flow:
//   1. rrweb.record() streams DOM events into a memory batch
//   2. Every 500ms, batch is written to IndexedDB + pruned to 60s window
//   3. On trigger (error, rage click, dead click, network failure):
//      a. Read 60s from IDB → compress → POST /ingest/replays
//      b. Start 10s post-incident timer
//      c. After 10s → read extended window → compress → PATCH /ingest/replays/:uuid
//   4. Visibility hidden → pause recording (no point capturing invisible tab)

import { record } from 'rrweb';
import { deflate } from 'pako';
import type { SdkContext } from '../context';
import { writeEvents, pruneEvents, readEvents, type StoredEvent } from './idb';

const WINDOW_MS = 60_000;          // 60s pre-incident
const POST_INCIDENT_MS = 10_000;   // 10s after trigger
const BATCH_INTERVAL_MS = 500;     // IDB write cadence
const MIN_FLUSH_GAP_MS = 10_000;   // Don't flush same window twice within 10s
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB compressed limit

let teardown: (() => void) | null = null;

export function initReplay(ctx: SdkContext): void {
    if (teardown) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (typeof indexedDB === 'undefined') return;

    const { config, session, logger } = ctx;

    // ── rrweb recording ─────────────────────────────────────────────────

    const memBatch: StoredEvent[] = [];
    let recording = true;
    let lastFlushTime = 0;
    let pendingChunkUuid: string | null = null;
    let postIncidentTimer: ReturnType<typeof setTimeout> | null = null;

    const stopRrweb = record({
        emit(event) {
            if (!recording) return;
            memBatch.push({ timestamp: Date.now(), data: event });
        },
        // Swallow internal rrweb errors (e.g. node.matches on text nodes)
        // so they don't bubble to window.onerror and trigger infinite loops.
        errorHandler: (err) => {
            logger.debug('rrweb internal error (suppressed)', err);
        },
        maskAllInputs: true,
        maskTextSelector: '[data-rl-mask]',
        blockSelector: '[data-rl-block]',
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
            await pruneEvents(Date.now() - WINDOW_MS - POST_INCIDENT_MS);
        } catch (err) {
            logger.debug('replay IDB write failed', err);
        }
    }, BATCH_INTERVAL_MS);

    // ── Visibility pause/resume ─────────────────────────────────────────

    function onVisibility(): void {
        recording = document.visibilityState === 'visible';
    }
    document.addEventListener('visibilitychange', onVisibility);

    // ── Flush API ───────────────────────────────────────────────────────

    async function compress(events: unknown[]): Promise<string> {
        const json = JSON.stringify(events);
        const compressed = deflate(json);

        if (compressed.length > MAX_PAYLOAD_BYTES) {
            logger.warn('replay payload exceeds 5MB, truncating');
            // Truncate from the beginning (keep recent events).
            const half = Math.floor(events.length / 2);
            return compress(events.slice(half));
        }

        // Convert Uint8Array to base64.
        let binary = '';
        for (let i = 0; i < compressed.length; i++) {
            binary += String.fromCharCode(compressed[i]!);
        }
        return btoa(binary);
    }

    async function flushInitial(triggerEventUuid: string): Promise<void> {
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
        const startTs = endTs - WINDOW_MS;

        try {
            const events = await readEvents(startTs, endTs);
            if (events.length === 0) {
                logger.debug('replay flush skipped — no events in window');
                return;
            }

            const compressed = await compress(events);
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
                const events = await readEvents(originalStartTs, endTs);
                if (events.length === 0) return;

                const compressed = await compress(events);

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
