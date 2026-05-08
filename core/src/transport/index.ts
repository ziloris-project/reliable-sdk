// Transport orchestrator. Owns the outbound queue and decides *when* to
// flush it. Flush triggers:
//   - queue size >= BATCH_SIZE
//   - FLUSH_DEBOUNCE_MS after the most recent enqueue
//   - visibilitychange -> hidden
//   - pagehide
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
}

export function createTransport({ config, logger, isSampled }: TransportDeps): Transport {
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
        const batch = queue.drain();
        if (batch.length === 0) return;
        logger.debug('flush', batch.length, 'events', opts.unloading ? '(unloading)' : '');

        // The backend requires the session row to exist before any child
        // event can reference it via session_uuid. Send /sessions first,
        // wait for it to land, then fire everything else in parallel.
        const sessions = batch.filter((e) => e.path === '/sessions');
        const rest     = batch.filter((e) => e.path !== '/sessions');

        if (sessions.length > 0) {
            await Promise.all(sessions.map((e) => sendEvent(config, e, opts)));
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
        lifecycleBound = true;
    }

    function detachLifecycle(): void {
        if (!lifecycleBound) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        lifecycleBound = false;
    }

    function onVisibility(): void {
        if (document.visibilityState === 'hidden') void flush({ unloading: true });
    }

    function onPageHide(): void {
        void flush({ unloading: true });
    }

    return { enqueue, flush, attachLifecycle, detachLifecycle };
}

function safeHost(url: string): string | null {
    try {
        return new URL(url, 'http://_/').host;
    } catch {
        return null;
    }
}
