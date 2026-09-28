// Transport orchestrator. Owns the outbound queue and decides *when* to
// flush it. Flush triggers:
//   - queue size >= BATCH_SIZE
//   - FLUSH_DEBOUNCE_MS after the most recent enqueue
//   - visibilitychange -> hidden
//   - pagehide
//   - prerenderingchange (a prerendered page becoming visible)
//
// Nothing is sent while the page is being prerendered. Chrome prerenders
// pages it predicts you will open (from the address bar or speculation
// rules), running their scripts; most are never shown. Sending from them
// counted visits and page views that no person saw. Events are held and go
// out when the page is activated, or never, if it is discarded.
//
// Everything downstream (sampling gate, beforeSend hook, self-ignore,
// retries) is either filtered here or delegated to `send.ts`. Feature
// modules only see `enqueue`.

import type { ResolvedConfig } from '../config';
import type { Logger } from '../util/log';
import type { OutboundEvent } from './queue';
import { createQueue } from './queue';
import { sendEvent } from './send';

export type { OutboundEvent } from './queue';

const BATCH_SIZE = 20;
const FLUSH_DEBOUNCE_MS = 5000;

export interface Transport {
    enqueue(event: OutboundEvent): void;
    flush(opts?: { unloading?: boolean }): Promise<void>;
    attachLifecycle(): void;
    detachLifecycle(): void;
}

export interface TransportDeps {
    config: ResolvedConfig;
    logger: Logger;
    /** Called on every enqueue to check the per-session sampling decision. */
    isSampled: () => boolean;
    /** The backend sampled this session out (the project's sample-rate
     *  setting). The session should go dark. */
    onSampledOut?: (sessionUuid: string) => void;
}

export function createTransport({ config, logger, isSampled, onSampledOut }: TransportDeps): Transport {
    const queue = createQueue();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lifecycleBound = false;

    function clearDebounce(): void {
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }

    function scheduleFlush(): void {
        if (debounceTimer !== null) return;
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void flush();
        }, FLUSH_DEBOUNCE_MS);
    }

    function enqueue(event: OutboundEvent): void {
        // Dark mode: session lost the sample roll. Drop silently.
        if (!isSampled()) return;

        // Self-ignore: never report our own ingest traffic.
        const endpointHost = safeHost(config.endpoint);
        if (endpointHost && typeof event.payload['url'] === 'string') {
            if (safeHost(event.payload['url']) === endpointHost) return;
        }

        // beforeSend hook: integrator-supplied drop/mutate gate.
        const transformed = config.beforeSend(event.payload);
        if (transformed === null) {
            logger.debug('beforeSend dropped event', event.path);
            return;
        }

        queue.enqueue({ path: event.path, payload: transformed });
        logger.debug('enqueue', event.path, transformed);

        if (queue.size() >= BATCH_SIZE) {
            void flush();
        } else {
            scheduleFlush();
        }
    }

    async function flush(opts: { unloading?: boolean } = {}): Promise<void> {
        clearDebounce();
        if (isPrerendering()) return;
        const batch = queue.drain();
        if (batch.length === 0) return;
        logger.debug('flush', batch.length, 'events', opts.unloading ? '(unloading)' : '');

        // The backend requires the session row to exist before any child
        // event can reference it via session_uuid. Send /sessions first,
        // wait for it to land, then fire everything else in parallel.
        const sessions = batch.filter((e) => e.path === '/sessions');
        let rest       = batch.filter((e) => e.path !== '/sessions');

        // The backend applies the project's sample-rate setting per session
        // and answers a sampled-out session start with `sampled: false`.
        // Drop that session's other events from this batch, and let the
        // session go dark so nothing else is sent for it.
        const sampledOut = new Set<string>();
        if (sessions.length > 0) {
            await Promise.all(sessions.map(async (e) => {
                const res = await sendEvent(config, e, opts);
                if (!res || !res.ok) return;
                try {
                    const body = await res.clone().json() as { data?: { sampled?: boolean } };
                    const uuid = e.payload['uuid'];
                    if (body?.data?.sampled === false && typeof uuid === 'string') {
                        sampledOut.add(uuid);
                        onSampledOut?.(uuid);
                    }
                } catch {
                    // Not JSON (older backend): nothing to learn.
                }
            }));
        }
        if (sampledOut.size > 0) {
            rest = rest.filter((e) => !sampledOut.has(String(e.payload['session_uuid'])));
        }
        if (rest.length > 0) {
            await Promise.all(rest.map((e) => sendEvent(config, e, opts)));
        }
    }

    function attachLifecycle(): void {
        if (lifecycleBound) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('prerenderingchange', onActivated);
        lifecycleBound = true;
    }

    function detachLifecycle(): void {
        if (!lifecycleBound) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('prerenderingchange', onActivated);
        lifecycleBound = false;
    }

    function onVisibility(): void {
        if (document.visibilityState === 'hidden') void flush({ unloading: true });
    }

    function onPageHide(): void {
        void flush({ unloading: true });
    }

    function onActivated(): void {
        void flush();
    }

    return { enqueue, flush, attachLifecycle, detachLifecycle };
}

function isPrerendering(): boolean {
    return typeof document !== 'undefined'
        && (document as Document & { prerendering?: boolean }).prerendering === true;
}

function safeHost(url: string): string | null {
    try {
        return new URL(url, 'http://_/').host;
    } catch {
        return null;
    }
}
