// Error capture — auto-listens to window 'error' + 'unhandledrejection',
// and exposes captureException()/captureMessage() so user code can manually
// report handled failures (try/catch branches, validation errors, business
// logic failures, React error boundaries).
//
// Each error is normalized into a common shape, fingerprinted client-side
// (so the backend can group occurrences), de-duped within a 5s window to
// prevent render-loop floods, and enriched with:
//   • router_history       — last 10 route changes (from navigation module)
//   • browser_state        — cookies + localStorage (scrubbed)
//   • trigger              — page_load / click / navigation / api_response / timer
//   • component_stack      — optional, set by React error boundaries
//   • severity             — heuristic (crash → critical, console.warn → low, else medium)

import type { SdkContext } from '../context';
import { getCurrentPath, getRouterHistory } from '../navigation';
import { getRecentNetwork } from '../network';
import { triggerReplayFlush } from '../replay';
import { scrubString } from '../scrub';
import { uuid } from '../util/uuid';
import { nowIso } from '../util/now';

export type ErrorSource = 'js' | 'unhandled' | 'manual' | 'react';
export type ErrorTrigger = 'page_load' | 'click' | 'navigation' | 'api_response' | 'timer' | 'unknown';
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CaptureOptions {
    severity?: ErrorSeverity;
    isCrash?: boolean;
    tags?: Record<string, string | number | boolean>;
    /** React error boundary forwards componentInfo.componentStack here. */
    componentStack?: string | null;
    /** Mark the source. Defaults to 'manual'; React boundaries pass 'react'. */
    source?: ErrorSource;
}

export interface CaptureMessageOptions {
    severity?: ErrorSeverity;
    tags?: Record<string, string | number | boolean>;
}

interface NormalizedError {
    message: string;
    stack: string | null;
    source: ErrorSource;
    filename?: string | null;
    lineno?: number | null;
    colno?: number | null;
    componentStack?: string | null;
    isCrash?: boolean;
    severity?: ErrorSeverity;
    tags?: Record<string, string | number | boolean>;
}

/** De-dup window: same fingerprint within this period is dropped. */
const DEDUP_MS = 5_000;

/** Window after a network event in which an error is considered "api_response". */
const API_TRIGGER_WINDOW_MS = 500;

/** Window after page load in which errors are considered "page_load". */
const PAGE_LOAD_WINDOW_MS = 2_000;

/** Value truncation for browser_state entries — stops mega-tokens from bloating payloads. */
const STATE_VALUE_MAX = 200;

const pageLoadedAt = typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now();

let teardown: (() => void) | null = null;

// Module-level state so captureException/captureMessage can be called from
// outside the listener closure (i.e. user code after init()).
let activeContext: SdkContext | null = null;
const recentFingerprints = new Map<string, number>();

/** Queue React error boundary data so the next window 'error' picks it up. */
let pendingComponentStack: string | null = null;

export function setPendingComponentStack(stack: string | null): void {
    pendingComponentStack = stack;
}

export function initErrors(ctx: SdkContext): void {
    if (activeContext) return;
    activeContext = ctx;

    // Window listeners only attach when auto-capture is on; the manual API
    // (captureException/captureMessage) works either way as long as init()
    // ran, so users who disable auto-capture can still report by hand.
    if (!ctx.config.captureErrors || typeof window === 'undefined') {
        ctx.logger.debug('error auto-capture disabled; manual capture remains available');
        return;
    }

    const onError = (event: ErrorEvent): void => {
        // Ignore non-Error events (e.g. script load failures with no message).
        if (!event.error && !event.message) return;

        // Ignore rrweb internal errors to prevent replay → error → replay loops.
        const msg = event.error?.message ?? event.message ?? '';
        if (msg.includes('node.matches is not a function') ||
            msg.includes('rrweb')) return;

        const e = event.error;
        captureNormalizedError({
            message: e?.message ?? event.message ?? 'Unknown error',
            stack: e?.stack ?? null,
            source: 'js',
            filename: event.filename ?? null,
            lineno: event.lineno ?? null,
            colno: event.colno ?? null,
        });
    };

    const onUnhandled = (event: PromiseRejectionEvent): void => {
        const reason = event.reason;
        let message: string;
        let stack: string | null = null;

        if (reason instanceof Error) {
            message = reason.message;
            stack = reason.stack ?? null;
        } else if (typeof reason === 'string') {
            message = reason;
        } else {
            message = 'Unhandled promise rejection';
            try { message += ': ' + JSON.stringify(reason); } catch {}
        }

        captureNormalizedError({
            message,
            stack,
            source: 'unhandled',
        });
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);

    teardown = () => {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onUnhandled);
        teardown = null;
    };

    ctx.logger.debug('error instrumentation installed');
}

export function destroyErrors(): void {
    teardown?.();
    activeContext = null;
    recentFingerprints.clear();
}

// ── Public manual capture API ─────────────────────────────────────────────

/**
 * Manually report a caught error or arbitrary thrown value.
 * Returns the event UUID, or `null` if the SDK isn't initialized or the
 * error was de-duped.
 */
export function captureException(error: unknown, options: CaptureOptions = {}): string | null {
    if (!activeContext) return null;

    let message: string;
    let stack: string | null;

    if (error instanceof Error) {
        message = error.message || error.name || 'Error';
        stack = error.stack ?? null;
    } else if (typeof error === 'string') {
        message = error;
        // Synthesize a stack so fingerprinting/grouping has something to work with.
        stack = new Error(error).stack ?? null;
    } else {
        try { message = JSON.stringify(error); } catch { message = String(error); }
        stack = new Error(message).stack ?? null;
    }

    return captureNormalizedError({
        message,
        stack,
        source: options.source ?? 'manual',
        componentStack: options.componentStack,
        isCrash: options.isCrash,
        severity: options.severity,
        tags: options.tags,
    });
}

/**
 * Report an arbitrary message (no Error required). Useful for soft failures
 * — e.g. "payment retry succeeded after 3 attempts" at severity 'low'.
 */
export function captureMessage(message: string, options: CaptureMessageOptions = {}): string | null {
    if (!activeContext) return null;

    return captureNormalizedError({
        message,
        stack: new Error(message).stack ?? null,
        source: 'manual',
        severity: options.severity ?? 'medium',
        tags: options.tags,
    });
}

// ── Core capture pipeline ─────────────────────────────────────────────────

function isDuplicate(fp: string): boolean {
    const now = Date.now();
    const last = recentFingerprints.get(fp);
    if (last && now - last < DEDUP_MS) return true;
    recentFingerprints.set(fp, now);
    if (recentFingerprints.size > 50) {
        for (const [key, ts] of recentFingerprints) {
            if (now - ts > DEDUP_MS) recentFingerprints.delete(key);
        }
    }
    return false;
}

function captureNormalizedError(err: NormalizedError): string | null {
    const ctx = activeContext;
    if (!ctx) return null;

    const fp = fingerprint(err.message, err.stack);
    if (isDuplicate(fp)) {
        ctx.logger.debug('error de-duped', fp);
        return null;
    }

    const path = getCurrentPath() || (typeof location !== 'undefined' ? location.pathname : '/');
    const snap = ctx.scope.snapshot();
    const eventUuid = uuid();

    const crumbs = ctx.breadcrumbs.list();
    const trigger = classifyTrigger(crumbs);
    const isCrash = err.isCrash ?? detectCrash(err);
    const severity = err.severity ?? classifySeverity(err, isCrash);

    // Per-call tags override scope tags on key conflict.
    const mergedTags = err.tags ? { ...snap.tags, ...err.tags } : snap.tags;

    ctx.capture('/errors', {
        uuid: eventUuid,
        source: err.source,
        message: err.message,
        fingerprint: fp,
        stack_trace: err.stack,
        component_stack: err.componentStack ?? pendingComponentStack,
        trigger,
        is_crash: isCrash,
        crash_reason: isCrash
            ? (err.source === 'react' ? 'error_boundary' : err.componentStack ? 'error_boundary' : 'manual_crash')
            : undefined,
        severity,
        path,
        router_history: getRouterHistory().slice(),
        browser_state: collectBrowserState(),
        breadcrumbs: crumbs,
        tags: mergedTags,
        occurred_at: nowIso(),
    });

    pendingComponentStack = null;
    triggerReplayFlush(ctx, eventUuid);
    ctx.logger.debug('error captured', err.source, err.message);
    return eventUuid;
}

// ── fingerprint ─────────────────────────────────────────────────────────
// Cheap hash of (message + first stack frame) so the backend can group
// duplicate errors. Not cryptographic — just stable grouping.

function fingerprint(message: string, stack: string | null): string {
    const topFrame = stack ? firstFrame(stack) : '';
    const input = message + '\n' + topFrame;
    return simpleHash(input);
}

function firstFrame(stack: string): string {
    const lines = stack.split('\n');
    // Skip the first line (usually the error message itself).
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line.length > 0 && line.startsWith('at ')) return line;
    }
    return lines[1]?.trim() ?? '';
}

function simpleHash(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    // Convert to unsigned hex, zero-pad to 8 chars.
    return (h >>> 0).toString(16).padStart(8, '0');
}

// ── context collectors ─────────────────────────────────────────────────

/** Decide what *caused* the error. Heuristics, in priority order:
 *   1. within PAGE_LOAD_WINDOW_MS of timeOrigin → page_load
 *   2. a network event finished within API_TRIGGER_WINDOW_MS → api_response
 *   3. last breadcrumb is a route change → navigation
 *   4. last breadcrumb is a click → click
 *   5. otherwise → timer (setTimeout / setInterval leftovers) or unknown
 */
function classifyTrigger(
    crumbs: { category: string; timestamp: string }[],
): ErrorTrigger {
    const nowMs = Date.now();
    if (nowMs - pageLoadedAt < PAGE_LOAD_WINDOW_MS) return 'page_load';

    const net = getRecentNetwork();
    if (net.length) {
        const last = net[net.length - 1]!;
        if (nowMs - last.finishedAt < API_TRIGGER_WINDOW_MS) return 'api_response';
    }

    for (let i = crumbs.length - 1; i >= 0; i--) {
        const c = crumbs[i]!;
        if (c.category === 'navigation') return 'navigation';
        if (c.category === 'click')      return 'click';
    }

    return 'unknown';
}

/** Grab what's visible on document.cookie and localStorage. Values are scrubbed
 *  (emails, CC-shaped) and truncated. Token-named keys are redacted entirely. */
function collectBrowserState(): { cookies: Record<string, string>; localStorage: Record<string, string> } {
    const cookies: Record<string, string> = {};
    const ls: Record<string, string> = {};

    try {
        if (typeof document !== 'undefined' && document.cookie) {
            for (const pair of document.cookie.split(';')) {
                const idx = pair.indexOf('=');
                if (idx < 0) continue;
                const k = pair.slice(0, idx).trim();
                const v = pair.slice(idx + 1).trim();
                if (k) cookies[k] = redactValue(k, v);
            }
        }
    } catch { /* third-party cookies can throw access errors */ }

    try {
        if (typeof localStorage !== 'undefined') {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k) continue;
                const v = localStorage.getItem(k) ?? '';
                ls[k] = redactValue(k, v);
            }
        }
    } catch { /* partitioned storage can throw */ }

    return { cookies, localStorage: ls };
}

const SENSITIVE_KEY_RE = /token|secret|password|auth(?!or)/i;

function redactValue(key: string, value: string): string {
    if (SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
    const scrubbed = scrubString(value);
    return scrubbed.length > STATE_VALUE_MAX
        ? scrubbed.slice(0, STATE_VALUE_MAX) + '…'
        : scrubbed;
}

function detectCrash(err: NormalizedError): boolean {
    // React error boundaries forward a componentStack — treat as crash.
    if (err.componentStack ?? pendingComponentStack) return true;
    if (err.source === 'react') return true;
    // Chunk load failures kill the page.
    if (/ChunkLoadError|Loading chunk/i.test(err.message)) return true;
    // Hydration mismatch aborts rendering.
    if (/Hydration failed/i.test(err.message)) return true;
    return false;
}

function classifySeverity(err: NormalizedError, isCrash: boolean): ErrorSeverity {
    if (isCrash) return 'critical';
    if (err.source === 'unhandled') return 'high';
    return 'medium';
}
