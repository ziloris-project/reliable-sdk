// Single-event delivery. Called in parallel by the transport on flush.
//
// We use `fetch` with `keepalive: true` on unload instead of `sendBeacon`
// because keepalive survives unload, accepts real headers (so we can send
// `x-reliable-key`), and avoids sendBeacon's 64KB-per-blob budget ambiguity.
// Browsers that lack keepalive fall back to a best-effort fetch that may or
// may not survive — better than silently dropping.
//
// Retries: a single 500ms-delayed retry on network error or 5xx. We don't
// retry 4xx — if the payload is malformed, a retry won't fix it.

import type { ResolvedConfig } from '../config';
import type { OutboundEvent } from './queue';

export interface SendOptions {
    /** Page is unloading — use keepalive and accept best-effort. */
    unloading?: boolean;
}

export async function sendEvent(
    config: ResolvedConfig,
    event: OutboundEvent,
    opts: SendOptions = {},
): Promise<boolean> {
    const url = `${config.endpoint}${event.path}`;
    const body = safeStringify(event.payload);
    if (body === null) return false;

    const attempt = async (): Promise<Response | null> => {
        try {
            return await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-reliable-key': config.publicKey,
                },
                body,
                keepalive: Boolean(opts.unloading),
                credentials: 'omit',
                mode: 'cors',
            });
        } catch {
            return null;
        }
    };

    let res = await attempt();
    if (shouldRetry(res) && !opts.unloading) {
        await delay(500);
        res = await attempt();
    }
    return Boolean(res && res.ok);
}

function shouldRetry(res: Response | null): boolean {
    if (res === null) return true;
    return res.status >= 500 && res.status < 600;
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function safeStringify(value: unknown): string | null {
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}
