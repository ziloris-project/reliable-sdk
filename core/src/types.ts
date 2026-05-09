// ── Public types for @reliable/core ──────────────────────────────────────
// Only types that end users / framework adapters (@reliable/react, etc.)
// need to see. Internal types live next to their owning module.

export type LogLevel = 'info' | 'warn' | 'error';

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CaptureOptions {
    severity?: ErrorSeverity;
    isCrash?: boolean;
    tags?: Record<string, string | number | boolean>;
    /** React error boundary forwards componentInfo.componentStack here. */
    componentStack?: string | null;
}

export interface CaptureMessageOptions {
    severity?: ErrorSeverity;
    tags?: Record<string, string | number | boolean>;
}

export interface Breadcrumb {
    category: string;
    message: string;
    level: LogLevel;
    data?: Record<string, unknown>;
    timestamp: string;
}

export interface UserIdentity {
    externalId: string;
    email?: string;
    name?: string;
    traits?: Record<string, unknown>;
}

/**
 * User-facing SDK config. All fields except `publicKey` are optional.
 * Feature capture flags default to `true`; the server-side project config
 * is authoritative and can disable features remotely.
 */
export interface ReliableConfig {
    publicKey: string;
    endpoint?: string;
    /** 0-100. Per-session dice roll; losers go dark for the whole session. */
    sampleRate?: number;
    debug?: boolean;
    /** Return `null` to drop an event, or a mutated copy to rewrite it. */
    beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null;
    captureVitals?: boolean;
    captureErrors?: boolean;
    captureNetwork?: boolean;
    captureClicks?: boolean;
    captureNavigation?: boolean;
    /** If true, network capture reports all requests, not just failures. */
    captureAllRequests?: boolean;
    captureReplay?: boolean;
    /** If true, console.error and console.warn are captured as messages. */
    captureConsole?: boolean;
    /**
     * Release identifier (commit SHA, version tag, build ID — anything
     * unique per deploy). Sent with every event so the backend can look
     * up the matching sourcemap and resolve minified stacks.
     */
    release?: string;
}

export interface ReliableClient {
    identify(user: UserIdentity): void;
    setTag(key: string, value: string | number | boolean): void;
    setTags(tags: Record<string, string | number | boolean>): void;
    addBreadcrumb(crumb: {
        category: string;
        message: string;
        level?: LogLevel;
        data?: Record<string, unknown>;
    }): void;
    /** Force-flush the transport queue. */
    flush(): Promise<void>;
    /** Track a custom business or product event. */
    track(eventName: string, properties?: Record<string, unknown>): void;
    /**
     * Manually report a caught error or arbitrary thrown value.
     * Returns the event UUID, or `null` if the SDK isn't initialized
     * or the error was de-duped within the 5s window.
     */
    captureException(error: unknown, options?: CaptureOptions): string | null;
    /**
     * Report an arbitrary message (no Error required). Useful for soft
     * failures — e.g. "payment retry succeeded after 3 attempts".
     */
    captureMessage(message: string, options?: CaptureMessageOptions): string | null;
}
