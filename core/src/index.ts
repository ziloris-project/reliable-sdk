// @reliable/core — framework-agnostic browser observability SDK.
//
// Public entrypoint. The SDK exposes a single-client singleton model:
//
//     import { init, identify } from '@reliable/core';
//     init({ publicKey: 'pk_live_rl_...' });
//     identify({ externalId: 'user_123' });
//
// The singleton pattern is deliberate — feature modules (errors, vitals,
// network, clicks, navigation) all want to reach the same client without
// plumbing it through every call site. `init()` is idempotent; calling it
// twice is a warning, not an error.

import { createClient, type InternalClient } from './client';
import type {
    ReliableClient,
    ReliableConfig,
    UserIdentity,
    LogLevel,
    CaptureOptions,
    CaptureMessageOptions,
} from './types';

let _client: InternalClient | null = null;

/**
 * Initialize the SDK. Must be called before any other method. Calling a
 * second time with a different config is a no-op and logs a warning.
 */
export function init(config: ReliableConfig): ReliableClient {
    if (_client) {
        // eslint-disable-next-line no-console
        console.warn('[reliable] init() called more than once — ignoring.');
        return _client;
    }
    _client = createClient(config);
    return _client;
}

/**
 * Return the active client, or `null` if `init()` hasn't been called.
 * Feature modules use `requireClient()` instead; this is for app code that
 * needs to guard against double-init or lazy bootstrapping.
 */
export function getClient(): ReliableClient | null {
    return _client;
}

/**
 * Internal: used by feature modules that must not run before init(). Throws
 * with a clear message instead of silently no-op'ing, because silent drops
 * are how observability tools get debugged at 2am.
 */
export function requireClient(): InternalClient {
    if (!_client) {
        throw new Error('[reliable] SDK not initialized. Call init({ publicKey }) first.');
    }
    return _client;
}

/** Identify the current session with a user. Rotates the session if the user changes. */
export function identify(user: UserIdentity): void {
    _client?.identify(user);
}

/** Set a single tag attached to all future events. */
export function setTag(key: string, value: string | number | boolean): void {
    _client?.setTag(key, value);
}

/** Merge-set multiple tags at once. */
export function setTags(tags: Record<string, string | number | boolean>): void {
    _client?.setTags(tags);
}

/** Push a breadcrumb onto the ring buffer. The last 30 are attached to errors. */
export function addBreadcrumb(crumb: {
    category: string;
    message: string;
    level?: LogLevel;
    data?: Record<string, unknown>;
}): void {
    _client?.addBreadcrumb(crumb);
}

/** Force-flush the outbound queue. Returns a promise that resolves when delivery attempts complete. */
export function flush(): Promise<void> {
    return _client ? _client.flush() : Promise.resolve();
}

/**
 * Manually report a caught error or arbitrary thrown value. Works whether
 * or not auto-capture is enabled, as long as init() has been called.
 * Returns the event UUID, or `null` if dropped (no client / de-duped).
 */
export function captureException(error: unknown, options?: CaptureOptions): string | null {
    return _client?.captureException(error, options) ?? null;
}

/**
 * Report an arbitrary message with optional severity. Useful for soft
 * failures, retries, or noteworthy state transitions.
 */
export function captureMessage(message: string, options?: CaptureMessageOptions): string | null {
    return _client?.captureMessage(message, options) ?? null;
}

/**
 * Reset the singleton. Exposed for tests only — not part of the stable API.
 * @internal
 */
export function __resetClientForTesting(): void {
    _client = null;
}

// Re-export the public types so integrators don't need to reach into submodules.
export type {
    ReliableConfig,
    ReliableClient,
    UserIdentity,
    Breadcrumb,
    LogLevel,
    ErrorSeverity,
    CaptureOptions,
    CaptureMessageOptions,
} from './types';
