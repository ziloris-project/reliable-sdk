// Console capture — monkey-patches `console.error` and `console.warn` so
// "soft failures" that don't throw still surface as incidents.
//
// console.error → severity 'medium'
// console.warn  → severity 'low'
//
// The original implementations are always called after capture so the
// integrator's DevTools output is unchanged. Dedup happens upstream in
// captureMessage → captureNormalizedError (5s window per fingerprint),
// so logging the same message in a loop doesn't flood the backend.
//
// Safety: the SDK's own logger captures console.* references at init time
// (see util/log.ts) and bypasses these patched versions, so internal
// warnings don't feedback-loop into captureMessage.

import type { SdkContext } from '../context';
import { captureMessage } from '../errors';

let teardown: (() => void) | null = null;

const MESSAGE_MAX = 2000;

export function initConsole(ctx: SdkContext): void {
    if (teardown) return;
    if (typeof console === 'undefined') return;

    const origError = console.error;
    const origWarn  = console.warn;

    console.error = function patchedError(...args: unknown[]): void {
        try {
            captureMessage(formatArgs(args), { severity: 'medium' });
        } catch { /* never let capture break the user's console call */ }
        return origError.apply(console, args);
    };

    console.warn = function patchedWarn(...args: unknown[]): void {
        try {
            captureMessage(formatArgs(args), { severity: 'low' });
        } catch { /* never let capture break the user's console call */ }
        return origWarn.apply(console, args);
    };

    teardown = () => {
        console.error = origError;
        console.warn  = origWarn;
        teardown = null;
    };

    ctx.logger.debug('console capture installed');
}

export function destroyConsole(): void {
    teardown?.();
}

// ── helpers ─────────────────────────────────────────────────────────────

function formatArgs(args: unknown[]): string {
    if (args.length === 0) return '(empty console call)';
    const joined = args.map(formatArg).join(' ');
    return joined.length > MESSAGE_MAX
        ? joined.slice(0, MESSAGE_MAX) + '…[truncated]'
        : joined;
}

function formatArg(arg: unknown): string {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg instanceof Error) return arg.stack ?? arg.message;
    try {
        return JSON.stringify(arg);
    } catch {
        // Circular references, BigInt, etc.
        return String(arg);
    }
}
